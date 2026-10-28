import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, ChevronDown, ChevronUp, MapPin, Navigation, Route, Users, XCircle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, Button, ErrorState, Spinner, cn, useToast } from '../../components/ui';
import { ApiError, errorMessage, get, post } from '../../lib/api';
import { fmt12h, fmtTravelDate } from '../../lib/format';
import { multiStopRouteUrl, navigationUrl } from '../../lib/maps';
import { DriverCancelDialog, PinPanel, type Ride } from './DriverRide';

type Trip = { tripId: string; tripName: string; direction: 'IN' | 'OUT'; rides: Ride[] };

const nameOf = (r: Ride) => r.employee?.name ?? 'Passenger';
const ENDED: Record<string, string> = { COMPLETED: 'Dropped', CANCELLED: 'Cancelled', NO_SHOW: 'Didn’t show up', REASSIGNED: 'Moved to another cab', DECLINED: 'Moved to another cab' };

function NavButton({ point, place, label }: { point?: { lat: number; lng: number } | null; place: string; label: string }) {
  return (
    <a
      href={navigationUrl(point, place)}
      target="_blank"
      rel="noopener noreferrer"
      className="flex h-14 w-full items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white text-lg font-semibold text-indigo-700 shadow-xs active:bg-slate-50"
    >
      <MapPin className="h-5 w-5" aria-hidden />
      {label}
    </a>
  );
}

function Step({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
      <h2 className="text-lg font-bold text-slate-900">{title}</h2>
      {children}
    </section>
  );
}

/**
 * A shared cab as one trip for the driver: every rider in stop order and one next step at a time.
 *  Office → homes: start → navigate to the office → arrived → each rider's PIN → drop-offs in order.
 *  Homes → office: start → each pickup in order (navigate, arrived, PIN) → navigate to the office → complete.
 * Every rider keeps their own ride, PIN and notifications; the buttons act on the right riders.
 */
