import type { TxContext } from '../db.js';
import type { ExceptionType } from '../domain.js';
import { logger } from '../logger.js';
import { User } from '../models/User.js';
import { notifyCoordinators } from './lifecycle.js';
import { notifyInApp } from './notification.service.js';

export type AlertInput = {
  type: ExceptionType;
  message: string;
  /** Coordinators of this office are alerted; without one, active admins are. */
  officeLocation?: string;
  bookingId?: string;
  /** Same key => alerted once (repeated monitor runs don't repeat the alert). */
  dedupeKey?: string;
};

const TITLES: Partial<Record<ExceptionType, string>> = {
  EMPLOYEE_DEACTIVATED_WITH_BOOKINGS: 'Deactivated employee has upcoming rides',
  DRIVER_UNAVAILABLE_WITH_ASSIGNMENTS: 'Ride needs a new driver',
  VEHICLE_UNAVAILABLE_WITH_ASSIGNMENTS: 'Ride needs a new vehicle',
  TRIP_INTERRUPTED: 'Trip ended while in progress',
  EMAIL_FAILED: 'Email could not be sent',
  NO_SHOW: "Employee didn't show up",
  DOCUMENT_EXPIRY: 'Document expiring',
};

/** Tells the transport team about something that needs their attention, via in-app notifications. */
export async function alertOperations(input: AlertInput, tx?: TxContext | null) {
  const n = {
    type: input.type,
    title: TITLES[input.type] ?? 'Needs attention',
    body: input.message,
    data: input.bookingId ? { bookingId: input.bookingId } : {},
    idempotencyKey: input.dedupeKey ? `alert:${input.dedupeKey}` : undefined,
  };
  if (input.officeLocation) {
    await notifyCoordinators(tx ?? null, input.officeLocation, n);
  } else {
    const admins = await User.find({ role: 'ADMIN', status: 'ACTIVE' }, { _id: 1 }).session(tx?.session ?? null).lean();
    for (const a of admins) await notifyInApp(tx ?? null, { userId: String(a._id), ...n, idempotencyKey: n.idempotencyKey ? `${n.idempotencyKey}:${a._id}` : undefined });
  }
  logger.info({ type: input.type, office: input.officeLocation }, 'Operations alerted');
}
