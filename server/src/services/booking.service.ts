import crypto from 'node:crypto';
import { DateTime } from 'luxon';
import type { PipelineStage } from 'mongoose';
import mongoose from 'mongoose';
import { z } from 'zod';
import { isDuplicateKeyError, withTransaction, type TxContext } from '../db.js';
import { ACTIVE_TRIP_STATUSES, OPEN_STATUSES, TERMINAL_STATUSES, type BookingStatus } from '../domain.js';
import { CabAssignment, CabRequest, RideStartCredential, TripStatusHistory } from '../models/booking.js';
import { nextSequence } from '../models/Counter.js';
import { Driver } from '../models/Driver.js';
import { Employee } from '../models/Employee.js';
import { EmailOutbox } from '../models/system.js';
import { User } from '../models/User.js';
import { decrypt } from '../utils/crypto.js';
import { AppError, badRequest, forbidden, notFound, validationError } from '../utils/errors.js';
import { escapeRegex, paged, resolveSort, type Pagination } from '../utils/listing.js';
import { addMinutes, DATE_RE, fmt12h, localToUtc, TIME_RE } from '../utils/time.js';
import { audit, type Actor } from './audit.service.js';
import { refreshDriverAvailability } from './availability.service.js';
import { alertOperations } from './alert.service.js';
import { bookingEmailParams, broadcastBookingUpdate, notifyCoordinators, recordEvent, transitionBooking } from './lifecycle.js';
import { enqueueEmail, notifyInApp } from './notification.service.js';
import { getPolicy, inCabWindow } from './policy.service.js';
import { assertBookingInScope, assertInScope, bookingScope, bookingScopeFilter } from './scope.service.js';

export const createBookingSchema = z.object({
  travelDate: z.string().regex(DATE_RE, 'Use YYYY-MM-DD'),
  // Ignored when the shift has hours (the cab time then follows from the shift times).
  pickupTime: z.string().regex(TIME_RE, 'Use HH:mm (24h)').optional(),
  // The employee's shift times for this day, when they differ from the usual ones (e.g. 10 PM - 7 AM
  // instead of 9 PM - 6 AM). They decide whether the cab is IN or OUT; see cabForShift.
  shiftStart: z.string().regex(TIME_RE, 'Use HH:mm (24h)').optional(),
  shiftEnd: z.string().regex(TIME_RE, 'Use HH:mm (24h)').optional(),
  // Only needed when the shift times allow both an IN and an OUT cab.
  direction: z.enum(['IN', 'OUT']).optional(),
  // Employees aren't asked for the route: when left out it is the saved home address and the
  // office, in the shift's direction. The transport team plans the actual cab route.
  pickupLocation: z.string().trim().min(3, 'Pickup location is required').max(300).optional(),
  dropLocation: z.string().trim().min(3, 'Drop-off location is required').max(300).optional(),
  passengers: z.coerce.number().int().min(1).max(60).default(1),
  tripType: z.enum(['ONE_WAY', 'ROUND_TRIP']).default('ONE_WAY'),
  returnPickupTime: z.string().regex(TIME_RE).optional(),
  shift: z.string().trim().toUpperCase().max(20).optional().or(z.literal('')),
  // Optional; must match the employee's own office when sent.
  officeLocation: z.string().trim().toUpperCase().max(20).optional(),
  notes: z.string().trim().max(500).optional().default(''),
  clientRequestId: z.string().uuid('clientRequestId must be a UUID'),
});

/** IN cabs need time for the pickup run, so the shift must start at least this long after cab hours begin. */
export const IN_LEAD_MINUTES = 60;

/**
 * Which cab a shift gets, from its start/end times and the cab hours (e.g. 8 PM - 6 AM):
 *  - IN  (home → office) when the shift starts between cab-hours start + 1 h and cab-hours end;
 *        the employee must reach the office by the start, the transport team sets the pickup.
 *  - OUT (office → home) when the shift ends within cab hours, before they end; the cab leaves at the end.
 * Without cab hours both are possible. Returns the options; the caller picks or rejects.
 */
export function cabForShift(start: string, end: string, winStart?: string | null, winEnd?: string | null) {
  if (!winStart || !winEnd) return { in: true, out: true };
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const span = (toMin(winEnd) - toMin(winStart) + 1440) % 1440 || 1440;
  const offset = (t: string) => (toMin(t) - toMin(winStart) + 1440) % 1440;
  return { in: offset(start) >= IN_LEAD_MINUTES && offset(start) <= span, out: offset(end) < span };
}

/**
 * Date of a shift's cab. The shift's own cab time is on the next day when it is before the shift
 * starts (e.g. 4 AM for a 7 PM shift). A changed time lands on whichever day puts it closest to
 * that default, so 5 AM stays the morning after and 11 PM stays the shift's evening.
 */
export function shiftCabDate(startTime: string, defaultTime: string, shiftDate: string, time: string) {
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const defaultOffset = toMin(defaultTime) + (defaultTime < startTime ? 1440 : 0);
  const nextDay = Math.abs(toMin(time) + 1440 - defaultOffset) < Math.abs(toMin(time) - defaultOffset);
  return nextDay ? DateTime.fromISO(shiftDate).plus({ days: 1 }).toFormat('yyyy-MM-dd') : shiftDate;
}

