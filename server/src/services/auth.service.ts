import type { ClientSession } from 'mongoose';
import { z } from 'zod';
import { config } from '../config.js';
import { withTransaction } from '../db.js';
import { logger } from '../logger.js';
import { AuthToken } from '../models/system.js';
import { User } from '../models/User.js';
import { hashPassword, hashToken, randomToken, verifyPassword } from '../utils/crypto.js';
import { AppError, badRequest, forbidden } from '../utils/errors.js';
import { formatInZone } from '../utils/time.js';
import { audit, type Actor } from './audit.service.js';
import { enqueueEmail } from './notification.service.js';
import { createSession, revokeAllSessions } from './session.service.js';

export const ACTIVATION_TTL_HOURS = 72;
export const RESET_TTL_MINUTES = 30;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128, 'Password must be at most 128 characters')
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Password must contain letters and numbers');

export const NOT_REGISTERED_MESSAGE =
  "Your account can't be registered automatically. Please contact your administrator.";

/**
 * Employees sign in only with Microsoft once it is configured (always in production).
 * Local development without Entra settings keeps employee passwords so the app stays testable.
 */
export function employeesUseMicrosoftOnly() {
  return config.ssoEnabled || config.isProd;
}

/**
 * Admins are added by email and sign in with Microsoft once it is configured; no set-password
 * invitation is sent. Admins who already have a password (e.g. the bootstrap account) keep it.
 */
export function adminsUseMicrosoft() {
  return config.ssoEnabled;
}

/** Drivers sign in only with their mobile number and vehicle number; employees possibly only with Microsoft. */
function usesPassword(role: string) {
  if (role === 'DRIVER' || role === 'COORDINATOR') return false;
  return !(role === 'EMPLOYEE' && employeesUseMicrosoftOnly());
}

const invalidCredentials = () =>
  new AppError(
    401,
    'INVALID_CREDENTIALS',
    employeesUseMicrosoftOnly()
      ? 'Invalid email or password. Employees: use "Sign in with Microsoft". Coordinators: use "Sign in with email and mobile number". Drivers: use "Sign in with your mobile number".'
      : 'Invalid email or password. Coordinators: use "Sign in with email and mobile number". Drivers: use "Sign in with your mobile number". If you are not registered yet, please contact your administrator.',
  );

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase().normalize('NFKC');
}

export async function login(emailRaw: string, password: string, meta: { ip?: string; userAgent?: string }) {
  const email = normalizeEmail(emailRaw);
  const user = await User.findOne({ email }).select('+passwordHash');
  const ok = await verifyPassword(password, user?.passwordHash);

  // Same response for unknown accounts, wrong passwords and employees (who must use
  // Microsoft), so the form never reveals which emails exist or who is an employee.
  if (!user || !usesPassword(user.role)) throw invalidCredentials();
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError(429, 'ACCOUNT_LOCKED', 'Too many failed sign-in attempts. Try again later or reset your password.');
  }
  if (!ok) {
    const failed = (user.failedLoginCount ?? 0) + 1;
    const update: Record<string, unknown> = { failedLoginCount: failed };
    if (failed >= MAX_FAILED_LOGINS) {
      update.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60_000);
      update.failedLoginCount = 0;
      await audit({ id: String(user._id), role: user.role, email: user.email, ...meta }, 'LOGIN_LOCKOUT', 'User', user._id, 'Account temporarily locked after repeated failed sign-ins');
    }
    await User.updateOne({ _id: user._id }, { $set: update });
    throw invalidCredentials();
  }
  // Correct password: it is now safe to explain the account state.
  if (user.status === 'INVITED') {
    throw new AppError(403, 'ACCOUNT_NOT_ACTIVATED', 'Your account has not been activated yet. Use the activation link sent to your work email, or ask your administrator to resend it.');
  }
  if (user.status !== 'ACTIVE') {
    throw new AppError(403, 'ACCOUNT_INACTIVE', 'Your account is not active. Please contact your administrator.');
  }
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date(), failedLoginCount: 0 }, $unset: { lockedUntil: 1 } });
  const session = await createSession(user, { ...meta, method: 'PASSWORD' });
  await audit({ id: String(user._id), role: user.role, email: user.email, ...meta }, 'LOGIN', 'User', user._id, 'Signed in with password');
  return { user, session };
}

