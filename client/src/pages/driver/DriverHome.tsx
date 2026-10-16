import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Bell, Car, ChevronRight, History } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, Card, EmptyState, ErrorState, Spinner, cn, useToast } from '../../components/ui';
import { errorMessage, get, post } from '../../lib/api';
import { fmtDateTime, fmtTravelDate, humanize } from '../../lib/format';

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
  } | null;
  employee: { name?: string; phone?: string } | null;
};

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

/** A ride waiting for the driver to confirm it. */
function ConfirmCard({ r }: { r: RideView }) {
  const b = r.booking;
  return (
    <Link to={`/driver/rides/${r.assignmentId}`} className="block rounded-2xl border-2 border-amber-400 bg-white p-4 shadow-sm active:bg-amber-50">
      <p className="text-3xl font-bold text-slate-900">{b?.pickupTime ?? '—'}</p>
      <p className="text-sm text-slate-600">{b ? fmtTravelDate(b.travelDate) : '—'}</p>
      {b && (
        <p className="mt-2 text-lg text-slate-900">
          <span className="text-slate-500">Pickup: </span>
          {b.pickupLocation}
        </p>
      )}
      <p className="mt-1 font-mono text-xs text-slate-500">{b?.reference}</p>
      <span className="mt-3 flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-amber-500 text-lg font-semibold text-slate-900">
        View & confirm <ArrowRight className="h-5 w-5" aria-hidden />
      </span>
    </Link>
  );
}

/** An upcoming (already confirmed) ride. */
function RideCard({ r }: { r: RideView }) {
  const b = r.booking;
  return (
    <Link to={`/driver/rides/${r.assignmentId}`} className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs active:bg-slate-50">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold text-slate-900">{b?.pickupTime ?? '—'}</span>
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
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [dutyBusy, setDutyBusy] = useState(false);
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
  const toggleDuty = async () => {
    if (!d) return;
    setDutyBusy(true);
    try {
      const res = await post<{ onDuty: boolean; availability: string }>('/driver/duty', { onDuty: !d.onDuty });
      toast.success(res.onDuty ? 'You are on duty' : 'You are off duty', `Availability: ${humanize(res.availability)}`);
      qc.invalidateQueries({ queryKey: ['driver'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      toast.error('Could not change duty status', errorMessage(e));
    } finally {
      setDutyBusy(false);
    }
  };

  const active = data.activeTrip;
  const allUpcoming = [...data.today, ...data.upcoming];
  const toConfirm = allUpcoming.filter((r) => r.assignmentStatus === 'ACTIVE' && !r.acknowledgedAt);
  const confirmed = allUpcoming.filter((r) => !toConfirm.includes(r));
  const visibleNext = showAll ? confirmed : confirmed.slice(0, 3);
  const doneToday = data.completed.filter((r) => isSameLocalDay(r.completedAt)).length;
  const movedCount = data.cancelledOrReassigned.length;
  const noRides = !active && !allUpcoming.length;
  const problem = d && (d.verificationStatus !== 'VERIFIED' || d.employmentStatus !== 'ACTIVE');

  return (
    <div className="space-y-6">
      {/* Header: who am I, which car, am I working */}
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

        {d && (
          <div className={cn('mt-4 flex items-center justify-between gap-3 rounded-xl p-3', d.onDuty ? 'bg-emerald-50' : 'bg-slate-100')}>
            <div>
              <p id="duty-label" className={cn('text-lg font-bold', d.onDuty ? 'text-emerald-800' : 'text-slate-700')}>
                You are {d.onDuty ? 'ON DUTY' : 'OFF DUTY'}
              </p>
              <p className="text-sm text-slate-600">{d.onDuty ? 'You will get new rides.' : 'Turn on to get rides.'}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={d.onDuty}
              aria-label="On duty"
              aria-describedby="duty-label"
              disabled={dutyBusy}
              onClick={toggleDuty}
              className={cn('relative inline-flex h-12 w-24 shrink-0 items-center rounded-full transition-colors disabled:opacity-60', d.onDuty ? 'bg-emerald-600' : 'bg-slate-400')}
            >
              <span className={cn('inline-block h-10 w-10 transform rounded-full bg-white shadow-sm transition-transform', d.onDuty ? 'translate-x-13' : 'translate-x-1')} />
            </button>
          </div>
        )}
      </section>

      {problem && d && (
        <Alert tone="error" title="Your driver profile needs attention">
          {d.employmentStatus !== 'ACTIVE' && <>Account: {humanize(d.employmentStatus)}. </>}
          {d.verificationStatus !== 'VERIFIED' && <>Verification: {humanize(d.verificationStatus)}. </>}
          Please contact the transport coordinator.
        </Alert>
      )}

      {/* Trip in progress — the one obvious next step */}
      {active && active.booking && (
        <section className="rounded-2xl border-2 border-cyan-500 bg-cyan-50 p-4 shadow-sm" aria-label="Current trip">
          <p className="text-sm font-semibold uppercase tracking-wide text-cyan-900">Current trip</p>
          <p className="mt-1 text-2xl font-bold text-slate-900">{NEXT_STEP[active.booking.status] ?? 'Trip in progress'}</p>
          <p className="mt-2 text-base text-slate-800">
            {active.booking.pickupLocation} <span className="text-slate-400">→</span> {active.booking.dropLocation}
          </p>
          <p className="mt-1 text-sm text-slate-600">
            {active.employee?.name} · {active.booking.pickupTime} · <span className="font-mono text-xs">{active.booking.reference}</span>
          </p>
          <Button size="xl" className="mt-4 h-18 text-xl" onClick={() => navigate(`/driver/rides/${active.assignmentId}`)} icon={<ArrowRight className="h-6 w-6" aria-hidden />}>
            Open trip
          </Button>
        </section>
      )}

      {/* New rides that the driver still has to confirm */}
      {toConfirm.length > 0 && (
        <section aria-label="New rides to confirm" className="rounded-2xl bg-amber-50 p-3">
          <h2 className="mb-3 text-lg font-bold text-amber-900">
            New rides to confirm ({toConfirm.length})
          </h2>
          <ul className="space-y-3">
            {toConfirm.map((r) => (
              <li key={r.assignmentId}>
                <ConfirmCard r={r} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {noRides ? (
        <Card>
          <EmptyState title="No rides right now" description={d?.onDuty ? 'We will tell you when a ride is given to you.' : 'Turn on duty to get rides.'} />
        </Card>
      ) : (
        confirmed.length > 0 && (
          <section aria-label="Next rides">
            <h2 className="mb-3 text-lg font-bold text-slate-900">Next rides</h2>
            <ul className="space-y-3">
              {visibleNext.map((r) => (
                <li key={r.assignmentId}>
                  <RideCard r={r} />
                </li>
              ))}
            </ul>
            {confirmed.length > 3 && (
              <Button size="lg" variant="secondary" className="mt-3 w-full" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Show fewer' : `Show all (${confirmed.length})`}
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
