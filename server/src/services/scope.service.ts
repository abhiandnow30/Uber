import { Coordinator } from '../models/Coordinator.js';
import { forbidden } from '../utils/errors.js';
import type { Actor } from './audit.service.js';

/**
 * Operational scope. Admins: all offices (null = unrestricted). Coordinators: only
 * the offices assigned to them by an admin.
 */
export async function officeScope(actor: Actor): Promise<string[] | null> {
  if (actor.role === 'ADMIN' || actor.role === 'SYSTEM') return null;
  if (actor.role === 'COORDINATOR') {
    const c = await Coordinator.findOne({ user: actor.id }).lean();
    return c?.officeLocations ?? [];
  }
  throw forbidden();
}

export function assertInScope(scope: string[] | null, office: string | null | undefined) {
  if (scope === null) return;
  if (!office || !scope.includes(office)) throw forbidden('This record is outside your assigned office locations');
}

/** Mongo filter fragment restricting a query to the scope. */
export function scopeFilter(scope: string[] | null, field = 'officeLocation') {
  return scope === null ? {} : { [field]: { $in: scope } };
}

/** Booking scope = office scope: coordinators cover every shift of their offices. */
export type BookingScope = { offices: string[] | null };

export async function bookingScope(actor: Actor): Promise<BookingScope> {
  return { offices: await officeScope(actor) };
}

export function bookingScopeFilter(scope: BookingScope) {
  return scopeFilter(scope.offices);
}

export async function assertBookingInScope(actor: Actor, booking: { officeLocation: string }) {
  assertInScope(await officeScope(actor), booking.officeLocation);
}
