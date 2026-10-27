import mongoose from 'mongoose';
import { withTransaction, type TxContext } from '../db.js';
import type { BookingStatus } from '../domain.js';
import { CabAssignment, CabRequest, RideStartCredential, type CabRequestDoc } from '../models/booking.js';
import { Driver } from '../models/Driver.js';
import { Employee } from '../models/Employee.js';
import { Notification } from '../models/system.js';
import { hashPin, safeEqualHex } from '../utils/crypto.js';
import { AppError, badRequest, forbidden, notFound } from '../utils/errors.js';
import { audit, type Actor } from './audit.service.js';
import { refreshDriverAvailability } from './availability.service.js';
import { cancelBookingInternal, endActiveAssignment } from './booking.service.js';
import { z } from 'zod';
import { alertOperations } from './alert.service.js';
import { bookingEmailParams, notifyCoordinators, recordEvent, transitionBooking } from './lifecycle.js';
import { enqueueEmail, notifyInApp } from './notification.service.js';
import { assertBookingInScope } from './scope.service.js';
import { formatInZone } from '../utils/time.js';

async function currentDriver(actor: Actor) {
  if (actor.role !== 'DRIVER') throw forbidden();
  const driver = await Driver.findOne({ user: actor.id });
  if (!driver) throw forbidden('No driver profile is linked to this account');
  return driver;
}

/** Loads an assignment only if it belongs to the calling driver (resource-level check). */
async function myAssignment(actor: Actor, assignmentId: string) {
  const driver = await currentDriver(actor);
  if (!mongoose.isValidObjectId(assignmentId)) throw notFound('Ride');
  const assignment = await CabAssignment.findOne({ _id: assignmentId, driver: driver._id });
  if (!assignment) throw notFound('Ride');
  const booking = await CabRequest.findById(assignment.booking);
  if (!booking) throw notFound('Ride');
  return { driver, assignment, booking };
}

function requireActive(assignment: { status: string }) {
  if (assignment.status !== 'ACTIVE') {
    throw new AppError(409, 'ASSIGNMENT_NOT_ACTIVE', `This ride is no longer assigned to you (${assignment.status.toLowerCase()})`);
  }
}

// ---------------------------------------------------------------------------
// Driver dashboard data
// ---------------------------------------------------------------------------
// Drivers see the passenger's name only, never their phone number.
function rideView(a: Record<string, unknown>, b: Record<string, unknown> | null, employee?: { fullName?: string | null } | null) {
  return {
    assignmentId: a._id,
    assignmentStatus: a.status,
    acknowledgedAt: a.acknowledgedAt,
    enRouteAt: a.enRouteAt,
    arrivedAt: a.arrivedAt,
    startedAt: a.startedAt,
    completedAt: a.completedAt,
    endReason: a.endReason,
    scheduledPickupAt: a.scheduledPickupAt,
    vehicle: a.vehicle,
    booking: b
      ? {
          _id: b._id, reference: b.reference, status: b.status, travelDate: b.travelDate, pickupTime: b.pickupTime, timezone: b.timezone,
          pickupLocation: b.pickupLocation, dropLocation: b.dropLocation, passengers: b.passengers, notes: b.notes, isDelayed: b.isDelayed,
        }
      : null,
    employee: employee ? { name: employee.fullName } : null,
  };
}

