import { Route } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { multiStopRouteUrl, rideRouteUrl } from '../lib/maps';
import { usePolicy } from '../lib/policy';

/**
 * "View route": the ride in Google Maps directions, from the exact saved office and home spots. In a
 * shared cab it's the whole route, every stop in the driver's order (A, B, C… in Google Maps).
 */
export function RideRouteLink({
  ride,
}: {
  ride: { direction?: 'IN' | 'OUT'; pickupLocation: string; dropLocation: string; officeLocation?: string; sharedCab?: { route?: string[] } | null };
}) {
  const { me } = useAuth();
  const { data: policy } = usePolicy();
  const office = policy?.officeLocations.find((o) => o.code === ride.officeLocation);
  const home = (me?.profile as { homeLocation?: { lat: number; lng: number } | null } | undefined)?.homeLocation ?? null;
  return (
    <a
      href={ride.sharedCab?.route && ride.sharedCab.route.length > 2 ? multiStopRouteUrl(ride.sharedCab.route) : rideRouteUrl(ride, office, home)}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-indigo-200 bg-white px-3 text-sm font-medium text-indigo-700 hover:bg-indigo-50"
    >
      <Route className="h-4 w-4" aria-hidden /> View route
    </a>
  );
}
