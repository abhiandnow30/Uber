import { DateTime } from 'luxon';
import { config } from '../config.js';
import { withTransaction } from '../db.js';
import { OPEN_STATUSES } from '../domain.js';
import { logger } from '../logger.js';
import { CabAssignment, CabRequest, RideStartCredential } from '../models/booking.js';
import { Driver } from '../models/Driver.js';
import { Employee } from '../models/Employee.js';
import { User } from '../models/User.js';
import { Vehicle } from '../models/Vehicle.js';
import { addMinutes } from '../utils/time.js';
import { SYSTEM_ACTOR } from './audit.service.js';
import { refreshDriverAvailability } from './availability.service.js';
import { processOutboxBatch } from './email/outbox.worker.js';
import { alertOperations } from './alert.service.js';
import { bookingEmailParams, broadcastBookingUpdate, notifyCoordinators, recordEvent } from './lifecycle.js';
import { enqueueEmail, notifyInApp } from './notification.service.js';
import { getPolicy } from './policy.service.js';

/** Human-friendly "x minutes ago" for operational messages. */
function lastOnline(at: Date | undefined | null, now: Date) {
  if (!at) return 'never';
  const mins = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const friendlyDate = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Late pickups: assigned rides whose driver has not arrived past the threshold. */
export async function detectLatePickups(now = new Date()) {
  const policy = await getPolicy();
  const threshold = policy.exceptions?.latePickupThresholdMinutes ?? 15;
  const late = await CabRequest.find({
    status: { $in: ['ASSIGNED', 'DRIVER_EN_ROUTE'] },
    isDelayed: { $ne: true },
    scheduledPickupAt: { $lt: addMinutes(now, -threshold) },
  }).limit(200);
  for (const b of late) {
    await withTransaction(async (tx) => {
      const updated = await CabRequest.findOneAndUpdate({ _id: b._id, isDelayed: { $ne: true } }, { $set: { isDelayed: true, delayReason: 'Driver has not arrived at the pickup location' } }, { new: true, session: tx.session });
      if (!updated) return;
      await recordEvent(tx, updated, 'LATE_PICKUP_DETECTED', SYSTEM_ACTOR, { assignmentId: updated.currentAssignment });
      await notifyCoordinators(tx, b.officeLocation, { type: 'LATE_PICKUP', title: 'Late pickup', body: `${b.reference}: driver has not arrived`, data: { bookingId: String(b._id) }, idempotencyKey: `late:${b._id}` });
      const emp = await Employee.findById(b.employee).session(tx.session).lean();
      await notifyInApp(tx, { userId: String(b.employeeUser), type: 'BOOKING_DELAYED', title: 'Your cab is running late', body: `${b.reference}: the transport team has been alerted.`, data: { bookingId: String(b._id) }, idempotencyKey: `late-emp:${b._id}` });
      if (emp) {
        await enqueueEmail(tx.session, { idempotencyKey: `late:${b._id}`, template: 'TRIP_DELAYED', to: emp.email, toUserId: String(b.employeeUser), params: bookingEmailParams(b, emp.fullName), relatedBookingId: String(b._id), preference: 'emailOnDelay' });
      }
      tx.afterCommit(() => broadcastBookingUpdate(updated));
    });
  }
  return late.length;
}

/** Assignments the driver has not acknowledged within the policy timeout. */
export async function detectUnacknowledged(now = new Date()) {
  const policy = await getPolicy();
  const timeout = policy.assignment?.acknowledgementTimeoutMinutes ?? 30;
  const stale = await CabAssignment.find({ status: 'ACTIVE', acknowledgedAt: null, unacknowledgedAlertedAt: null, createdAt: { $lt: addMinutes(now, -timeout) } })
    .populate('driver', 'fullName lastSeenAt')
    .limit(200);
  for (const a of stale) {
    const claimed = await CabAssignment.updateOne({ _id: a._id, unacknowledgedAlertedAt: null }, { $set: { unacknowledgedAlertedAt: now } });
    if (!claimed.modifiedCount) continue;
    const driver = a.driver as unknown as { fullName: string; lastSeenAt?: Date };
    await notifyCoordinators(null, a.officeLocation, { type: 'UNACKNOWLEDGED_ASSIGNMENT', title: 'Assignment not acknowledged', body: `${a.bookingReference}: ${driver.fullName} has not acknowledged`, data: { bookingId: String(a.booking) }, idempotencyKey: `unack:${a._id}` });
  }
  return stale.length;
}

export async function detectOverdueTrips(now = new Date()) {
  const policy = await getPolicy();
  const limit = policy.exceptions?.overdueTripMinutes ?? 180;
  const overdue = await CabAssignment.find({ status: 'ACTIVE', startedAt: { $lt: addMinutes(now, -limit) }, completedAt: null }).limit(200).lean();
  for (const a of overdue) {
    await notifyCoordinators(null, a.officeLocation, { type: 'OVERDUE_TRIP', title: 'Overdue trip', body: `${a.bookingReference} has not been completed`, data: { bookingId: String(a.booking) }, idempotencyKey: `overdue:${a._id}` });
  }
  return overdue.length;
}

export async function expirePins(now = new Date()) {
  const res = await RideStartCredential.updateMany({ status: 'ACTIVE', expiresAt: { $lte: now } }, { $set: { status: 'EXPIRED' } });
  return res.modifiedCount;
}

export async function checkDocumentExpiry(now = new Date()) {
  const soon = addMinutes(now, 14 * 24 * 60);
  const drivers = await Driver.find({ employmentStatus: 'ACTIVE', licenseExpiry: { $lt: soon } }).lean();
  for (const d of drivers) {
    const expired = d.licenseExpiry <= now;
    if (expired && d.verificationStatus === 'VERIFIED') {
      await Driver.updateOne({ _id: d._id }, { $set: { verificationStatus: 'EXPIRED' } });
    }
    await alertOperations({
      type: 'DOCUMENT_EXPIRY',
      message: `Driver ${d.fullName} (${d.driverCode}): driving licence ${expired ? 'expired' : 'expires'} on ${friendlyDate(d.licenseExpiry)}`,
      officeLocation: d.officeLocation,
      dedupeKey: `LICENSE:${d._id}:${d.licenseExpiry.toISOString().slice(0, 10)}:${expired ? 'expired' : 'soon'}`,
    });
  }
  // Vehicle insurance / permit: assignment is already blocked once expired; this
  // gives the transport team advance warning (14 days) and flags expired documents.
  const vehicles = await Vehicle.find({
    status: { $ne: 'INACTIVE' },
    $or: [{ insuranceExpiry: { $lt: soon } }, { permitExpiry: { $lt: soon } }],
  }).lean();
  for (const v of vehicles) {
    for (const [label, date] of [['insurance', v.insuranceExpiry], ['permit', v.permitExpiry]] as const) {
      if (!date || date >= soon) continue;
      const expired = date <= now;
      await alertOperations({
        type: 'DOCUMENT_EXPIRY',
        message: `Vehicle ${v.registrationNumber}: ${label} ${expired ? 'expired' : 'expires'} on ${friendlyDate(date)}${expired ? ' — it cannot be used for rides until renewed' : ''}`,
        officeLocation: v.officeLocation,
        dedupeKey: `VEHICLE_${label.toUpperCase()}:${v._id}:${date.toISOString().slice(0, 10)}:${expired ? 'expired' : 'soon'}`,
      });
    }
  }
  return drivers.length + vehicles.length;
}

export async function refreshAvailabilities() {
  const drivers = await Driver.find({ employmentStatus: 'ACTIVE' }, { _id: 1 }).lean();
  for (const d of drivers) await refreshDriverAvailability(d._id);
}

// Daily reminder window in each office's local time: sent from 6 PM, or later the same
// evening if the server was down at 6, but never in the middle of the night.
const REMINDER_FROM = '18:00';
const REMINDER_UNTIL = '22:00';
const reminderDone = new Map<string, string>(); // office -> local date already handled

/**
 * At 6 PM office time, emails every signed-in (ACTIVE) employee who has no open cab request
 * for tomorrow, reminding them to request one. One email per employee per day (idempotency key).
 */
export async function sendDailyBookingReminders(now: Date) {
  const policy = await getPolicy();
  if ((policy.notifications as Record<string, boolean> | undefined)?.dailyBookingReminder === false) return 0;
  let queued = 0;
  for (const office of policy.officeLocations.filter((o) => o.active)) {
    const local = DateTime.fromJSDate(now).setZone(office.timezone);
    const hhmm = local.toFormat('HH:mm');
    const today = local.toFormat('yyyy-MM-dd');
    if (hhmm < REMINDER_FROM || hhmm >= REMINDER_UNTIL || reminderDone.get(office.code) === today) continue;
    const tomorrow = local.plus({ days: 1 }).toFormat('yyyy-MM-dd');

    const signedIn = await User.find({ role: 'EMPLOYEE', status: 'ACTIVE' }, { _id: 1 }).lean();
    const employees = await Employee.find({ officeLocation: office.code, deletedAt: null, user: { $in: signedIn.map((u) => u._id) } }, { fullName: 1, email: 1, user: 1 }).lean();
    const booked = new Set(
      (await CabRequest.distinct('employee', { employee: { $in: employees.map((e) => e._id) }, status: { $in: OPEN_STATUSES }, $or: [{ shiftDate: tomorrow }, { travelDate: tomorrow }] })).map(String),
    );
    for (const e of employees) {
      if (booked.has(String(e._id))) continue;
      const id = await enqueueEmail(null, {
        idempotencyKey: `daily-booking-reminder:${e._id}:${today}`,
        template: 'DAILY_BOOKING_REMINDER',
        to: e.email,
        toUserId: String(e.user),
        params: { name: e.fullName, shiftDate: DateTime.fromISO(tomorrow).toFormat('ccc, d LLL yyyy'), cutoffTime: policy.booking?.dailyCutoffTime || '' },
        preference: 'dailyBookingReminder',
      });
      if (id) queued++;
    }
    reminderDone.set(office.code, today);
  }
  if (queued) logger.info({ queued }, 'Daily booking reminders queued');
  return queued;
}

export async function runMonitorsOnce() {
  const now = new Date();
  await expirePins(now);
  await detectLatePickups(now);
  await detectUnacknowledged(now);
  await detectOverdueTrips(now);
  await refreshAvailabilities();
  await sendDailyBookingReminders(now);
}

let timers: NodeJS.Timeout[] = [];
let running = { outbox: false, monitors: false, docs: false };

/** Background workers. Each loop guards against overlapping runs. */
export function startWorkers() {
  if (!config.WORKERS_ENABLED) {
    logger.info('Background workers disabled');
    return;
  }
  const loop = (key: keyof typeof running, ms: number, fn: () => Promise<unknown>) => {
    const tick = async () => {
      if (running[key]) return;
      running[key] = true;
      try {
        await fn();
      } catch (err) {
        logger.error({ err, worker: key }, 'Worker run failed');
      } finally {
        running[key] = false;
      }
    };
    timers.push(setInterval(tick, ms));
    void tick();
  };
  loop('outbox', 3_000, () => processOutboxBatch(25));
  loop('monitors', 60_000, runMonitorsOnce);
  loop('docs', 6 * 3600_000, () => checkDocumentExpiry());
  logger.info('Background workers started (outbox, monitors, document expiry)');
}

export function stopWorkers() {
  timers.forEach(clearInterval);
  timers = [];
  running = { outbox: false, monitors: false, docs: false };
}