export async function driverHome(actor: Actor) {
  const driver = await currentDriver(actor);
  const full = await Driver.findById(driver._id).populate('currentVehicle', 'registrationNumber model capacity status').lean();
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 3600_000);
  const assignments = await CabAssignment.find({
    driver: driver._id,
    $or: [{ status: 'ACTIVE' }, { updatedAt: { $gt: new Date(now.getTime() - 7 * 24 * 3600_000) } }],
  })
    .sort({ scheduledPickupAt: 1 })
    .populate('vehicle', 'registrationNumber model')
    .populate('booking')
    .lean();
  const empIds = assignments.map((a) => (a.booking as unknown as { employee: unknown })?.employee).filter(Boolean);
  const employees = new Map((await Employee.find({ _id: { $in: empIds } }, { fullName: 1 }).lean()).map((e) => [String(e._id), e]));
  const views = assignments.map((a) => {
    const b = a.booking as unknown as Record<string, unknown>;
    return rideView(a as unknown as Record<string, unknown>, b, employees.get(String(b?.employee)));
  });
  const endOfToday = new Date(now.getTime() + 18 * 3600_000);
  const active = views.find((v) => v.assignmentStatus === 'ACTIVE' && ['DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'].includes(String(v.booking?.status)));
  const upcomingAll = views.filter((v) => v.assignmentStatus === 'ACTIVE' && v.booking?.status === 'ASSIGNED');
  const unread = await Notification.countDocuments({ user: actor.id, readAt: null });
  return {
    driver: full,
    activeTrip: active ?? null,
    today: upcomingAll.filter((v) => new Date(v.scheduledPickupAt as Date) <= endOfToday),
    upcoming: upcomingAll.filter((v) => new Date(v.scheduledPickupAt as Date) > endOfToday),
    completed: views.filter((v) => v.assignmentStatus === 'COMPLETED' && new Date(v.completedAt as Date) > dayAgo).reverse(),
    cancelledOrReassigned: views.filter((v) => ['CANCELLED', 'REASSIGNED', 'DECLINED', 'NO_SHOW'].includes(String(v.assignmentStatus))).reverse().slice(0, 10),
    unreadNotifications: unread,
  };
}

