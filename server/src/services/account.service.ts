import { withTransaction, type TxContext } from '../db.js';
import { canTransitionAccount, OPEN_STATUSES, type AccountStatus } from '../domain.js';
import { CabAssignment, CabRequest } from '../models/booking.js';
import { Driver } from '../models/Driver.js';
import { Employee } from '../models/Employee.js';
import { AuthToken } from '../models/system.js';
import { User } from '../models/User.js';
import { AppError, badRequest, notFound } from '../utils/errors.js';
import { audit, type Actor } from './audit.service.js';
import { adminsUseMicrosoft, employeesUseMicrosoftOnly, issueActivation } from './auth.service.js';
import { refreshDriverAvailability } from './availability.service.js';
import { alertOperations } from './alert.service.js';
import { revokeAllSessions } from './session.service.js';

/**
 * The only path through which an account status changes (other than activation).
 * Enforces the backend state machine and the operational side effects.
 */
export async function setAccountStatus(actor: Actor, userId: string, to: AccountStatus, reason?: string) {
  if (actor.id === userId && to !== 'ACTIVE') throw badRequest('You cannot deactivate or suspend your own account');
  const result = await withTransaction(async (tx) => {
    const { session } = tx;
    const user = await User.findById(userId).select('+passwordHash').session(session);
    if (!user) throw notFound('User');
    const from = user.status as AccountStatus;
    if (from === to) return { user, from, changed: false };
    if (!canTransitionAccount(from, to)) {
      throw new AppError(409, 'INVALID_TRANSITION', `Cannot change account status from ${from} to ${to}`);
    }
    if (from === 'INVITED' && to === 'ACTIVE') {
      throw new AppError(409, 'INVALID_TRANSITION', 'Invited accounts become active only when the user completes activation');
    }
    if (to === 'ACTIVE' && from === 'INACTIVE' && user.role !== 'DRIVER' && !user.passwordHash && !user.entraOid) {
      throw new AppError(409, 'INVALID_TRANSITION', 'This account was never activated. Re-send an invitation instead.');
    }
    if ((to === 'INACTIVE' || to === 'SUSPENDED') && !reason?.trim()) throw badRequest('A reason is required');
    if (user.role === 'ADMIN' && from === 'ACTIVE' && to !== 'ACTIVE') {
      const otherActive = await User.countDocuments({ role: 'ADMIN', status: 'ACTIVE', _id: { $ne: user._id } }).session(session);
      if (!otherActive) throw new AppError(409, 'LAST_ADMIN', 'This is the only active admin. Add or reactivate another admin first.');
    }
    if (actor.role !== 'ADMIN' && user.role === 'ADMIN') throw new AppError(403, 'FORBIDDEN', 'Only admins can change admin accounts');

    const updated = await User.findOneAndUpdate(
      { _id: user._id, status: from },
      { $set: { status: to, statusReason: reason, statusChangedAt: new Date() } },
      { new: true, session },
    );
    if (!updated) throw new AppError(409, 'CONCURRENT_UPDATE', 'Account was modified concurrently, please retry');

    const signsInWithMicrosoft = (updated.role === 'EMPLOYEE' && employeesUseMicrosoftOnly()) || (updated.role === 'ADMIN' && adminsUseMicrosoft());
    if (to === 'INVITED' && updated.role !== 'DRIVER' && !signsInWithMicrosoft) {
      await issueActivation(updated, actor, session);
    }
    if (to === 'INACTIVE' || to === 'SUSPENDED') {
      await AuthToken.updateMany({ user: user._id, usedAt: null, revokedAt: null }, { $set: { revokedAt: new Date() } }, { session });
      await handleDeactivationSideEffects(tx, updated, to, reason ?? '');
    }
    if (user.role === 'DRIVER') {
      const driver = await Driver.findOne({ user: user._id }).session(session);
      if (driver) await refreshDriverAvailability(driver._id, session);
    }
    await audit(actor, 'ACCOUNT_STATUS_CHANGED', 'User', user._id, `${user.email}: ${from} → ${to}`, { from, to, reason }, session);
    return { user: updated, from, changed: true };
  });
  if (result.changed && (to === 'INACTIVE' || to === 'SUSPENDED')) {
    await revokeAllSessions(userId, `ACCOUNT_${to}`);
  }
  return result.user;
}

/**
 * Deactivating someone with live or upcoming rides must not silently delete or
 * interrupt them: bookings are flagged and the transport team is alerted for
 * an authorised human decision.
 */
async function handleDeactivationSideEffects(tx: TxContext, user: { _id: unknown; role: string; email: string }, to: string, reason: string) {
  const { session } = tx;
  if (user.role === 'EMPLOYEE') {
    const employee = await Employee.findOne({ user: user._id }).session(session);
    const open = await CabRequest.find({ employeeUser: user._id, status: { $in: OPEN_STATUSES } }).session(session);
    if (open.length && employee) {
      await CabRequest.updateMany(
        { _id: { $in: open.map((b) => b._id) } },
        { $set: { flaggedForReview: true, flagReason: `Employee account ${to.toLowerCase()}: ${reason}` } },
        { session },
      );
      for (const b of open) {
        await alertOperations(
          {
            type: 'EMPLOYEE_DEACTIVATED_WITH_BOOKINGS',
            message: `${employee.fullName} (${employee.employeeId}) was set to ${to} while booking ${b.reference} is ${b.status}. Decide whether to keep or cancel it.`,
            officeLocation: b.officeLocation,
            bookingId: String(b._id),
            dedupeKey: `EMP_DEACT:${b._id}:${Date.now()}`,
          },
          tx,
        );
      }
    }
  }
  if (user.role === 'DRIVER') {
    const driver = await Driver.findOne({ user: user._id }).session(session);
    if (!driver) return;
    const active = await CabAssignment.find({ driver: driver._id, status: 'ACTIVE' }).session(session);
    for (const a of active) {
      await alertOperations(
        {
          type: 'DRIVER_UNAVAILABLE_WITH_ASSIGNMENTS',
          message: `Driver ${driver.fullName} was set to ${to} but still holds assignment for booking ${a.bookingReference}. Reassign it.`,
          officeLocation: a.officeLocation,
          bookingId: String(a.booking),
          dedupeKey: `DRIVER_DEACT:${a._id}:${Date.now()}`,
        },
        tx,
      );
    }
  }
}
