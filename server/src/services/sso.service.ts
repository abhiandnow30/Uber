import crypto from 'node:crypto';
import { ConfidentialClientApplication, CryptoProvider } from '@azure/msal-node';
import { z } from 'zod';
import { config } from '../config.js';
import { withTransaction } from '../db.js';
import { Employee } from '../models/Employee.js';
import { AuthToken } from '../models/system.js';
import { User } from '../models/User.js';
import { AppError, conflict } from '../utils/errors.js';
import { audit } from './audit.service.js';
import { normalizeEmail } from './auth.service.js';
import { createEmployee, emailDomainAllowed, employeeInputSchema, PHONE_RE } from './employee.service.js';
import { getPolicy } from './policy.service.js';
import { createSession } from './session.service.js';

type MsalClient = Pick<ConfidentialClientApplication, 'getAuthCodeUrl' | 'acquireTokenByCode'>;
let client: MsalClient | null = null;

/** Test hook: inject a fake MSAL client (no network). */
export function setSsoClient(c: MsalClient | null) {
  client = c;
}
const cryptoProvider = new CryptoProvider();
const SCOPES = ['openid', 'profile', 'email'];

function getClient(): MsalClient {
  if (!config.ssoEnabled) throw new Error('SSO is not configured');
  if (!client) {
    client = new ConfidentialClientApplication({
      auth: {
        clientId: config.ENTRA_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${config.ENTRA_TENANT_ID}`,
        clientSecret: config.ENTRA_CLIENT_SECRET,
      },
    });
  }
  return client;
}

/** Start the auth-code + PKCE flow. state and verifier travel in a short-lived httpOnly cookie. */
export async function buildLoginUrl() {
  const { verifier, challenge } = await cryptoProvider.generatePkceCodes();
  const state = crypto.randomBytes(24).toString('base64url');
  const nonce = crypto.randomBytes(16).toString('base64url');
  const url = await getClient().getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: config.ENTRA_REDIRECT_URI,
    state,
    nonce,
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    responseMode: 'query',
    prompt: 'select_account',
  });
  return { url, cookieValue: JSON.stringify({ state, verifier }) };
}

export type SsoOutcome =
  | { ok: true; token: string; csrfToken: string; expiresAt: Date }
  | { ok: false; reason: 'register'; ticket: string }
  | { ok: false; reason: 'not_registered' | 'inactive' | 'invalid' | 'driver_mobile_only' };

// ---------------------------------------------------------------------------
// Self-registration ticket: proof that Microsoft verified this identity, carried
// in a short-lived httpOnly cookie between the callback and the registration form.
// ---------------------------------------------------------------------------
export const REGISTRATION_TTL_MS = 30 * 60_000;
type Ticket = { oid: string; email: string; name: string; exp: number };

const sign = (payload: string) => crypto.createHmac('sha256', config.TOKEN_HMAC_KEY).update(`sso-registration:${payload}`).digest('base64url');

export function issueRegistrationTicket(t: Omit<Ticket, 'exp'>) {
  const payload = Buffer.from(JSON.stringify({ ...t, exp: Date.now() + REGISTRATION_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function readRegistrationTicket(value: string | undefined): Ticket | null {
  const [payload, mac] = (value ?? '').split('.');
  if (!payload || !mac) return null;
  const expected = sign(payload);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const t = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Ticket;
    return t.exp > Date.now() && t.oid && t.email ? t : null;
  } catch {
    return null;
  }
}

/**
 * Completes SSO. A valid Microsoft identity is NOT enough: it must match an existing
 * authorised user record (by Entra object id, or by email on first SSO sign-in).
 */
export async function completeLogin(params: { code: string; state: string; cookie: string | undefined; ip?: string; userAgent?: string }): Promise<SsoOutcome> {
  let saved: { state: string; verifier: string };
  try {
    saved = JSON.parse(params.cookie ?? '');
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!saved.state || saved.state.length !== params.state.length || !crypto.timingSafeEqual(Buffer.from(saved.state), Buffer.from(params.state))) {
    return { ok: false, reason: 'invalid' };
  }
  const result = await getClient().acquireTokenByCode({ code: params.code, scopes: SCOPES, redirectUri: config.ENTRA_REDIRECT_URI, codeVerifier: saved.verifier });
  const claims = (result?.idTokenClaims ?? {}) as { oid?: string; tid?: string; preferred_username?: string; email?: string };
  if (!claims.oid || claims.tid !== config.ENTRA_TENANT_ID) return { ok: false, reason: 'invalid' };
  const email = normalizeEmail(claims.email ?? claims.preferred_username ?? '');

  let user = await User.findOne({ entraOid: claims.oid });
  if (!user && email) {
    user = await User.findOne({ email, $or: [{ entraOid: null }, { entraOid: { $exists: false } }] });
  }
  if (!user) {
    // Unknown but Microsoft-verified colleague: let them register themselves, unless the
    // email is already taken (e.g. linked to another Microsoft account) or not a company domain.
    if (!email || !emailDomainAllowed(email) || (await User.exists({ email }))) return { ok: false, reason: 'not_registered' };
    const name = String((claims as { name?: string }).name ?? '').trim();
    return { ok: false, reason: 'register', ticket: issueRegistrationTicket({ oid: claims.oid, email, name }) };
  }
  // Drivers sign in only with their mobile number and vehicle number, never with Microsoft.
  if (user.role === 'DRIVER') return { ok: false, reason: 'driver_mobile_only' };
  if (user.status === 'INVITED') {
    // The admin already approved this record and Microsoft proved the identity:
    // first SSO sign-in completes activation.
    await withTransaction(async ({ session }) => {
      await User.updateOne({ _id: user!._id, status: 'INVITED' }, { $set: { status: 'ACTIVE', activatedAt: new Date(), statusChangedAt: new Date(), entraOid: claims.oid } }, { session });
      await AuthToken.updateMany({ user: user!._id, purpose: 'ACTIVATION', usedAt: null, revokedAt: null }, { $set: { revokedAt: new Date() } }, { session });
      await audit({ id: String(user!._id), role: user!.role, email: user!.email, ip: params.ip }, 'ACCOUNT_ACTIVATED', 'User', user!._id, 'Account activated via Microsoft SSO', undefined, session);
    });
    user = await User.findById(user._id);
  }
  if (!user || user.status !== 'ACTIVE') return { ok: false, reason: 'inactive' };
  if (!user.entraOid) await User.updateOne({ _id: user._id }, { $set: { entraOid: claims.oid } });
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
  const s = await createSession(user, { ip: params.ip, userAgent: params.userAgent, method: 'SSO' });
  await audit({ id: String(user._id), role: user.role, email: user.email, ip: params.ip, userAgent: params.userAgent }, 'LOGIN', 'User', user._id, 'Signed in with Microsoft SSO');
  return { ok: true, ...s };
}

// ---------------------------------------------------------------------------
// Self-registration form
// ---------------------------------------------------------------------------
const required = (label: string, max: number) => z.string().trim().min(1, `${label} is required`).max(max);

export const selfRegistrationSchema = z.object({
  employeeId: employeeInputSchema.shape.employeeId,
  fullName: z.string().trim().min(2, 'Full name is required').max(100),
  phone: required('Phone', 25).refine((p) => PHONE_RE.test(p), 'Enter a valid phone number'),
  officeLocation: z.string().trim().toUpperCase().min(1, 'Office location is required'),
  route: required('Route', 120),
  homeAddress: z.string().trim().min(5, 'Enter your full home address').max(300),
});

/** What the form needs: the verified identity plus the offices and routes to choose from. */
export async function getRegistrationContext(ticket: Ticket) {
  const [policy, routes] = await Promise.all([getPolicy(), Employee.distinct('route', { route: { $nin: [null, ''] } })]);
  return {
    email: ticket.email,
    fullName: ticket.name,
    offices: policy.officeLocations.filter((o) => o.active).map((o) => ({ code: o.code, name: o.name })),
    routes: (routes as string[]).sort((a, b) => a.localeCompare(b)),
  };
}

/** Creates the employee as ACTIVE, linked to the Microsoft account, and signs them in. */
export async function completeRegistration(ticket: Ticket, input: z.infer<typeof selfRegistrationSchema>, meta: { ip?: string; userAgent?: string }) {
  if (await User.exists({ entraOid: ticket.oid })) throw conflict('This Microsoft account is already registered. Sign in instead.', 'ALREADY_REGISTERED');
  const actor = { id: '', role: 'EMPLOYEE' as const, email: ticket.email, ip: meta.ip, userAgent: meta.userAgent };
  const userId = await withTransaction(async (tx) => {
    const employee = await createEmployee(actor, { ...input, email: ticket.email }, { sendInvitation: false, source: 'SSO' }, tx);
    const now = new Date();
    await User.updateOne(
      { _id: employee.user },
      { $set: { status: 'ACTIVE', activatedAt: now, statusChangedAt: now, entraOid: ticket.oid, lastLoginAt: now } },
      { session: tx.session },
    );
    await audit({ ...actor, id: String(employee.user) }, 'ACCOUNT_ACTIVATED', 'User', employee.user, `${input.employeeId} registered via Microsoft sign-in`, undefined, tx.session);
    return employee.user;
  });
  const user = await User.findById(userId);
  if (!user) throw new AppError(500, 'INTERNAL', 'Registration could not be completed');
  return createSession(user, { ...meta, method: 'SSO' });
}
