import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CalendarClock, Car, Phone, Plus } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, Card, EmptyState, ErrorState, PageHeader, Spinner, cn } from '../../components/ui';
import { get } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtTravelDate } from '../../lib/format';

type Assigned = {
  driver?: { fullName?: string; phone?: string } | null;
  vehicle?: { registrationNumber?: string; model?: string } | null;
} | null;

type HomeBooking = {
  _id: string;
  reference: string;
  status: string;
  travelDate: string;
  pickupTime: string;
  scheduledPickupAt?: string;
  pickupLocation: string;
  dropLocation: string;
  passengers: number;
  isDelayed?: boolean;
  currentAssignment?: Assigned | string;
};

type HomeData = {
  pending: HomeBooking[];
  upcoming: HomeBooking[];
  activeTrip: HomeBooking | null;
  recent: HomeBooking[];
  unreadNotifications: number;
};

/** Plain-language status for employees (no internal jargon). */
const PLAIN_STATUS: Record<string, { text: string; tone: string }> = {
  REQUESTED: { text: 'Waiting for a cab', tone: 'bg-amber-100 text-amber-800' },
  PENDING_APPROVAL: { text: 'Waiting for approval', tone: 'bg-amber-100 text-amber-800' },
  APPROVED: { text: 'Waiting for a cab', tone: 'bg-amber-100 text-amber-800' },
  ASSIGNED: { text: 'Cab assigned', tone: 'bg-indigo-100 text-indigo-800' },
  DRIVER_EN_ROUTE: { text: 'Driver is on the way', tone: 'bg-blue-100 text-blue-800' },
  ARRIVED: { text: 'Driver has arrived — share your PIN', tone: 'bg-violet-100 text-violet-800' },
  IN_PROGRESS: { text: 'On your way', tone: 'bg-cyan-100 text-cyan-800' },
};

function PlainStatus({ status, delayed, className }: { status: string; delayed?: boolean; className?: string }) {
  const s = PLAIN_STATUS[status] ?? { text: status.replace(/_/g, ' ').toLowerCase(), tone: 'bg-slate-100 text-slate-700' };
  return (
    <span className={cn('inline-flex flex-wrap gap-1', className)}>
      <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', s.tone)}>{s.text}</span>
      {delayed && <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-800">Running late</span>}
    </span>
  );
}

const assignmentOf = (b: HomeBooking): Assigned => (b.currentAssignment && typeof b.currentAssignment === 'object' ? b.currentAssignment : null);
const sortKey = (b: HomeBooking) => b.scheduledPickupAt ?? `${b.travelDate}T${b.pickupTime}`;

function NextRideCard({ b }: { b: HomeBooking }) {
  const a = assignmentOf(b);
  const waiting = ['REQUESTED', 'PENDING_APPROVAL', 'APPROVED'].includes(b.status);
  const vehicleModel = a?.vehicle?.model ?? '';
  return (
    <section className="rounded-xl border-2 border-indigo-200 bg-indigo-50/60 p-4 shadow-xs" aria-labelledby="next-ride-title">
      <h2 id="next-ride-title" className="flex items-center gap-2 text-sm font-semibold text-indigo-900">
        <Car className="h-4 w-4" aria-hidden /> {b.status === 'IN_PROGRESS' ? 'Your ride now' : 'Your next ride'}
      </h2>
      <PlainStatus status={b.status} delayed={b.isDelayed} className="mt-2" />
      <p className="mt-3 text-lg font-semibold text-slate-900">
        {fmtTravelDate(b.travelDate)} · {b.pickupTime}
      </p>
      <p className="text-sm text-slate-700">
        {b.pickupLocation} <span aria-label="to">→</span> {b.dropLocation}
      </p>

      {waiting ? (
        <p className="mt-3 text-sm text-slate-600">We will let you know as soon as a driver and cab are assigned.</p>
      ) : a?.driver || a?.vehicle ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white p-3">
          <div className="min-w-0">
            <p className="font-medium text-slate-900">{a?.driver?.fullName ?? 'Driver'}</p>
            {a?.vehicle?.registrationNumber && (
              <p className="text-sm text-slate-600">
                <span className="font-mono">{a.vehicle.registrationNumber}</span>
                {vehicleModel ? ` · ${vehicleModel}` : ''}
              </p>
            )}
          </div>
          {a?.driver?.phone && (
            <a
              href={`tel:${a.driver.phone}`}
              className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700"
              aria-label={`Call driver ${a.driver.fullName ?? ''}`.trim()}
            >
              <Phone className="h-4 w-4" aria-hidden /> Call
            </a>
          )}
        </div>
      ) : null}

      <Link to={`/employee/bookings/${b._id}`} className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-indigo-700 hover:underline">
        View details & PIN <ArrowRight className="h-4 w-4" aria-hidden />
      </Link>
    </section>
  );
}