/**
 * Issue a single-use activation token and queue the invitation email (in the
 * caller's transaction). Any outstanding activation tokens are revoked first.
 */
export async function issueActivation(
  user: { _id: unknown; email: string; name: string },
  actor: Actor,
  session: ClientSession | null,
) {
  const role = (await User.findById(user._id, { role: 1 }).session(session).lean())?.role ?? '';
  if (role === 'DRIVER') throw new AppError(409, 'MOBILE_SIGN_IN_ONLY', 'Drivers sign in with their mobile number and vehicle number; no invitation is needed.');
  if (role === 'COORDINATOR') throw new AppError(409, 'MOBILE_SIGN_IN_ONLY', 'Coordinators sign in with their email and mobile number; no invitation is needed.');
  if (role === 'ADMIN' && adminsUseMicrosoft()) throw new AppError(409, 'MICROSOFT_SIGN_IN_ONLY', 'Admins sign in with Microsoft using their work email; no invitation is needed.');
  if (!usesPassword(role)) throw new AppError(409, 'MICROSOFT_SIGN_IN_ONLY', 'Employees activate their account by signing in with Microsoft; no invitation is needed.');
  await AuthToken.updateMany(
    { user: user._id, purpose: 'ACTIVATION', usedAt: null, revokedAt: null },
    { $set: { revokedAt: new Date() } },
    { session: session ?? undefined },
  );
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + ACTIVATION_TTL_HOURS * 3600_000);
  const [doc] = await AuthToken.create(
    [{ user: user._id, purpose: 'ACTIVATION', tokenHash: hashToken(token), expiresAt, createdBy: actor.id || undefined }],
    { session: session ?? undefined },
  );
  await User.updateOne({ _id: user._id }, { $set: { invitedAt: new Date() } }, { session: session ?? undefined });
  await enqueueEmail(session, {
    idempotencyKey: `invitation:${doc._id}`,
    template: 'ACCOUNT_INVITATION',
    to: user.email,
    toUserId: String(user._id),
    params: { name: user.name, expiresAt: formatInZone(expiresAt, 'UTC', "dd LLL yyyy HH:mm 'UTC'") },
    secretParams: { activationUrl: `${config.APP_BASE_URL}/activate?token=${encodeURIComponent(token)}` },
  });
  return { expiresAt };
}

