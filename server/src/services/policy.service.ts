import { z } from 'zod';
import { Policy, type PolicyAttrs } from '../models/Policy.js';
import { badRequest, notFound } from '../utils/errors.js';
import { isValidTimezone, TIME_RE } from '../utils/time.js';
import { audit, type Actor } from './audit.service.js';

export type PolicyView = PolicyAttrs & { _id: unknown };

let cache: { at: number; value: PolicyView } | null = null;
const CACHE_MS = 5_000;

export const DEFAULT_OFFICES = [
  { code: 'HYD', name: 'Hyderabad HQ', address: 'HITEC City, Hyderabad', timezone: 'Asia/Kolkata', active: true },
  { code: 'BLR', name: 'Bengaluru Office', address: 'Whitefield, Bengaluru', timezone: 'Asia/Kolkata', active: true },
];
/**
 * Shifts with their single cab trip: home at the end of the shift, except the 9 PM shift
 * whose cab is the pickup to the office (cabs only run 8 PM - 6 AM).
 */
export const DEFAULT_SHIFTS = [
  { code: '1PM-10PM', name: '1 PM - 10 PM', startTime: '13:00', endTime: '22:00', direction: 'FROM_OFFICE', defaultPickupTime: '22:00', active: true },
  { code: '3PM-12AM', name: '3 PM - 12 AM', startTime: '15:00', endTime: '00:00', direction: 'FROM_OFFICE', defaultPickupTime: '00:00', active: true },
  { code: '4PM-1AM', name: '4 PM - 1 AM', startTime: '16:00', endTime: '01:00', direction: 'FROM_OFFICE', defaultPickupTime: '01:00', active: true },
  { code: '530PM-230AM', name: '5:30 PM - 2:30 AM', startTime: '17:30', endTime: '02:30', direction: 'FROM_OFFICE', defaultPickupTime: '02:30', active: true },
  { code: '7PM-4AM', name: '7 PM - 4 AM', startTime: '19:00', endTime: '04:00', direction: 'FROM_OFFICE', defaultPickupTime: '04:00', active: true },
  { code: '9PM-6AM', name: '9 PM - 6 AM', startTime: '21:00', endTime: '06:00', direction: 'TO_OFFICE', defaultPickupTime: '21:00', active: true },
];

/** Is HH:mm inside the daily window? The window may cross midnight (20:00-06:00). Blank = always. */
export function inCabWindow(time: string, start?: string | null, end?: string | null) {
  if (!start || !end) return true;
  return start <= end ? time >= start && time <= end : time >= start || time <= end;
}

export async function getPolicy(): Promise<PolicyView> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let doc = await Policy.findOne({ key: 'global' }).lean();
  if (!doc) {
    try {
      await Policy.create({ key: 'global', officeLocations: DEFAULT_OFFICES, shifts: DEFAULT_SHIFTS, migrations: ['company-shifts-2026-10'] });
    } catch {
      /* created concurrently */
    }
    doc = await Policy.findOne({ key: 'global' }).lean();
  }
  if (!doc) throw notFound('Policy');
  cache = { at: Date.now(), value: doc as PolicyView };
  return cache.value;
}

export function invalidatePolicyCache() {
  cache = null;
}

export async function getOffice(code: string | undefined | null) {
  if (!code) return null;
  const policy = await getPolicy();
  return policy.officeLocations.find((o) => o.code === code.toUpperCase()) ?? null;
}

export async function activeOfficeCodes() {
  const policy = await getPolicy();
  return policy.officeLocations.filter((o) => o.active).map((o) => o.code);
}

const hhmm = z.string().regex(TIME_RE, 'Use HH:mm');

