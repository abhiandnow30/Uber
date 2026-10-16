import type { NextFunction, Request, Response } from 'express';
import type { Role } from '../domain.js';
import type { UserDoc } from '../models/User.js';
import type { Actor } from '../services/audit.service.js';
import { CSRF_COOKIE, resolveSession, SESSION_COOKIE } from '../services/session.service.js';
import { AppError, forbidden, unauthorized } from '../utils/errors.js';

export type AuthContext = {
  user: UserDoc;
  sessionId: string;
  csrfToken: string;
  actor: Actor;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function actorFromRequest(req: Request): Actor {
  return req.auth?.actor ?? { id: '', role: 'SYSTEM', ip: req.ip, userAgent: req.get('user-agent') };
}

/** Loads the session if present; never rejects. */
export async function loadSession(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    const resolved = await resolveSession(token);
    if (resolved) {
      req.auth = {
        user: resolved.user,
        sessionId: String(resolved.session._id),
        csrfToken: resolved.session.csrfToken,
        actor: {
          id: String(resolved.user._id),
          role: resolved.user.role as Role,
          email: resolved.user.email,
          ip: req.ip,
          userAgent: req.get('user-agent'),
        },
      };
    }
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(unauthorized());
  next();
}

/** Role gate. Always combined with resource-level checks inside services. */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(unauthorized());
    if (!roles.includes(req.auth.user.role as Role)) return next(forbidden());
    next();
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF protection:
 *  1. Every state-changing request must carry the X-Requested-With header, which a
 *     cross-site form cannot set and cross-origin fetch cannot send without a CORS
 *     preflight (which we do not grant).
 *  2. Authenticated requests must also echo the session-bound CSRF token
 *     (double-submit, compared against the server-side session record).
 */
export function csrfProtection(req: Request, _res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.get('x-requested-with') !== 'XMLHttpRequest') {
    return next(new AppError(403, 'CSRF_REJECTED', 'Missing request header'));
  }
  if (req.auth) {
    const header = req.get('x-csrf-token');
    if (!header || header !== req.auth.csrfToken) {
      return next(new AppError(403, 'CSRF_REJECTED', 'Invalid or missing CSRF token. Refresh the page and try again.'));
    }
  }
  next();
}

export { CSRF_COOKIE, SESSION_COOKIE };