/** Atomically consume a single-use token. Returns the token doc or throws. */
async function consumeToken(token: string, purpose: 'ACTIVATION' | 'PASSWORD_RESET', session: ClientSession) {
  const doc = await AuthToken.findOneAndUpdate(
    { tokenHash: hashToken(token), purpose, usedAt: null, revokedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
    { new: true, session },
  );
  if (!doc) throw new AppError(400, 'INVALID_TOKEN', 'This link is invalid, expired or has already been used. Ask your administrator for a new one.');
  const role = (await User.findById(doc.user, { role: 1 }).session(session).lean())?.role ?? '';
  if (role === 'DRIVER') throw new AppError(400, 'MOBILE_SIGN_IN_ONLY', 'Drivers sign in with their mobile number. Go to the sign-in page and use "Driver? Sign in with your mobile number".');
  if (role === 'COORDINATOR') throw new AppError(400, 'MOBILE_SIGN_IN_ONLY', 'Coordinators sign in with their email and mobile number. Go to the sign-in page and use "Coordinator? Sign in with email and mobile number".');
  if (role === 'ADMIN' && adminsUseMicrosoft()) throw new AppError(400, 'MICROSOFT_SIGN_IN_ONLY', 'Admins sign in with Microsoft. Go to the sign-in page and use "Sign in with Microsoft".');
  if (!usesPassword(role)) throw new AppError(400, 'MICROSOFT_SIGN_IN_ONLY', 'Employees sign in with Microsoft. Go to the sign-in page and use "Sign in with Microsoft".');
  return doc;
}

export async function inspectToken(token: string, purpose: 'ACTIVATION' | 'PASSWORD_RESET') {
  const doc = await AuthToken.findOne({ tokenHash: hashToken(token), purpose, usedAt: null, revokedAt: null, expiresAt: { $gt: new Date() } });
  if (!doc) return null;
  const user = await User.findById(doc.user).lean();
  return user ? { email: user.email, name: user.name } : null;
}

export async function activateAccount(token: string, password: string, meta: { ip?: string; userAgent?: string }) {
  const parsed = passwordSchema.safeParse(password);
  if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
  const passwordHash = await hashPassword(password);
  const user = await withTransaction(async ({ session }) => {
    const doc = await consumeToken(token, 'ACTIVATION', session);
    const u = await User.findOneAndUpdate(
      { _id: doc.user, status: 'INVITED' },
      { $set: { status: 'ACTIVE', passwordHash, passwordChangedAt: new Date(), activatedAt: new Date(), statusChangedAt: new Date() } },
      { new: true, session },
    );
    if (!u) throw new AppError(400, 'INVALID_TOKEN', 'This account cannot be activated. Contact your administrator.');
    await audit({ id: String(u._id), role: u.role, email: u.email, ...meta }, 'ACCOUNT_ACTIVATED', 'User', u._id, 'Account activated via invitation', undefined, session);
    return u;
  });
  return user;
}

export async function requestPasswordReset(emailRaw: string) {
  const email = normalizeEmail(emailRaw);
  const user = await User.findOne({ email, status: 'ACTIVE' });
  if (!user) return; // identical response regardless (no enumeration)
  if (!usesPassword(user.role)) return; // no password to reset
  await withTransaction(async ({ session }) => {
    await AuthToken.updateMany(
      { user: user._id, purpose: 'PASSWORD_RESET', usedAt: null, revokedAt: null },
      { $set: { revokedAt: new Date() } },
      { session },
    );
    const token = randomToken(32);
    const [doc] = await AuthToken.create(
      [{ user: user._id, purpose: 'PASSWORD_RESET', tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000) }],
      { session },
    );
    await enqueueEmail(session, {
      idempotencyKey: `password-reset:${doc._id}`,
      template: 'PASSWORD_RESET',
      to: user.email,
      toUserId: String(user._id),
      params: { name: user.name, expiresInMinutes: RESET_TTL_MINUTES },
      secretParams: { resetUrl: `${config.APP_BASE_URL}/reset-password?token=${encodeURIComponent(token)}` },
    });
  });
}

export async function resetPassword(token: string, password: string, meta: { ip?: string; userAgent?: string }) {
  const parsed = passwordSchema.safeParse(password);
  if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
  const passwordHash = await hashPassword(password);
  const user = await withTransaction(async ({ session }) => {
    const doc = await consumeToken(token, 'PASSWORD_RESET', session);
    const u = await User.findOneAndUpdate(
      { _id: doc.user, status: 'ACTIVE' },
      { $set: { passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0 }, $unset: { lockedUntil: 1 } },
      { new: true, session },
    );
    if (!u) throw new AppError(400, 'INVALID_TOKEN', 'This account cannot reset its password. Contact your administrator.');
    await audit({ id: String(u._id), role: u.role, email: u.email, ...meta }, 'PASSWORD_RESET', 'User', u._id, 'Password reset via emailed link', undefined, session);
    return u;
  });
  await revokeAllSessions(user._id, 'PASSWORD_RESET');
}

export async function changePassword(userId: string, current: string, next: string, actor: Actor) {
  const user = await User.findById(userId).select('+passwordHash');
  if (user && !usesPassword(user.role)) throw forbidden('This account has no password: it signs in with Microsoft or a mobile number');
  if (!user || !(await verifyPassword(current, user.passwordHash))) throw forbidden('Current password is incorrect');
  const parsed = passwordSchema.safeParse(next);
  if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
  user.passwordHash = await hashPassword(next);
  user.passwordChangedAt = new Date();
  await user.save();
  await audit(actor, 'PASSWORD_CHANGED', 'User', user._id, 'Password changed');
  logger.info({ userId }, 'Password changed');
}