async function validateBookingWindow(input: { travelDate: string; pickupTime: string }, timezone: string) {
  const policy = await getPolicy();
  const scheduled = localToUtc(input.travelDate, input.pickupTime, timezone);
  if (!scheduled) throw validationError('Invalid travel date or pickup time');
  const now = DateTime.now().setZone(timezone);
  const minLead = policy.booking?.minLeadMinutes ?? 0;
  if (scheduled.getTime() < Date.now() + minLead * 60_000) {
    throw new AppError(422, 'BOOKING_CUTOFF', `Bookings must be made at least ${minLead} minutes before pickup`);
  }
  const maxDays = policy.booking?.maxDaysAhead ?? 14;
  const lastDate = now.startOf('day').plus({ days: maxDays }).toFormat('yyyy-MM-dd');
  if (input.travelDate > lastDate) throw new AppError(422, 'BOOKING_WINDOW', `Bookings can be made at most ${maxDays} days in advance`);
  const cutoff = policy.booking?.dailyCutoffTime;
  if (cutoff) {
    const deadline = DateTime.fromISO(`${input.travelDate}T${cutoff}`, { zone: timezone }).minus({ days: 1 });
    if (now > deadline) throw new AppError(422, 'BOOKING_CUTOFF', `Bookings for ${input.travelDate} closed at ${fmt12h(cutoff)} on the previous day`);
  }
  return scheduled;
}

/**
 * The work day a cab belongs to when no shift says so. With cab hours crossing midnight
 * (8 PM - 6 AM), a cab up to the end of those hours counts for the previous day.
 */
export function workDayOf(travelDate: string, pickupTime: string, winStart?: string | null, winEnd?: string | null) {
  const overnight = !!winStart && !!winEnd && winStart > winEnd;
  return overnight && pickupTime <= winEnd! ? DateTime.fromISO(travelDate).minus({ days: 1 }).toFormat('yyyy-MM-dd') : travelDate;
}

/** Bookings of a work day. Bookings made before workDay was stored fall back to their shift date, then travel date. */
export function workDayMatch(day: string) {
  return {
    $or: [
      { workDay: day },
      { workDay: { $exists: false }, shiftDate: day },
      { workDay: { $exists: false }, shiftDate: { $exists: false }, travelDate: day },
    ],
  };
}

/** The current work day in an office zone (runs until the end of overnight cab hours). */
export async function currentWorkDay(timezone?: string) {
  const policy = await getPolicy();
  const now = DateTime.now().setZone(timezone ?? policy.officeLocations[0]?.timezone ?? 'Asia/Kolkata');
  return workDayOf(now.toFormat('yyyy-MM-dd'), now.toFormat('HH:mm'), policy.booking?.cabWindowStart, policy.booking?.cabWindowEnd);
}

/** Has the employee a cab (not cancelled or rejected) for this work day? */
async function hasCabForDay(userId: string, shiftDay: string) {
  return !!(await CabRequest.exists({
    employeeUser: userId,
    $or: [
      { shiftDayKey: { $in: [`${userId}:${shiftDay}:OUTBOUND`, `${userId}:${shiftDay}:RETURN`] } },
      // bookings made before shiftDayKey existed
      {
        shiftDayKey: { $exists: false },
        status: { $nin: ['CANCELLED', 'REJECTED'] },
        $or: [{ shiftDate: shiftDay }, { shiftDate: { $exists: false }, travelDate: shiftDay }],
      },
    ],
  }));
}

/** Has the employee already got a cab for the current work day (which runs until the end of cab hours)? */
export async function hasCabForCurrentWorkDay(userId: string, officeCode: string) {
  const policy = await getPolicy();
  return hasCabForDay(userId, await currentWorkDay(policy.officeLocations.find((o) => o.code === officeCode)?.timezone));
}

const shiftDayTaken = (shiftDay: string) =>
  new AppError(
    409,
    'SHIFT_DAY_BOOKED',
    `You already have a cab for your shift on ${DateTime.fromISO(shiftDay).toFormat('ccc, d LLL')}. Only one cab is allowed per shift day; cancel that request first if you need to change it.`,
  );

async function makeReference(session: mongoose.ClientSession, travelDate: string) {
  const ymd = travelDate.replace(/-/g, '').slice(2);
  const seq = await nextSequence(`booking:${ymd}`, session);
  return `CB-${ymd}-${String(seq).padStart(4, '0')}`;
}

/**
 * Employee creates a cab request. Idempotent by clientRequestId; an employee can
 * hold only one open booking per pickup instant (unique openSlotKey).
 */
