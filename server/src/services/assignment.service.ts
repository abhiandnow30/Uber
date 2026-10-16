import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { z } from 'zod';
import { isDuplicateKeyError, withTransaction, type TxContext } from '../db.js';
import { ASSIGNABLE_STATUSES, type BookingStatus } from '../domain.js';
import { CabAssignment, CabRequest, RideStartCredential, type CabRequestDoc } from '../models/booking.js';
import { Driver, type DriverAttrs } from '../models/Driver.js';
import { Employee } from '../models/Employee.js';
import { User } from '../models/User.js';
import { Vehicle, type VehicleAttrs } from '../models/Vehicle.js';
import { encrypt, generatePin, hashPin } from '../utils/crypto.js';
import { AppError, notFound } from '../utils/errors.js';
import { addMinutes } from '../utils/time.js';
import { audit, type Actor } from './audit.service.js';
import { refreshDriverAvailability } from './availability.service.js';
import { endActiveAssignment } from './booking.service.js';
import { bookingEmailParams, transitionBooking } from './lifecycle.js';
import { enqueueEmail, notifyInApp } from './notification.service.js';
import { getPolicy } from './policy.service.js';
import { assertBookingInScope } from './scope.service.js';
import { emitToOperations } from '../realtime.js';

export const assignSchema = z.object({
  driverId: z.string().refine(mongoose.isValidObjectId, 'Invalid driver'),
  vehicleId: z.string().refine(mongoose.isValidObjectId, 'Invalid vehicle'),
  reason: z.string().trim().max(300).optional(),
});

type Window = { start: Date; end: Date };

async function windowFor(booking: { scheduledPickupAt: Date }): Promise<Window> {
  const policy = await getPolicy();
  const buffer = policy.assignment?.bufferMinutes ?? 15;
  const duration = policy.assignment?.defaultTripDurationMinutes ?? 90;
  return { start: addMinutes(booking.scheduledPickupAt, -buffer), end: addMinutes(booking.scheduledPickupAt, duration + buffer) };
}

type DriverLike = DriverAttrs & { _id: unknown };
type VehicleLike = VehicleAttrs & { _id: unknown };

/** Static eligibility rules (no schedule check). Returns human-readable problems. */
async function driverProblems(driver: DriverLike, booking: { officeLocation: string; scheduledPickupAt: Date }, w: Window, session?: mongoose.ClientSession) {
  const policy = await getPolicy();
  const p: string[] = [];
  if (driver.employmentStatus !== 'ACTIVE') p.push(`Driver is ${driver.employmentStatus.toLowerCase()}`);
  if (policy.assignment?.requireVerifiedDriver !== false && driver.verificationStatus !== 'VERIFIED') p.push('Driver documents are not verified');
  if (driver.licenseExpiry <= booking.scheduledPickupAt) p.push('Driver license expires before pickup');
  if (driver.officeLocation !== booking.officeLocation) p.push('Driver belongs to a different office');
  if (!driver.user) p.push('Driver has not signed in yet (mobile number + vehicle number)');
  else {
    const u = await User.findById(driver.user).session(session ?? null).lean();
    if (!u || u.status !== 'ACTIVE') p.push('Driver account is not active');
  }
  const blocked = (driver.unavailablePeriods ?? []).find((u) => u.from < w.end && u.to > w.start);
  if (blocked) p.push(`Driver flagged unavailable: ${blocked.reason}`);
  return p;
}

function vehicleProblems(vehicle: VehicleLike, booking: { officeLocation: string; scheduledPickupAt: Date; passengers: number }) {
  const p: string[] = [];
  if (vehicle.status !== 'ACTIVE') p.push(`Vehicle is ${vehicle.status.toLowerCase()}`);
  if (vehicle.capacity < booking.passengers) p.push(`Capacity ${vehicle.capacity} < ${booking.passengers} passengers`);
  if (vehicle.officeLocation !== booking.officeLocation) p.push('Vehicle belongs to a different office');
  if (vehicle.insuranceExpiry && vehicle.insuranceExpiry <= booking.scheduledPickupAt) p.push('Insurance expires before pickup');
  if (vehicle.permitExpiry && vehicle.permitExpiry <= booking.scheduledPickupAt) p.push('Permit expires before pickup');
  return p;
}

