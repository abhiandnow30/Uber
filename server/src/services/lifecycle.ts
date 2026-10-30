import type { TxContext } from '../db.js';
import { canTransitionBooking, TERMINAL_STATUSES, type BookingStatus } from '../domain.js';
import { CabAssignment, CabRequest, TripStatusHistory, type CabRequestDoc } from '../models/booking.js';
import { Coordinator } from '../models/Coordinator.js';
import { Driver } from '../models/Driver.js';
import { User } from '../models/User.js';
import { emitToOperations, emitToUser, noteChange } from '../realtime.js';
import { AppError } from '../utils/errors.js';
import { fmt12h } from '../utils/time.js';
import type { Actor } from './audit.service.js';
import { notifyInApp } from './notification.service.js';

/**
 * Atomic, state-machine-checked booking transition. The update only matches when
 * the booking is still in one of the expected states, so concurrent requests
 * (double clicks, two coordinators, duplicate PIN submissions) cannot both win.
 */
export async function transitionBooking(
  tx: TxContext,
  bookingId: unknown,
  from: BookingStatus[],
  to: BookingStatus,
  opts: {
    actor: Actor;
    event: string;
    reason?: string;
    assignmentId?: unknown;
    // Only while this is still the ride's cab: a driver's tap can't land on a ride just given to another cab.
    current?: unknown;
    set?: Record<string, unknown>;
    unset?: string[];
    meta?: Record<string, unknown>;
  },
): Promise<CabRequestDoc> {
  for (const f of from) {
    if (!canTransitionBooking(f, to)) throw new Error(`Programming error: ${f} → ${to} is not an allowed transition`);
  }
  // A finished ride (cancelled, completed...) is no longer running late.
  const update: Record<string, unknown> = { $set: { status: to, ...(TERMINAL_STATUSES.includes(to) ? { isDelayed: false } : {}), ...(opts.set ?? {}) } };
  if (opts.unset?.length) update.$unset = Object.fromEntries(opts.unset.map((k) => [k, 1]));
  const filter = { _id: bookingId, status: { $in: from }, ...(opts.current ? { currentAssignment: opts.current } : {}) };
  const updated = await CabRequest.findOneAndUpdate(filter, update, { new: true, session: tx.session });
  if (!updated) {
    const current = await CabRequest.findById(bookingId).session(tx.session).lean();
    if (!current) throw new AppError(404, 'NOT_FOUND', 'Booking not found');
    if (opts.current && from.includes(current.status as BookingStatus) && String(current.currentAssignment) !== String(opts.current)) {
      throw new AppError(409, 'ASSIGNMENT_NOT_ACTIVE', `${current.reference} is no longer assigned to this cab`);
    }
    throw new AppError(409, 'INVALID_TRANSITION', `Booking ${current.reference} is ${current.status}; cannot move to ${to}`);
  }
  const previous = from.length === 1 ? from[0] : undefined;
  await TripStatusHistory.create(
    [
      {
        booking: updated._id,
        assignment: opts.assignmentId ?? updated.currentAssignment,
        from: previous,
        to,
        event: opts.event,
        actor: opts.actor.id || undefined,
        actorRole: opts.actor.role,
        reason: opts.reason,
        meta: opts.meta,
      },
    ],
    { session: tx.session },
  );
  tx.afterCommit(() => broadcastBookingUpdate(updated, opts.assignmentId));
  return updated;
}

/** Record a non-status lifecycle event (acknowledged, PIN failed, delayed...). */
export async function recordEvent(
  tx: TxContext | null,
  booking: { _id: unknown; status: string },
  event: string,
  actor: Actor,
  opts: { assignmentId?: unknown; reason?: string; meta?: Record<string, unknown> } = {},
) {
  await TripStatusHistory.create(
    [{ booking: booking._id, assignment: opts.assignmentId, from: booking.status, to: booking.status, event, actor: actor.id || undefined, actorRole: actor.role, reason: opts.reason, meta: opts.meta }],
    { session: tx?.session },
  );
}

/**
 * A ride changed: its employee, its office's transport team and the driver of its cab (the one it
 * has now, or the one this change concerned) see it at once. Also covers background changes
 * (e.g. auto-cancel), which no API request announces.
 */
export async function broadcastBookingUpdate(
  b: { _id: unknown; reference: string; status: string; officeLocation: string; employeeUser: unknown; isDelayed?: boolean | null; currentAssignment?: unknown },
  assignmentId?: unknown,
) {
  const payload = { bookingId: String(b._id), reference: b.reference, status: b.status, isDelayed: !!b.isDelayed };
  emitToOperations(b.officeLocation, 'booking:updated', payload);
  emitToUser(String(b.employeeUser), 'booking:updated', payload);
  const cab = assignmentId ?? b.currentAssignment;
  const driverId = cab ? (await CabAssignment.findById(cab, { driver: 1 }).lean())?.driver : undefined;
  const driverUser = driverId ? (await Driver.findById(driverId, { user: 1 }).lean())?.user : undefined;
  noteChange({ users: [b.employeeUser, driverUser], offices: [b.officeLocation] });
}

/** In-app notification for every active coordinator scoped to the office. */
export async function notifyCoordinators(
  tx: TxContext | null,
  officeLocation: string,
  n: { type: string; title: string; body: string; data?: Record<string, unknown>; idempotencyKey?: string },
) {
  const coords = await Coordinator.find({ officeLocations: officeLocation }, { user: 1 }).session(tx?.session ?? null).lean();
  const active = await User.find({ _id: { $in: coords.map((c) => c.user) }, status: 'ACTIVE' }, { _id: 1 }).session(tx?.session ?? null).lean();
  for (const u of active) {
    await notifyInApp(tx, { userId: String(u._id), ...n, idempotencyKey: n.idempotencyKey ? `${n.idempotencyKey}:${u._id}` : undefined });
  }
}

export function bookingEmailParams(b: { reference: string; travelDate: string; pickupTime: string; pickupLocation: string; dropLocation: string }, name: string) {
  return {
    name,
    reference: b.reference,
    travelDate: b.travelDate,
    pickupTime: fmt12h(b.pickupTime),
    pickupLocation: b.pickupLocation,
    destination: b.dropLocation,
  };
}