export async function createBooking(actor: Actor, input: z.infer<typeof createBookingSchema>) {
  const employee = await Employee.findOne({ user: actor.id }).lean();
  if (!employee) throw forbidden('Only registered employees can request cabs');

  const existing = await CabRequest.findOne({ employeeUser: actor.id, clientRequestId: input.clientRequestId }).lean();
  if (existing) return { booking: existing, duplicate: true };

  const policy = await getPolicy();
  // Bookings always belong to the employee's own office, so only that office's coordinators handle them.
  if (input.officeLocation && input.officeLocation !== employee.officeLocation) {
    throw new AppError(422, 'OFFICE_MISMATCH', `Cabs can only be booked for your own office (${employee.officeLocation}). Ask your administrator if your office has changed.`);
  }
  const office = policy.officeLocations.find((o) => o.code === employee.officeLocation && o.active);
  if (!office) throw new AppError(422, 'OFFICE_INACTIVE', `Your office (${employee.officeLocation}) is not accepting cab requests. Please contact your administrator.`);
  const shift = input.shift ? policy.shifts.find((s) => s.code === input.shift && s.active) : undefined;
  if (input.shift && !shift) throw badRequest('Select a valid shift');
  if (!shift && policy.booking?.requireShift) throw validationError('Select your shift', { fields: { shift: 'Select your shift' } });
  // IN (home → office) or OUT (office → home). Without a shift the default route is home → office.
  let direction: 'IN' | 'OUT' = shift?.direction === 'FROM_OFFICE' ? 'OUT' : 'IN';
  let travelDate = input.travelDate;
  let pickupTime = input.pickupTime ?? '';
  let shiftDate: string | undefined;
  let shiftStart: string | undefined;
  let shiftEnd: string | undefined;
  let reportBy: string | undefined;
  let pickupTimeSet = true;
  if (shift?.startTime && shift.endTime) {
    // The employee may enter different shift times for this day (10 PM - 7 AM instead of 9 PM - 6 AM);
    // the times then decide the cab: IN to reach the office by the start, or OUT leaving at the end.
    shiftDate = input.travelDate;
    shiftStart = input.shiftStart ?? shift.startTime;
    shiftEnd = input.shiftEnd ?? shift.endTime;
    if (shiftStart === shiftEnd) throw validationError('The shift must end at a different time from when it starts', { fields: { shiftEnd: 'Must differ from the start' } });
    const can = cabForShift(shiftStart, shiftEnd, policy.booking?.cabWindowStart, policy.booking?.cabWindowEnd);
    if (!can.in && !can.out) {
      const ws = policy.booking?.cabWindowStart;
      const we = policy.booking?.cabWindowEnd;
      const inFrom = DateTime.fromFormat(ws!, 'HH:mm').plus({ minutes: IN_LEAD_MINUTES }).toFormat('HH:mm');
      throw new AppError(422, 'NO_CAB_FOR_SHIFT', `No cab for a ${fmt12h(shiftStart)} - ${fmt12h(shiftEnd)} shift. Cabs take you to the office for shifts starting ${fmt12h(inFrom)} - ${fmt12h(we)}, or home for shifts ending ${fmt12h(ws)} - before ${fmt12h(we)}.`, {
        fields: { shiftStart: 'No cab for these hours' },
      });
    }
    if (can.in && can.out) direction = input.direction ?? direction;
    else direction = can.in ? 'IN' : 'OUT';
    if (direction === 'IN') {
      // The start is when they must reach the office; the transport team sets the pickup when assigning.
      reportBy = shiftStart;
      pickupTime = shiftStart;
      pickupTimeSet = false;
      travelDate = shiftDate;
    } else {
      // The cab leaves the office when the shift ends (the next day when it ends after midnight).
      pickupTime = shiftEnd;
      travelDate = shiftEnd < shiftStart ? DateTime.fromISO(shiftDate).plus({ days: 1 }).toFormat('yyyy-MM-dd') : shiftDate;
    }
  } else if (shift?.startTime && shift.defaultPickupTime) {
    // Shift with a cab time but no end (older setups): the shift's own cab time.
    shiftDate = input.travelDate;
    pickupTime = shift.defaultPickupTime;
    travelDate = shiftCabDate(shift.startTime, shift.defaultPickupTime, shiftDate, pickupTime);
  }
  if (!pickupTime) throw validationError('Choose a pickup time', { fields: { pickupTime: 'Choose a pickup time' } });
  const winStart = policy.booking?.cabWindowStart;
  const winEnd = policy.booking?.cabWindowEnd;
  if (!inCabWindow(pickupTime, winStart, winEnd)) {
    throw new AppError(422, 'OUTSIDE_CAB_HOURS', `Cabs run only between ${fmt12h(winStart)} and ${fmt12h(winEnd)}`);
  }
  if (input.passengers > (policy.booking?.maxPassengers ?? 4)) {
    throw new AppError(422, 'PASSENGER_LIMIT', `A booking can include at most ${policy.booking?.maxPassengers} passengers`);
  }
  let pickupLocation = input.pickupLocation;
  let dropLocation = input.dropLocation;
  if (!pickupLocation || !dropLocation) {
    const home = employee.homeAddress?.trim();
    if (!home) throw new AppError(422, 'HOME_ADDRESS_REQUIRED', 'Add your present address to your account before requesting a cab.');
    const officeText = office.address ? `${office.name}, ${office.address}` : office.name;
    const fromOffice = direction === 'OUT';
    pickupLocation ||= fromOffice ? officeText : home;
    dropLocation ||= fromOffice ? home : officeText;
  }
  if (pickupLocation.toLowerCase() === dropLocation.toLowerCase()) throw badRequest('Pickup and drop-off locations must differ');
  if (input.tripType === 'ROUND_TRIP') {
    if (!policy.booking?.allowRoundTrip) throw badRequest('Round-trip bookings are not enabled');
    if (!input.returnPickupTime || input.returnPickupTime <= pickupTime) throw badRequest('Return pickup time must be later than the outbound pickup time');
  }
  const scheduled = await validateBookingWindow({ travelDate, pickupTime }, office.timezone);
  // One cab per shift day: a 7 PM shift's 1 AM cab belongs to the day the shift started.
  const shiftDay = shiftDate ?? workDayOf(travelDate, pickupTime, winStart, winEnd);
  if (await hasCabForDay(actor.id, shiftDay)) throw shiftDayTaken(shiftDay);
  const legs: Array<{ leg: 'OUTBOUND' | 'RETURN'; pickupTime: string; scheduled: Date; pickup: string; drop: string }> = [
    { leg: 'OUTBOUND', pickupTime, scheduled, pickup: pickupLocation, drop: dropLocation },
  ];
  if (input.tripType === 'ROUND_TRIP') {
    const ret = localToUtc(travelDate, input.returnPickupTime!, office.timezone);
    if (!ret) throw badRequest('Invalid return pickup time');
    legs.push({ leg: 'RETURN', pickupTime: input.returnPickupTime!, scheduled: ret, pickup: dropLocation, drop: pickupLocation });
  }
  const approvalRequired = !!policy.booking?.approvalRequired;
  const status: BookingStatus = approvalRequired ? 'PENDING_APPROVAL' : 'REQUESTED';
  const tripGroupId = crypto.randomUUID();

  try {
    const bookings = await withTransaction(async (tx) => {
      const created = [];
      for (const leg of legs) {
        const reference = await makeReference(tx.session, travelDate);
        const [b] = await CabRequest.create(
          [
            {
              reference,
              employee: employee._id,
              employeeUser: actor.id,
              officeLocation: office.code,
              pickupLocation: leg.pickup,
              dropLocation: leg.drop,
              travelDate,
              shiftDate,
              direction: leg.leg === 'RETURN' ? (direction === 'IN' ? 'OUT' : 'IN') : direction,
              shiftStart,
              shiftEnd,
              reportBy: leg.leg === 'OUTBOUND' ? reportBy : undefined,
              pickupTimeSet: leg.leg === 'OUTBOUND' ? pickupTimeSet : true,
              pickupTime: leg.pickupTime,
              timezone: office.timezone,
              scheduledPickupAt: leg.scheduled,
              passengers: input.passengers,
              tripType: input.tripType,
              leg: leg.leg,
              tripGroupId,
              shift: input.shift || undefined,
              notes: input.notes,
              status,
              approvalRequired,
              // the return leg reuses the request id with a suffix to stay idempotent
              clientRequestId: leg.leg === 'OUTBOUND' ? input.clientRequestId : `${input.clientRequestId}:return`,
              openSlotKey: `${actor.id}:${leg.scheduled.toISOString()}`,
              shiftDayKey: `${actor.id}:${shiftDay}:${leg.leg}`,
              workDay: shiftDay,
            },
          ],
          { session: tx.session },
        );
        await TripStatusHistory.create([{ booking: b._id, to: status, event: 'REQUESTED', actor: actor.id, actorRole: actor.role }], { session: tx.session });
        await enqueueEmail(tx.session, {
          idempotencyKey: `booking-submitted:${b._id}`,
          template: 'BOOKING_SUBMITTED',
          to: employee.email,
          toUserId: actor.id,
          params: { ...bookingEmailParams(b, employee.fullName), approvalRequired },
          relatedBookingId: String(b._id),
          preference: 'emailOnSubmitted',
        });
        await notifyCoordinators(tx, office.code, {
          type: 'BOOKING_CREATED',
          title: approvalRequired ? 'Cab request awaiting approval' : 'New cab request',
          body: `${employee.fullName} · ${b.reference} · ${b.travelDate} ${fmt12h(b.pickupTime)}`,
          data: { bookingId: String(b._id), reference: b.reference },
          idempotencyKey: `booking-created:${b._id}`,
        });
        tx.afterCommit(() => broadcastBookingUpdate(b));
        created.push(b);
      }
      await audit(actor, 'BOOKING_CREATED', 'CabRequest', created[0]._id, `Booking ${created.map((c) => c.reference).join(', ')} requested`, { tripType: input.tripType }, tx.session);
      return created;
    });
    return { booking: bookings[0], legs: bookings, duplicate: false };
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const again = await CabRequest.findOne({ employeeUser: actor.id, clientRequestId: input.clientRequestId }).lean();
      if (again) return { booking: again, duplicate: true };
      if (err.keyPattern?.shiftDayKey) throw shiftDayTaken(shiftDay);
      throw new AppError(409, 'DUPLICATE_BOOKING', 'You already have an open booking for this pickup time');
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Employee views (resource-level: only their own bookings)
// ---------------------------------------------------------------------------
export async function listMyBookings(actor: Actor, p: Pagination, scopeParam?: string) {
  const filter: Record<string, unknown> = { employeeUser: actor.id };
  if (scopeParam === 'upcoming') filter.status = { $in: OPEN_STATUSES };
  if (scopeParam === 'past') filter.status = { $in: TERMINAL_STATUSES };
  const [items, total] = await Promise.all([
    CabRequest.find(filter)
      .sort(scopeParam === 'upcoming' ? { scheduledPickupAt: 1 } : { scheduledPickupAt: -1 })
      .skip((p.page - 1) * p.pageSize)
      .limit(p.pageSize)
      .populate({ path: 'currentAssignment', select: 'driver vehicle acknowledgedAt arrivedAt startedAt completedAt', populate: [{ path: 'driver', select: 'fullName phone' }, { path: 'vehicle', select: 'registrationNumber model' }] })
      .lean(),
    CabRequest.countDocuments(filter),
  ]);
  return paged(items, total, p);
}

/** Full booking view for its owner, including the ride-start PIN while it is valid. */
export async function getMyBooking(actor: Actor, id: string) {
  if (!mongoose.isValidObjectId(id)) throw notFound('Booking');
  const booking = await CabRequest.findOne({ _id: id, employeeUser: actor.id }).lean();
  if (!booking) throw notFound('Booking'); // same response for "not yours" and "missing" (no IDOR oracle)
  const assignment = booking.currentAssignment
    ? await CabAssignment.findById(booking.currentAssignment).populate('driver', 'fullName phone').populate('vehicle', 'registrationNumber model vehicleType').lean()
    : null;
  let pin: { code: string; expiresAt: Date } | null = null;
  let pinStatus: string | null = null;
  if (assignment && ['ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED'].includes(booking.status)) {
    const cred = await RideStartCredential.findOne({ assignment: assignment._id, employeeUser: actor.id }).sort({ createdAt: -1 }).select('+pinCipher').lean();
    pinStatus = cred?.status ?? null;
    if (cred && cred.status === 'ACTIVE' && cred.expiresAt > new Date()) pin = { code: decrypt(cred.pinCipher), expiresAt: cred.expiresAt };
  }
  const history = await TripStatusHistory.find({ booking: booking._id }).sort({ createdAt: 1 }).select('from to event reason actorRole createdAt').lean();
  return {
    ...booking,
    assignment: assignment
      ? {
          _id: assignment._id,
          driver: assignment.driver,
          vehicle: assignment.vehicle,
          acknowledgedAt: assignment.acknowledgedAt,
          enRouteAt: assignment.enRouteAt,
          arrivedAt: assignment.arrivedAt,
          startedAt: assignment.startedAt,
          completedAt: assignment.completedAt,
        }
      : null,
    pin,
    pinStatus,
    history,
    canCancel: EMPLOYEE_CANCELLABLE.includes(booking.status as BookingStatus),
    canRequestCancellation: CANCELLATION_REQUESTABLE.includes(booking.status as BookingStatus) && booking.cancellationRequest?.status !== 'PENDING',
  };
}

/** Before a cab is assigned the employee cancels directly; afterwards they request it (until the trip starts). */
const EMPLOYEE_CANCELLABLE: BookingStatus[] = ['REQUESTED', 'PENDING_APPROVAL', 'APPROVED'];
const CANCELLATION_REQUESTABLE: BookingStatus[] = ['ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED'];

export async function cancelMyBooking(actor: Actor, id: string, reason: string) {
  if (!mongoose.isValidObjectId(id)) throw notFound('Booking');
  const booking = await CabRequest.findOne({ _id: id, employeeUser: actor.id }).lean();
  if (!booking) throw notFound('Booking');
  if (!EMPLOYEE_CANCELLABLE.includes(booking.status as BookingStatus)) {
    throw new AppError(
      422,
      'CANCELLATION_NOT_ALLOWED',
      CANCELLATION_REQUESTABLE.includes(booking.status as BookingStatus)
        ? 'A cab is already assigned, so this booking can no longer be cancelled directly. Send a cancellation request to the admin instead.'
        : `This booking is ${booking.status} and can no longer be cancelled`,
    );
  }
  return cancelBookingInternal(actor, booking._id, reason, EMPLOYEE_CANCELLABLE);
}

/** Employee asks the transport team to cancel a booking that already has a cab. */
export async function requestCancellation(actor: Actor, id: string, reason: string) {
  if (!mongoose.isValidObjectId(id)) throw notFound('Booking');
  return withTransaction(async (tx) => {
    const updated = await CabRequest.findOneAndUpdate(
      { _id: id, employeeUser: actor.id, status: { $in: CANCELLATION_REQUESTABLE }, 'cancellationRequest.status': { $ne: 'PENDING' } },
      { $set: { cancellationRequest: { status: 'PENDING', reason, requestedAt: new Date() } } },
      { new: true, session: tx.session },
    );
    if (!updated) {
      const b = await CabRequest.findOne({ _id: id, employeeUser: actor.id }).session(tx.session).lean();
      if (!b) throw notFound('Booking');
      if (b.cancellationRequest?.status === 'PENDING') throw new AppError(409, 'ALREADY_REQUESTED', 'You have already asked to cancel this booking. The admin will respond soon.');
      throw new AppError(422, 'CANCELLATION_NOT_ALLOWED', EMPLOYEE_CANCELLABLE.includes(b.status as BookingStatus) ? 'No cab is assigned yet: you can cancel this booking directly.' : `This booking is ${b.status} and can no longer be cancelled`);
    }
    const notice = {
      type: 'CANCELLATION_REQUESTED',
      title: 'Cancellation requested',
      body: `${updated.reference} (${updated.travelDate} ${updated.pickupTime}): ${reason}`,
      data: { bookingId: String(updated._id) },
      idempotencyKey: `cancel-request:${updated._id}:${updated.cancellationRequest!.requestedAt!.getTime()}`,
    };
    await notifyCoordinators(tx, updated.officeLocation, notice);
    const admins = await User.find({ role: 'ADMIN', status: 'ACTIVE' }, { _id: 1 }).session(tx.session).lean();
    for (const a of admins) await notifyInApp(tx, { userId: String(a._id), ...notice, idempotencyKey: `${notice.idempotencyKey}:${a._id}` });
    await audit(actor, 'CANCELLATION_REQUESTED', 'CabRequest', updated._id, `Cancellation requested for ${updated.reference}`, { reason }, tx.session);
    tx.afterCommit(() => broadcastBookingUpdate(updated));
    return updated;
  });
}

/** Transport team approves (booking is cancelled) or declines (booking stays) an employee's request. */
export async function decideCancellationRequest(actor: Actor, id: string, decision: 'APPROVED' | 'DECLINED', note?: string) {
  const booking = await CabRequest.findById(id).lean();
  if (!booking) throw notFound('Booking');
  await assertBookingInScope(actor, booking);
  const req = booking.cancellationRequest;
  if (req?.status !== 'PENDING') throw new AppError(409, 'NO_PENDING_REQUEST', 'There is no pending cancellation request for this booking');
  const decided = { 'cancellationRequest.status': decision, 'cancellationRequest.decidedBy': actor.id, 'cancellationRequest.decidedAt': new Date(), 'cancellationRequest.note': note };
  if (decision === 'APPROVED') {
    if (!OPEN_STATUSES.includes(booking.status as BookingStatus)) throw new AppError(409, 'INVALID_STATE', `This booking is ${booking.status} and can no longer be cancelled`);
    return cancelBookingInternal(actor, booking._id, `Cancelled at the employee's request: ${req.reason}`, ['REQUESTED', 'PENDING_APPROVAL', 'APPROVED', ...ACTIVE_TRIP_STATUSES], decided);
  }
  return withTransaction(async (tx) => {
    const updated = await CabRequest.findOneAndUpdate({ _id: booking._id, 'cancellationRequest.status': 'PENDING' }, { $set: decided }, { new: true, session: tx.session });
    if (!updated) throw new AppError(409, 'NO_PENDING_REQUEST', 'This request was already handled');
    await notifyInApp(tx, {
      userId: String(updated.employeeUser),
      type: 'CANCELLATION_DECLINED',
      title: 'Cancellation request declined',
      body: `${updated.reference} is still booked. ${note ?? ''}`.trim(),
      data: { bookingId: String(updated._id) },
    });
    await audit(actor, 'CANCELLATION_REQUEST_DECLINED', 'CabRequest', updated._id, `Cancellation request for ${updated.reference} declined`, { note }, tx.session);
    tx.afterCommit(() => broadcastBookingUpdate(updated));
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Cancellation (shared by employee / coordinator / admin)
// ---------------------------------------------------------------------------
export async function cancelBookingInternal(actor: Actor, bookingId: unknown, reason: string, allowedFrom: BookingStatus[], extraSet: Record<string, unknown> = {}) {
  if (!reason?.trim()) throw badRequest('A cancellation reason is required');
  return withTransaction(async (tx) => {
    const current = await CabRequest.findById(bookingId).session(tx.session);
    if (!current) throw notFound('Booking');
    const wasInProgress = current.status === 'IN_PROGRESS';
    const updated = await transitionBooking(tx, current._id, allowedFrom.filter((s) => s === current.status).length ? [current.status as BookingStatus] : allowedFrom, 'CANCELLED', {
      actor,
      event: wasInProgress ? 'TRIP_INTERRUPTED' : 'CANCELLED',
      reason,
      set: { cancelledBy: actor.id, cancelledByRole: actor.role, cancellationReason: reason, cancelledAt: new Date(), ...extraSet },
      unset: ['openSlotKey', 'shiftDayKey'],
    });
    await endActiveAssignment(tx, updated, 'CANCELLED', actor, reason);
    const employee = await Employee.findById(updated.employee).session(tx.session).lean();
    if (employee) {
      await enqueueEmail(tx.session, {
        idempotencyKey: `ride-cancelled:${updated._id}`,
        template: 'RIDE_CANCELLED',
        to: employee.email,
        toUserId: String(updated.employeeUser),
        params: { ...bookingEmailParams(updated, employee.fullName), reason: actor.role === 'EMPLOYEE' ? 'Cancelled by you' : reason },
        relatedBookingId: String(updated._id),
        preference: 'emailOnCancelled',
      });
      if (actor.role !== 'EMPLOYEE') {
        await notifyInApp(tx, {
          userId: String(updated.employeeUser),
          type: 'BOOKING_CANCELLED',
          title: 'Booking cancelled',
          body: `${updated.reference} was cancelled: ${reason}`,
          data: { bookingId: String(updated._id) },
        });
      }
    }
    if (actor.role === 'EMPLOYEE') {
      await notifyCoordinators(tx, updated.officeLocation, {
        type: 'BOOKING_CANCELLED',
        title: 'Booking cancelled by employee',
        body: `${updated.reference} · ${reason}`,
        data: { bookingId: String(updated._id) },
      });
    }
    if (wasInProgress) {
      await alertOperations(
        { type: 'TRIP_INTERRUPTED', message: `Trip ${updated.reference} was ended while in progress: ${reason}`, officeLocation: updated.officeLocation, bookingId: String(updated._id) },
        tx,
      );
    }
    await audit(actor, wasInProgress ? 'TRIP_INTERRUPTED' : 'BOOKING_CANCELLED', 'CabRequest', updated._id, `Booking ${updated.reference} cancelled`, { reason }, tx.session);
    return updated;
  });
}

/** Ends the booking's active assignment (if any), revokes its PIN and notifies the driver. */
export async function endActiveAssignment(
  tx: TxContext,
  booking: { _id: unknown; reference: string; currentAssignment?: unknown },
  status: 'CANCELLED' | 'REASSIGNED' | 'DECLINED' | 'NO_SHOW',
  actor: Actor,
  reason: string,
) {
  const assignment = await CabAssignment.findOneAndUpdate(
    { booking: booking._id, status: 'ACTIVE' },
    { $set: { status, endedAt: new Date(), endedBy: actor.id || undefined, endReason: reason } },
    { new: true, session: tx.session },
  );
  if (!assignment) return null;
  await RideStartCredential.updateMany(
    { assignment: assignment._id, status: 'ACTIVE' },
    { $set: { status: 'REVOKED', revokedAt: new Date(), revokeReason: status } },
    { session: tx.session },
  );
  await refreshDriverAvailability(assignment.driver, tx.session);
  if (status !== 'DECLINED') {
    const driver = await Driver.findById(assignment.driver).session(tx.session).lean();
    if (driver?.user) {
      await notifyInApp(tx, {
        userId: String(driver.user),
        type: status === 'REASSIGNED' ? 'RIDE_REASSIGNED' : 'RIDE_CANCELLED',
        title: status === 'REASSIGNED' ? 'Ride reassigned to another driver' : status === 'NO_SHOW' ? 'Ride closed as no-show' : 'Ride cancelled',
        body: `${booking.reference} is no longer assigned to you. ${reason}`,
        data: { assignmentId: String(assignment._id), bookingId: String(booking._id) },
        idempotencyKey: `assignment-ended:${assignment._id}`,
      });
    }
  }
  return assignment;
}

// ---------------------------------------------------------------------------
// Coordinator / admin booking management
// ---------------------------------------------------------------------------
export const bookingListSchema = z.object({
  // Work day (shift day): a 7 PM shift's 4 AM cab belongs to the day the shift started.
  workDay: z.string().regex(DATE_RE).optional(),
  date: z.string().regex(DATE_RE).optional(),
  dateFrom: z.string().regex(DATE_RE).optional(),
  dateTo: z.string().regex(DATE_RE).optional(),
  officeLocation: z.string().trim().toUpperCase().optional(),
  shift: z.string().trim().toUpperCase().optional(),
  status: z.string().optional(), // comma separated
  driverId: z.string().optional(),
  vehicleId: z.string().optional(),
  employeeId: z.string().optional(),
  delayed: z.enum(['true', 'false']).optional(),
  flagged: z.enum(['true', 'false']).optional(),
  cancellationRequested: z.enum(['true']).optional(),
});

export async function listBookings(actor: Actor, p: Pagination, f: z.infer<typeof bookingListSchema>) {
  const scope = await bookingScope(actor);
  const match: Record<string, unknown> = { ...bookingScopeFilter(scope) };
  if (f.officeLocation) {
    assertInScope(scope.offices, f.officeLocation);
    match.officeLocation = f.officeLocation;
  }
  if (f.workDay) Object.assign(match, workDayMatch(f.workDay));
  else if (f.date) match.travelDate = f.date;
  else if (f.dateFrom || f.dateTo) match.travelDate = { ...(f.dateFrom ? { $gte: f.dateFrom } : {}), ...(f.dateTo ? { $lte: f.dateTo } : {}) };
  if (f.shift) match.shift = f.shift;
  if (f.status) match.status = { $in: f.status.split(',').map((s) => s.trim().toUpperCase()) };
  if (f.delayed) match.isDelayed = f.delayed === 'true';
  if (f.flagged) match.flaggedForReview = f.flagged === 'true';
  if (f.cancellationRequested) match['cancellationRequest.status'] = 'PENDING';
  if (f.employeeId && mongoose.isValidObjectId(f.employeeId)) match.employee = new mongoose.Types.ObjectId(f.employeeId);

  const sort = resolveSort(p.sort, ['scheduledPickupAt', 'reference', 'status', 'createdAt', 'travelDate'], { scheduledPickupAt: 1, _id: 1 });
  const pipeline: PipelineStage[] = [
    { $match: match },
    { $lookup: { from: 'employees', localField: 'employee', foreignField: '_id', as: 'emp', pipeline: [{ $project: { fullName: 1, employeeId: 1, email: 1, phone: 1, route: 1 } }] } },
    { $unwind: { path: '$emp', preserveNullAndEmptyArrays: true } },
    { $lookup: { from: 'cabassignments', localField: 'currentAssignment', foreignField: '_id', as: 'asg' } },
    { $unwind: { path: '$asg', preserveNullAndEmptyArrays: true } },
  ];
  if (f.driverId && mongoose.isValidObjectId(f.driverId)) pipeline.push({ $match: { 'asg.driver': new mongoose.Types.ObjectId(f.driverId) } });
  if (f.vehicleId && mongoose.isValidObjectId(f.vehicleId)) pipeline.push({ $match: { 'asg.vehicle': new mongoose.Types.ObjectId(f.vehicleId) } });
  if (p.q) {
    const rx = new RegExp(escapeRegex(p.q), 'i');
    pipeline.push({ $match: { $or: [{ reference: rx }, { 'emp.fullName': rx }, { 'emp.employeeId': rx }, { 'emp.route': rx }, { pickupLocation: rx }, { dropLocation: rx }] } });
  }
  pipeline.push(
    { $lookup: { from: 'drivers', localField: 'asg.driver', foreignField: '_id', as: 'drv', pipeline: [{ $project: { fullName: 1, driverCode: 1, phone: 1 } }] } },
    { $lookup: { from: 'vehicles', localField: 'asg.vehicle', foreignField: '_id', as: 'veh', pipeline: [{ $project: { registrationNumber: 1, capacity: 1 } }] } },
    {
      $lookup: {
        from: 'emailoutboxes',
        let: { aid: '$currentAssignment' },
        pipeline: [
          { $match: { $expr: { $and: [{ $ne: ['$$aid', null] }, { $in: ['$idempotencyKey', [{ $concat: ['cab-assigned:', { $toString: '$$aid' }] }, { $concat: ['assignment-changed:', { $toString: '$$aid' }] }]] }] } } },
          { $project: { status: 1, lastError: 1, acceptedAt: 1, attempts: 1 } },
        ],
        as: 'mail',
      },
    },
    {
      $facet: {
        items: [
          { $sort: sort },
          { $skip: (p.page - 1) * p.pageSize },
          { $limit: p.pageSize },
          {
            $project: {
              reference: 1, status: 1, travelDate: 1, pickupTime: 1, scheduledPickupAt: 1, timezone: 1, pickupLocation: 1, dropLocation: 1,
              passengers: 1, shift: 1, tripType: 1, leg: 1, officeLocation: 1, notes: 1, isDelayed: 1, delayReason: 1, flaggedForReview: 1, flagReason: 1, cancellationRequest: 1, createdAt: 1,
              direction: 1, reportBy: 1, pickupTimeSet: 1, shiftStart: 1, shiftEnd: 1,
              employee: '$emp',
              assignment: { _id: '$asg._id', acknowledgedAt: '$asg.acknowledgedAt', status: '$asg.status', tripId: '$asg.tripId', tripName: '$asg.tripName' },
              driver: { $first: '$drv' },
              vehicle: { $first: '$veh' },
              notification: { $first: '$mail' },
            },
          },
        ],
        total: [{ $count: 'n' }],
      },
    },
  );
  const [res] = await CabRequest.aggregate(pipeline);
  return paged(res.items, res.total[0]?.n ?? 0, p);
}

export async function getBookingForOperations(actor: Actor, id: string) {
  if (!mongoose.isValidObjectId(id)) throw notFound('Booking');
  const booking = await CabRequest.findById(id).populate('employee', 'fullName employeeId email phone officeLocation').lean();
  if (!booking) throw notFound('Booking');
  await assertBookingInScope(actor, booking);
  const [assignments, history, emails, pinState] = await Promise.all([
    CabAssignment.find({ booking: booking._id }).sort({ createdAt: -1 }).populate('driver', 'fullName driverCode phone').populate('vehicle', 'registrationNumber model capacity').populate('assignedBy', 'name').lean(),
    TripStatusHistory.find({ booking: booking._id }).sort({ createdAt: 1 }).populate('actor', 'name').lean(),
    EmailOutbox.find({ relatedBooking: booking._id }).sort({ createdAt: -1 }).select('template to status attempts lastError acceptedAt createdAt provider').lean(),
    booking.currentAssignment ? RideStartCredential.findOne({ assignment: booking.currentAssignment }).sort({ createdAt: -1 }).select('status attempts maxAttempts expiresAt usedAt').lean() : null,
  ]);
  // Coordinators never see the PIN itself, only its state.
  return { ...booking, assignments, history, emails, pinState };
}

export async function approveBooking(actor: Actor, id: string) {
  const booking = await CabRequest.findById(id).lean();
  if (!booking) throw notFound('Booking');
  await assertBookingInScope(actor, booking);
  return withTransaction(async (tx) => {
    const updated = await transitionBooking(tx, booking._id, ['PENDING_APPROVAL'], 'APPROVED', { actor, event: 'APPROVED', set: { approvedBy: actor.id, approvedAt: new Date() } });
    const emp = await Employee.findById(updated.employee).session(tx.session).lean();
    if (emp) {
      await enqueueEmail(tx.session, {
        idempotencyKey: `booking-approved:${updated._id}`,
        template: 'BOOKING_APPROVED',
        to: emp.email,
        toUserId: String(updated.employeeUser),
        params: bookingEmailParams(updated, emp.fullName),
        relatedBookingId: String(updated._id),
        preference: 'emailOnApprovalDecision',
      });
    }
    await notifyInApp(tx, { userId: String(updated.employeeUser), type: 'BOOKING_APPROVED', title: 'Cab request approved', body: `${updated.reference} was approved`, data: { bookingId: String(updated._id) } });
    await audit(actor, 'BOOKING_APPROVED', 'CabRequest', updated._id, `Booking ${updated.reference} approved`, undefined, tx.session);
    return updated;
  });
}

export async function rejectBooking(actor: Actor, id: string, reason: string) {
  if (!reason?.trim()) throw badRequest('A rejection reason is required');
  const booking = await CabRequest.findById(id).lean();
  if (!booking) throw notFound('Booking');
  await assertBookingInScope(actor, booking);
  return withTransaction(async (tx) => {
    const updated = await transitionBooking(tx, booking._id, ['PENDING_APPROVAL', 'REQUESTED', 'APPROVED'].filter((s) => s === booking.status) as BookingStatus[], 'REJECTED', {
      actor,
      event: 'REJECTED',
      reason,
      set: { rejectedBy: actor.id, rejectionReason: reason },
      unset: ['openSlotKey', 'shiftDayKey'],
    });
    const emp = await Employee.findById(updated.employee).session(tx.session).lean();
    if (emp) {
      await enqueueEmail(tx.session, {
        idempotencyKey: `booking-rejected:${updated._id}`,
        template: 'BOOKING_REJECTED',
        to: emp.email,
        toUserId: String(updated.employeeUser),
        params: { ...bookingEmailParams(updated, emp.fullName), reason },
        relatedBookingId: String(updated._id),
        preference: 'emailOnApprovalDecision',
      });
    }
    await notifyInApp(tx, { userId: String(updated.employeeUser), type: 'BOOKING_REJECTED', title: 'Cab request rejected', body: `${updated.reference}: ${reason}`, data: { bookingId: String(updated._id) } });
    await audit(actor, 'BOOKING_REJECTED', 'CabRequest', updated._id, `Booking ${updated.reference} rejected`, { reason }, tx.session);
    return updated;
  });
}

export async function cancelBookingByOperations(actor: Actor, id: string, reason: string) {
  const booking = await CabRequest.findById(id).lean();
  if (!booking) throw notFound('Booking');
  await assertBookingInScope(actor, booking);
  return cancelBookingInternal(actor, booking._id, reason, ['REQUESTED', 'PENDING_APPROVAL', 'APPROVED', ...ACTIVE_TRIP_STATUSES]);
}

export async function markDelayed(actor: Actor, id: string, reason: string) {
  const booking = await CabRequest.findById(id).lean();
  if (!booking) throw notFound('Booking');
  await assertBookingInScope(actor, booking);
  if (!OPEN_STATUSES.includes(booking.status as BookingStatus)) throw new AppError(409, 'INVALID_STATE', 'Only open bookings can be marked delayed');
  return withTransaction(async (tx) => {
    const updated = await CabRequest.findByIdAndUpdate(booking._id, { $set: { isDelayed: true, delayReason: reason } }, { new: true, session: tx.session });
    await recordEvent(tx, updated!, 'DELAYED', actor, { reason, assignmentId: updated!.currentAssignment });
    const emp = await Employee.findById(booking.employee).session(tx.session).lean();
    if (emp) {
      await enqueueEmail(tx.session, {
        idempotencyKey: `delayed:${booking._id}:${Date.now()}`,
        template: 'TRIP_DELAYED',
        to: emp.email,
        toUserId: String(booking.employeeUser),
        params: { ...bookingEmailParams(booking, emp.fullName), reason },
        relatedBookingId: String(booking._id),
        preference: 'emailOnDelay',
      });
    }
    await notifyInApp(tx, { userId: String(booking.employeeUser), type: 'BOOKING_DELAYED', title: 'Your cab is delayed', body: `${booking.reference}: ${reason}`, data: { bookingId: String(booking._id) } });
    tx.afterCommit(() => broadcastBookingUpdate(updated!));
    await audit(actor, 'BOOKING_MARKED_DELAYED', 'CabRequest', booking._id, `Booking ${booking.reference} marked delayed`, { reason }, tx.session);
    return updated;
  });
}

export async function clearFlag(actor: Actor, id: string, note: string) {
  const booking = await CabRequest.findById(id).lean();
  if (!booking) throw notFound('Booking');
  await assertBookingInScope(actor, booking);
  await CabRequest.updateOne({ _id: booking._id }, { $set: { flaggedForReview: false }, $unset: { flagReason: 1 } });
  await recordEvent(null, booking, 'REVIEW_CLEARED', actor, { reason: note });
  await audit(actor, 'BOOKING_REVIEW_CLEARED', 'CabRequest', booking._id, `Review flag cleared on ${booking.reference}`, { note });
}

