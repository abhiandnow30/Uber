/**
 * Domain enums and state machines. These are the single source of truth for which
 * transitions the backend permits; clients can never set a status directly.
 */

export const ROLES = ['ADMIN', 'COORDINATOR', 'EMPLOYEE', 'DRIVER'] as const;
export type Role = (typeof ROLES)[number];

// ---------------------------------------------------------------------------
// Account status (users of every role)
// ---------------------------------------------------------------------------
export const ACCOUNT_STATUSES = ['PENDING_ADMIN_REVIEW', 'INVITED', 'ACTIVE', 'INACTIVE', 'REJECTED', 'SUSPENDED'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const ACCOUNT_TRANSITIONS: Record<AccountStatus, AccountStatus[]> = {
  PENDING_ADMIN_REVIEW: ['INVITED', 'REJECTED'],
  INVITED: ['ACTIVE', 'INACTIVE'], // ACTIVE only via first sign-in (Microsoft, or mobile number for drivers/coordinators)
  ACTIVE: ['INACTIVE', 'SUSPENDED'],
  SUSPENDED: ['ACTIVE', 'INACTIVE'],
  INACTIVE: ['INVITED', 'ACTIVE'], // reactivate directly, or back to INVITED (active again on next sign-in)
  REJECTED: ['INVITED'],
};

export function canTransitionAccount(from: AccountStatus, to: AccountStatus) {
  return ACCOUNT_TRANSITIONS[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------
// Booking / trip status
// ---------------------------------------------------------------------------
export const BOOKING_STATUSES = [
  'REQUESTED',
  'PENDING_APPROVAL',
  'APPROVED',
  'ASSIGNED',
  'DRIVER_EN_ROUTE',
  'ARRIVED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'REJECTED',
  'NO_SHOW',
  // DELAYED is modelled as an exception flag (`isDelayed`) layered over the
  // lifecycle state, because a ride can be both ASSIGNED and late at once.
  'DELAYED',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const ASSIGNABLE_STATUSES: BookingStatus[] = ['REQUESTED', 'APPROVED'];
export const TERMINAL_STATUSES: BookingStatus[] = ['COMPLETED', 'CANCELLED', 'REJECTED', 'NO_SHOW'];
export const ACTIVE_TRIP_STATUSES: BookingStatus[] = ['ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'];
export const OPEN_STATUSES: BookingStatus[] = ['REQUESTED', 'PENDING_APPROVAL', 'APPROVED', ...ACTIVE_TRIP_STATUSES];

export const BOOKING_TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  REQUESTED: ['ASSIGNED', 'CANCELLED', 'REJECTED'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['ASSIGNED', 'CANCELLED', 'REJECTED'],
  // back to REQUESTED/APPROVED happens when the cab can't do the ride (breakdown, out of fuel...)
  // before the rider is picked up; → ASSIGNED again when a coordinator changes the cab (before it starts)
  ASSIGNED: ['DRIVER_EN_ROUTE', 'CANCELLED', 'REQUESTED', 'APPROVED', 'ASSIGNED'],
  DRIVER_EN_ROUTE: ['ARRIVED', 'CANCELLED', 'REQUESTED', 'APPROVED', 'ASSIGNED'],
  ARRIVED: ['IN_PROGRESS', 'NO_SHOW', 'CANCELLED', 'REQUESTED', 'APPROVED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'], // CANCELLED here = interrupted trip, coordinator/admin only
  COMPLETED: [],
  CANCELLED: [],
  REJECTED: [],
  NO_SHOW: [],
  DELAYED: [],
};

export function canTransitionBooking(from: BookingStatus, to: BookingStatus) {
  return BOOKING_TRANSITIONS[from]?.includes(to) ?? false;
}

export const TRIP_TYPES = ['ONE_WAY', 'ROUND_TRIP'] as const;
export const TRIP_LEGS = ['OUTBOUND', 'RETURN'] as const;

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------
export const ASSIGNMENT_STATUSES = ['ACTIVE', 'DECLINED', 'REASSIGNED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------
export const DRIVER_AVAILABILITY = ['AVAILABLE', 'ASSIGNED', 'ON_TRIP', 'OFFLINE', 'SUSPENDED'] as const;
export type DriverAvailability = (typeof DRIVER_AVAILABILITY)[number];
export const DRIVER_VERIFICATION = ['PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED'] as const;
export const DRIVER_EMPLOYMENT = ['ACTIVE', 'INACTIVE', 'SUSPENDED'] as const;

export const VEHICLE_STATUSES = ['ACTIVE', 'INACTIVE', 'MAINTENANCE'] as const;
export const VEHICLE_TYPES = ['SEDAN', 'HATCHBACK', 'SUV', 'MUV', 'VAN', 'MINIBUS'] as const;

// ---------------------------------------------------------------------------
// Access requests, PIN, notifications, exceptions
// ---------------------------------------------------------------------------
export const ACCESS_REQUEST_STATUSES = ['PENDING_ADMIN_REVIEW', 'INFO_REQUESTED', 'APPROVED', 'REJECTED'] as const;
export const PIN_STATUSES = ['ACTIVE', 'USED', 'REVOKED', 'EXPIRED', 'LOCKED'] as const;

export const EMAIL_STATUSES = [
  'PENDING', // queued in outbox
  'SENDING', // claimed by a worker
  'RETRYING', // transient failure, will retry with backoff
  'ACCEPTED', // provider accepted the message (NOT proof of delivery)
  'DELIVERED', // only set when delivery evidence is available
  'FAILED', // permanent failure or retries exhausted
  'SKIPPED', // disabled by notification preferences
] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export const EXCEPTION_TYPES = [
  'LATE_PICKUP',
  'OVERDUE_TRIP',
  'UNACKNOWLEDGED_ASSIGNMENT',
  'DRIVER_DECLINED',
  'NO_SHOW',
  'PIN_LOCKED',
  'EMPLOYEE_DEACTIVATED_WITH_BOOKINGS',
  'DRIVER_UNAVAILABLE_WITH_ASSIGNMENTS',
  'VEHICLE_UNAVAILABLE_WITH_ASSIGNMENTS',
  'TRIP_INTERRUPTED',
  'START_OVERRIDE',
  'COMPLETION_OVERRIDE',
  'EMAIL_FAILED',
  'DOCUMENT_EXPIRY',
] as const;
export type ExceptionType = (typeof EXCEPTION_TYPES)[number];