export default function DriverTrip() {
  const { tripId = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [cancelFor, setCancelFor] = useState<Ride | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['driver', 'trip', tripId],
    queryFn: () => get<Trip>(`/driver/trips/${tripId}`),
    refetchInterval: 30_000,
  });

  const done = () => {
    qc.invalidateQueries({ queryKey: ['driver'] });
    return refetch();
  };

  /** Runs one step for several riders, one after another. */
  const runFor = async (rides: Ride[], path: string, success: string) => {
    if (busy || !rides.length) return false;
    setBusy(true);
    setActionError('');
    try {
      for (const r of rides) await post(`/driver/rides/${r.assignmentId}/${path}`, {});
      toast.success(success);
      return true;
    } catch (e) {
      setActionError(e instanceof ApiError && e.code === 'ASSIGNMENT_NOT_ACTIVE' ? 'One of these rides is no longer yours — the coordinator may have moved it.' : errorMessage(e));
      return false;
    } finally {
      setBusy(false);
      await done();
    }
  };

  const back = (
    <Link to="/driver" className="inline-flex items-center gap-1 text-sm font-medium text-slate-600 hover:text-slate-900">
      <ArrowLeft className="h-4 w-4" aria-hidden /> My rides
    </Link>
  );

  if (isLoading) return <Spinner />;
  if (error || !data) {
    return (
      <div className="space-y-4">
        {back}
        {error instanceof ApiError && error.status === 404 ? <Alert tone="error" title="Trip not found">This trip doesn&apos;t exist or isn&apos;t assigned to you.</Alert> : <ErrorState error={error} onRetry={refetch} />}
      </div>
    );
  }

  const rides = data.rides;
  const toOffice = data.direction === 'IN';
  const live = rides.filter((r) => r.assignmentStatus === 'ACTIVE' && r.booking);
  const at = (s: string) => live.filter((r) => r.booking!.status === s);
  const assigned = at('ASSIGNED');
  const goingTo = at('DRIVER_EN_ROUTE');
  const waiting = at('ARRIVED');
  const onBoard = at('IN_PROGRESS');
  const ended = rides.filter((r) => r.assignmentStatus !== 'ACTIVE');
  const first = rides.find((r) => r.booking)?.booking;
  // The office is the pickup of office → home rides and the drop of home → office rides.
  const officeRide = rides.find((r) => r.booking);
  const officePoint = toOffice ? officeRide?.dropPoint : officeRide?.pickupPoint;
  const officeText = (toOffice ? officeRide?.booking?.dropLocation : officeRide?.booking?.pickupLocation) ?? 'Office';

  /** Moves a rider one place up or down in the stops; the order is saved for the driver. */
  const move = async (r: Ride, by: -1 | 1) => {
    const ids = live.map((x) => x.assignmentId);
    const i = ids.indexOf(r.assignmentId);
    const j = i + by;
    if (busy || i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setBusy(true);
    setActionError('');
    try {
      await post(`/driver/trips/${tripId}/order`, { assignmentIds: ids });
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
      await done();
    }
  };

  // The whole route in the current order: the office and every rider still on the trip.
  const homeStop = (r: Ride) => {
    const p = toOffice ? r.pickupPoint : r.dropPoint;
    return p ? `${p.lat},${p.lng}` : ((toOffice ? r.booking?.pickupLocation : r.booking?.dropLocation) ?? '');
  };
  const officeStop = officePoint ? `${officePoint.lat},${officePoint.lng}` : officeText;
  const fullRoute = (toOffice ? [...live.map(homeStop), officeStop] : [officeStop, ...live.map(homeStop)]).filter(Boolean);

  const cancelLink = (r: Ride) => (
    <button type="button" onClick={() => setCancelFor(r)} className="text-sm font-medium text-red-700 underline" disabled={busy}>
      Not coming?
    </button>
  );

  // PIN entry for riders at the pickup (several at the office, one at a time at homes).
  const pins = waiting.length > 0 && (
    <Step title={waiting.length > 1 ? `Riders getting in (${waiting.length}) — enter each PIN` : `${nameOf(waiting[0])} is getting in — enter the PIN`}>
      {waiting.map((r) => (
        <div key={r.assignmentId} className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-base font-semibold text-slate-900">{nameOf(r)}</p>
            {cancelLink(r)}
          </div>
          <PinPanel ride={r} onStarted={done} onNotActive={(m) => setActionError(m)} />
        </div>
      ))}
    </Step>
  );

  let steps: ReactNode = null;
  if (assigned.length) {
    steps = (
      <Step title="Ready to go?">
        <Button size="xl" loading={busy} onClick={() => runFor(assigned, 'en-route', 'Trip started — every rider has been told')} icon={<Navigation className="h-6 w-6" aria-hidden />}>
          Start the trip
        </Button>
      </Step>
    );
  } else if (!toOffice) {
    // Office → homes: everyone gets in at the office, then drop-offs in order.
    const [nextDrop, ...laterDrops] = onBoard;
    steps = (
      <>
        {goingTo.length > 0 && (
          <Step title="Go to the office">
            <NavButton point={officePoint} place={officeText} label="Navigate to office" />
            <Button size="xl" loading={busy} onClick={() => runFor(goingTo, 'arrived', 'Arrival recorded — every rider has been told')} icon={<MapPin className="h-6 w-6" aria-hidden />}>
              I have arrived at the office
            </Button>
          </Step>
        )}
        {pins}
        {nextDrop && (
          <Step title={`Drop ${onBoard.length > 1 ? `1 of ${onBoard.length}` : ''}: ${nameOf(nextDrop)}`}>
            <p className="text-base text-slate-700">{nextDrop.booking!.dropLocation}</p>
            {waiting.length > 0 ? (
              <Alert tone="warn">Enter every rider&apos;s PIN (or mark who isn&apos;t coming) before you leave the office.</Alert>
            ) : (
              <>
                <NavButton point={nextDrop.dropPoint} place={nextDrop.booking!.dropLocation} label={`Navigate to ${nameOf(nextDrop)}`} />
                <Button
                  size="xl"
                  variant="success"
                  loading={busy}
                  onClick={() => runFor([nextDrop], 'complete', `${nameOf(nextDrop)} dropped`)}
                  icon={<CheckCircle2 className="h-6 w-6" aria-hidden />}
                >
                  Dropped {nameOf(nextDrop)}
                </Button>
              </>
            )}
            {laterDrops.length > 0 && (
              <ol className="space-y-1 border-t border-slate-100 pt-3 text-sm text-slate-600">
                {laterDrops.map((r, i) => (
                  <li key={r.assignmentId}>
                    Then {i + 2}. <span className="font-medium text-slate-800">{nameOf(r)}</span> — {r.booking!.dropLocation}
                  </li>
                ))}
              </ol>
            )}
          </Step>
        )}
      </>
    );
  } else {
    // Homes → office: pick each rider up in order, then everyone to the office.
    const [nextPickup, ...laterPickups] = goingTo;
    steps = (
      <>
        {nextPickup && waiting.length === 0 && (
          <Step title={`Pick up ${goingTo.length > 1 ? `1 of ${goingTo.length}` : ''}: ${nameOf(nextPickup)}`}>
            <div className="flex items-start justify-between gap-2">
              <p className="text-base text-slate-700">{nextPickup.booking!.pickupLocation}</p>
              {cancelLink(nextPickup)}
            </div>
            <NavButton point={nextPickup.pickupPoint} place={nextPickup.booking!.pickupLocation} label={`Navigate to ${nameOf(nextPickup)}`} />
            <Button size="xl" loading={busy} onClick={() => runFor([nextPickup], 'arrived', `${nameOf(nextPickup)} has been told you've arrived`)} icon={<MapPin className="h-6 w-6" aria-hidden />}>
              I have arrived at {nameOf(nextPickup)}&apos;s
            </Button>
            {laterPickups.length > 0 && (
              <ol className="space-y-1 border-t border-slate-100 pt-3 text-sm text-slate-600">
                {laterPickups.map((r, i) => (
                  <li key={r.assignmentId}>
                    Then {i + 2}. <span className="font-medium text-slate-800">{nameOf(r)}</span> — {r.booking!.pickupLocation}
                  </li>
                ))}
              </ol>
            )}
          </Step>
        )}
        {pins}
        {!goingTo.length && !waiting.length && onBoard.length > 0 && (
          <Step title="Everyone is on board — go to the office">
            <NavButton point={officePoint} place={officeText} label="Navigate to office" />
            <Button
              size="xl"
              variant="success"
              loading={busy}
              onClick={async () => {
                if (await runFor(onBoard, 'complete', 'Trip completed')) navigate('/driver');
              }}
              icon={<CheckCircle2 className="h-6 w-6" aria-hidden />}
            >
              Complete trip
            </Button>
          </Step>
        )}
      </>
    );
  }

  return (
    <div className="space-y-4">
      {back}

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
        <p className="flex items-center gap-1.5 text-sm font-medium text-indigo-700">
          <Users className="h-4 w-4" aria-hidden /> Shared cab · {rides.length} riders · {toOffice ? 'homes → office' : 'office → homes'}
        </p>
        <p className="mt-1 text-xl font-bold text-slate-900">{data.tripName}</p>
        {first && (
          <p className="text-base text-slate-700">
            <span className="text-2xl font-bold text-slate-900">{fmt12h(first.pickupTime)}</span> · {fmtTravelDate(first.travelDate)}
          </p>
        )}
        <ol className="mt-3 space-y-1.5">
          {rides.map((r, i) => {
            const pos = live.indexOf(r);
            const endedAs = r.assignmentStatus !== 'ACTIVE' ? (ENDED[r.assignmentStatus] ?? 'Ended') : r.booking?.status === 'IN_PROGRESS' ? 'On board' : null;
            return (
              <li key={r.assignmentId} className={cn('flex items-start gap-2 text-sm', r.assignmentStatus !== 'ACTIVE' && 'text-slate-400')}>
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-semibold text-indigo-800">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-slate-900">{nameOf(r)}</span> — {toOffice ? r.booking?.pickupLocation : r.booking?.dropLocation}
                </span>
                {endedAs && (
                  <span className={cn('shrink-0 text-xs font-medium', r.assignmentStatus === 'COMPLETED' || endedAs === 'On board' ? 'text-emerald-700' : 'text-slate-500')}>
                    {r.assignmentStatus === 'COMPLETED' ? <CheckCircle2 className="mr-0.5 inline h-3.5 w-3.5" aria-hidden /> : r.assignmentStatus !== 'ACTIVE' ? <XCircle className="mr-0.5 inline h-3.5 w-3.5" aria-hidden /> : null}
                    {endedAs}
                  </span>
                )}
                {live.length > 1 && pos >= 0 && (
                  <span className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      onClick={() => move(r, -1)}
                      disabled={busy || pos === 0}
                      aria-label={`Move ${nameOf(r)} earlier`}
                      className="rounded-lg border border-slate-300 p-1.5 text-slate-700 hover:bg-slate-50 disabled:opacity-30"
                    >
                      <ChevronUp className="h-4 w-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(r, 1)}
                      disabled={busy || pos === live.length - 1}
                      aria-label={`Move ${nameOf(r)} later`}
                      className="rounded-lg border border-slate-300 p-1.5 text-slate-700 hover:bg-slate-50 disabled:opacity-30"
                    >
                      <ChevronDown className="h-4 w-4" aria-hidden />
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
        {live.length > 1 && (
          <>
            <a
              href={multiStopRouteUrl(fullRoute)}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 text-base font-semibold text-indigo-700 active:bg-indigo-100"
            >
              <Route className="h-5 w-5" aria-hidden /> View full route ({live.length} stops)
            </a>
            <p className="mt-2 text-xs text-slate-500">Suggested order, nearest stop next. Know a better way? Use the arrows to change it.</p>
          </>
        )}
      </section>

      {actionError && (
        <div aria-live="assertive">
          <Alert tone="error" title="Action failed">
            {actionError}
          </Alert>
        </div>
      )}

      {live.length ? (
        steps
      ) : (
        <Step title="Trip finished">
          <p className="text-base text-slate-700">
            {ended.filter((r) => r.assignmentStatus === 'COMPLETED').length} of {rides.length} riders dropped.
          </p>
          <Button size="lg" variant="secondary" onClick={() => navigate('/driver')}>
            Back to my rides
          </Button>
        </Step>
      )}

      <DriverCancelDialog
        open={!!cancelFor}
        arrived={cancelFor?.booking?.status === 'ARRIVED'}
        onClose={() => setCancelFor(null)}
        onConfirm={async (reason, note) => {
          await post(`/driver/rides/${cancelFor!.assignmentId}/cancel`, { reason, ...(note ? { note } : {}) });
          toast.success(`${cancelFor ? nameOf(cancelFor) : 'Ride'} removed from this trip — the coordinator is informed`);
          await done();
        }}
      />
    </div>
  );
}
