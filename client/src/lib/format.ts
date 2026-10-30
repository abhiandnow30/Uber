import { DateTime } from 'luxon';

/** Times are shown in office time (a phone or laptop set to another zone shows the same as everyone else). */
const OFFICE_ZONE = 'Asia/Kolkata';

export function fmtDateTime(iso?: string | null, zone?: string) {
  if (!iso) return '—';
  return DateTime.fromISO(iso).setZone(zone || OFFICE_ZONE).toFormat('dd LLL yyyy, h:mm a');
}

export function fmtDate(iso?: string | null) {
  if (!iso) return '—';
  return DateTime.fromISO(iso).toFormat('dd LLL yyyy');
}

export function fmtTime(iso?: string | null, zone?: string) {
  if (!iso) return '—';
  const d = DateTime.fromISO(iso);
  return (zone ? d.setZone(zone) : d).toFormat('h:mm a');
}

/** "22:00" -> "10:00 PM". */
export function fmt12h(hhmm?: string) {
  if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm)) return hhmm ?? '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

export function fmtRelative(iso?: string | null) {
  if (!iso) return '—';
  return DateTime.fromISO(iso).toRelative() ?? '—';
}

/** "2026-10-16" → "Fri, 16 Oct 2026" */
export function fmtTravelDate(ymd?: string | null) {
  if (!ymd) return '—';
  return DateTime.fromISO(ymd).toFormat('ccc, dd LLL yyyy');
}

/** "2026-10-24" → "Sat 24 Oct" */
export function fmtShortDate(ymd?: string | null) {
  if (!ymd) return '—';
  return DateTime.fromISO(ymd).toFormat('ccc d LLL');
}

export function todayISO(zone = 'Asia/Kolkata') {
  return DateTime.now().setZone(zone).toFormat('yyyy-MM-dd');
}

/**
 * Today's work day in the office zone. With overnight cab hours (8 PM - 6 AM) the day runs until
 * the end of cab hours, so at 2 AM it is still the previous day's shift (same rule as the server).
 */
export function currentWorkDay(zone = 'Asia/Kolkata', cabWindowStart?: string | null, cabWindowEnd?: string | null) {
  const now = DateTime.now().setZone(zone);
  const overnight = !!cabWindowStart && !!cabWindowEnd && cabWindowStart > cabWindowEnd;
  return (overnight && now.toFormat('HH:mm') <= cabWindowEnd! ? now.minus({ days: 1 }) : now).toFormat('yyyy-MM-dd');
}

export function addDaysISO(ymd: string, days: number) {
  return DateTime.fromISO(ymd).plus({ days }).toFormat('yyyy-MM-dd');
}

export const humanize = (s?: string | null) => (s ? s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : '—');

/**
 * Google Maps directions link (no API key needed; opens the Maps app on phones).
 * Without an origin, Maps starts from the device's current location.
 */
export function mapsDirectionsUrl(destination: string, origin?: string) {
  const p = new URLSearchParams({ api: '1', destination, travelmode: 'driving' });
  if (origin) p.set('origin', origin);
  return `https://www.google.com/maps/dir/?${p}`;
}

export function uuid() {
  return crypto.randomUUID();
}
