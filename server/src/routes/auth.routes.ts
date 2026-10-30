import { Router, type Response } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { authLimiter, body, publicFormLimiter } from '../middleware/common.js';
import { Coordinator } from '../models/Coordinator.js';
import { Driver } from '../models/Driver.js';
import { Employee } from '../models/Employee.js';
import { audit } from '../services/audit.service.js';
import { adminsUseMicrosoft, employeesUseMicrosoftOnly, NOT_REGISTERED_MESSAGE } from '../services/auth.service.js';
import { CSRF_COOKIE, revokeSessionByToken, SESSION_COOKIE } from '../services/session.service.js';
import {
  buildLoginUrl,
  completeLogin,
  completeRegistration,
  getRegistrationContext,
  readRegistrationTicket,
  REGISTRATION_TTL_MS,
  selfRegistrationSchema,
} from '../services/sso.service.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../logger.js';
import { coordinatorPhoneLogin } from '../services/coordinatorAuth.service.js';
import { driverPhoneLogin } from '../services/driverAuth.service.js';
import { linkLimiter, mapsLinkLookup } from './geo.routes.js';

export const authRouter = Router();

function setAuthCookies(res: Response, token: string, csrfToken: string, expiresAt: Date) {
  const base = { secure: config.COOKIE_SECURE, sameSite: 'lax' as const, expires: expiresAt, path: '/' };
  res.cookie(SESSION_COOKIE, token, { ...base, httpOnly: true });
  res.cookie(CSRF_COOKIE, csrfToken, { ...base, httpOnly: false });
}

function clearAuthCookies(res: Response) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.clearCookie(CSRF_COOKIE, { path: '/' });
}

const meta = (req: { ip?: string; get(h: string): string | undefined }) => ({ ip: req.ip, userAgent: req.get('user-agent') });

authRouter.post('/driver-login', authLimiter, async (req, res) => {
  const input = body(z.object({ phone: z.string().trim().min(6).max(25), password: z.string().trim().min(4).max(10) }), req);
  const { user, session } = await driverPhoneLogin(input.phone, input.password, meta(req));
  setAuthCookies(res, session.token, session.csrfToken, session.expiresAt);
  res.json({ user: { id: user._id, name: user.name, role: user.role }, csrfToken: session.csrfToken });
});

authRouter.post('/coordinator-login', authLimiter, async (req, res) => {
  const input = body(z.object({ email: z.string().trim().min(3).max(254), phone: z.string().trim().min(6).max(25) }), req);
  const { user, session } = await coordinatorPhoneLogin(input.email, input.phone, meta(req));
  setAuthCookies(res, session.token, session.csrfToken, session.expiresAt);
  res.json({ user: { id: user._id, name: user.name, role: user.role }, csrfToken: session.csrfToken });
});

authRouter.post('/logout', async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await revokeSessionByToken(token, 'LOGOUT');
  if (req.auth) await audit(req.auth.actor, 'LOGOUT', 'User', req.auth.user._id, 'Signed out');
  clearAuthCookies(res);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = req.auth!.user;
  let profile: unknown = null;
  if (user.role === 'EMPLOYEE') profile = await Employee.findOne({ user: user._id }).lean();
  if (user.role === 'DRIVER') profile = await Driver.findOne({ user: user._id }).select('driverCode fullName phone officeLocation availability onDuty verificationStatus employmentStatus').lean();
  if (user.role === 'COORDINATOR') profile = await Coordinator.findOne({ user: user._id }).lean();
  res.json({
    user: { id: user._id, name: user.name, email: user.email, role: user.role, status: user.status, lastLoginAt: user.lastLoginAt },
    profile,
    csrfToken: req.auth!.csrfToken,
  });
});

// ---------------------------------------------------------------------------
// Microsoft Entra ID SSO (employees and admins)
// ---------------------------------------------------------------------------
authRouter.get('/sso/config', (_req, res) => {
  res.json({ enabled: config.ssoEnabled, employeesMicrosoftOnly: employeesUseMicrosoftOnly(), adminsMicrosoft: adminsUseMicrosoft(), notRegisteredMessage: NOT_REGISTERED_MESSAGE });
});

authRouter.get('/sso/login', authLimiter, async (_req, res) => {
  if (!config.ssoEnabled) return res.redirect('/login?error=sso_disabled');
  const { url, cookieValue } = await buildLoginUrl();
  res.cookie('cab_sso', cookieValue, { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'lax', maxAge: 10 * 60_000, path: '/api/auth/sso' });
  res.redirect(url);
});

authRouter.get('/sso/callback', authLimiter, async (req, res) => {
  if (!config.ssoEnabled) return res.redirect('/login?error=sso_disabled');
  const code = String(req.query.code ?? '');
  const state = String(req.query.state ?? '');
  const cookie = req.cookies?.cab_sso;
  res.clearCookie('cab_sso', { path: '/api/auth/sso' });
  if (!code || !state) return res.redirect('/login?error=sso_failed');
  try {
    const outcome = await completeLogin({ code, state, cookie, ...meta(req) });
    if (!outcome.ok && outcome.reason === 'register') {
      res.cookie(REGISTRATION_COOKIE, outcome.ticket, { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'lax', maxAge: REGISTRATION_TTL_MS, path: '/api/auth/sso' });
      return res.redirect('/register');
    }
    if (!outcome.ok) return res.redirect(`/login?error=${outcome.reason}`);
    setAuthCookies(res, outcome.token, outcome.csrfToken, outcome.expiresAt);
    res.redirect('/');
  } catch (err) {
    logger.warn({ err }, 'SSO callback failed');
    res.redirect('/login?error=sso_failed');
  }
});

// Self-registration for Microsoft-verified employees who aren't in the system yet.
const REGISTRATION_COOKIE = 'cab_sso_reg';
const registrationTicket = (req: { cookies?: Record<string, string> }) => {
  const ticket = readRegistrationTicket(req.cookies?.[REGISTRATION_COOKIE]);
  if (!ticket) throw new AppError(401, 'REGISTRATION_EXPIRED', 'Your Microsoft sign-in has expired. Sign in with Microsoft again to register.');
  return ticket;
};

authRouter.get('/sso/registration', async (req, res) => {
  res.json(await getRegistrationContext(registrationTicket(req)));
});

// The registration form's Google Maps link reader: only for someone with a valid registration ticket.
authRouter.get('/sso/geo/link', linkLimiter, async (req, res) => {
  registrationTicket(req);
  await mapsLinkLookup(req, res);
});

authRouter.post('/sso/register', publicFormLimiter, async (req, res) => {
  const ticket = registrationTicket(req);
  const input = body(selfRegistrationSchema, req);
  const s = await completeRegistration(ticket, input, meta(req));
  res.clearCookie(REGISTRATION_COOKIE, { path: '/api/auth/sso' });
  setAuthCookies(res, s.token, s.csrfToken, s.expiresAt);
  res.status(201).json({ ok: true });
});
