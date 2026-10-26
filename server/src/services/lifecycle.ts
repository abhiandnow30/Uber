import type { TxContext } from '../db.js';
import { canTransitionBooking, type BookingStatus } from '../domain.js';
import { CabRequest, TripStatusHistory, type CabRequestDoc } from '../models/booking.js';
import { Coordinator } from '../models/Coordinator.js';
import { User } from '../models/User.js';
import { emitToOperations, emitToUser } from '../realtime.js';
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
  opts: { actor: Actor; event: string; reason?: string; assignmentId?: unknown; set?: Record<string, unknown>; unset?: string[]; meta?: Record<string, unknown> },
): Promise<CabRequestDoc> {
  for (const f of from) {
    if (!canTransitionBooking(f, to)) throw new Error(`Programming error: ${f} → ${to} is not an allowed transition`);
  }
  const update: Record<string, unknown> = { $set: { status: to, ...(opts.set ?? {}) } };
  if (opts.unset?.length) update.$unset = Object.fromEntries(opts.unset.map((k) => [k, 1]));
  const updated = await CabRequest.findOneAndUpdate({ _id: bookingId, status: { $in: from } }, update, { new: true, session: tx.session });
  if (!updated) {
    const current = await CabRequest.findById(bookingId).session(tx.session).lean();
    if (!current) throw new AppError(404, 'NOT_FOUND', 'Booking not found');
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
  tx.afterCommit(() => broadcastBookingUpdate(updated));
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

export function broadcastBookingUpdate(b: { _id: unknown; reference: string; status: string; officeLocation: string; employeeUser: unknown; isDelayed?: boolean | null }) {
  const payload = { bookingId: String(b._id), reference: b.reference, status: b.status, isDelayed: !!b.isDelayed };
  emitToOperations(b.officeLocation, 'booking:updated', payload);
  emitToUser(String(b.employeeUser), 'booking:updated', payload);
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