async function conflictsFor(field: 'driver' | 'vehicle', id: unknown, w: Window, excludeBooking: unknown, session?: mongoose.ClientSession) {
  return CabAssignment.find({
    [field]: id,
    status: 'ACTIVE',
    booking: { $ne: excludeBooking },
    windowStart: { $lt: w.end },
    windowEnd: { $gt: w.start },
  })
    .select('bookingReference scheduledPickupAt')
    .session(session ?? null)
    .lean();
}

/** Drivers and vehicles for the coordinator's picker, with eligibility explained. */
export async function eligibleResources(actor: Actor, bookingId: string) {
  const booking = await CabRequest.findById(bookingId).lean();
  if (!booking) throw notFound('Booking');
  await assertBookingInScope(actor, booking);
  const w = await windowFor(booking);
  const [drivers, vehicles] = await Promise.all([
    Driver.find({ officeLocation: booking.officeLocation, employmentStatus: { $ne: 'INACTIVE' } }).populate('currentVehicle', 'registrationNumber capacity status').lean(),
    Vehicle.find({ officeLocation: booking.officeLocation, status: { $ne: 'INACTIVE' } }).populate('currentDriver', 'fullName').lean(),
  ]);
  const driverRows = await Promise.all(
    drivers.map(async (d) => {
      const problems = await driverProblems(d as DriverLike, booking, w);
      const conflicts = await conflictsFor('driver', d._id, w, booking._id);
      if (conflicts.length) problems.push(`Already assigned: ${conflicts.map((c) => c.bookingReference).join(', ')}`);
      return {
        _id: d._id, fullName: d.fullName, driverCode: d.driverCode, phone: d.phone, availability: d.availability, onDuty: d.onDuty,
        verificationStatus: d.verificationStatus, currentVehicle: d.currentVehicle, eligible: problems.length === 0, problems,
      };
    }),
  );
  const vehicleRows = await Promise.all(
    vehicles.map(async (v) => {
      const problems = vehicleProblems(v as VehicleLike, booking);
      const conflicts = await conflictsFor('vehicle', v._id, w, booking._id);
      if (conflicts.length) problems.push(`Already assigned: ${conflicts.map((c) => c.bookingReference).join(', ')}`);
      return { _id: v._id, registrationNumber: v.registrationNumber, model: v.model, capacity: v.capacity, status: v.status, currentDriver: v.currentDriver, eligible: problems.length === 0, problems };
    }),
  );
  driverRows.sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.fullName.localeCompare(b.fullName));
  vehicleRows.sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.registrationNumber.localeCompare(b.registrationNumber));
  return { booking: { _id: booking._id, reference: booking.reference, passengers: booking.passengers, scheduledPickupAt: booking.scheduledPickupAt, status: booking.status }, window: w, drivers: driverRows, vehicles: vehicleRows };
}

/**
 * Core reservation step, run inside a transaction:
 *  1. bump driver.scheduleLock and vehicle.scheduleLock - any concurrent transaction
 *     reserving the same driver or vehicle now hits a WriteConflict and is retried;
 *     on retry it sees this assignment and fails the overlap check below
 *  2. re-validate eligibility and overlapping ACTIVE assignments in the snapshot
 *  3. create the assignment + ride-start credential
 */
