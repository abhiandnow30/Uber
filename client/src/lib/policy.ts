import { useQuery } from '@tanstack/react-query';
import { get } from './api';

export type Office = { code: string; name: string; address?: string; timezone: string; active: boolean };
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

/** "22:00" -> "10:00 PM". */
export function fmt12h(hhmm?: string) {
  if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm)) return hhmm ?? '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** A shift with hours fixes the cab time; returns the cab's date and time for a given shift date. */
export function cabFor(shift: Shift | undefined, shiftDate: string) {
  if (!shift?.startTime || !shift.defaultPickupTime || !shiftDate) return null;
  const [y, mo, d] = shiftDate.split('-').map(Number);
  const next = shift.defaultPickupTime < shift.startTime;
  const date = next ? new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().slice(0, 10) : shiftDate;
  return { date, time: shift.defaultPickupTime, nextDay: next };
}

export const DIRECTION_LABEL: Record<string, string> = { TO_OFFICE: 'Home → Office', FROM_OFFICE: 'Office → Home' };
