import { DateTime } from 'luxon';

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Convert a local date + time in an IANA zone to a UTC Date. Returns null if invalid. */
export function localToUtc(date: string, time: string, timezone: string): Date | null {
  if (!DATE_RE.test(date) || !TIME_RE.test(time)) return null;
  const dt = DateTime.fromISO(`${date}T${time}`, { zone: timezone });
  if (!dt.isValid) return null;
  // Reject non-existent local times (DST gaps): luxon shifts them forward silently.
  if (dt.toFormat('yyyy-MM-dd HH:mm') !== `${date} ${time}`) return null;
  return dt.toUTC().toJSDate();
}

export function formatInZone(d: Date, timezone: string, fmt = 'dd LLL yyyy, HH:mm') {
  return DateTime.fromJSDate(d).setZone(timezone).toFormat(fmt);
}

export function todayInZone(timezone: string) {
  return DateTime.now().setZone(timezone).toFormat('yyyy-MM-dd');
}

export function addMinutes(d: Date, minutes: number) {
  return new Date(d.getTime() + minutes * 60_000);
}

export function isValidTimezone(tz: string) {
  return DateTime.now().setZone(tz).isValid;
}