async function reserve(tx: TxContext, actor: Actor, booking: CabRequestDoc, driverId: string, vehicleId: string, requestKey?: string) {
  const { session } = tx;
  const w = await windowFor(booking);
  const driver = await Driver.findOneAndUpdate({ _id: driverId }, { $inc: { scheduleLock: 1 } }, { new: true, session });
  const vehicle = await Vehicle.findOneAndUpdate({ _id: vehicleId }, { $inc: { scheduleLock: 1 } }, { new: true, session });
  if (!driver) throw notFound('Driver');
  if (!vehicle) throw notFound('Vehicle');

  const problems = [...(await driverProblems(driver.toObject() as DriverLike, booking, w, session)), ...vehicleProblems(vehicle.toObject() as VehicleLike, booking)];
  if (problems.length) throw new AppError(422, 'NOT_ELIGIBLE', `Cannot assign: ${problems.join('; ')}`, { problems });

  const [driverConflicts, vehicleConflicts] = await Promise.all([
    conflictsFor('driver', driver._id, w, booking._id, session),
    conflictsFor('vehicle', vehicle._id, w, booking._id, session),
  ]);
  if (driverConflicts.length || vehicleConflicts.length) {
    throw new AppError(409, 'SCHEDULE_CONFLICT', 'The driver or vehicle is already booked for an overlapping trip', {
      driverConflicts: driverConflicts.map((c) => c.bookingReference),
      vehicleConflicts: vehicleConflicts.map((c) => c.bookingReference),
    });
  }

  const [assignment] = await CabAssignment.create(
    [
      {
        booking: booking._id,
        bookingReference: booking.reference,
        employee: booking.employee,
        driver: driver._id,
        vehicle: vehicle._id,
        officeLocation: booking.officeLocation,
        assignedBy: actor.id,
        status: 'ACTIVE',
        windowStart: w.start,
        windowEnd: w.end,
        scheduledPickupAt: booking.scheduledPickupAt,
        requestKey,
      },
    ],
    { session },
  );
  await createPinCredential(tx, assignment._id, booking);
  await refreshDriverAvailability(driver._id, session);
  return { assignment, driver, vehicle };
}

/** Ride-start PINs are 4 digits (with the attempt limit, a guess succeeds 5 times in 10,000). */
const PIN_DIGITS = 4;

/** Generate a ride-start PIN: HMAC for verification + encrypted copy for the employee only. */
export async function createPinCredential(tx: TxContext, assignmentId: unknown, booking: { _id: unknown; employeeUser: unknown; scheduledPickupAt: Date }) {
  const policy = await getPolicy();
  const pin = generatePin(PIN_DIGITS);
  const salt = crypto.randomBytes(16).toString('hex');
  const expiresAt = addMinutes(booking.scheduledPickupAt, policy.pin?.validAfterPickupMinutes ?? 240);
  await RideStartCredential.create(
    [
      {
        assignment: assignmentId,
        booking: booking._id,
        employeeUser: booking.employeeUser,
        pinHash: hashPin(pin, salt),
        salt,
        pinCipher: encrypt(pin),
        status: 'ACTIVE',
        expiresAt,
        maxAttempts: policy.pin?.maxAttempts ?? 5,
      },
    ],
    { session: tx.session },
  );
}

