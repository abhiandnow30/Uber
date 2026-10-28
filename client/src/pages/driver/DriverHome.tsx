import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Bell, Car, ChevronRight, History, Users } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, Card, EmptyState, ErrorState, Spinner } from '../../components/ui';
import { get } from '../../lib/api';
import { fmt12h, fmtDateTime, fmtTravelDate, humanize } from '../../lib/format';

type Vehicle = { registrationNumber?: string; model?: string; capacity?: number; status?: string } | null;

type RideView = {
  assignmentId: string;
  assignmentStatus: string;
  acknowledgedAt?: string | null;
  enRouteAt?: string | null;
  arrivedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  endReason?: string | null;
  scheduledPickupAt: string;
  vehicle?: Vehicle | string;
  booking: {
    _id: string;
    reference: string;
    status: string;
    travelDate: string;
    pickupTime: string;
    timezone?: string;
    pickupLocation: string;
    dropLocation: string;
    passengers: number;
    notes?: string;
    isDelayed?: boolean;
    direction?: 'IN' | 'OUT';
  } | null;
  employee: { name?: string } | null;
  // A shared cab: its id and name, and how many of its riders are still on.
  tripId?: string | null;
  tripName?: string | null;
  tripRiders?: number;
};

/** Several riders in one cab show (and open) as one trip. */
const isSharedTrip = (r: RideView) => !!r.tripId && (r.tripRiders ?? 0) > 1;
const openPath = (r: RideView) => (isSharedTrip(r) ? `/driver/trips/${r.tripId}` : `/driver/rides/${r.assignmentId}`);

/** Upcoming rides with each shared cab folded into one entry (its riders together). */
function groupTrips(rides: RideView[]): RideView[][] {
  const groups: RideView[][] = [];
  const byTrip = new Map<string, RideView[]>();
  for (const r of rides) {
    if (!isSharedTrip(r)) groups.push([r]);
    else if (byTrip.has(r.tripId!)) byTrip.get(r.tripId!)!.push(r);
    else {
      const g = [r];
      byTrip.set(r.tripId!, g);
      groups.push(g);
    }
  }
  return groups;
}

type DriverHomeData = {
  driver: {
    fullName: string;
    driverCode: string;
    verificationStatus: string;
    employmentStatus: string;
    availability: string;
    onDuty: boolean;
    currentVehicle?: Vehicle | string;
  } | null;
  activeTrip: RideView | null;
  today: RideView[];
  upcoming: RideView[];
  completed: RideView[];
  cancelledOrReassigned: RideView[];
  unreadNotifications: number;
};

const vehicleOf = (v: RideView['vehicle']) => (v && typeof v === 'object' ? v : null);

/** Plain-language next step for the trip currently in progress. */
const NEXT_STEP: Record<string, string> = {
  DRIVER_EN_ROUTE: 'Go to pickup',
  ARRIVED: 'Waiting for passenger — enter PIN',
  IN_PROGRESS: 'Trip in progress — drop the passenger',
};

const isSameLocalDay = (iso?: string | null) => {
  if (!iso) return false;
  const d = new Date(iso);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
};

/** An upcoming shared cab: one trip with several riders. */
function TripCard({ rides }: { rides: RideView[] }) {
  const b = rides[0].booking;
  const toOffice = b?.direction === 'IN';
  return (
    <Link to={openPath(rides[0])} className="flex items-center gap-3 rounded-2xl border-2 border-indigo-200 bg-white p-4 shadow-xs active:bg-slate-50">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-2xl font-bold text-slate-900">{b?.pickupTime ? fmt12h(b.pickupTime) : '—'}</span>
          <span className="text-sm text-slate-500">{b ? fmtTravelDate(b.travelDate) : '—'}</span>
          <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-800">
            <Users className="mr-1 inline h-3.5 w-3.5" aria-hidden />
            {rides.length} riders
          </span>
        </div>
        <p className="mt-1 text-base font-semibold text-slate-900">{rides[0].tripName ?? 'Shared cab'}</p>
        <p className="text-sm text-slate-600">
          {toOffice ? 'Pick up' : 'From the office, drop'} {rides.map((r) => r.employee?.name ?? 'Passenger').join(', ')}
          {toOffice ? ' → office' : ''}
        </p>
      </div>
      <ChevronRight className="h-6 w-6 shrink-0 text-slate-400" aria-hidden />
    </Link>
  );
}

