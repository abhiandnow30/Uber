import { useQuery } from '@tanstack/react-query';
import { get } from './api';
import { fmt12h } from './format';

export type Office = { code: string; name: string; address?: string; timezone: string; active: boolean; location?: { lat: number; lng: number }; mapLink?: string };
export type Shift = { code: string; name: string; direction: string; startTime?: string; endTime?: string; defaultPickupTime?: string; active: boolean };
export type PublicPolicy = {
  officeLocations: Office[];
  shifts: Shift[];
  booking: {
    maxDaysAhead: number;
    minLeadMinutes: number;
    dailyCutoffTime: string;
    cancellationDeadlineMinutes: number;
    approvalRequired: boolean;
    maxPassengers: number;
    allowRoundTrip: boolean;
    cabWindowStart?: string;
    cabWindowEnd?: string;
    requireShift?: boolean;
  };
  version: number;
};

/** Offices, shifts and booking rules (readable by every signed-in role). */
export function usePolicy() {
  return useQuery({ queryKey: ['policy'], queryFn: () => get<PublicPolicy>('/policy'), staleTime: 5 * 60_000 });
}

export const VEHICLE_TYPES = ['SEDAN', 'HATCHBACK', 'SUV', 'MUV', 'VAN', 'MINIBUS'] as const;
export const BOOKING_STATUSES = ['REQUESTED', 'PENDING_APPROVAL', 'APPROVED', 'ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'REJECTED', 'NO_SHOW'] as const;
export const ACCOUNT_STATUSES = ['PENDING_ADMIN_REVIEW', 'INVITED', 'ACTIVE', 'INACTIVE', 'REJECTED', 'SUSPENDED'] as const;

export { fmt12h };

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/**
 * A shift with hours sets the cab time; returns the cab's date and time for a given shift date.
 * `time` overrides the shift's cab time and lands on whichever day is closest to it (same rule as the server).
 */
export function cabFor(shift: Shift | undefined, shiftDate: string, time?: string) {
  if (!shift?.startTime || !shift.defaultPickupTime || !shiftDate) return null;
  const t = time || shift.defaultPickupTime;
  const defaultOffset = toMin(shift.defaultPickupTime) + (shift.defaultPickupTime < shift.startTime ? 1440 : 0);
  const next = Math.abs(toMin(t) + 1440 - defaultOffset) < Math.abs(toMin(t) - defaultOffset);
  const [y, mo, d] = shiftDate.split('-').map(Number);
  const date = next ? new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().slice(0, 10) : shiftDate;
  return { date, time: t, nextDay: next };
}

export const DIRECTION_LABEL: Record<string, string> = { TO_OFFICE: 'Home → Office', FROM_OFFICE: 'Office → Home' };

/** IN cabs need time for the pickup run: the shift must start this long after cab hours begin (as on the server). */
export const IN_LEAD_MINUTES = 60;

/**
 * Which cab a shift gets from its times (same rule as the server): IN (home → office, reach by the
 * start) when it starts from cab-hours start + 1 h to cab-hours end; OUT (office → home at the end)
 * when it ends within cab hours, before they end.
 */
export function cabForShift(start: string, end: string, winStart?: string, winEnd?: string) {
  if (!winStart || !winEnd) return { in: true, out: true };
  const span = (toMin(winEnd) - toMin(winStart) + 1440) % 1440 || 1440;
  const offset = (t: string) => (toMin(t) - toMin(winStart) + 1440) % 1440;
  return { in: offset(start) >= IN_LEAD_MINUTES && offset(start) <= span, out: offset(end) < span };
}

/** "20:00" + 60 → "21:00" */
export const addMinutesHHmm = (t: string, m: number) => {
  const v = (toMin(t) + m + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
};

/** Pickup line for a booking: IN rides wait for the transport team to set it. */
export function pickupLabel(b: { direction?: string; pickupTimeSet?: boolean; pickupTime: string; reportBy?: string }) {
  if (b.direction === 'IN' && b.pickupTimeSet === false) return `Pickup time to be set · reach office by ${fmt12h(b.reportBy ?? b.pickupTime)}`;
  return fmt12h(b.pickupTime);
}
