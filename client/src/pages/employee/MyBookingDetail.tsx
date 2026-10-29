import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Phone } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Card, ConfirmDialog, DescriptionList, ErrorState, PageHeader, Plate, Spinner, StatusBadge, cn, useToast } from '../../components/ui';
import { ApiError, get, post } from '../../lib/api';
import { fmt12h, fmtDateTime, fmtTravelDate, humanize } from '../../lib/format';
import { pickupLabel } from '../../lib/policy';
import { CancelRideDialog } from './CancelRideDialog';
import { RideRouteLink } from '../../components/RideRouteLink';

type HistoryEntry = { _id: string; from?: string; to: string; event: string; reason?: string; actorRole?: string; createdAt: string };

type BookingDetail = {
  _id: string;
  reference: string;
  status: string;
  travelDate: string;
  pickupTime: string;
  direction?: 'IN' | 'OUT';
  reportBy?: string;
  pickupTimeSet?: boolean;
  timezone: string;
  officeLocation: string;
  scheduledPickupAt: string;
  pickupLocation: string;
  dropLocation: string;
  passengers: number;
  tripType: string;
  leg?: string;
  shift?: string;
  notes?: string;
  isDelayed?: boolean;
  delayReason?: string;
  approvalRequired?: boolean;
  rejectionReason?: string;
  cancellationReason?: string;
  cancelledAt?: string;
  completedAt?: string;
  assignment: {
    _id: string;
    driver?: { fullName?: string; phone?: string } | null;
    vehicle?: { registrationNumber?: string; model?: string; vehicleType?: string } | null;
    acknowledgedAt?: string;
    enRouteAt?: string;
    arrivedAt?: string;
    startedAt?: string;
    completedAt?: string;
  } | null;
  pin: { code: string; expiresAt: string } | null;
  pinStatus: string | null;
  history: HistoryEntry[];
  canCancel: boolean;
  // No cab assigned yet: the employee may still change the ride.
  canEdit?: boolean;
  // The assigned cab is late: the employee may cancel it themselves (with a reason).
  cabLate?: boolean;
  canRequestCancellation: boolean;
  cancellationRequest?: { status: 'PENDING' | 'APPROVED' | 'DECLINED'; reason?: string; requestedAt?: string; decidedAt?: string; note?: string } | null;
};

const ACTIVE = ['REQUESTED', 'PENDING_APPROVAL', 'APPROVED', 'ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'];
export const PRE_START = ['ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED'];

export function PinCard({ pin, tz }: { pin: { code: string; expiresAt: string }; tz: string }) {
  return (
    <section className="rounded-xl border-2 border-indigo-200 bg-indigo-50/60 p-4 shadow-xs" aria-labelledby="pin-title">
      <h2 id="pin-title" className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-indigo-900">
        <KeyRound className="h-4 w-4" aria-hidden /> Ride-start PIN
      </h2>
      {/* Always visible: the employee reads it out to the driver. */}
      <div className="mt-3 flex gap-2" aria-label={`PIN ${pin.code.split('').join(' ')}`}>
        {pin.code.split('').map((d, i) => (
          <span key={i} className="flex h-16 w-14 items-center justify-center rounded-xl border-2 border-indigo-200 bg-white font-mono text-4xl font-bold text-slate-900" aria-hidden>
            {d}
          </span>
        ))}
      </div>
      <p className="mt-2 text-xs text-slate-600">Valid until {fmtDateTime(pin.expiresAt, tz)}</p>
      <p className="mt-3 text-sm font-medium text-indigo-900">Tell this PIN to the driver once you are inside the cab.</p>
    </section>
  );
}