export const policyUpdateSchema = z
  .object({
    officeLocations: z
      .array(
        z.object({
          code: z.string().trim().min(2).max(10).regex(/^[A-Za-z0-9_-]+$/),
          name: z.string().trim().min(2).max(100),
          address: z.string().trim().max(300).optional().default(''),
          timezone: z.string().refine(isValidTimezone, 'Invalid IANA time zone'),
          active: z.boolean().default(true),
        }),
      )
      .min(1)
      .optional(),
    shifts: z
      .array(
        z.object({
          code: z.string().trim().min(2).max(20).regex(/^[A-Za-z0-9_-]+$/),
          name: z.string().trim().min(2).max(100),
          direction: z.enum(['TO_OFFICE', 'FROM_OFFICE', 'ANY']).default('ANY'),
          startTime: z.union([hhmm, z.literal('')]).optional(),
          endTime: z.union([hhmm, z.literal('')]).optional(),
          defaultPickupTime: z.union([hhmm, z.literal('')]).optional(),
          active: z.boolean().default(true),
        }),
      )
      .optional(),
    booking: z
      .object({
        maxDaysAhead: z.number().int().min(0).max(90),
        minLeadMinutes: z.number().int().min(0).max(7 * 24 * 60),
        dailyCutoffTime: z.union([hhmm, z.literal('')]),
        cancellationDeadlineMinutes: z.number().int().min(0).max(7 * 24 * 60),
        approvalRequired: z.boolean(),
        maxPassengers: z.number().int().min(1).max(60),
        allowRoundTrip: z.boolean(),
        cabWindowStart: z.union([hhmm, z.literal('')]),
        cabWindowEnd: z.union([hhmm, z.literal('')]),
        requireShift: z.boolean(),
      })
      .partial()
      .optional(),
    assignment: z
      .object({
        defaultTripDurationMinutes: z.number().int().min(10).max(24 * 60),
        bufferMinutes: z.number().int().min(0).max(240),
        requireVerifiedDriver: z.boolean(),
        acknowledgementTimeoutMinutes: z.number().int().min(1).max(24 * 60),
      })
      .partial()
      .optional(),
    pin: z
      .object({
        maxAttempts: z.number().int().min(3).max(10),
        validAfterPickupMinutes: z.number().int().min(30).max(24 * 60),
      })
      .partial()
      .optional(),
    exceptions: z
      .object({
        latePickupThresholdMinutes: z.number().int().min(1).max(240),
        overdueTripMinutes: z.number().int().min(10).max(24 * 60),
      })
      .partial()
      .optional(),
    notifications: z.record(z.string(), z.boolean()).optional(),
  })
  .strict();

export async function updatePolicy(actor: Actor, input: z.infer<typeof policyUpdateSchema>) {
  const current = await getPolicy();
  if (input.officeLocations) {
    const codes = input.officeLocations.map((o) => o.code.toUpperCase());
    if (new Set(codes).size !== codes.length) throw badRequest('Office codes must be unique');
  }
  if (input.shifts) {
    const codes = input.shifts.map((s) => s.code.toUpperCase());
    if (new Set(codes).size !== codes.length) throw badRequest('Shift codes must be unique');
  }
  // Every active shift's cab time must fall inside the cab window.
  const winStart = input.booking?.cabWindowStart ?? current.booking?.cabWindowStart;
  const winEnd = input.booking?.cabWindowEnd ?? current.booking?.cabWindowEnd;
  for (const s of input.shifts ?? current.shifts) {
    if (s.active && s.defaultPickupTime && !inCabWindow(s.defaultPickupTime, winStart, winEnd)) {
      throw badRequest(`Shift "${s.name}": cab time ${s.defaultPickupTime} is outside the cab hours ${winStart}-${winEnd}`);
    }
  }
  const set: Record<string, unknown> = { updatedBy: actor.id };
  if (input.officeLocations) set.officeLocations = input.officeLocations;
  if (input.shifts) set.shifts = input.shifts;
  for (const section of ['booking', 'assignment', 'pin', 'exceptions', 'notifications'] as const) {
    const values = input[section];
    if (!values) continue;
    for (const [k, v] of Object.entries(values)) {
      if (section === 'notifications' && !(k in (current.notifications ?? {}))) {
        throw badRequest(`Unknown notification preference: ${k}`);
      }
      set[`${section}.${k}`] = v;
    }
  }
  const updated = await Policy.findOneAndUpdate({ key: 'global' }, { $set: set, $inc: { version: 1 } }, { new: true });
  invalidatePolicyCache();
  await audit(actor, 'POLICY_UPDATED', 'Policy', updated?._id, `Booking policy updated to v${updated?.version}`, {
    changes: input,
  });
  return getPolicy();
}
