import { withTransaction } from '../db.js';
import { Driver } from '../models/Driver.js';
import { User } from '../models/User.js';
import { AppError } from '../utils/errors.js';
import { audit } from './audit.service.js';
import { createSession } from './session.service.js';

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

/** Mobile numbers are compared on their last 10 digits, so "+91 94444 44444" and "9444444444" match. */
export const phoneKey = (phone: string) => phone.replace(/\D/g, '').slice(-10);

/** Placeholder login address for drivers registered without an email; it can never receive mail. */
export const placeholderDriverEmail = (driverCode: string) => `driver.${driverCode.toLowerCase()}@phone-login.invalid`;
export const isPlaceholderEmail = (email?: string | null) => !!email && email.endsWith('@phone-login.invalid');

const noMatch = () =>
  new AppError(401, 'INVALID_CREDENTIALS', "Those details don't match our records. Check your mobile number and password (the first 4 digits of your mobile number), or contact your transport coordinator.");

/**
 * Driver sign-in: the mobile number the coordinator registered is the username, and its first
 * 4 digits (of the 10-digit number, without +91) are the password — the company's chosen
 * method. Note this is derivable from the number itself, so it only keeps out people who don't
 * know a driver's number. Repeated failures for a number lock it for a while; every outcome looks
 * the same to the caller.
 */
export async function driverPhoneLogin(phoneRaw: string, passwordRaw: string, meta: { ip?: string; userAgent?: string }) {
  const key = phoneKey(phoneRaw);
  const password = passwordRaw.replace(/\D/g, '');
  if (key.length !== 10 || password.length !== 4) throw noMatch();

  const candidates = await Driver.find({ phoneKey: key, employmentStatus: 'ACTIVE' });
  // A number shared by two active drivers is ambiguous: refuse rather than guess.
  if (candidates.length !== 1) throw noMatch();
  const driver = candidates[0];
  if (driver.phoneLoginLockedUntil && driver.phoneLoginLockedUntil > new Date()) {
    throw new AppError(429, 'ACCOUNT_LOCKED', `Too many incorrect attempts. Try again in ${LOCK_MINUTES} minutes or contact your transport coordinator.`);
  }

  if (password !== key.slice(0, 4)) {
    const failures = (driver.phoneLoginFailures ?? 0) + 1;
    const locked = failures >= MAX_FAILURES;
    await Driver.updateOne(
      { _id: driver._id },
      locked ? { $set: { phoneLoginFailures: 0, phoneLoginLockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) } } : { $set: { phoneLoginFailures: failures } },
    );
    if (locked) await audit({ id: String(driver.user ?? ''), role: 'DRIVER', ...meta }, 'LOGIN_LOCKOUT', 'Driver', driver._id, `Mobile sign-in for ${driver.driverCode} locked after repeated failures`);
    throw noMatch();
  }

  // Matched: find or create the driver's account. Microsoft-style first sign-in activates it.
  const user = await withTransaction(async ({ session }) => {
    let u = driver.user ? await User.findById(driver.user).session(session) : null;
    if (!u) {
      [u] = await User.create(
        [{ email: driver.email || placeholderDriverEmail(driver.driverCode), name: driver.fullName, phone: driver.phone, role: 'DRIVER', status: 'ACTIVE', activatedAt: new Date(), statusChangedAt: new Date() }],
        { session },
      );
      await Driver.updateOne({ _id: driver._id }, { $set: { user: u._id } }, { session });
      await audit({ id: String(u._id), role: 'DRIVER', email: u.email, ...meta }, 'ACCOUNT_ACTIVATED', 'User', u._id, `Driver ${driver.driverCode} activated by mobile sign-in`, undefined, session);
    } else if (u.status === 'INVITED') {
      u = await User.findOneAndUpdate({ _id: u._id, status: 'INVITED' }, { $set: { status: 'ACTIVE', activatedAt: new Date(), statusChangedAt: new Date() } }, { new: true, session });
      if (u) await audit({ id: String(u._id), role: 'DRIVER', email: u.email, ...meta }, 'ACCOUNT_ACTIVATED', 'User', u._id, `Driver ${driver.driverCode} activated by mobile sign-in`, undefined, session);
    }
    return u;
  });
  if (!user || user.status !== 'ACTIVE' || user.role !== 'DRIVER') throw noMatch();

  await Driver.updateOne({ _id: driver._id }, { $set: { phoneLoginFailures: 0 }, $unset: { phoneLoginLockedUntil: 1 } });
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
  const s = await createSession(user, { ...meta, method: 'PHONE' });
  await audit({ id: String(user._id), role: 'DRIVER', email: user.email, ...meta }, 'LOGIN', 'User', user._id, 'Signed in with mobile number');
  return { user, session: s };
}
