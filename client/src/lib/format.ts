import { DateTime } from 'luxon';

export function fmtDateTime(iso?: string | null, zone?: string) {
  if (!iso) return '—';
  const d = DateTime.fromISO(iso);
  return (zone ? d.setZone(zone) : d).toFormat('dd LLL yyyy, HH:mm');
}

export function fmtDate(iso?: string | null) {
  if (!iso) return '—';
  return DateTime.fromISO(iso).toFormat('dd LLL yyyy');
}

export function fmtTime(iso?: string | null, zone?: string) {
  if (!iso) return '—';
  const d = DateTime.fromISO(iso);
  return (zone ? d.setZone(zone) : d).toFormat('HH:mm');
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

export function todayISO(zone = 'Asia/Kolkata') {
  return DateTime.now().setZone(zone).toFormat('yyyy-MM-dd');
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
