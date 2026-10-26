import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Car, Phone, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, Card, ConfirmDialog, EmptyState, ErrorState, PageHeader, Spinner, cn, useToast } from '../../components/ui';
import { get, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtTravelDate } from '../../lib/format';
import { pickupLabel } from '../../lib/policy';
import { PinCard, PRE_START } from './MyBookingDetail';

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
  direction?: 'IN' | 'OUT';
  reportBy?: string;
  pickupTimeSet?: boolean;
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
  // Already has a cab for the current work day (one per day; the day runs until the end of cab hours).
  bookedToday: boolean;
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
// No cab assigned yet: the employee can still cancel it themselves.
const isWaiting = (b: HomeBooking) => ['REQUESTED', 'PENDING_APPROVAL', 'APPROVED'].includes(b.status);

function NextRideCard({ b, onCancel }: { b: HomeBooking; onCancel: (b: HomeBooking) => void }) {
  const a = assignmentOf(b);
  const waiting = isWaiting(b);
  const vehicleModel = a?.vehicle?.model ?? '';
  return (
    <section className="rounded-xl border-2 border-indigo-200 bg-indigo-50/60 p-4 shadow-xs" aria-labelledby="next-ride-title">
      <h2 id="next-ride-title" className="flex items-center gap-2 text-sm font-semibold text-indigo-900">
        <Car className="h-4 w-4" aria-hidden /> {b.status === 'IN_PROGRESS' ? 'Your ride now' : 'Your next ride'}
      </h2>
      <PlainStatus status={b.status} delayed={b.isDelayed} className="mt-2" />
      <p className="mt-3 text-lg font-semibold text-slate-900">
        {fmtTravelDate(b.travelDate)} · {pickupLabel(b)}
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

      {waiting && (
        <div className="mt-4 flex justify-end">
          <Button size="sm" variant="danger" icon={<X className="h-4 w-4" aria-hidden />} onClick={() => onCancel(b)}>
            Cancel ride
          </Button>
        </div>
      )}
    </section>
  );
}

type PinView = { timezone: string; pin: { code: string; expiresAt: string } | null };

/** The ride-start PIN, shown once a cab is assigned and until the ride starts. */
function RidePin({ bookingId }: { bookingId: string }) {
  const { data } = useQuery({
    queryKey: ['my-bookings', 'detail', bookingId],
    queryFn: () => get<PinView>(`/me/bookings/${bookingId}`),
    refetchInterval: 30_000,
    gcTime: 0, // contains the PIN: do not keep it cached after leaving the page
  });
  return data?.pin ? <PinCard pin={data.pin} tz={data.timezone} /> : null;
}

export default function EmployeeHome() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [cancelling, setCancelling] = useState<HomeBooking | null>(null);
  const cancel = async (reason: string) => {
    if (!cancelling) return;
    await post(`/me/bookings/${cancelling._id}/cancel`, { reason });
    toast.success('Booking cancelled', cancelling.reference);
    qc.invalidateQueries({ queryKey: ['my-bookings'] });
    qc.invalidateQueries({ queryKey: ['employee-home'] });
  };
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

      {featured && !data?.bookedToday && <div className="mb-6">{requestButton}</div>}

      {isLoading ? (
        <Spinner />
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : data ? (
        featured ? (
          <div className="space-y-6">
            <NextRideCard b={featured} onCancel={setCancelling} />
            {PRE_START.includes(featured.status) && <RidePin bookingId={featured._id} />}
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

      <ConfirmDialog
        open={!!cancelling}
        onClose={() => setCancelling(null)}
        onConfirm={cancel}
        title="Cancel this ride?"
        message={
          cancelling && (
            <>
              <p>
                {cancelling.reference} · {fmtTravelDate(cancelling.travelDate)} · {pickupLabel(cancelling)}
              </p>
              <p className="mt-1 text-slate-500">This cannot be undone. You can request a cab for that day again afterwards.</p>
            </>
          )
        }
        confirmLabel="Cancel ride"
        reasonLabel="Reason for cancelling"
      />
    </>
  );
}