async function notifyAssignment(
  tx: TxContext,
  booking: CabRequestDoc,
  assignment: { _id: unknown },
  driver: { user?: unknown; fullName: string; phone: string },
  vehicle: { registrationNumber: string },
  changed: boolean,
) {
  const employee = await Employee.findById(booking.employee).session(tx.session).lean();
  if (employee) {
    await enqueueEmail(tx.session, {
      idempotencyKey: `${changed ? 'assignment-changed' : 'cab-assigned'}:${assignment._id}`,
      template: changed ? 'ASSIGNMENT_CHANGED' : 'CAB_ASSIGNED',
      to: employee.email,
      toUserId: String(booking.employeeUser),
      params: { ...bookingEmailParams(booking, employee.fullName), vehicleNumber: vehicle.registrationNumber, driverName: driver.fullName, driverPhone: driver.phone },
      relatedBookingId: String(booking._id),
      preference: changed ? 'emailOnChanged' : 'emailOnAssigned',
    });
    await notifyInApp(tx, {
      userId: String(booking.employeeUser),
      type: changed ? 'ASSIGNMENT_CHANGED' : 'CAB_ASSIGNED',
      title: changed ? 'Your cab assignment changed' : 'Your cab has been assigned',
      body: `${booking.reference}: ${vehicle.registrationNumber} · ${driver.fullName}. Your ride-start PIN is in the booking details.`,
      data: { bookingId: String(booking._id) },
      idempotencyKey: `employee-assigned:${assignment._id}`,
    });
  }
  if (driver.user) {
    // Never include the PIN in driver notifications.
    await notifyInApp(tx, {
      userId: String(driver.user),
      type: 'RIDE_ASSIGNED',
      title: 'New ride assigned',
      body: `${booking.reference} · ${booking.travelDate} ${booking.pickupTime} · ${booking.pickupLocation} → ${booking.dropLocation}`,
      data: {
        assignmentId: String(assignment._id),
        bookingReference: booking.reference,
        pickupLocation: booking.pickupLocation,
        destination: booking.dropLocation,
        pickupTime: booking.pickupTime,
        travelDate: booking.travelDate,
        passengers: booking.passengers,
        vehicle: vehicle.registrationNumber,
      },
      idempotencyKey: `driver-assigned:${assignment._id}`,
    });
  }
  tx.afterCommit(() => emitToOperations(booking.officeLocation, 'assignment:created', { bookingId: String(booking._id), assignmentId: String(assignment._id) }));
}

/** Assign an eligible driver + vehicle to an unassigned booking. Idempotent by requestKey. */
export async function assignBooking(actor: Actor, bookingId: string, input: z.infer<typeof assignSchema>, requestKey?: string) {
  if (requestKey) {
    const existing = await CabAssignment.findOne({ requestKey }).lean();
    if (existing) {
      if (String(existing.booking) !== bookingId) throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key already used for another booking');
      return { assignment: existing, duplicate: true };
    }
  }
  const pre = await CabRequest.findById(bookingId).lean();
  if (!pre) throw notFound('Booking');
  await assertBookingInScope(actor, pre);
  try {
    const result = await withTransaction(async (tx) => {
      const booking = await CabRequest.findById(bookingId).session(tx.session);
      if (!booking) throw notFound('Booking');
      if (!ASSIGNABLE_STATUSES.includes(booking.status as BookingStatus)) {
        throw new AppError(409, 'INVALID_TRANSITION', `Booking ${booking.reference} is ${booking.status} and cannot be assigned`);
      }
      const { assignment, driver, vehicle } = await reserve(tx, actor, booking, input.driverId, input.vehicleId, requestKey);
      const updated = await transitionBooking(tx, booking._id, [booking.status as BookingStatus], 'ASSIGNED', {
        actor,
        event: 'ASSIGNED',
        assignmentId: assignment._id,
        set: { currentAssignment: assignment._id, isDelayed: false },
        unset: ['delayReason'],
        meta: { driver: driver.driverCode, vehicle: vehicle.registrationNumber },
      });
      const hadPrevious = await CabAssignment.exists({ booking: booking._id, _id: { $ne: assignment._id } }).session(tx.session);
      await notifyAssignment(tx, updated, assignment, driver, vehicle, !!hadPrevious);
      await audit(actor, 'RIDE_ASSIGNED', 'CabAssignment', assignment._id, `${booking.reference} assigned to ${driver.driverCode} / ${vehicle.registrationNumber}`, { bookingId, driverId: input.driverId, vehicleId: input.vehicleId }, tx.session);
      return { assignment, duplicate: false };
    });
    return result;
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      if (requestKey) {
        const existing = await CabAssignment.findOne({ requestKey }).lean();
        if (existing) return { assignment: existing, duplicate: true };
      }
      throw new AppError(409, 'ALREADY_ASSIGNED', 'This booking was assigned by someone else just now. Refresh to see the latest state.');
    }
    throw err;
  }
}

