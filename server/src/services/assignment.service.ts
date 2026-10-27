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
import { DateTime } from 'luxon';
import { fmt12h } from '../utils/time.js';
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
  const p: string[] = [];
  if (driver.employmentStatus !== 'ACTIVE') p.push(`Driver is ${driver.employmentStatus.toLowerCase()}`);
  if (driver.licenseExpiry <= booking.scheduledPickupAt) p.push('Driver license expires before pickup');
  if (driver.officeLocation !== booking.officeLocation) p.push('Driver belongs to a different office');
  // Drivers added by a coordinator can be assigned straight away, before their first sign-in:
  // their account is created when they sign in, and the rides are waiting for them.
  if (driver.user) {
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

/** Overlapping active assignments of a driver/vehicle. Rides of the same trip share the cab, so they never conflict. */
async function conflictsFor(field: 'driver' | 'vehicle', id: unknown, w: Window, excludeBooking: unknown, session?: mongoose.ClientSession, tripId?: string) {
  return CabAssignment.find({
    [field]: id,
    status: 'ACTIVE',
    booking: { $ne: excludeBooking },
    windowStart: { $lt: w.end },
    windowEnd: { $gt: w.start },
    ...(tripId ? { tripId: { $ne: tripId } } : {}),
  })
    .select('bookingReference scheduledPickupAt tripName')
    .session(session ?? null)
    .lean();
}

/** "Busy with Gachibowli Cab at 10:00 PM" (or the booking references when not a shared trip). */
function busyWith(conflicts: Array<{ bookingReference: string; scheduledPickupAt: Date; tripName?: string | null }>, timezone: string) {
  const times = [...new Set(conflicts.map((c) => DateTime.fromJSDate(c.scheduledPickupAt).setZone(timezone).toFormat('h:mm a')))].join(', ');
  const names = [...new Set(conflicts.map((c) => c.tripName).filter(Boolean))];
  return `Busy with ${names.length ? names.join(', ') : conflicts.map((c) => c.bookingReference).join(', ')} at ${times}`;
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
      if (conflicts.length) problems.push(busyWith(conflicts, booking.timezone));
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
      if (conflicts.length) problems.push(busyWith(conflicts, booking.timezone));
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
async function reserve(tx: TxContext, actor: Actor, booking: CabRequestDoc, driverId: string, vehicleId: string, requestKey?: string, trip?: { id: string; name: string; allowNearby?: boolean }) {
  const { session } = tx;
  const w = await windowFor(booking);
  const driver = await Driver.findOneAndUpdate({ _id: driverId }, { $inc: { scheduleLock: 1 } }, { new: true, session });
  const vehicle = await Vehicle.findOneAndUpdate({ _id: vehicleId }, { $inc: { scheduleLock: 1 } }, { new: true, session });
  if (!driver) throw notFound('Driver');
  if (!vehicle) throw notFound('Vehicle');

  const problems = [...(await driverProblems(driver.toObject() as DriverLike, booking, w, session)), ...vehicleProblems(vehicle.toObject() as VehicleLike, booking)];
  if (problems.length) throw new AppError(422, 'NOT_ELIGIBLE', `Cannot assign: ${problems.join('; ')}`, { problems });

  // The coordinator may knowingly use a cab that has another trip at a different time close by
  // (e.g. a short 10 PM run before an 11 PM one); a trip at the very same time always clashes.
  const sameTime = (c: { scheduledPickupAt: Date }) => !trip?.allowNearby || +c.scheduledPickupAt === +booking.scheduledPickupAt;
  const [driverConflicts, vehicleConflicts] = (
    await Promise.all([conflictsFor('driver', driver._id, w, booking._id, session, trip?.id), conflictsFor('vehicle', vehicle._id, w, booking._id, session, trip?.id)])
  ).map((list) => list.filter(sameTime));
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
        tripId: trip?.id,
        tripName: trip?.name,
        // Drivers don't accept rides: an assigned ride is theirs to do.
        acknowledgedAt: new Date(),
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

// ---------------------------------------------------------------------------
// Shared trips: several rides assigned to one cab together
// ---------------------------------------------------------------------------
export const tripSchema = z.object({
  bookingIds: z
    .array(z.string().refine(mongoose.isValidObjectId, 'Invalid booking'))
    .min(1, 'Select at least one ride')
    .max(20, 'At most 20 rides per cab')
    .refine((ids) => new Set(ids).size === ids.length, 'A ride was selected twice'),
  driverId: z.string().refine(mongoose.isValidObjectId, 'Invalid driver'),
  vehicleId: z.string().refine(mongoose.isValidObjectId, 'Invalid vehicle'),
  name: z.string().trim().max(120).optional(),
  // IN rides (home → office): when the cab picks the riders up. Required while their pickup isn't set.
  pickupTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm (24h)').optional(),
  // Add the rides to a shared cab already going at that time (its cab, driver and pickup time are used).
  joinTripId: z.string().uuid('Invalid trip').optional(),
  // The coordinator chose a cab that has another trip at a different time close by.
  allowNearby: z.boolean().optional(),
});
export const tripRenameSchema = z.object({ name: z.string().trim().min(2, 'Enter a name for this cab').max(120) });
export const tripEligibleSchema = z.object({ bookingIds: tripSchema.shape.bookingIds });

/** "Kondapur Cab" + "Madhapur Cab" → "Kondapur & Madhapur Cab"; one route keeps its own name. */
export function defaultTripName(routes: Array<string | null | undefined>) {
  const unique = [...new Set(routes.map((r) => r?.trim()).filter((r): r is string => !!r))];
  if (!unique.length) return 'Shared cab';
  if (unique.length === 1) return unique[0];
  return `${unique.map((r) => r.replace(/\s+cab$/i, '')).join(' & ')} Cab`;
}

async function routesOf(bookings: Array<{ employee: unknown }>) {
  const emps = await Employee.find({ _id: { $in: bookings.map((b) => b.employee) } }, { route: 1 }).lean();
  return emps.map((e) => e.route);
}

/**
 * Drivers and cabs for a group of rides: a driver/cab is offered only if it can take every ride,
 * and a cab must have a seat for every rider together.
 */
export async function tripEligibleResources(actor: Actor, bookingIds: string[]) {
  const results = await Promise.all(bookingIds.map((id) => eligibleResources(actor, id)));
  const offices = new Set((await CabRequest.find({ _id: { $in: bookingIds } }, { officeLocation: 1 }).lean()).map((b) => b.officeLocation));
  if (offices.size > 1) throw new AppError(422, 'MIXED_OFFICES', 'Rides from different offices cannot share a cab');
  const seats = results.reduce((n, r) => n + r.booking.passengers, 0);
  const merge = <T extends { _id: unknown; eligible: boolean; problems: string[] }>(lists: T[][]) => {
    const byId = new Map<string, T>();
    for (const list of lists)
      for (const row of list) {
        const prev = byId.get(String(row._id));
        byId.set(String(row._id), prev ? { ...prev, eligible: prev.eligible && row.eligible, problems: [...new Set([...prev.problems, ...row.problems])] } : { ...row, problems: [...row.problems] });
      }
    return [...byId.values()];
  };
  const drivers = merge(results.map((r) => r.drivers));
  const selected = await CabRequest.find({ _id: { $in: bookingIds } }).lean();
  const vehicles = await Promise.all(
    merge(results.map((r) => r.vehicles)).map(async (v) => {
      // A cab busy only with one shared trip at this time can take these riders too (same direction, seats left).
      const join = v.eligible ? null : await joinableTrip(v, selected, seats);
      // Busy only with trips at other times close by: the coordinator may still choose it (their call).
      let nearby: Awaited<ReturnType<typeof nearbyTrips>> = null;
      // The cab's driver, from either side of the link.
      const cabDriver =
        (v as { currentDriver?: { _id: unknown } | null }).currentDriver ??
        drivers.find((x) => String((x as { currentVehicle?: { _id: unknown } | null }).currentVehicle?._id) === String(v._id));
      if (!v.eligible && !join && v.capacity >= seats && cabDriver) {
        const d = drivers.find((x) => String(x._id) === String(cabDriver._id));
        const other = [...v.problems, ...(d?.problems ?? [])].filter((p) => !p.startsWith('Busy with'));
        if (!other.length) nearby = await nearbyTrips(v._id, cabDriver._id, selected);
      }
      return v.capacity < seats ? { ...v, eligible: false, join, nearby, problems: [...new Set([...v.problems, `Only ${v.capacity} seats for ${seats} riders`])] } : { ...v, join, nearby };
    }),
  );
  const sortRows = <T extends { eligible: boolean }>(rows: T[], name: (r: T) => string) => rows.sort((a, b) => Number(b.eligible) - Number(a.eligible) || name(a).localeCompare(name(b)));
  return {
    bookings: results.map((r) => r.booking),
    seats,
    suggestedName: defaultTripName(await routesOf(selected)),
    drivers: sortRows(drivers, (d) => d.fullName),
    vehicles: sortRows(vehicles, (v) => v.registrationNumber),
  };
}

/**
 * Other trips of this cab or its driver that overlap these rides but are at a different time
 * (e.g. 10 PM vs 11 PM): not a hard clash, the coordinator decides. Null when there are none,
 * or when one is at the very same time (the cab can't be in two places).
 */
async function nearbyTrips(vehicleId: unknown, driverId: unknown, selected: Array<{ _id: unknown; scheduledPickupAt: Date; timezone: string }>) {
  const windows = await Promise.all(selected.map((b) => windowFor(b)));
  const clashes = await CabAssignment.find({
    status: 'ACTIVE',
    booking: { $nin: selected.map((b) => b._id) },
    $and: [{ $or: [{ vehicle: vehicleId }, { driver: driverId }] }, { $or: windows.map((w) => ({ windowStart: { $lt: w.end }, windowEnd: { $gt: w.start } })) }],
  })
    .select('bookingReference scheduledPickupAt tripName')
    .lean();
  if (!clashes.length) return null;
  const times = new Set(selected.map((b) => +b.scheduledPickupAt));
  if (clashes.some((c) => times.has(+c.scheduledPickupAt))) return null;
  const tz = selected[0]?.timezone ?? 'Asia/Kolkata';
  const trips = new Map<string, { name: string; time: string }>();
  for (const c of clashes) {
    const time = DateTime.fromJSDate(c.scheduledPickupAt).setZone(tz).toFormat('h:mm a');
    const name = c.tripName ?? c.bookingReference;
    trips.set(`${name} ${time}`, { name, time });
  }
  return { trips: [...trips.values()] };
}

type SlotFields ={ direction?: string | null; travelDate?: string; shiftDate?: string | null; pickupTime?: string; reportBy?: string | null };
type TripMember = { tripName?: string | null; startedAt?: Date | null; driver: unknown; booking: ({ passengers?: number; employee?: unknown } & SlotFields) | null };

/**
 * The moment a ride is about, for joining a cab: OUT rides by date + time the cab leaves the office,
 * IN rides by date + reach-office time (their pickup may not be set yet, or is the cab's).
 */
const slotOf = (b: SlotFields | null | undefined) =>
  !b ? '' : b.direction === 'IN' && b.reportBy ? `IN ${b.shiftDate ?? b.travelDate} ${b.reportBy}` : `${b.direction ?? 'OUT'} ${b.travelDate} ${b.pickupTime}`;

/**
 * The shared trip these rides could join on this cab: the cab is busy at that time only with it, and
 * every rider goes the same way at the same date and time, with seats left. A trip at another time
 * that merely overlaps is a clash, not a cab to join.
 */
async function joinableTrip(vehicle: { _id: unknown; capacity: number }, selected: Array<{ _id: unknown; passengers: number; scheduledPickupAt: Date } & SlotFields>, seats: number) {
  const windows = await Promise.all(selected.map((b) => windowFor(b)));
  const clashes = await CabAssignment.find({
    vehicle: vehicle._id,
    status: 'ACTIVE',
    booking: { $nin: selected.map((b) => b._id) },
    $or: windows.map((w) => ({ windowStart: { $lt: w.end }, windowEnd: { $gt: w.start } })),
  }).lean();
  const tripIds = new Set(clashes.map((c) => c.tripId ?? ''));
  const tripId = [...tripIds][0];
  if (!clashes.length || tripIds.size !== 1 || !tripId) return null;
  const members = (await CabAssignment.find({ tripId, status: 'ACTIVE' })
    .populate('booking', 'passengers direction pickupTime employee travelDate shiftDate reportBy')
    .populate('driver', 'fullName driverCode phone')
    .lean()) as unknown as TripMember[];
  // Same direction, date and time for everyone (that also rules out IN with OUT).
  const slot = slotOf(selected[0]);
  if (selected.some((b) => slotOf(b) !== slot) || members.some((m) => slotOf(m.booking) !== slot)) return null;
  if (members.some((m) => m.startedAt)) return null; // already on the road
  const used = members.reduce((n, m) => n + (m.booking?.passengers ?? 1), 0);
  if (used + seats > vehicle.capacity) return null;
  const d = members[0].driver as { _id: unknown; fullName: string; driverCode: string; phone: string };
  return {
    tripId,
    tripName: members[0].tripName ?? 'Shared cab',
    riders: members.length,
    seatsUsed: used,
    pickupTime: members[0].booking?.pickupTime,
    driver: { _id: String(d._id), fullName: d.fullName, driverCode: d.driverCode, phone: d.phone },
  };
}

/**
 * Assign several waiting rides to one driver + cab as a shared trip, all or nothing. Each rider
 * still gets their own assignment, PIN and notifications; the rides don't conflict with each other.
 */
export async function assignTrip(actor: Actor, input: z.infer<typeof tripSchema>, requestKey?: string) {
  const keyFor = (bookingId: unknown) => (requestKey ? `${requestKey}:${bookingId}` : undefined);
  if (requestKey) {
    const existing = await CabAssignment.find({ requestKey: { $in: input.bookingIds.map(keyFor) } }).lean();
    if (existing.length) return { tripId: existing[0].tripId, tripName: existing[0].tripName, assignments: existing, duplicate: true };
  }
  const pre = await CabRequest.find({ _id: { $in: input.bookingIds } }).lean();
  if (pre.length !== input.bookingIds.length) throw notFound('Booking');
  for (const b of pre) await assertBookingInScope(actor, b);
  if (new Set(pre.map((b) => b.officeLocation)).size > 1) throw new AppError(422, 'MIXED_OFFICES', 'Rides from different offices cannot share a cab');
  let tripId: string = crypto.randomUUID();
  let tripName = input.name?.trim() || defaultTripName(await routesOf(pre));
  try {
    const assignments = await withTransaction(async (tx) => {
      const bookings = await CabRequest.find({ _id: { $in: input.bookingIds } }).sort({ scheduledPickupAt: 1 }).session(tx.session);
      const notReady = bookings.filter((b) => !ASSIGNABLE_STATUSES.includes(b.status as BookingStatus));
      if (notReady.length) {
        throw new AppError(409, 'INVALID_TRANSITION', `${notReady.map((b) => b.reference).join(', ')} ${notReady.length === 1 ? 'is' : 'are'} no longer waiting for a cab. Refresh and try again.`);
      }
      // One cab, one trip: everyone goes the same way at the same date and time.
      if (bookings.some((b) => slotOf(b) !== slotOf(bookings[0]))) {
        throw new AppError(422, 'NOT_SAME_TIME', 'These rides are at different times. Assign rides at the same time to one cab.');
      }
      let { driverId, vehicleId } = input;
      let pickupTime = input.pickupTime;
      let seats = bookings.reduce((n, b) => n + b.passengers, 0);
      if (input.joinTripId) {
        // Joining a shared cab already going: its cab, driver and pickup time; its name grows to cover the new routes.
        const members = (await CabAssignment.find({ tripId: input.joinTripId, status: 'ACTIVE' })
          .populate('booking', 'passengers direction pickupTime employee travelDate shiftDate reportBy')
          .session(tx.session)
          .lean()) as unknown as Array<TripMember & { vehicle: unknown }>;
        if (!members.length || members.some((m) => m.startedAt)) throw new AppError(409, 'TRIP_CHANGED', 'That cab has already left or its trip changed. Refresh and choose again.');
        const direction = members[0].booking?.direction ?? 'OUT';
        if (bookings.some((b) => (b.direction ?? 'OUT') !== direction)) throw new AppError(422, 'MIXED_DIRECTIONS', 'Rides to the office (IN) and rides home (OUT) need separate cabs');
        if (bookings.some((b) => slotOf(b) !== slotOf(members[0].booking))) {
          throw new AppError(422, 'NOT_SAME_TIME', 'Only rides at the same date and time can be added to a cab already going');
        }
        tripId = input.joinTripId;
        driverId = String(members[0].driver);
        vehicleId = String(members[0].vehicle);
        if (direction === 'IN') pickupTime = members[0].booking?.pickupTime;
        seats += members.reduce((n, m) => n + (m.booking?.passengers ?? 1), 0);
        const current = members[0].tripName ?? 'Shared cab';
        const memberRoutes = await routesOf(members.map((m) => ({ employee: m.booking?.employee })));
        // Keep a name the coordinator chose; replace the automatic one with one covering every route.
        tripName = current === defaultTripName(memberRoutes) ? defaultTripName([...memberRoutes, ...(await routesOf(bookings))]) : current;
        if (tripName !== current) await CabAssignment.updateMany({ tripId }, { $set: { tripName } }, { session: tx.session });
      }
      const cab = await Vehicle.findById(vehicleId).session(tx.session).lean();
      if (cab && cab.capacity < seats) throw new AppError(422, 'NOT_ELIGIBLE', `Cannot assign: ${cab.registrationNumber} has ${cab.capacity} seats for ${seats} riders`);
      await setInPickupTimes(bookings, pickupTime);
      const created = [];
      for (const booking of bookings) {
        const { assignment, driver, vehicle } = await reserve(tx, actor, booking, driverId, vehicleId, keyFor(booking._id), { id: tripId, name: tripName, allowNearby: input.allowNearby });
        const updated = await transitionBooking(tx, booking._id, [booking.status as BookingStatus], 'ASSIGNED', {
          actor,
          event: 'ASSIGNED',
          assignmentId: assignment._id,
          set: { currentAssignment: assignment._id, isDelayed: false },
          unset: ['delayReason'],
          meta: { driver: driver.driverCode, vehicle: vehicle.registrationNumber, trip: tripName },
        });
        const hadPrevious = await CabAssignment.exists({ booking: booking._id, _id: { $ne: assignment._id } }).session(tx.session);
        await notifyAssignment(tx, updated, assignment, driver, vehicle, !!hadPrevious);
        created.push(assignment);
      }
      await audit(
        actor,
        input.joinTripId ? 'TRIP_JOINED' : 'TRIP_ASSIGNED',
        'CabAssignment',
        created[0]._id,
        `${tripName}: ${bookings.map((b) => b.reference).join(', ')} ${input.joinTripId ? 'added to the cab already going' : 'assigned to one cab'}`,
        { tripId, driverId, vehicleId },
        tx.session,
      );
      return created;
    });
    return { tripId, tripName, assignments, duplicate: false };
  } catch (err) {
    if (isDuplicateKeyError(err)) throw new AppError(409, 'ALREADY_ASSIGNED', 'One of these rides was assigned by someone else just now. Refresh to see the latest state.');
    throw err;
  }
}

/** How long before the reach-office time an IN pickup may be. */
const MAX_IN_PICKUP_LEAD_HOURS = 4;

/**
 * IN rides (home → office): the coordinator's pickup time becomes the ride's time. It must be before
 * every rider's reach-office time (on the previous day when that is just after midnight), at most
 * a few hours earlier and not in the past. It may be before cab hours start: a long ride from home
 * can need an earlier pickup to reach the office on time. Saved on the documents in the session.
 */
async function setInPickupTimes(bookings: Array<InstanceType<typeof CabRequest>>, pickupTime?: string) {
  const ins = bookings.filter((b) => b.direction === 'IN');
  if (ins.length && ins.length !== bookings.length) throw new AppError(422, 'MIXED_DIRECTIONS', 'Rides to the office (IN) and rides home (OUT) need separate cabs');
  if (!ins.length) return;
  if (!pickupTime) {
    if (ins.some((b) => b.pickupTimeSet === false)) throw new AppError(422, 'PICKUP_TIME_REQUIRED', 'Set the pickup time for these rides to the office', { fields: { pickupTime: 'Set the pickup time' } });
    return;
  }
  const [h, m] = pickupTime.split(':').map(Number);
  // Only rides with a reach-office time are timed by the coordinator; others keep the time they were booked for.
  for (const b of ins.filter((x) => x.reportBy)) {
    const reportAt = DateTime.fromISO(`${b.shiftDate ?? b.travelDate}T${b.reportBy}`, { zone: b.timezone });
    let at = reportAt.set({ hour: h, minute: m, second: 0, millisecond: 0 });
    if (at >= reportAt) at = at.minus({ days: 1 });
    if (reportAt.diff(at, 'hours').hours > MAX_IN_PICKUP_LEAD_HOURS) {
      throw new AppError(422, 'PICKUP_TIME_INVALID', `${b.reference} must reach the office by ${fmt12h(b.reportBy ?? b.pickupTime)}: pick them up before that, at most ${MAX_IN_PICKUP_LEAD_HOURS} hours earlier`, { fields: { pickupTime: 'Before the reach-office time' } });
    }
    if (at.toMillis() < Date.now()) throw new AppError(422, 'PICKUP_TIME_INVALID', `A ${fmt12h(pickupTime)} pickup for ${b.reference} is already in the past`, { fields: { pickupTime: 'In the past' } });
    b.travelDate = at.toFormat('yyyy-MM-dd');
    b.pickupTime = pickupTime;
    b.scheduledPickupAt = at.toUTC().toJSDate();
    b.pickupTimeSet = true;
    if (b.openSlotKey) b.openSlotKey = `${b.employeeUser}:${b.scheduledPickupAt.toISOString()}`;
    await b.save(); // loaded in the transaction's session, so saved within it
  }
}

/** Rename a shared trip (e.g. after combining two routes into one cab). */
export async function renameTrip(actor: Actor, tripId: string, name: string) {
  const first = await CabAssignment.findOne({ tripId }).lean();
  if (!first) throw notFound('Trip');
  await assertBookingInScope(actor, first);
  await CabAssignment.updateMany({ tripId }, { $set: { tripName: name } });
  await audit(actor, 'TRIP_RENAMED', 'CabAssignment', first._id, `Shared cab renamed to "${name}"`, { tripId, from: first.tripName, to: name });
  emitToOperations(first.officeLocation, 'assignment:created', { tripId });
  return { tripId, tripName: name };
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