export default function MyBookingDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const { data: b, isLoading, error, refetch } = useQuery({
    queryKey: ['my-bookings', 'detail', id],
    queryFn: () => get<BookingDetail>(`/me/bookings/${id}`),
    refetchInterval: 30_000,
    gcTime: 0, // contains the PIN: do not keep it cached after leaving the page
  });

  if (isLoading) return <Spinner />;
  if (error || !b) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <>
        <PageHeader title="Booking" subtitle={<Link to="/employee/bookings" className="text-indigo-700 hover:underline">← My bookings</Link>} />
        {notFound ? <Alert tone="error" title="Booking not found">This booking does not exist or is not yours.</Alert> : <ErrorState error={error} onRetry={refetch} />}
      </>
    );
  }

  const tz = b.timezone;
  const a = b.assignment;
  const isActive = ACTIVE.includes(b.status);
  const pinProblem = !b.pin && b.pinStatus && ['LOCKED', 'EXPIRED', 'REVOKED'].includes(b.pinStatus) && PRE_START.includes(b.status);

  const cancel = async (reason: string) => {
    await post(`/me/bookings/${b._id}/cancel`, { reason });
    toast.success('Booking cancelled', b.reference);
    qc.invalidateQueries({ queryKey: ['my-bookings'] });
    qc.invalidateQueries({ queryKey: ['employee-home'] });
  };

  const requestCancellation = async (reason: string) => {
    await post(`/me/bookings/${b._id}/cancellation-request`, { reason });
    toast.success('Cancellation requested', 'The admin will review it and let you know.');
    qc.invalidateQueries({ queryKey: ['my-bookings'] });
  };
  const cr = b.cancellationRequest;

  return (
    <>
      <PageHeader
        title={b.reference}
        subtitle={<Link to="/employee/bookings" className="text-indigo-700 hover:underline">← My bookings</Link>}
        actions={
          <div className="flex flex-wrap items-center gap-1">
            <StatusBadge status={b.status} className="text-sm" />
            {b.isDelayed && <StatusBadge status="DELAYED" className="text-sm" />}
          </div>
        }
      />

      <div className="space-y-4">
        {b.isDelayed && (
          <Alert tone="warn" title="Your cab is delayed">
            {b.delayReason ?? 'The transport team is aware and will keep you updated.'}
          </Alert>
        )}
        {b.status === 'PENDING_APPROVAL' && <Alert tone="info" title="Awaiting approval">You will be notified when your request is approved and a cab is assigned.</Alert>}
        {['REQUESTED', 'APPROVED'].includes(b.status) && <Alert tone="info" title="Waiting for a cab">The transport team will assign a driver and vehicle. You will be notified.</Alert>}
        {b.status === 'REJECTED' && b.rejectionReason && <Alert tone="error" title="Request rejected">{b.rejectionReason}</Alert>}
        {b.status === 'CANCELLED' && b.cancellationReason && <Alert tone="info" title="Cancelled">{b.cancellationReason}</Alert>}

        {b.pin && <PinCard pin={b.pin} tz={tz} />}
        {pinProblem && (
          <Alert tone="error" title={`Your ride-start PIN is ${humanize(b.pinStatus).toLowerCase()}`}>
            The driver cannot start the trip with this PIN. Please contact the transport coordinator to get a new PIN.
          </Alert>
        )}
        {!b.pin && !b.pinStatus && PRE_START.includes(b.status) && <Alert tone="info">Your ride-start PIN will appear here once it is issued.</Alert>}

        {a && (
          <Card title="Your cab">
            <DescriptionList
              items={[
                ['Driver', a.driver?.fullName],
                [
                  'Driver phone',
                  a.driver?.phone ? (
                    <a href={`tel:${a.driver.phone}`} className="inline-flex items-center gap-1 font-medium text-indigo-700 underline">
                      <Phone className="h-3.5 w-3.5" aria-hidden /> {a.driver.phone}
                    </a>
                  ) : null,
                ],
                ['Cab number', a.vehicle?.registrationNumber ? <Plate reg={a.vehicle.registrationNumber} size="lg" /> : null],
                ['Model', a.vehicle?.model || (a.vehicle?.vehicleType ? humanize(a.vehicle.vehicleType) : null)],
              ]}
            />
          </Card>
        )}

        <Card title="Trip details" actions={<RideRouteLink ride={b} />}>
          <DescriptionList
            items={[
              ['Date', fmtTravelDate(b.travelDate)],
              ...(b.direction === 'IN' && b.reportBy ? ([['Reach office by', fmt12h(b.reportBy)]] as Array<[string, string]>) : []),
              ['Pickup time', b.direction === 'IN' && b.pickupTimeSet === false ? 'Set by the transport team when your cab is assigned' : fmt12h(b.pickupTime)],
              ['Pickup', b.pickupLocation],
              ['Destination', b.dropLocation],
              ['Trip type', b.tripType === 'ROUND_TRIP' ? `Round trip${b.leg ? ` · ${humanize(b.leg)} leg` : ''}` : null],
              ['Shift', b.shift || null],
              ['Notes', b.notes || null],
            ]}
          />
        </Card>

        {isActive && (b.canCancel || !!cr || b.canRequestCancellation) && (
          <Card title="Cancellation">
            {b.canCancel ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-slate-600">
                  {b.cabLate ? 'Your cab is running late, so you can cancel this ride yourself.' : 'No cab is assigned yet, so you can cancel this booking yourself.'}
                </p>
                <div className="flex flex-wrap gap-2">
                  {b.canEdit && (
                    <Link to={`/employee/request?edit=${b._id}`}>
                      <Button variant="secondary">Change ride</Button>
                    </Link>
                  )}
                  <Button variant="danger" onClick={() => setCancelOpen(true)}>
                    Cancel booking
                  </Button>
                </div>
              </div>
            ) : cr?.status === 'PENDING' ? (
              <Alert tone="info" title="Cancellation requested">
                You asked to cancel this ride{cr.requestedAt ? ` on ${fmtDateTime(cr.requestedAt, tz)}` : ''}: “{cr.reason}”. The admin will review it and notify you. Until then the ride stays booked.
              </Alert>
            ) : b.canRequestCancellation ? (
              <div className="space-y-3">
                {cr?.status === 'DECLINED' && (
                  <Alert tone="warn" title="Your last cancellation request was declined">
                    {cr.note || 'The ride stays booked.'}
                  </Alert>
                )}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-slate-600">A cab is already assigned. If your plans have changed, ask the admin to cancel it.</p>
                  <Button variant="danger" onClick={() => setRequestOpen(true)}>
                    Request cancellation
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-600">This ride can no longer be cancelled. Please contact the transport coordinator if your plans have changed.</p>
            )}
          </Card>
        )}

        <Card title="Status history">
          {b.history.length ? (
            <ol className="relative space-y-4 border-l border-slate-200 pl-5">
              {b.history.map((h, i) => (
                <li key={h._id} className="relative">
                  {/* The latest step stands out; earlier ones are greyed. */}
                  <span className={cn('absolute left-[-25px] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-white', i === b.history.length - 1 ? 'bg-indigo-600' : 'bg-slate-300')} aria-hidden />
                  <p className={cn('text-sm', i === b.history.length - 1 ? 'font-semibold text-slate-900' : 'font-medium text-slate-700')}>{humanize(h.event)}</p>
                  <p className="text-xs text-slate-500">{fmtDateTime(h.createdAt, tz)}</p>
                  {h.reason && <p className="mt-0.5 text-sm text-slate-600">{h.reason}</p>}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-slate-500">No history yet.</p>
          )}
        </Card>
      </div>

      <CancelRideDialog
        open={cancelOpen}
        late={!!b.cabLate}
        onClose={() => setCancelOpen(false)}
        onConfirm={cancel}
        summary={
          <p>
            {b.reference} · {fmtTravelDate(b.travelDate)} · {pickupLabel(b)}
          </p>
        }
      />
      <ConfirmDialog
        open={requestOpen}
        onClose={() => setRequestOpen(false)}
        onConfirm={requestCancellation}
        title="Ask to cancel this ride?"
        message={
          <>
            <p>
              {b.reference} · {fmtTravelDate(b.travelDate)} · {pickupLabel(b)}
            </p>
            <p className="mt-1 text-slate-500">A cab is already assigned, so the admin decides. The ride stays booked until they approve your request.</p>
          </>
        }
        confirmLabel="Send request"
        reasonLabel="Why do you need to cancel?"
      />
    </>
  );
}