function ComingUpRow({ b }: { b: HomeBooking }) {
  return (
    <li>
      <Link to={`/employee/bookings/${b._id}`} className="flex items-center justify-between gap-3 py-3 hover:bg-slate-50">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-900">
            {fmtTravelDate(b.travelDate)} · {b.pickupTime}
          </p>
          <p className="truncate text-sm text-slate-600">
            {b.pickupLocation} → {b.dropLocation}
          </p>
        </div>
        <PlainStatus status={b.status} delayed={b.isDelayed} className="shrink-0 justify-end" />
      </Link>
    </li>
  );
}

export default function EmployeeHome() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['employee-home'],
    queryFn: () => get<HomeData>('/me/home'),
    refetchInterval: 60_000,
  });
  const name = (me?.profile?.fullName as string | undefined) ?? me?.user.name ?? '';
  const firstName = name.split(' ')[0];

  // Next ride: a trip in progress first, then the soonest assigned ride, then the soonest pending request.
  const upcoming = data ? [...data.upcoming].sort((x, y) => sortKey(x).localeCompare(sortKey(y))) : [];
  const pending = data ? [...data.pending].sort((x, y) => sortKey(x).localeCompare(sortKey(y))) : [];
  const featured = data ? data.activeTrip ?? upcoming[0] ?? pending[0] ?? null : null;
  const rest = [...upcoming, ...pending].filter((b) => b._id !== featured?._id).sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
  const comingUp = rest.slice(0, 3);

  const requestButton = (
    <Button size="xl" className="sm:max-w-sm" icon={<Plus className="h-5 w-5" aria-hidden />} onClick={() => navigate('/employee/request')}>
      Request a cab
    </Button>
  );

  return (
    <>
      <PageHeader title={firstName ? `Hi, ${firstName}` : 'Welcome'} subtitle="Book your office cab in a few taps." />

      {!me?.profile?.homeAddress && (
        <div className="mb-4">
          <Alert tone="info" title="Add your present address">
            Save it once and your cab requests will be filled in automatically.{' '}
            <Link to="/account" className="font-medium underline">
              Add present address
            </Link>
          </Alert>
        </div>
      )}

      <div className="mb-6">{requestButton}</div>

      {isLoading ? (
        <Spinner />
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : data ? (
        featured ? (
          <div className="space-y-6">
            <NextRideCard b={featured} />

            <Card
              title="Coming up"
              actions={
                <Link to="/employee/bookings" className="text-sm font-medium text-indigo-700 hover:underline">
                  See all bookings
                </Link>
              }
            >
              {comingUp.length ? (
                <ul className="-my-3 divide-y divide-slate-100">
                  {comingUp.map((b) => (
                    <ComingUpRow key={b._id} b={b} />
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-slate-500">Nothing else booked.</p>
              )}
            </Card>
          </div>
        ) : (
          <Card>
            <EmptyState
              icon={<CalendarClock className="h-10 w-10" aria-hidden />}
              title="No rides booked"
              description="When you request a cab, it will show up here."
              action={
                <div className="flex flex-col items-center gap-3">
                  <Button icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => navigate('/employee/request')}>
                    Request a cab
                  </Button>
                  <Link to="/employee/bookings" className="text-sm font-medium text-indigo-700 hover:underline">
                    See past bookings
                  </Link>
                </div>
              }
            />
          </Card>
        )
      ) : null}
    </>
  );
}
