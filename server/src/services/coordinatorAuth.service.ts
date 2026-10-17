import { withTransaction } from '../db.js';
import { Coordinator } from '../models/Coordinator.js';
import { User } from '../models/User.js';
import { AppError } from '../utils/errors.js';
import { audit } from './audit.service.js';
import { normalizeEmail } from './auth.service.js';
import { phoneKey } from './driverAuth.service.js';
import { createSession } from './session.service.js';

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

const noMatch = () =>
  new AppError(401, 'INVALID_CREDENTIALS', "Those details don't match our records. Check your email and mobile number, or contact your administrator.");

/**
 * Coordinators (often from outside the company) sign in with the email and mobile number an
 * admin registered for them. Neither is secret, so repeated failures lock the account for a
 * while and every mismatch looks the same to the caller.
 */
export async function coordinatorPhoneLogin(emailRaw: string, phoneRaw: string, meta: { ip?: string; userAgent?: string }) {
  const email = normalizeEmail(emailRaw);
  const key = phoneKey(phoneRaw);
  if (!email || key.length !== 10) throw noMatch();

  const coord = await Coordinator.findOne({ email, deletedAt: null });
  if (!coord) throw noMatch();
  if (coord.phoneLoginLockedUntil && coord.phoneLoginLockedUntil > new Date()) {
    throw new AppError(429, 'ACCOUNT_LOCKED', `Too many incorrect attempts. Try again in ${LOCK_MINUTES} minutes or contact your administrator.`);
  }
  if (phoneKey(coord.phone ?? '') !== key) {
    const failures = (coord.phoneLoginFailures ?? 0) + 1;
    const locked = failures >= MAX_FAILURES;
    await Coordinator.updateOne(
      { _id: coord._id },
      locked ? { $set: { phoneLoginFailures: 0, phoneLoginLockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) } } : { $set: { phoneLoginFailures: failures } },
    );
    if (locked) await audit({ id: String(coord.user), role: 'COORDINATOR', email, ...meta }, 'LOGIN_LOCKOUT', 'Coordinator', coord._id, `Sign-in for coordinator ${email} locked after repeated failures`);
    throw noMatch();
  }

  // First successful sign-in activates the account (the admin already approved them by adding them).
  const user = await withTransaction(async ({ session }) => {
    let u = await User.findById(coord.user).session(session);
    if (u?.status === 'INVITED') {
      u = await User.findOneAndUpdate({ _id: u._id, status: 'INVITED' }, { $set: { status: 'ACTIVE', activatedAt: new Date(), statusChangedAt: new Date() } }, { new: true, session });
      if (u) await audit({ id: String(u._id), role: 'COORDINATOR', email, ...meta }, 'ACCOUNT_ACTIVATED', 'User', u._id, `Coordinator ${email} activated by first sign-in`, undefined, session);
    }
    return u;
  });
  if (!user || user.status !== 'ACTIVE' || user.role !== 'COORDINATOR') throw noMatch();

  await Coordinator.updateOne({ _id: coord._id }, { $set: { phoneLoginFailures: 0 }, $unset: { phoneLoginLockedUntil: 1 } });
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
  const s = await createSession(user, { ...meta, method: 'PHONE' });
  await audit({ id: String(user._id), role: 'COORDINATOR', email, ...meta }, 'LOGIN', 'User', user._id, 'Signed in with email and mobile number');
  return { user, session: s };
}
