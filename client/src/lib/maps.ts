import type { Office } from './policy';

type Point = { lat: number; lng: number };
type Ride = { direction?: 'IN' | 'OUT'; pickupLocation: string; dropLocation: string };

const at = (p: Point) => `${p.lat},${p.lng}`;

/**
 * Turn-by-turn navigation from where the driver is now to a stop: its exact saved spot when there is
 * one, otherwise its address text. Opens straight into navigation in the Google Maps app.
 */
export function navigationUrl(point: Point | null | undefined, text: string) {
  const p = new URLSearchParams({ api: '1', destination: point ? at(point) : text, travelmode: 'driving', dir_action: 'navigate' });
  return `https://www.google.com/maps/dir/?${p}`;
}

/**
 * Google Maps driving directions for a ride (opens the Google Maps app on phones; free, no key).
 * Uses the exact saved spots where there are any (the office's pin from Settings, the home's pin from
 * the employee's account) and otherwise the ride's pickup and drop-off text. IN rides go home →
 * office, OUT rides office → home.
 */
export function rideRouteUrl(ride: Ride, office?: Office | null, home?: Point | null) {
  const officeAt = office?.location ? at(office.location) : null;
  const homeAt = home ? at(home) : null;
  const toOffice = ride.direction === 'IN';
  const origin = (toOffice ? homeAt : officeAt) ?? ride.pickupLocation;
  const destination = (toOffice ? officeAt : homeAt) ?? ride.dropLocation;
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&travelmode=driving`;
}

/**
 * A route through several stops in order (first = start, last = end, the rest as stops in between,
 * shown A, B, C… in Google Maps). Each stop is "lat,lng" or address text.
 */
export function multiStopRouteUrl(stops: string[]) {
  const p = new URLSearchParams({ api: '1', origin: stops[0], destination: stops[stops.length - 1], travelmode: 'driving' });
  if (stops.length > 2) p.set('waypoints', stops.slice(1, -1).join('|'));
  return `https://www.google.com/maps/dir/?${p}`;
}