/** An upcoming ride. */
function RideCard({ r }: { r: RideView }) {
  const b = r.booking;
  return (
    <Link to={openPath(r)} className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs active:bg-slate-50">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold text-slate-900">{b?.pickupTime ? fmt12h(b.pickupTime) : '—'}</span>
          <span className="text-sm text-slate-500">{b ? fmtTravelDate(b.travelDate) : '—'}</span>
          {b?.isDelayed && <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">Delayed</span>}
        </div>
        {b && (
          <p className="mt-1 text-base text-slate-800">
            {b.pickupLocation} <span className="text-slate-400">→</span> {b.dropLocation}
          </p>
        )}
        <p className="mt-1 text-sm text-slate-500">
          {r.employee?.name ?? 'Passenger'} · <span className="font-mono text-xs">{b?.reference}</span>
        </p>
      </div>
      <ChevronRight className="h-6 w-6 shrink-0 text-slate-400" aria-hidden />
    </Link>
  );
}

export default function DriverHome() {
  const navigate = useNavigate();
  const [showAll, setShowAll] = useState(false);
  const { data, isLoading, error, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['driver', 'home'],
    queryFn: () => get<DriverHomeData>('/driver/home'),
    refetchInterval: 30_000,
  });

  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} onRetry={refetch} />;

  const d = data.driver;
  const cv = vehicleOf(d?.currentVehicle);

  const active = data.activeTrip;
  // A shared cab already under way isn't listed again under "Next rides".
  const allUpcoming = groupTrips([...data.today, ...data.upcoming].filter((r) => !(active && isSharedTrip(r) && r.tripId === active.tripId)));
  const visibleNext = showAll ? allUpcoming : allUpcoming.slice(0, 3);
  const doneToday = data.completed.filter((r) => isSameLocalDay(r.completedAt)).length;
  const movedCount = data.cancelledOrReassigned.length;
  const noRides = !active && !allUpcoming.length;
  const problem = d && d.employmentStatus !== 'ACTIVE';

  return (
    <div className="space-y-6">
      {/* Header: who am I, which car */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold text-slate-900">{d?.fullName ?? 'Driver'}</h1>
            <p className="mt-0.5 flex items-center gap-1.5 text-base text-slate-700">
              <Car className="h-5 w-5 text-slate-500" aria-hidden />
              {cv?.registrationNumber ? <span className="font-mono font-semibold">{cv.registrationNumber}</span> : <span className="text-slate-500">No vehicle linked</span>}
            </p>
          </div>
          <Link to="/notifications" className="relative rounded-lg p-2 text-slate-600 hover:bg-slate-100" aria-label={`Messages, ${data.unreadNotifications} unread`}>
            <Bell className="h-7 w-7" aria-hidden />
            {data.unreadNotifications > 0 && (
              <span className="absolute -right-0.5 -top-0.5 min-w-5 rounded-full bg-red-600 px-1 text-center text-xs font-semibold text-white">{data.unreadNotifications}</span>
            )}
          </Link>
        </div>
      </section>

      {problem && d && (
        <Alert tone="error" title="Your driver profile needs attention">
          Account: {humanize(d.employmentStatus)}.{' '}
          Please contact the transport coordinator.
        </Alert>
      )}

      {/* Trip in progress — the one obvious next step */}
      {active && active.booking && (
        <section className="rounded-2xl border-2 border-cyan-500 bg-cyan-50 p-4 shadow-sm" aria-label="Current trip">
          <p className="text-sm font-semibold uppercase tracking-wide text-cyan-900">Current trip</p>
          {isSharedTrip(active) ? (
            <>
              <p className="mt-1 text-2xl font-bold text-slate-900">{active.tripName ?? 'Shared cab'}</p>
              <p className="mt-2 text-base text-slate-800">
                {active.tripRiders} riders · {fmt12h(active.booking.pickupTime)} · {active.booking.direction === 'IN' ? 'homes → office' : 'office → homes'}
              </p>
            </>
          ) : (
            <>
              <p className="mt-1 text-2xl font-bold text-slate-900">{NEXT_STEP[active.booking.status] ?? 'Trip in progress'}</p>
              <p className="mt-2 text-base text-slate-800">
                {active.booking.pickupLocation} <span className="text-slate-400">→</span> {active.booking.dropLocation}
              </p>
              <p className="mt-1 text-sm text-slate-600">
                {active.employee?.name} · {fmt12h(active.booking.pickupTime)} · <span className="font-mono text-xs">{active.booking.reference}</span>
              </p>
            </>
          )}
          <Button size="xl" className="mt-4 h-18 text-xl" onClick={() => navigate(openPath(active))} icon={<ArrowRight className="h-6 w-6" aria-hidden />}>
            Open trip
          </Button>
        </section>
      )}

      {noRides ? (
        <Card>
          <EmptyState title="No rides right now" description="We will tell you when a ride is given to you." />
        </Card>
      ) : (
        allUpcoming.length > 0 && (
          <section aria-label="Next rides">
            <h2 className="mb-3 text-lg font-bold text-slate-900">Next rides</h2>
            <ul className="space-y-3">
              {visibleNext.map((g) => (
                <li key={g[0].assignmentId}>{g.length > 1 ? <TripCard rides={g} /> : <RideCard r={g[0]} />}</li>
              ))}
            </ul>
            {allUpcoming.length > 3 && (
              <Button size="lg" variant="secondary" className="mt-3 w-full" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Show fewer' : `Show all (${allUpcoming.length})`}
              </Button>
            )}
          </section>
        )
      )}

      {/* Short summary of finished work */}
      <div className="space-y-2">
        <Link to="/driver/history" className="flex items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white p-4 text-base shadow-xs hover:bg-slate-50">
          <span className="flex items-center gap-2 font-medium text-slate-800">
            <History className="h-5 w-5 text-slate-500" aria-hidden />
            Done today: {doneToday} trip{doneToday === 1 ? '' : 's'}
          </span>
          <span className="flex items-center gap-1 text-sm font-medium text-indigo-700">
            Ride history <ChevronRight className="h-4 w-4" aria-hidden />
          </span>
        </Link>
        {movedCount > 0 && (
          <p className="text-center text-sm text-slate-600">
            {movedCount === 1 ? '1 ride was' : `${movedCount} rides were`} cancelled or moved —{' '}
            <Link to="/driver/history" className="font-medium text-indigo-700 underline">
              see history
            </Link>
          </p>
        )}
      </div>

      <p className="text-center text-xs text-slate-400">Updated {fmtDateTime(new Date(dataUpdatedAt).toISOString())} · refreshes automatically</p>
    </div>
  );
}