export async function driverRideHistory(actor: Actor, page = 1, pageSize = 20) {
  const driver = await currentDriver(actor);
  const filter = { driver: driver._id, status: { $ne: 'ACTIVE' } };
  const [items, total] = await Promise.all([
    CabAssignment.find(filter).sort({ scheduledPickupAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).populate('vehicle', 'registrationNumber').populate('booking', 'reference status travelDate pickupTime pickupLocation dropLocation passengers timezone').lean(),
    CabAssignment.countDocuments(filter),
  ]);
  return { items: items.map((a) => rideView(a as unknown as Record<string, unknown>, a.booking as unknown as Record<string, unknown>)), total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function driverRide(actor: Actor, assignmentId: string) {
  const { assignment, booking } = await myAssignment(actor, assignmentId);
  const [vehicle, employee, cred] = await Promise.all([
    mongoose.model('Vehicle').findById(assignment.vehicle).select('registrationNumber model capacity').lean(),
    Employee.findById(booking.employee, { fullName: 1 }).lean(),
    RideStartCredential.findOne({ assignment: assignment._id }).sort({ createdAt: -1 }).select('status attempts maxAttempts expiresAt').lean(),
  ]);
  return {
    ...rideView({ ...assignment.toObject(), vehicle } as unknown as Record<string, unknown>, booking.toObject() as unknown as Record<string, unknown>, employee),
    // PIN state only (never the PIN): lets the driver know remaining attempts.
    pin: cred ? { status: cred.status, attemptsRemaining: Math.max(0, cred.maxAttempts - cred.attempts), expiresAt: cred.expiresAt } : null,
    driverNotes: assignment.driverNotes,
  };
}

export async function setDuty(actor: Actor, onDuty: boolean) {
  const driver = await currentDriver(actor);
  if (!onDuty && driver.availability === 'ON_TRIP') throw new AppError(409, 'ON_TRIP', 'You cannot go offline during an active trip');
  if (onDuty && driver.employmentStatus !== 'ACTIVE') throw forbidden('Your driver profile is not active');
  await Driver.updateOne({ _id: driver._id }, { $set: { onDuty, lastSeenAt: new Date() } });
  const availability = await refreshDriverAvailability(driver._id);
  await audit(actor, 'DRIVER_DUTY_CHANGED', 'Driver', driver._id, `Driver ${driver.driverCode} went ${onDuty ? 'on' : 'off'} duty`);
  return { onDuty, availability };
}

// ---------------------------------------------------------------------------
// Lifecycle actions (driver)
// ---------------------------------------------------------------------------
export async function acknowledge(actor: Actor, assignmentId: string) {
  const { assignment, booking } = await myAssignment(actor, assignmentId);
  requireActive(assignment);
  if (assignment.acknowledgedAt) return { acknowledgedAt: assignment.acknowledgedAt, alreadyAcknowledged: true };
  return withTransaction(async (tx) => {
    const res = await CabAssignment.findOneAndUpdate({ _id: assignment._id, status: 'ACTIVE', acknowledgedAt: null }, { $set: { acknowledgedAt: new Date() } }, { new: true, session: tx.session });
    if (!res) throw new AppError(409, 'ASSIGNMENT_NOT_ACTIVE', 'This ride is no longer assigned to you');
    await recordEvent(tx, booking, 'ACKNOWLEDGED', actor, { assignmentId: assignment._id });
    tx.afterCommit(async () => {
      const { emitToOperations } = await import('../realtime.js');
      emitToOperations(booking.officeLocation, 'booking:updated', { bookingId: String(booking._id), reference: booking.reference, status: booking.status });
    });
    await audit(actor, 'RIDE_ACKNOWLEDGED', 'CabAssignment', assignment._id, `Driver acknowledged ${booking.reference}`, undefined, tx.session);
    return { acknowledgedAt: res.acknowledgedAt, alreadyAcknowledged: false };
  });
}

/** Driver declines: the ride goes back to the coordinator's queue; it is never silently dropped. */
export async function decline(actor: Actor, assignmentId: string, reason: string) {
  if (!reason?.trim() || reason.trim().length < 3) throw badRequest('Please give a reason for declining');
  const { driver, assignment, booking } = await myAssignment(actor, assignmentId);
  requireActive(assignment);
  if (booking.status !== 'ASSIGNED') throw new AppError(409, 'INVALID_TRANSITION', 'You can only decline before starting the trip. Contact the coordinator.');
  return withTransaction(async (tx) => {
    const back: BookingStatus = booking.approvalRequired ? 'APPROVED' : 'REQUESTED';
    const ended = await CabAssignment.findOneAndUpdate(
      { _id: assignment._id, status: 'ACTIVE' },
      { $set: { status: 'DECLINED', declinedAt: new Date(), declineReason: reason, endedAt: new Date(), endedBy: actor.id, endReason: reason } },
      { new: true, session: tx.session },
    );
    if (!ended) throw new AppError(409, 'ASSIGNMENT_NOT_ACTIVE', 'This ride is no longer assigned to you');
    await RideStartCredential.updateMany({ assignment: assignment._id, status: 'ACTIVE' }, { $set: { status: 'REVOKED', revokedAt: new Date(), revokeReason: 'DECLINED' } }, { session: tx.session });
    await transitionBooking(tx, booking._id, ['ASSIGNED'], back, { actor, event: 'DRIVER_DECLINED', reason, assignmentId: assignment._id, unset: ['currentAssignment'] });
    await refreshDriverAvailability(driver._id, tx.session);
    await notifyCoordinators(tx, booking.officeLocation, {
      type: 'DRIVER_DECLINED',
      title: 'Driver declined a ride — reassignment needed',
      body: `${booking.reference}: ${driver.fullName} — ${reason}`,
      data: { bookingId: String(booking._id) },
      idempotencyKey: `declined:${assignment._id}`,
    });
    await notifyInApp(tx, {
      userId: String(booking.employeeUser),
      type: 'ASSIGNMENT_PENDING_CHANGE',
      title: 'Your cab is being reassigned',
      body: `The driver for ${booking.reference} is unavailable. The transport team is assigning another cab.`,
      data: { bookingId: String(booking._id) },
      idempotencyKey: `declined-employee:${assignment._id}`,
    });
    await audit(actor, 'RIDE_DECLINED', 'CabAssignment', assignment._id, `Driver declined ${booking.reference}`, { reason }, tx.session);
    return { status: back };
  });
}

export async function markEnRoute(actor: Actor, assignmentId: string) {
  const { assignment, booking } = await myAssignment(actor, assignmentId);
  requireActive(assignment);
  return withTransaction(async (tx) => {
    const now = new Date();
    await CabAssignment.updateOne({ _id: assignment._id, status: 'ACTIVE' }, { $set: { enRouteAt: now, acknowledgedAt: assignment.acknowledgedAt ?? now } }, { session: tx.session });
    const updated = await transitionBooking(tx, booking._id, ['ASSIGNED'], 'DRIVER_EN_ROUTE', { actor, event: 'DRIVER_EN_ROUTE', assignmentId: assignment._id });
    await notifyInApp(tx, { userId: String(booking.employeeUser), type: 'DRIVER_EN_ROUTE', title: 'Your driver is on the way', body: `${booking.reference}: driver is heading to ${booking.pickupLocation}`, data: { bookingId: String(booking._id) }, idempotencyKey: `enroute:${assignment._id}` });
    await audit(actor, 'RIDE_EN_ROUTE', 'CabAssignment', assignment._id, `Driver en route for ${booking.reference}`, undefined, tx.session);
    return updated;
  });
}

export async function markArrived(actor: Actor, assignmentId: string) {
  const { driver, assignment, booking } = await myAssignment(actor, assignmentId);
  requireActive(assignment);
  return withTransaction(async (tx) => {
    await CabAssignment.updateOne({ _id: assignment._id, status: 'ACTIVE' }, { $set: { arrivedAt: new Date() } }, { session: tx.session });
    const updated = await transitionBooking(tx, booking._id, ['DRIVER_EN_ROUTE'], 'ARRIVED', { actor, event: 'ARRIVED', assignmentId: assignment._id });
    const employee = await Employee.findById(booking.employee).session(tx.session).lean();
    const vehicle = await mongoose.model('Vehicle').findById(assignment.vehicle).session(tx.session).lean<{ registrationNumber: string }>();
    await notifyInApp(tx, { userId: String(booking.employeeUser), type: 'DRIVER_ARRIVED', title: 'Your cab has arrived', body: `${vehicle?.registrationNumber} is at ${booking.pickupLocation}. Share your PIN once you are in the cab.`, data: { bookingId: String(booking._id) }, idempotencyKey: `arrived:${assignment._id}` });
    if (employee) {
      await enqueueEmail(tx.session, {
        idempotencyKey: `arrived:${assignment._id}`,
        template: 'DRIVER_ARRIVED',
        to: employee.email,
        toUserId: String(booking.employeeUser),
        params: { ...bookingEmailParams(booking, employee.fullName), driverName: driver.fullName, vehicleNumber: vehicle?.registrationNumber },
        relatedBookingId: String(booking._id),
        preference: 'emailOnArrived',
      });
    }
    await audit(actor, 'RIDE_ARRIVED', 'CabAssignment', assignment._id, `Driver arrived for ${booking.reference}`, undefined, tx.session);
    return updated;
  });
}

/**
 * Ride-start PIN verification.
 *  - The PIN must belong to the ACTIVE credential of *this* assignment, owned by the
 *    calling driver (cross-assignment / cross-driver use is impossible by query).
 *  - Each attempt is reserved atomically before comparison, so parallel guesses
 *    cannot exceed maxAttempts; reaching the limit locks the credential.
 *  - The start itself is a single transaction with conditional updates, so two
 *    simultaneous correct submissions start the trip exactly once.
 */
export async function verifyPinAndStart(actor: Actor, assignmentId: string, pin: string) {
  if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) throw badRequest('Enter the numeric PIN provided by the employee');
  const { driver, assignment, booking } = await myAssignment(actor, assignmentId);
  requireActive(assignment);
  if (booking.status === 'IN_PROGRESS' || assignment.startedAt) throw new AppError(409, 'ALREADY_STARTED', 'This trip has already started');
  if (booking.status !== 'ARRIVED') throw new AppError(409, 'INVALID_TRANSITION', 'Mark yourself as arrived at the pickup location first');

  const now = new Date();
  const cred = await RideStartCredential.findOneAndUpdate(
    { assignment: assignment._id, status: 'ACTIVE', expiresAt: { $gt: now }, $expr: { $lt: ['$attempts', '$maxAttempts'] } },
    { $inc: { attempts: 1 }, $set: { lastAttemptAt: now } },
    { new: true },
  ).select('+pinHash +salt');

  if (!cred) {
    const latest = await RideStartCredential.findOne({ assignment: assignment._id }).sort({ createdAt: -1 }).lean();
    if (latest?.status === 'ACTIVE' && latest.expiresAt <= now) {
      await RideStartCredential.updateOne({ _id: latest._id, status: 'ACTIVE' }, { $set: { status: 'EXPIRED' } });
      throw new AppError(410, 'PIN_EXPIRED', 'This PIN has expired. Ask the coordinator to issue a new one.');
    }
    if (latest?.status === 'LOCKED' || (latest?.status === 'ACTIVE' && latest.attempts >= latest.maxAttempts)) {
      throw new AppError(423, 'PIN_LOCKED', 'Too many incorrect attempts. The PIN is locked; contact the coordinator.');
    }
    if (latest?.status === 'USED') throw new AppError(409, 'ALREADY_STARTED', 'This PIN has already been used');
    throw new AppError(409, 'PIN_INVALID_STATE', 'No valid PIN exists for this ride. Contact the coordinator.');
  }

  const ok = safeEqualHex(hashPin(pin, cred.salt), cred.pinHash);
  if (!ok) {
    const remaining = Math.max(0, cred.maxAttempts - cred.attempts);
    await recordEvent(null, booking, 'PIN_FAILED', actor, { assignmentId: assignment._id, meta: { attempt: cred.attempts, remaining } });
    if (remaining === 0) {
      const locked = await RideStartCredential.updateOne({ _id: cred._id, status: 'ACTIVE' }, { $set: { status: 'LOCKED' } });
      if (locked.modifiedCount) {
        await notifyCoordinators(null, booking.officeLocation, { type: 'PIN_LOCKED', title: 'Ride-start PIN locked', body: `${booking.reference}: too many incorrect PIN attempts`, data: { bookingId: String(booking._id) }, idempotencyKey: `pin-locked:${cred._id}` });
        await audit(actor, 'PIN_LOCKED', 'CabAssignment', assignment._id, `PIN locked for ${booking.reference}`);
      }
      throw new AppError(423, 'PIN_LOCKED', 'Too many incorrect attempts. The PIN is locked; contact the coordinator.');
    }
    throw new AppError(422, 'INVALID_PIN', `Incorrect PIN. ${remaining} attempt(s) remaining.`, { attemptsRemaining: remaining });
  }

  return withTransaction(async (tx) => {
    const used = await RideStartCredential.updateOne({ _id: cred._id, status: 'ACTIVE' }, { $set: { status: 'USED', usedAt: new Date() } }, { session: tx.session });
    if (!used.modifiedCount) throw new AppError(409, 'ALREADY_STARTED', 'This PIN has already been used');
    const started = await CabAssignment.findOneAndUpdate(
      { _id: assignment._id, status: 'ACTIVE', startedAt: null },
      { $set: { startedAt: new Date(), startMethod: 'PIN' } },
      { new: true, session: tx.session },
    );
    if (!started) throw new AppError(409, 'ALREADY_STARTED', 'This trip has already started');
    const updated = await transitionBooking(tx, booking._id, ['ARRIVED'], 'IN_PROGRESS', { actor, event: 'TRIP_STARTED', assignmentId: assignment._id, meta: { method: 'PIN' } });
    await refreshDriverAvailability(driver._id, tx.session);
    await notifyTripStarted(tx, updated);
    await audit(actor, 'RIDE_STARTED', 'CabAssignment', assignment._id, `Trip ${booking.reference} started with verified PIN`, undefined, tx.session);
    return { status: updated.status, startedAt: started.startedAt };
  });
}

async function notifyTripStarted(tx: TxContext, booking: { _id: unknown; employee: unknown; employeeUser: unknown; reference: string; travelDate: string; pickupTime: string; pickupLocation: string; dropLocation: string; officeLocation: string }) {
  await notifyInApp(tx, { userId: String(booking.employeeUser), type: 'TRIP_STARTED', title: 'Trip started', body: `${booking.reference} is in progress`, data: { bookingId: String(booking._id) }, idempotencyKey: `started:${booking._id}` });
  const employee = await Employee.findById(booking.employee).session(tx.session).lean();
  if (employee) {
    await enqueueEmail(tx.session, {
      idempotencyKey: `trip-started:${booking._id}`,
      template: 'TRIP_STARTED',
      to: employee.email,
      toUserId: String(booking.employeeUser),
      params: bookingEmailParams(booking, employee.fullName),
      relatedBookingId: String(booking._id),
      preference: 'emailOnTripStarted',
    });
  }
}

type TripRefs = { driverId: unknown; assignment: { _id: { toString(): string } }; booking: CabRequestDoc };
type Override = { by: Actor; reason: string };

/**
 * Shared completion: IN_PROGRESS -> COMPLETED with conditional updates so a trip is
 * completed exactly once. `override` records a coordinator/admin completing on the
 * driver's behalf (e.g. the driver's phone died); it is audited.
 */
async function finishTrip(actor: Actor, refs: TripRefs, opts: { notes?: string; override?: Override } = {}) {
  const { driverId, assignment, booking } = refs;
  return withTransaction(async (tx) => {
    const completedAt = new Date();
    const done = await CabAssignment.findOneAndUpdate(
      { _id: assignment._id, status: 'ACTIVE', startedAt: { $ne: null }, completedAt: null },
      {
        $set: {
          status: 'COMPLETED',
          completedAt,
          completionMethod: opts.override ? 'OVERRIDE' : 'DRIVER',
          ...(opts.notes ? { driverNotes: opts.notes.slice(0, 1000) } : {}),
          ...(opts.override ? { completionOverrideBy: opts.override.by.id, completionOverrideReason: opts.override.reason } : {}),
        },
      },
      { new: true, session: tx.session },
    );
    if (!done) throw new AppError(409, 'INVALID_TRANSITION', 'Only a trip in progress can be completed');
    const updated = await transitionBooking(tx, booking._id, ['IN_PROGRESS'], 'COMPLETED', {
      actor,
      event: opts.override ? 'COMPLETED_OVERRIDE' : 'COMPLETED',
      reason: opts.override?.reason,
      assignmentId: assignment._id,
      set: { completedAt, isDelayed: false },
      unset: ['openSlotKey'],
    });
    await refreshDriverAvailability(driverId as string, tx.session);
    const employee = await Employee.findById(booking.employee).session(tx.session).lean();
    await notifyInApp(tx, { userId: String(booking.employeeUser), type: 'TRIP_COMPLETED', title: 'Trip completed', body: `${booking.reference} was completed`, data: { bookingId: String(booking._id) }, idempotencyKey: `completed:${booking._id}` });
    if (employee) {
      await enqueueEmail(tx.session, {
        idempotencyKey: `trip-completed:${booking._id}`,
        template: 'TRIP_COMPLETED',
        to: employee.email,
        toUserId: String(booking.employeeUser),
        params: { ...bookingEmailParams(booking, employee.fullName), completedAt: formatInZone(completedAt, booking.timezone, 'dd LLL yyyy, HH:mm') },
        relatedBookingId: String(booking._id),
        preference: 'emailOnCompleted',
      });
    }
    if (opts.override) {
      const driver = await Driver.findById(driverId).session(tx.session).lean();
      if (driver?.user) {
        await notifyInApp(tx, { userId: String(driver.user), type: 'TRIP_COMPLETED', title: 'Trip completed by coordinator', body: `${booking.reference} was marked completed by the transport team`, data: { assignmentId: String(assignment._id) } });
      }
      await audit(actor, 'SUPPORT_OVERRIDE_COMPLETE', 'CabAssignment', assignment._id, `Trip ${booking.reference} completed on the driver's behalf by support override`, { reason: opts.override.reason }, tx.session);
    } else {
      await audit(actor, 'RIDE_COMPLETED', 'CabAssignment', assignment._id, `Trip ${booking.reference} completed`, undefined, tx.session);
    }
    return { status: updated.status, completedAt };
  });
}

/** Shared no-show: ARRIVED -> NO_SHOW, ends the assignment and revokes the PIN. */
async function recordNoShow(actor: Actor, refs: TripRefs, reason: string, byOperations = false) {
  const { driverId, assignment, booking } = refs;
  return withTransaction(async (tx) => {
    const updated = await transitionBooking(tx, booking._id, ['ARRIVED'], 'NO_SHOW', { actor, event: 'NO_SHOW', reason, assignmentId: assignment._id, unset: ['openSlotKey'] });
    await endActiveAssignment(tx, updated, 'NO_SHOW', actor, reason);
    await refreshDriverAvailability(driverId as string, tx.session);
    await alertOperations({ type: 'NO_SHOW', message: `Employee no-show for ${booking.reference}: ${reason}${byOperations ? ' (recorded by transport team)' : ''}`, officeLocation: booking.officeLocation, bookingId: String(booking._id), dedupeKey: `NO_SHOW:${assignment._id}` }, tx);
    await notifyInApp(tx, { userId: String(booking.employeeUser), type: 'NO_SHOW', title: 'Ride marked as no-show', body: `${booking.reference}: the driver could not find you at the pickup point.`, data: { bookingId: String(booking._id) } });
    await audit(actor, 'RIDE_NO_SHOW', 'CabAssignment', assignment._id, `No-show recorded for ${booking.reference}${byOperations ? ' by transport team' : ''}`, { reason }, tx.session);
    return { status: updated.status };
  });
}

export async function completeTrip(actor: Actor, assignmentId: string, notes?: string) {
  const { driver, assignment, booking } = await myAssignment(actor, assignmentId);
  if (assignment.status === 'COMPLETED') throw new AppError(409, 'ALREADY_COMPLETED', 'This trip is already completed');
  requireActive(assignment);
  return finishTrip(actor, { driverId: driver._id, assignment, booking }, { notes });
}

export async function markNoShow(actor: Actor, assignmentId: string, reason: string) {
  if (!reason?.trim()) throw badRequest('A reason is required');
  const { driver, assignment, booking } = await myAssignment(actor, assignmentId);
  requireActive(assignment);
  return recordNoShow(actor, { driverId: driver._id, assignment, booking }, reason);
}

/**
 * A driver may cancel only because of the employee: they didn't show up at the pickup (recorded
 * as a no-show), said they're not coming, or another reason they explain. Drivers can't drop a
 * ride for their own reasons; that goes through the coordinator.
 */
export const DRIVER_CANCEL_REASONS = { NO_SHOW: "Employee didn't show up", NOT_COMING: "Employee said they're not coming", OTHER: 'Other' } as const;
export const driverCancelSchema = z
  .object({ reason: z.enum(['NO_SHOW', 'NOT_COMING', 'OTHER']), note: z.string().trim().max(300).optional() })
  .refine((v) => v.reason !== 'OTHER' || (v.note?.length ?? 0) >= 3, { message: 'Say why the ride is cancelled', path: ['note'] });

export async function driverCancel(actor: Actor, assignmentId: string, input: z.infer<typeof driverCancelSchema>) {
  const { driver, assignment, booking } = await myAssignment(actor, assignmentId);
  requireActive(assignment);
  const text = input.reason === 'OTHER' ? input.note! : `${DRIVER_CANCEL_REASONS[input.reason]}${input.note ? ` — ${input.note}` : ''}`;
  if (input.reason === 'NO_SHOW') {
    if (booking.status !== 'ARRIVED') throw new AppError(409, 'INVALID_TRANSITION', 'Tap "Arrived" at the pickup first — a no-show is recorded there');
    return recordNoShow(actor, { driverId: driver._id, assignment, booking }, text);
  }
  if (!['ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED'].includes(booking.status)) throw new AppError(409, 'INVALID_TRANSITION', `This ride is ${booking.status.toLowerCase()} and can't be cancelled`);
  const updated = await cancelBookingInternal(actor, booking._id, `Cancelled by driver: ${text}`, ['ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED']);
  await refreshDriverAvailability(driver._id);
  return updated;
}

/** Coordinator/admin view of the booking's live assignment (scope-checked). */
async function operationsAssignment(actor: Actor, bookingId: string) {
  const booking = await CabRequest.findById(bookingId);
  if (!booking) throw notFound('Booking');
  await assertBookingInScope(actor, booking);
  const assignment = booking.currentAssignment ? await CabAssignment.findOne({ _id: booking.currentAssignment, status: 'ACTIVE' }) : null;
  if (!assignment) throw new AppError(409, 'ASSIGNMENT_NOT_ACTIVE', 'This booking has no active assignment');
  return { booking, assignment };
}

/** Support action: record a no-show reported to the transport team (e.g. by phone). */
export async function noShowByOperations(actor: Actor, bookingId: string, reason: string) {
  if (!reason || reason.trim().length < 3) throw badRequest('A reason is required');
  const { booking, assignment } = await operationsAssignment(actor, bookingId);
  if (booking.status !== 'ARRIVED') throw new AppError(409, 'INVALID_TRANSITION', 'A no-show can only be recorded after the driver has arrived');
  return recordNoShow(actor, { driverId: assignment.driver, assignment, booking }, reason.trim(), true);
}

export async function addDriverNote(actor: Actor, assignmentId: string, note: string) {
  const { assignment } = await myAssignment(actor, assignmentId);
  await CabAssignment.updateOne({ _id: assignment._id }, { $set: { driverNotes: note.slice(0, 1000) } });
}

// ---------------------------------------------------------------------------
// Support override (coordinator/admin), fully audited
// ---------------------------------------------------------------------------
export async function overrideStart(actor: Actor, bookingId: string, reason: string) {
  if (!reason || reason.trim().length < 10) throw badRequest('Describe why the PIN could not be used (at least 10 characters)');
  const booking = await CabRequest.findById(bookingId);
  if (!booking) throw notFound('Booking');
  await assertBookingInScope(actor, booking);
  if (booking.status !== 'ARRIVED') throw new AppError(409, 'INVALID_TRANSITION', 'An override start is only possible after the driver has arrived');
  return withTransaction(async (tx) => {
    const started = await CabAssignment.findOneAndUpdate(
      { _id: booking.currentAssignment, status: 'ACTIVE', startedAt: null },
      { $set: { startedAt: new Date(), startMethod: 'OVERRIDE', overrideBy: actor.id, overrideReason: reason } },
      { new: true, session: tx.session },
    );
    if (!started) throw new AppError(409, 'ALREADY_STARTED', 'This trip has already started');
    await RideStartCredential.updateMany({ assignment: started._id, status: { $in: ['ACTIVE', 'LOCKED', 'EXPIRED'] } }, { $set: { status: 'REVOKED', revokedAt: new Date(), revokeReason: 'OVERRIDE' } }, { session: tx.session });
    const updated = await transitionBooking(tx, booking._id, ['ARRIVED'], 'IN_PROGRESS', { actor, event: 'TRIP_STARTED_OVERRIDE', reason, assignmentId: started._id, meta: { method: 'OVERRIDE' } });
    await refreshDriverAvailability(started.driver, tx.session);
    const driver = await Driver.findById(started.driver).session(tx.session).lean();
    if (driver?.user) await notifyInApp(tx, { userId: String(driver.user), type: 'TRIP_STARTED', title: 'Trip started by coordinator', body: `${booking.reference} was started by support override`, data: { assignmentId: String(started._id) } });
    await notifyTripStarted(tx, updated);
    await audit(actor, 'SUPPORT_OVERRIDE_START', 'CabAssignment', started._id, `Trip ${booking.reference} started WITHOUT PIN by support override`, { reason }, tx.session);
    return { status: updated.status };
  });
}
