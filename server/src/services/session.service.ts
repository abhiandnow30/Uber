import { config } from '../config.js';
import { Session } from '../models/system.js';
import { User, type UserDoc } from '../models/User.js';
import { hashToken, randomToken } from '../utils/crypto.js';

export const SESSION_COOKIE = 'cab_sid';
export const CSRF_COOKIE = 'cab_csrf';

export async function createSession(
  user: { _id: unknown },
  meta: { ip?: string; userAgent?: string; method?: 'PASSWORD' | 'SSO' | 'PHONE' },
) {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.SESSION_TTL_HOURS * 3600_000);
  await Session.create({
    user: user._id,
    tokenHash: hashToken(token),
    csrfToken,
    expiresAt,
    lastSeenAt: now,
    ip: meta.ip,
    userAgent: meta.userAgent?.slice(0, 300),
    authMethod: meta.method ?? 'PASSWORD',
  });
  return { token, csrfToken, expiresAt };
}

export type ResolvedSession = {
  session: { _id: unknown; csrfToken: string; expiresAt: Date };
  user: UserDoc;
};

/**
 * Validates a session cookie: not revoked, not past absolute expiry, not idle for
 * longer than SESSION_IDLE_MINUTES, and the user account is still ACTIVE.
 */
export async function resolveSession(token: string, opts: { touch?: boolean } = {}): Promise<ResolvedSession | null> {
  if (!token || token.length > 200) return null;
  const session = await Session.findOne({ tokenHash: hashToken(token), revokedAt: null });
  if (!session) return null;
  const now = Date.now();
  const idleLimit = config.SESSION_IDLE_MINUTES * 60_000;
  if (session.expiresAt.getTime() <= now || now - session.lastSeenAt.getTime() > idleLimit) {
    await Session.updateOne({ _id: session._id }, { $set: { revokedAt: new Date(), revokeReason: 'EXPIRED' } });
    return null;
  }
  const user = await User.findById(session.user);
  if (!user || user.status !== 'ACTIVE') return null;
  if (opts.touch !== false && now - session.lastSeenAt.getTime() > 60_000) {
    await Session.updateOne({ _id: session._id }, { $set: { lastSeenAt: new Date() } });
  }
  return { session: { _id: session._id, csrfToken: session.csrfToken, expiresAt: session.expiresAt }, user };
}

export async function revokeSessionByToken(token: string, reason = 'LOGOUT') {
  await Session.updateOne({ tokenHash: hashToken(token), revokedAt: null }, { $set: { revokedAt: new Date(), revokeReason: reason } });
}

export async function revokeAllSessions(userId: unknown, reason: string) {
  await Session.updateMany({ user: userId, revokedAt: null }, { $set: { revokedAt: new Date(), revokeReason: reason } });
  const { disconnectUserSockets } = await import('../realtime.js');
  await disconnectUserSockets(String(userId));
}

/** Signs the user out everywhere except this session (e.g. after they change their password). */
export async function revokeOtherSessions(userId: unknown, keepSessionId: string, reason: string) {
  await Session.updateMany({ user: userId, revokedAt: null, _id: { $ne: keepSessionId } }, { $set: { revokedAt: new Date(), revokeReason: reason } });
  const { disconnectUserSockets } = await import('../realtime.js');
  await disconnectUserSockets(String(userId), keepSessionId);
}