/**
 * Replace the driver/vehicle of an assigned booking: the old assignment is closed as
 * REASSIGNED, its PIN revoked, and a new assignment + new PIN are created atomically.
 */
export async function reassignBooking(actor: Actor, bookingId: string, input: z.infer<typeof assignSchema>) {
  if (!input.reason?.trim()) throw new AppError(422, 'VALIDATION_ERROR', 'A reason is required to reassign');
  const pre = await CabRequest.findById(bookingId).lean();
  if (!pre) throw notFound('Booking');
  await assertBookingInScope(actor, pre);
  return withTransaction(async (tx) => {
    const booking = await CabRequest.findById(bookingId).session(tx.session);
    if (!booking) throw notFound('Booking');
    if (!['ASSIGNED', 'DRIVER_EN_ROUTE'].includes(booking.status)) {
      throw new AppError(409, 'INVALID_TRANSITION', `Booking ${booking.reference} is ${booking.status} and cannot be reassigned`);
    }
    const old = await endActiveAssignment(tx, booking, 'REASSIGNED', actor, input.reason!);
    const { assignment, driver, vehicle } = await reserve(tx, actor, booking, input.driverId, input.vehicleId);
    if (old) await CabAssignment.updateOne({ _id: old._id }, { $set: { replacedBy: assignment._id } }, { session: tx.session });
    const updated = await transitionBooking(tx, booking._id, [booking.status as BookingStatus], 'ASSIGNED', {
      actor,
      event: 'REASSIGNED',
      reason: input.reason,
      assignmentId: assignment._id,
      set: { currentAssignment: assignment._id },
      meta: { driver: driver.driverCode, vehicle: vehicle.registrationNumber, previousAssignment: old ? String(old._id) : undefined },
    });
    await notifyAssignment(tx, updated, assignment, driver, vehicle, true);
    await audit(actor, 'RIDE_REASSIGNED', 'CabAssignment', assignment._id, `${booking.reference} reassigned to ${driver.driverCode} / ${vehicle.registrationNumber}`, { reason: input.reason, previous: old ? String(old._id) : null }, tx.session);
    return { assignment };
  });
}

/** Coordinator/admin issues a fresh PIN when the old one is locked or expired. */
export async function regeneratePin(actor: Actor, bookingId: string, reason: string) {
  const pre = await CabRequest.findById(bookingId).lean();
  if (!pre) throw notFound('Booking');
  await assertBookingInScope(actor, pre);
  return withTransaction(async (tx) => {
    const booking = await CabRequest.findById(bookingId).session(tx.session);
    if (!booking?.currentAssignment || !['ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED'].includes(booking.status)) {
      throw new AppError(409, 'INVALID_STATE', 'A PIN can only be regenerated for an assigned ride that has not started');
    }
    await RideStartCredential.updateMany(
      { assignment: booking.currentAssignment, status: { $in: ['ACTIVE', 'LOCKED', 'EXPIRED'] } },
      { $set: { status: 'REVOKED', revokedAt: new Date(), revokeReason: 'REGENERATED' } },
      { session: tx.session },
    );
    await createPinCredential(tx, booking.currentAssignment, booking);
    await notifyInApp(tx, {
      userId: String(booking.employeeUser),
      type: 'PIN_REGENERATED',
      title: 'New ride-start PIN issued',
      body: `A new PIN was issued for ${booking.reference}. View it in your booking details.`,
      data: { bookingId: String(booking._id) },
    });
    await audit(actor, 'PIN_REGENERATED', 'CabRequest', booking._id, `Ride-start PIN regenerated for ${booking.reference}`, { reason }, tx.session);
  });
}
