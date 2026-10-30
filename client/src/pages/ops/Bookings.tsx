import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Car, CheckCircle2, ChevronDown, Clock, MapPin, Search, User, X } from 'lucide-react';
import { Children, isValidElement, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { CallButton,
  Alert,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  Plate,
  Pagination,
  SearchInput,
  Select,
  Spinner,
  StatusBadge,
  Tabs,
  cn,
  useToast,
  type Column,
} from '../../components/ui';
import { ApiError, errorMessage, post, qs } from '../../lib/api';
import { useUnsavedChanges } from '../../lib/unsaved';
import { usePaged } from '../../lib/hooks';
import { addDaysISO, currentWorkDay, fmt12h, fmtShortDate, fmtTravelDate, humanize, uuid } from '../../lib/format';
import { addMinutesHHmm } from '../../lib/policy';
import { useOpsOffices } from './OpsDashboard';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type BookingRow = {
  _id: string;
  reference: string;
  status: string;
  travelDate: string;
  pickupTime: string;
  scheduledPickupAt: string;
  timezone: string;
  // IN = home → office (reach by reportBy; the coordinator sets the pickup), OUT = office → home.
  direction?: 'IN' | 'OUT';
  reportBy?: string;
  pickupTimeSet?: boolean;
  pickupLocation: string;
  dropLocation: string;
  passengers: number;
  shift?: string;
  tripType: string;
  leg?: string;
  officeLocation: string;
  notes?: string;
  isDelayed?: boolean;
  delayReason?: string;
  flaggedForReview?: boolean;
  flagReason?: string;
  cancellationRequest?: { status: string; reason?: string } | null;
  employee: { _id: string; fullName: string; employeeId: string; email?: string; phone?: string; route?: string };
  // tripId/tripName: set when the ride shares a cab with others (assigned together).
  assignment?: { _id?: string; acknowledgedAt?: string; status?: string; tripId?: string; tripName?: string };
  driver?: { _id: string; fullName: string; driverCode: string; phone?: string } | null;
  vehicle?: { _id: string; registrationNumber: string; capacity?: number } | null;
};

type EligibleDriver = {
  _id: string;
  fullName: string;
  driverCode: string;
  phone: string;
  availability: string;
  onDuty: boolean;
  verificationStatus: string;
  currentVehicle?: { _id: string; registrationNumber: string; capacity: number; status: string } | null;
  eligible: boolean;
  problems: string[];
};
type EligibleVehicle = {
  _id: string;
  registrationNumber: string;
  model: string;
  capacity: number;
  status: string;
  currentDriver?: { _id: string; fullName: string } | null;
  eligible: boolean;
  problems: string[];
  // Busy at this time only with one shared trip that has room: the rides can join it.
  join?: { tripId: string; tripName: string; riders: number; seatsUsed: number; pickupTime?: string; driver: { _id: string; fullName: string; driverCode: string; phone: string } } | null;
  // Busy only with trips at other times close by (e.g. 10 PM for an 11 PM ride): the coordinator's call.
  nearby?: { trips: Array<{ name: string; time: string }> } | null;
};

export const ASSIGNABLE = ['REQUESTED', 'APPROVED'];
// The cab can be changed only until the driver starts the trip; after that a cab problem is the
// driver's to report, and the riders come back here to assign again.
export const REASSIGNABLE = ['ASSIGNED'];
/** Rides of trips the driver has started (anyone in the cab on the way, picked up or dropped). */
export const TRIP_STARTED = ['DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'NO_SHOW'];

// ---------------------------------------------------------------------------
// Shared trip: several selected rides → one driver + cab
// ---------------------------------------------------------------------------
type TripEligible = { bookings: Array<{ _id: string; passengers: number }>; seats: number; suggestedName: string; drivers: EligibleDriver[]; vehicles: EligibleVehicle[] };

const seatsOf = (rides: BookingRow[]) => rides.reduce((n, r) => n + (r.passengers || 1), 0);

/**
 * The bar under the ticked rides. "Assign to one cab" opens it in place (no pop-up) to show only
 * the cabs that can take every ticked ride: active, with a driver, neither of them on another ride
 * at that time, and with a seat for everyone. Picking a cab picks its driver; one click assigns.
 */
export function PoolBar({ rides, onClear, onDone, change = false, startOpen = false }: { rides: BookingRow[]; onClear: () => void; onDone: () => void; change?: boolean; startOpen?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const ids = useMemo(() => rides.map((r) => r._id).sort(), [rides]);
  // Change mode: one assigned ride moves to another free cab (with a reason); the list opens at once.
  const [open, setOpen] = useState(change || startOpen);
  const [reason, setReason] = useState('');
  const current = change ? rides[0] : undefined;
  // A typed reason for changing the cab isn't thrown away without asking.
  const guard = useUnsavedChanges(change && !!reason.trim());
  const [vehicleId, setVehicleId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(uuid());
  const seats = seatsOf(rides);

  // IN rides (home → office): the coordinator sets when the cab picks them up, before everyone's
  // reach-office time — earlier than cab hours if the ride is long. Suggested: an hour before.
  const ins = rides.filter((r) => r.direction === 'IN');
  const mixed = ins.length > 0 && ins.length !== rides.length;
  // One cab, one trip: every ticked ride must go the same way at the same date and time.
  const differentTimes = !mixed && new Set(rides.map((r) => `${r.travelDate} ${r.direction === 'IN' ? (r.reportBy ?? r.pickupTime) : r.pickupTime}`)).size > 1;
  const blocked = !change && (mixed || differentTimes);
  const firstReport = [...ins].sort((a, b) => a.scheduledPickupAt.localeCompare(b.scheduledPickupAt))[0];
  const reachBy = firstReport ? (firstReport.reportBy ?? firstReport.pickupTime) : '';
  const [pickupTime, setPickupTime] = useState('');

  // A different set of rides is a different trip: start over.
  const idsKey = ids.join(',');
  useEffect(() => {
    setVehicleId('');
    setError('');
    setReason('');
    setKey(uuid());
    setPickupTime(reachBy ? addMinutesHHmm(reachBy, -60) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const eligible = useQuery({
    queryKey: ['ops', 'trip-eligible', ids],
    queryFn: () => post<TripEligible>('/ops/trips/eligible', { bookingIds: ids }),
    enabled: open && ids.length > 0,
    staleTime: 0,
  });

  const drivers = new Map((eligible.data?.drivers ?? []).map((d) => [d._id, d]));
  const cabs = (eligible.data?.vehicles ?? [])
    // Changing a ride's cab: its current cab isn't a choice.
    .filter((v) => !current || v._id !== current.vehicle?._id)
    .map((v) => {
      const driver = v.currentDriver ? drivers.get(v.currentDriver._id) : undefined;
      const why = !v.currentDriver ? 'No driver assigned to this cab' : !v.eligible ? v.problems[0] : driver && !driver.eligible ? `Driver: ${driver.problems[0] ?? 'not available'}` : '';
      return { v, driver, usable: !why, why };
    });
  const usable = cabs.filter((c) => c.usable).sort((a, b) => a.v.capacity - b.v.capacity || a.v.registrationNumber.localeCompare(b.v.registrationNumber));
  // Cabs already going at this time with room: the riders can be added to that trip (also a ride
  // moving cab: A and B share a cab, A moves to C's cab, so A + C share and B rides alone).
  const joinable = cabs.filter((c) => !c.usable && c.v.join);
  // Cabs with another trip at a different time close by: selectable, the coordinator decides (new rides only).
  const nearbyCabs = change ? [] : cabs.filter((c) => !c.usable && !c.v.join && c.v.nearby && c.driver);
  const unusable = cabs.filter((c) => !c.usable && !joinable.includes(c) && !nearbyCabs.includes(c));
  const chosenFree = usable.find((c) => c.v._id === vehicleId) ?? nearbyCabs.find((c) => c.v._id === vehicleId);
  const chosenJoin = joinable.find((c) => c.v._id === vehicleId);
  const chosen = chosenFree ?? (chosenJoin ? { ...chosenJoin, driver: { ...chosenJoin.v.join!.driver } } : undefined);
  const join = chosenJoin?.v.join ?? null;
  const nearby = !join ? (chosenFree?.v.nearby ?? null) : null;
  // IN rides going into a new cab: the coordinator sets when it picks them up.
  const askPickup = !current && ins.length > 0 && !join;
  const nearbyText = (n: { trips: Array<{ name: string; time: string }> }) => n.trips.map((t) => `${t.name} at ${t.time}`).join(', ');

  const moveCab = async () => {
    if (!current || !chosen?.driver) return;
    if (reason.trim().length < 3) {
      setError('Give a reason for changing the cab (the employee is told the cab changed).');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await post(`/ops/bookings/${current._id}/reassign`, {
        driverId: chosen.driver._id,
        vehicleId: chosen.v._id,
        reason: reason.trim(),
        ...(join ? { joinTripId: join.tripId } : {}),
      });
      toast.success(
        join ? `Moved to ${join.tripName}` : 'Cab changed',
        `${current.employee?.fullName}: now ${chosen.v.registrationNumber} · ${chosen.driver.fullName}. The employee and both drivers are notified.`,
      );
      qc.invalidateQueries({ queryKey: ['ops'] });
      onDone();
    } catch (e) {
      setError(errorMessage(e));
      const code = e instanceof ApiError ? e.code : '';
      if (code === 'SCHEDULE_CONFLICT' || code === 'NOT_ELIGIBLE' || code === 'TRIP_CHANGED') {
        setVehicleId('');
        eligible.refetch();
      } else if (code === 'INVALID_TRANSITION' || code === 'TRIP_STARTED') qc.invalidateQueries({ queryKey: ['ops'] });
    } finally {
      setBusy(false);
    }
  };

  const assign = async () => {
    if (change) return moveCab();
    if (!chosen?.driver) return;
    if (ins.length && !join && !/^\d{2}:\d{2}$/.test(pickupTime)) {
      setError(`Set the pickup time — they must reach the office by ${fmt12h(reachBy)}.`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await post<{ tripName: string }>(
        '/ops/trips',
        // The cab is named after the riders' routes on the server.
        join
          ? { bookingIds: ids, driverId: join.driver._id, vehicleId: chosen.v._id, joinTripId: join.tripId }
          : { bookingIds: ids, driverId: chosen.driver._id, vehicleId: chosen.v._id, ...(ins.length ? { pickupTime } : {}), ...(nearby ? { allowNearby: true } : {}) },
        { 'Idempotency-Key': key },
      );
      toast.success(
        join ? `Added to ${res.tripName}` : `${res.tripName}: ${rides.length} ${rides.length === 1 ? 'ride' : 'rides'} assigned`,
        `${chosen.v.registrationNumber} · ${chosen.driver.fullName}${ins.length && !join ? ` · pickup ${fmt12h(pickupTime)}` : ''}. Riders and driver are notified.`,
      );
      qc.invalidateQueries({ queryKey: ['ops'] });
      setOpen(false);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
      setKey(uuid());
      const code = e instanceof ApiError ? e.code : '';
      if (code === 'INVALID_TRANSITION' || code === 'ALREADY_ASSIGNED') qc.invalidateQueries({ queryKey: ['ops'] });
      else if (code === 'SCHEDULE_CONFLICT' || code === 'NOT_ELIGIBLE') {
        // The cab or driver was taken meanwhile: choose again from a fresh list.
        setVehicleId('');
        eligible.refetch();
      }
      // Other errors (e.g. the pickup time): keep the cab selected so only the time needs fixing.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sticky bottom-4 z-20 mt-4 rounded-xl border border-indigo-200 bg-white shadow-lg ring-1 ring-indigo-100" role="region" aria-label="Selected rides">
      <div className="flex flex-wrap items-center justify-between gap-3 p-3 sm:p-4">
        <div className="min-w-0 text-sm">
          <p className="font-semibold text-slate-900">
            {current
              ? `Change cab · ${current.employee?.fullName ?? current.reference}`
              : startOpen && rides.length === 1
                ? `Assign cab · ${rides[0].employee?.fullName ?? rides[0].reference}`
                : `${rides.length} ${rides.length === 1 ? 'ride' : 'rides'} selected`}
          </p>
          <p className="truncate text-slate-500">
            {current ? (
              <>
                Now <span className="font-mono">{current.vehicle?.registrationNumber ?? '—'}</span> · {current.driver?.fullName ?? '—'} · {current.direction === 'IN' ? 'IN' : 'OUT'} {fmt12h(current.pickupTime)}
              </>
            ) : (
              <>
                {[...new Set(rides.map((r) => r.employee?.route || 'Route not set'))].join(' + ')} ·{' '}
                {[...new Set(rides.map((r) => (r.direction === 'IN' ? `IN by ${fmt12h(r.reportBy ?? r.pickupTime)}` : `OUT ${fmt12h(r.pickupTime)}`)))].join(', ')}
              </>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          {!current && !blocked && !open && (
            <Button icon={<Car className="h-4 w-4" />} onClick={() => setOpen(true)} aria-expanded={false}>
              Assign to one cab
            </Button>
          )}
          {/* Close: hides the cab list (rides stay ticked); changing a cab or a booking's own picker closes altogether. */}
          {(current || startOpen || (open && !blocked)) && (
            <button
              type="button"
              aria-label="Close"
              title="Close"
              disabled={busy}
              onClick={() => (current || startOpen ? guard(onClear) : setOpen(false))}
              className="grid h-10 w-10 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50"
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          )}
        </div>
      </div>

      {blocked && (
        <div className="border-t border-slate-100 p-3 sm:p-4">
          {mixed ? (
            <Alert tone="warn" title="IN and OUT rides need separate cabs">
              Tick only rides to the office (IN) or only rides home (OUT), then assign.
            </Alert>
          ) : (
            <Alert tone="warn" title="These rides are at different times">
              One cab takes one trip. Tick only rides at the same time, then assign.
            </Alert>
          )}
        </div>
      )}

      {open && !blocked && (
        <div className="max-h-[55vh] space-y-3 overflow-y-auto border-t border-slate-100 p-3 sm:p-4">
          {eligible.isLoading ? (
            <Spinner label="Finding cabs free for every ride…" />
          ) : eligible.error ? (
            <ErrorState error={eligible.error} onRetry={eligible.refetch} />
          ) : (
            <>
              {/* The list updates itself as cabs and rides change (live updates): no refresh button needed. */}
              {!usable.length && !joinable.length && !nearbyCabs.length && <p className="text-sm font-medium text-slate-900">No cab is free for these rides</p>}

              {usable.length > 0 && (
                <div role="radiogroup" aria-label="Cab" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {usable.map(({ v, driver }) => {
                    const selectedCab = v._id === vehicleId;
                    return (
                      <button
                        key={v._id}
                        type="button"
                        role="radio"
                        aria-checked={selectedCab}
                        onClick={() => setVehicleId(v._id)}
                        className={cn(
                          'rounded-lg border p-3 text-left text-sm transition-colors',
                          selectedCab ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500' : 'border-slate-200 bg-white hover:border-slate-400',
                        )}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="font-mono text-base font-semibold text-slate-900">{v.registrationNumber}</span>
                          <SeatsFree capacity={v.capacity} used={0} needed={seats} />
                        </span>
                        <span className="mt-1.5 flex items-center gap-1.5 text-slate-700">
                          <User className="h-4 w-4 text-slate-400" aria-hidden />
                          <span className="font-medium">{driver?.fullName}</span>
                          <span className="text-slate-500">({driver?.driverCode})</span>
                        </span>
                        <span className="mt-0.5 block text-xs text-slate-500">
                          {driver?.onDuty ? 'On duty' : 'Off duty'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Cabs already going at this time with room: add these riders to that trip (one cab covers every route). */}
              {joinable.length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-sky-800">Add to a cab already going</p>
                  <div role="radiogroup" aria-label="Cab already going" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {joinable.map(({ v }) => {
                      const j = v.join!;
                      const selectedCab = v._id === vehicleId;
                      return (
                        <button
                          key={v._id}
                          type="button"
                          role="radio"
                          aria-checked={selectedCab}
                          onClick={() => setVehicleId(v._id)}
                          className={cn(
                            'rounded-lg border p-3 text-left text-sm transition-colors',
                            selectedCab ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500' : 'border-sky-300 bg-sky-50 hover:border-sky-500',
                          )}
                        >
                          <span className="flex items-center justify-between gap-2">
                            <span className="font-mono text-base font-semibold text-slate-900">{v.registrationNumber}</span>
                            <SeatsFree capacity={v.capacity} used={j.seatsUsed} needed={seats} />
                          </span>
                          <span className="mt-1.5 block font-medium text-sky-900">
                            {j.tripName} · {j.riders} {j.riders === 1 ? 'rider' : 'riders'}
                            {j.pickupTime ? ` · ${fmt12h(j.pickupTime)}` : ''}
                          </span>
                          <span className="mt-0.5 flex items-center gap-1.5 text-slate-700">
                            <User className="h-4 w-4 text-slate-400" aria-hidden />
                            <span className="font-medium">{j.driver.fullName}</span>
                            <span className="text-slate-500">({j.driver.driverCode})</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Cabs with another trip at a different time close by: the coordinator knows if it's back in time. */}
              {nearbyCabs.length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-orange-800">Has another trip close by — your call</p>
                  <div role="radiogroup" aria-label="Cab with another trip close by" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {nearbyCabs.map(({ v, driver }) => {
                      const selectedCab = v._id === vehicleId;
                      return (
                        <button
                          key={v._id}
                          type="button"
                          role="radio"
                          aria-checked={selectedCab}
                          onClick={() => setVehicleId(v._id)}
                          className={cn(
                            'rounded-lg border p-3 text-left text-sm transition-colors',
                            selectedCab ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500' : 'border-orange-300 bg-orange-50 hover:border-orange-500',
                          )}
                        >
                          <span className="flex items-center justify-between gap-2">
                            <span className="font-mono text-base font-semibold text-slate-900">{v.registrationNumber}</span>
                            <SeatsFree capacity={v.capacity} used={0} needed={seats} />
                          </span>
                          <span className="mt-1.5 flex items-center gap-1.5 text-slate-700">
                            <User className="h-4 w-4 text-slate-400" aria-hidden />
                            <span className="font-medium">{driver?.fullName}</span>
                            <span className="text-slate-500">({driver?.driverCode})</span>
                          </span>
                          <span className="mt-1 flex items-start gap-1.5 font-medium text-orange-900">
                            <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> Also has {nearbyText(v.nearby!)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Cabs that can't take these rides, shown clearly with the reason (not selectable). */}
              {unusable.length > 0 && (
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" aria-label="Cabs that can't take these rides">
                  {unusable.map(({ v, driver, why }) => (
                    <div key={v._id} className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm" aria-disabled>
                      <span className="flex items-center justify-between gap-2">
                        <span className="font-mono text-base font-semibold text-slate-900">{v.registrationNumber}</span>
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">{v.capacity} seats</span>
                      </span>
                      {v.currentDriver && (
                        <span className="mt-1.5 flex items-center gap-1.5 text-slate-700">
                          <User className="h-4 w-4 text-slate-400" aria-hidden />
                          <span className="font-medium">{v.currentDriver.fullName}</span>
                          {driver?.driverCode && <span className="text-slate-500">({driver.driverCode})</span>}
                        </span>
                      )}
                      <span className="mt-1 flex items-start gap-1.5 font-medium text-amber-900">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {why}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {chosen && (
                  // Phones: the pickup time and Assign side by side (the time box shrinks, the button lines up with it).
                  <div className={cn('flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3', askPickup && 'max-sm:flex-nowrap max-sm:items-start')}>
                    {current && (
                      <div className="min-w-56 flex-1">
                        <Input label="Reason for the change" required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Original cab broke down" />
                      </div>
                    )}
                    {askPickup && (
                      <div className="w-44 max-sm:w-auto max-sm:min-w-0 max-sm:flex-1">
                        <Input label="Pickup time" type="time" required value={pickupTime} onChange={(e) => setPickupTime(e.target.value)} hint={`Reach office by ${fmt12h(reachBy)}`} />
                      </div>
                    )}
                    {nearby && (
                      <p className="flex items-start gap-1.5 text-sm font-medium text-orange-900">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> This cab also has {nearbyText(nearby)} — make sure it can be back in time.
                      </p>
                    )}
                    {join && (
                      <p className="text-sm text-slate-600">
                        Joins <strong>{join.tripName}</strong>
                        {join.pickupTime ? <> · pickup at this cab&apos;s time, {fmt12h(join.pickupTime)}</> : null}
                      </p>
                    )}
                    <Button variant="success" size="lg" className={cn('ml-auto', askPickup && 'max-sm:mt-6 max-sm:h-10 max-sm:shrink-0')} loading={busy} onClick={assign} icon={<CheckCircle2 className="h-5 w-5" />}>
                      {current ? `Move to ${chosen.v.registrationNumber}` : 'Assign'}
                    </Button>
                  </div>
              )}
              {error && <Alert tone="error">{error}</Alert>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bookings page
// ---------------------------------------------------------------------------
// Plain-language tabs. `also` lists other status sets (used by dashboard links) that open the same tab.
// "Cab requests" is today's and tomorrow's live work; finished and all bookings live on the History page.
const LIVE_PRESETS = [
  // `short`: the tab's name on phones, where the three must fit on one line.
  { value: 'waiting', label: 'Waiting for a cab', short: 'Waiting', status: 'REQUESTED,APPROVED,PENDING_APPROVAL', also: ['REQUESTED,APPROVED', 'PENDING_APPROVAL'] },
  { value: 'assigned', label: 'Cab assigned', short: 'Assigned', status: 'ASSIGNED,DRIVER_EN_ROUTE,ARRIVED', also: [] },
  { value: 'trip', label: 'On trip', short: 'On trip', status: 'IN_PROGRESS', also: [] },
] as const;
const HISTORY_PRESETS = [
  { value: 'all', label: 'All', status: '', also: [] },
  { value: 'completed', label: 'Completed', status: 'COMPLETED', also: [] },
  { value: 'cancelled', label: 'Cancelled', status: 'CANCELLED,REJECTED,NO_SHOW', also: [] },
] as const;
const PRESETS = [...LIVE_PRESETS, ...HISTORY_PRESETS];
// History's status dropdown covers every stage, so any booking can be found there.
const HISTORY_STATUS_OPTIONS = [HISTORY_PRESETS[0], ...LIVE_PRESETS, ...HISTORY_PRESETS.slice(1)];
type PresetKey = (typeof PRESETS)[number]['value'] | 'custom';

const normStatus = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean)
    .sort()
    .join(',');
const presetFor = (status: string, presets: readonly (typeof PRESETS)[number][]): PresetKey =>
  presets.find((p) => [p.status, ...p.also].some((x) => normStatus(x) === normStatus(status)))?.value ?? 'custom';

const EMPTY: Record<string, { title: string; description: string }> = {
  waiting: { title: 'No one is waiting for a cab', description: 'Every request for this day already has a cab.' },
  assigned: { title: 'No cabs assigned yet', description: 'Assigned rides for this day will appear here.' },
  trip: { title: 'No trips in progress', description: 'Rides appear here once the driver starts the trip.' },
  all: { title: 'No bookings yet', description: 'Every cab request appears here, newest first.' },
  completed: { title: 'No completed rides', description: 'Finished rides appear here.' },
  cancelled: { title: 'Nothing cancelled', description: 'Cancelled, rejected and no-show rides appear here.' },
};


function Pill({ tone, title, children }: { tone: 'red' | 'orange' | 'amber'; title?: string; children: ReactNode }) {
  const tones = { red: 'bg-red-100 text-red-800', orange: 'bg-orange-100 text-orange-800', amber: 'bg-amber-100 text-amber-800' };
  return (
    <span title={title} className={cn('inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium', tones[tone])}>
      {children}
    </span>
  );
}

/** History: every booking on any date, newest first. */
export function BookingHistory() {
  return <Bookings history />;
}

export default function Bookings({ history = false }: { history?: boolean }) {
  const presets = history ? HISTORY_PRESETS : LIVE_PRESETS;
  const [params, setParams] = useSearchParams();
  const { timezone, policy } = useOpsOffices();

  // Only today's and tomorrow's work days, plus search. A work day runs until the end of cab
  // hours, so tonight's 4 AM drops are still "today".
  const todayWork = currentWorkDay(timezone, policy?.booking.cabWindowStart, policy?.booking.cabWindowEnd);
  const [day, setDay] = useState<'today' | 'tomorrow'>(params.get('day') === 'tomorrow' ? 'tomorrow' : 'today');
  const workDay = day === 'today' ? todayWork : addDaysISO(todayWork, 1);
  // Dashboard links can still open a specific date, office or "wants to cancel" view; it is shown as a note.
  const urlDate = params.get('date');
  const [linkedDate, setLinkedDate] = useState(urlDate && urlDate !== 'today' ? urlDate : '');
  const [office, setOffice] = useState(params.get('office') ?? '');
  const [flags, setFlags] = useState(params.get('delayed') === 'true' ? 'delayed' : params.get('flagged') === 'true' ? 'flagged' : params.get('cancellationRequested') === 'true' ? 'cancelRequested' : '');
  const initialStatus = params.get('status');
  const [status, setStatus] = useState<string>(initialStatus === null ? presets[0].status : initialStatus.toUpperCase() === 'ALL' ? '' : initialStatus);
  const [q, setQ] = useState(params.get('q') ?? '');
  // Phones show a search icon; tapping it opens the box, ready to type.
  const [searchOpen, setSearchOpen] = useState(false);
  const searchBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (searchOpen) searchBox.current?.querySelector('input')?.focus();
  }, [searchOpen]);
  // History only: pickup date range.
  const [dateFrom, setDateFrom] = useState(params.get('from') ?? '');
  const [dateTo, setDateTo] = useState(params.get('to') ?? '');
  const [sort, setSort] = useState(history ? '-scheduledPickupAt' : 'scheduledPickupAt');
  const [page, setPage] = useState(1);
  // The assigned ride whose cab is being changed (in the bar at the bottom, no pop-up).
  const [changing, setChanging] = useState<BookingRow | null>(null);
  const [action, setAction] = useState<{ kind: RowAction; b: BookingRow } | null>(null);
  // Waiting rides ticked to share one cab.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleRides = (ids: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const qc = useQueryClient();
  const toast = useToast();
  const runAction = async ({ kind, b }: { kind: RowAction; b: BookingRow }, reason: string) => {
    // ConfirmDialog shows the error and stays open if this throws.
    await post(`/ops/bookings/${b._id}/${ROW_ACTIONS[kind].path}`, ROW_ACTIONS[kind].reasonLabel ? { reason } : {});
    toast.success(ROW_ACTIONS[kind].done, b.reference);
    qc.invalidateQueries({ queryKey: ['ops'] });
  };
  // The live list is grouped by route and pickup time, so it loads the whole day at once (server max 100).
  const pageSize = history ? 25 : 100;
  const linked = !!(linkedDate || office || flags);

  // Keep the URL in sync so the view can be bookmarked / shared / refreshed.
  useEffect(() => {
    const next = qs({
      day: history || linkedDate || day === 'today' ? '' : day,
      date: linkedDate,
      from: history ? dateFrom : '',
      to: history ? dateTo : '',
      status: status || 'ALL',
      office,
      q,
      delayed: flags === 'delayed' ? 'true' : '',
      flagged: flags === 'flagged' ? 'true' : '',
      cancellationRequested: flags === 'cancelRequested' ? 'true' : '',
    });
    if (`?${params.toString()}` !== next) setParams(new URLSearchParams(next), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, linkedDate, dateFrom, dateTo, status, office, q, flags]);

  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };
  const backToToday = () => {
    setLinkedDate('');
    setOffice('');
    setFlags('');
    setDay('today');
    setPage(1);
  };
  const clearHistoryFilters = () => {
    backToToday();
    setQ('');
    setDateFrom('');
    setDateTo('');
    setStatus('');
  };
  const historyFiltered = !!(q || dateFrom || dateTo || status || linked);

  const query = qs({
    page,
    pageSize,
    sort,
    q,
    workDay: linkedDate || history ? undefined : workDay,
    date: linkedDate && linkedDate !== 'all' ? linkedDate : undefined,
    dateFrom: history && !linkedDate ? dateFrom || undefined : undefined,
    dateTo: history && !linkedDate ? dateTo || undefined : undefined,
    status,
    officeLocation: office,
    delayed: flags === 'delayed' ? 'true' : undefined,
    flagged: flags === 'flagged' ? 'true' : undefined,
    cancellationRequested: flags === 'cancelRequested' ? 'true' : undefined,
  });
  const { data, isLoading, error, refetch } = usePaged<BookingRow>(['ops', 'bookings'], '/ops/bookings', query);
  // Only rides still waiting (and on screen) can be pooled; anything else drops out of the selection.
  const selectedRides = useMemo(() => (data?.items ?? []).filter((r) => selected.has(r._id) && ASSIGNABLE.includes(r.status)), [data, selected]);
  // Shared cabs the driver has started: none of their riders can change cab any more.
  const startedTrips = useMemo(() => new Set((data?.items ?? []).filter((r) => r.assignment?.tripId && TRIP_STARTED.includes(r.status)).map((r) => r.assignment!.tripId!)), [data]);
  useEffect(() => {
    if (selected.size && selectedRides.length !== selected.size) setSelected(new Set(selectedRides.map((r) => r._id)));
  }, [selected, selectedRides]);
  const linkedLabel = [
    linkedDate === 'all' ? 'All dates' : linkedDate ? fmtTravelDate(linkedDate) : '',
    office,
    { delayed: 'Running late', flagged: 'Needs review', cancelRequested: 'Wants to cancel' }[flags] ?? '',
  ]
    .filter(Boolean)
    .join(' · ');

  const preset = presetFor(status, history ? PRESETS : presets);
  const tabs = useMemo(() => {
    const t: Array<{ value: PresetKey; label: ReactNode }> = presets.map((p) => ({
      value: p.value,
      label:
        'short' in p ? (
          <>
            <span className="sm:hidden">{p.short}</span>
            <span className="max-sm:hidden">{p.label}</span>
          </>
        ) : (
          p.label
        ),
    }));
    if (preset === 'custom') t.push({ value: 'custom', label: `Custom: ${humanize(status)}` });
    return t;
  }, [preset, status, presets]);

  const columns: Column<BookingRow>[] = [
    {
      key: 'time',
      header: 'Pickup',
      sortKey: 'scheduledPickupAt',
      render: (b) => (
        <div className="whitespace-nowrap">
          <p className="font-semibold text-slate-900">{fmt12h(b.pickupTime)}</p>
          <p className="text-xs text-slate-500">{history ? fmtTravelDate(b.travelDate) : fmtShortDate(b.travelDate)}</p>
        </div>
      ),
    },
    {
      key: 'employee',
      header: 'Employee',
      render: (b) => (
        <div className="min-w-36">
          <p className="font-medium text-slate-900">{b.employee?.fullName}</p>
          <p className="text-xs text-slate-500">
            {b.employee?.employeeId} · {b.reference}
          </p>
          {/* Live lists have no status column: only what needs attention or shows progress. */}
          {!history && <LiveTags b={b} />}
        </div>
      ),
    },
    {
      key: 'route',
      header: 'From → To',
      cardWide: true,
      render: (b) => (
        <div className="min-w-48 max-w-72 text-sm">
          <p className="truncate" title={b.pickupLocation}>
            {b.pickupLocation}
          </p>
          <p className="truncate text-slate-500" title={b.dropLocation}>
            → {b.dropLocation}
          </p>
          {(b.passengers > 1 || b.tripType === 'ROUND_TRIP') && (
            <p className="text-xs text-slate-500">
              {[b.passengers > 1 ? `${b.passengers} people` : '', b.tripType === 'ROUND_TRIP' ? `Round trip${b.leg === 'RETURN' ? ' · return' : ''}` : ''].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortKey: 'status',
      render: (b) => (
        <div className="flex flex-col items-start gap-1">
          <StatusBadge status={b.status} />
          {b.isDelayed && (
            <Pill tone="amber" title={b.delayReason}>
              Running late
            </Pill>
          )}
          {b.flaggedForReview && (
            <Pill tone="orange" title={b.flagReason}>
              Needs review
            </Pill>
          )}
          {b.cancellationRequest?.status === 'PENDING' && (
            <Pill tone="red" title={b.cancellationRequest.reason}>
              Wants to cancel
            </Pill>
          )}
        </div>
      ),
    },
    {
      key: 'cab',
      header: 'Cab',
      render: (b) =>
        b.status === 'CANCELLED' || b.status === 'REJECTED' ? (
          <span className="text-sm text-slate-400">—</span>
        ) : b.driver || b.vehicle ? (
          <div className="text-sm lg:whitespace-nowrap">
            {b.vehicle?.registrationNumber ? <Plate reg={b.vehicle.registrationNumber} size="sm" /> : <p className="text-slate-400">—</p>}
            <p className="mt-1 flex flex-wrap items-center gap-2 text-slate-600">
              {b.driver?.fullName ?? '—'}
              <CallButton phone={b.driver?.phone} name={b.driver?.fullName} />
            </p>
          </div>
        ) : (
          <span className="text-sm text-slate-400">Not assigned</span>
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      // The coordinator acts straight from the row: no detail page needed.
      render: (b) => {
        const act = (kind: RowAction) => setAction({ kind, b });
        const buttons: ReactNode[] = [];
        if (b.cancellationRequest?.status === 'PENDING') {
          buttons.push(
            <Button key="ac" size="sm" variant="danger" onClick={() => act('approveCancel')}>
              Approve cancel
            </Button>,
            <Button key="dc" size="sm" variant="secondary" onClick={() => act('declineCancel')}>
              Decline
            </Button>,
          );
        } else if (b.status === 'PENDING_APPROVAL') {
          buttons.push(
            <Button key="ap" size="sm" onClick={() => act('approve')}>
              Approve
            </Button>,
            <Button key="rj" size="sm" variant="secondary" onClick={() => act('reject')}>
              Reject
            </Button>,
          );
        } else if (ASSIGNABLE.includes(b.status)) {
          // Assigning is done for the ticked rides together ("Assign to one cab").
          buttons.push(
            <Button key="cn" size="sm" variant="ghost" onClick={() => act('cancel')}>
              Cancel
            </Button>,
          );
        } else if (['ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'].includes(b.status)) {
          if (REASSIGNABLE.includes(b.status) && !(b.assignment?.tripId && startedTrips.has(b.assignment.tripId)))
            buttons.push(
              <Button
                key="ch"
                size="sm"
                variant="secondary"
                onClick={() => {
                  setSelected(new Set());
                  setChanging(b);
                }}
              >
                Change cab
              </Button>,
            );
          // Once the employee is in the cab there's nothing left to delay.
          if (!b.isDelayed && b.status !== 'IN_PROGRESS')
            buttons.push(
              <Button key="dl" size="sm" variant="secondary" onClick={() => act('delay')}>
                Mark delayed
              </Button>,
            );
          if (b.status !== 'IN_PROGRESS')
            buttons.push(
              <Button key="cn" size="sm" variant="ghost" onClick={() => act('cancel')}>
                Cancel
              </Button>,
            );
        }
        return buttons.length ? <div className="flex flex-wrap justify-end gap-2 lg:flex-nowrap [&>button]:whitespace-nowrap">{buttons}</div> : null;
      },
    },
  ];

  const empty = EMPTY[preset] ?? { title: 'No cab requests found', description: 'Try another day, tab or search.' };

  // Links asking for all or only finished bookings (e.g. from the dashboards) belong on History.
  const finished = ['COMPLETED', 'CANCELLED', 'REJECTED', 'NO_SHOW'];
  if (!history && (status === '' || status.split(',').every((s) => finished.includes(s.trim().toUpperCase())))) {
    return <Navigate to={`/ops/history?${params.toString()}`} replace />;
  }

  return (
    <>
      <PageHeader
        title={history ? 'History' : 'Cab requests'}
        subtitle={history ? 'All bookings, newest first' : linkedDate ? linkedLabel : `${day === 'today' ? "Today's" : "Tomorrow's"} shifts · ${fmtShortDate(workDay)}`}

      />

      {history ? (
        <Card className="mb-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6 lg:items-end">
            <div className="sm:col-span-2 lg:col-span-2">
              <SearchInput value={q} onChange={reset(setQ)} placeholder="Name, ID or reference" />
            </div>
            <Input label="From" type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => reset(setDateFrom)(e.target.value)} />
            <Input label="To" type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => reset(setDateTo)(e.target.value)} />
            <Select label="Status" value={preset === 'custom' ? status : (PRESETS.find((p) => p.value === preset)?.status ?? '')} onChange={(e) => reset(setStatus)(e.target.value)}>
              {HISTORY_STATUS_OPTIONS.map((o) => (
                <option key={o.label} value={o.status}>
                  {o.label}
                </option>
              ))}
              {preset === 'custom' && <option value={status}>{humanize(status)}</option>}
            </Select>
            <Button variant="ghost" onClick={clearHistoryFilters} disabled={!historyFiltered}>
              Clear filters
            </Button>
          </div>
        </Card>
      ) : (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-lg border border-slate-300 bg-white p-1" role="group" aria-label="Day">
            {(['today', 'tomorrow'] as const).map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={!linkedDate && day === d}
                onClick={() => {
                  setLinkedDate('');
                  reset(setDay)(d);
                }}
                className={cn(
                  'min-h-10 rounded-md px-4 text-sm font-medium',
                  !linkedDate && day === d ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100',
                )}
              >
                {d === 'today' ? 'Today' : 'Tomorrow'}
              </button>
            ))}
          </div>
          {/* Phones: a search icon that opens the box (it stays open while something is searched). */}
          {!searchOpen && !q && (
            <button
              type="button"
              aria-label="Search"
              onClick={() => setSearchOpen(true)}
              className="ml-auto grid h-[3.125rem] w-[3.125rem] place-items-center rounded-lg border border-slate-300 bg-white text-slate-600 shadow-xs hover:bg-slate-50 active:bg-slate-100 sm:hidden"
            >
              <Search className="h-5 w-5" aria-hidden />
            </button>
          )}
          <div
            ref={searchBox}
            className={cn('min-w-56 flex-1', !searchOpen && !q && 'max-sm:hidden')}
            onBlur={(e) => {
              if (!(e.target as HTMLInputElement).value) setSearchOpen(false);
            }}
          >
            <SearchInput value={q} onChange={reset(setQ)} placeholder="Search name, employee ID, route, reference or place" />
          </div>
        </div>
      )}
      {linked && (
        <div className="mb-4">
          <Alert tone="info">
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span>Showing: {linkedLabel}</span>
              <Button size="sm" variant="secondary" onClick={backToToday}>
                {history ? 'Clear' : 'Back to today'}
              </Button>
            </span>
          </Alert>
        </div>
      )}

      {!history && (
        <Tabs
          tabs={tabs}
          value={preset}
          onChange={(v) => {
            if (v === 'custom') return;
            setStatus(presets.find((p) => p.value === v)!.status);
            setPage(1);
          }}
        />
      )}

      {history ? (
        <>
          <DataTable
            columns={columns}
            rows={data?.items}
            rowKey={(b) => b._id}
            loading={isLoading}
            error={error}
            onRetry={refetch}
            sort={sort}
            onSort={(s) => {
              setSort(s);
              setPage(1);
            }}
            empty={<EmptyState title={empty.title} description={empty.description} />}
          />
          {data && <Pagination page={data.page} total={data.total} totalPages={data.totalPages} onPage={setPage} />}
        </>
      ) : isLoading ? (
        <Spinner />
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : !data?.items.length ? (
        <Card>
          <EmptyState title={empty.title} description={empty.description} />
        </Card>
      ) : (
        <>
          {preset === 'waiting' && (
            <p className="mb-3 text-sm text-slate-600">Tick the rides that will share a cab — a whole route or pickup time at once — then choose <strong>Assign to one cab</strong>.</p>
          )}
          <RideGroups
            rows={data.items}
            // The group header shows the time; the status column is replaced by tags under the name
            // (only what needs attention), and rides waiting for a cab have no cab to show yet.
            columns={columns.filter((c) => c.key !== 'time' && c.key !== 'status' && !(preset === 'waiting' && c.key === 'cab'))}
            byTrip={preset !== 'waiting'}
            selection={preset === 'waiting' ? { selected, onChange: toggleRides } : undefined}
          />
          {data.totalPages > 1 && <Pagination page={data.page} total={data.total} totalPages={data.totalPages} onPage={setPage} />}
          {preset === 'waiting' && !changing && selectedRides.length > 0 && <PoolBar rides={selectedRides} onClear={() => setSelected(new Set())} onDone={() => setSelected(new Set())} />}
        </>
      )}

      {changing && <PoolBar key={changing._id} rides={[changing]} change onClear={() => setChanging(null)} onDone={() => setChanging(null)} />}
      {action && (
        <ConfirmDialog
          open
          onClose={() => setAction(null)}
          onConfirm={(reason) => runAction(action, reason)}
          title={ROW_ACTIONS[action.kind].title}
          message={
            <p>
              {action.b.employee?.fullName} · {action.b.reference} · {history ? fmtTravelDate(action.b.travelDate) : fmtShortDate(action.b.travelDate)} at {fmt12h(action.b.pickupTime)}
              {action.kind === 'approveCancel' && action.b.cancellationRequest?.reason ? <span className="mt-1 block text-slate-500">Reason given: “{action.b.cancellationRequest.reason}”</span> : null}
            </p>
          }
          confirmLabel={ROW_ACTIONS[action.kind].confirm}
          tone={ROW_ACTIONS[action.kind].danger ? 'danger' : 'primary'}
          reasonLabel={ROW_ACTIONS[action.kind].reasonLabel}
          reasons={ROW_ACTIONS[action.kind].reasons}
          cancelLabel={ROW_ACTIONS[action.kind].keep}
        />
      )}
    </>
  );
}

/**
 * Seats free in a cab right now (before assigning): "4 of 4 free" when empty, "3 of 4 free" with one
 * rider on board. Red when full, or when there isn't room for the riders being assigned.
 */
function SeatsFree({ capacity, used, needed }: { capacity: number; used: number; needed: number }) {
  const free = Math.max(0, capacity - used);
  const short = free === 0 || free < needed;
  return (
    <span
      title={short ? `Not enough room for ${needed} ${needed === 1 ? 'rider' : 'riders'}` : undefined}
      className={cn('whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium', short ? 'bg-red-100 text-red-700' : 'bg-emerald-50 text-emerald-700')}
    >
      {free} of {capacity} free
    </span>
  );
}

/** Tags under the rider's name in the live lists: things that need attention and trip progress only. */
function LiveTags({ b }: { b: BookingRow }) {
  const tags: ReactNode[] = [];
  if (b.status === 'DRIVER_EN_ROUTE') tags.push(<span key="er" className="inline-flex rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">Driver on the way</span>);
  if (b.status === 'ARRIVED') tags.push(<span key="ar" className="inline-flex rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800">Driver arrived</span>);
  if (b.status === 'PENDING_APPROVAL') tags.push(<span key="pa" className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">Needs approval</span>);
  if (b.isDelayed) tags.push(<Pill key="dl" tone="amber" title={b.delayReason}>Running late</Pill>);
  if (b.flaggedForReview) tags.push(<Pill key="fl" tone="orange" title={b.flagReason}>Needs review</Pill>);
  if (b.cancellationRequest?.status === 'PENDING') tags.push(<Pill key="wc" tone="red" title={b.cancellationRequest.reason}>Wants to cancel</Pill>);
  return tags.length ? <div className="mt-1 flex flex-wrap gap-1">{tags}</div> : null;
}

/** IN = home → office, OUT = office → home. */
function DirectionBadge({ direction }: { direction?: string }) {
  const isIn = direction === 'IN';
  return (
    <span
      title={isIn ? 'Home → Office' : 'Office → Home'}
      className={cn('rounded-md px-1.5 py-0.5 text-xs font-bold tracking-wide', isIn ? 'bg-sky-100 text-sky-800' : 'bg-violet-100 text-violet-800')}
    >
      {isIn ? 'IN' : 'OUT'}
    </span>
  );
}

/** Checkbox for a whole group: ticked when all its rides are, a dash when only some are. */
function GroupCheckbox({ ids, selected, onChange, label }: { ids: string[]; selected: Set<string>; onChange: (ids: string[], on: boolean) => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const picked = ids.filter((id) => selected.has(id)).length;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = picked > 0 && picked < ids.length;
  }, [picked, ids.length]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      className="h-5 w-5 shrink-0 cursor-pointer rounded-sm border-slate-300 accent-indigo-600"
      checked={ids.length > 0 && picked === ids.length}
      disabled={!ids.length}
      onChange={(e) => onChange(ids, e.target.checked)}
    />
  );
}

/**
 * Rides grouped by cab, then by pickup time inside each, both collapsible. While waiting, the cab is
 * the employee's route; once assigned together (byTrip), it is the shared cab's name with its car and
 * driver. Rows arrive sorted by pickup, so groups follow their first pickup; rides without a route
 * come last. With `selection`, rides (or whole groups) can be ticked to share one cab.
 */
function RideGroups({
  rows,
  columns,
  byTrip,
  selection,
}: {
  rows: BookingRow[];
  columns: Column<BookingRow>[];
  byTrip?: boolean;
  selection?: { selected: Set<string>; onChange: (ids: string[], on: boolean) => void };
}) {
  const NO_ROUTE = 'Route not set';
  type Group = { key: string; label: string; tripId?: string; first: BookingRow; times: Map<string, BookingRow[]> };
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const tripId = byTrip ? r.assignment?.tripId : undefined;
    const label = (tripId && r.assignment?.tripName) || r.employee?.route?.trim() || NO_ROUTE;
    const key = tripId ? `trip:${tripId}` : `route:${label}`;
    const g = groups.get(key) ?? { key, label, tripId, first: r, times: new Map() };
    // IN and OUT rides never share a time group (they need separate cabs).
    const slot = `${r.travelDate} ${r.pickupTime} ${r.direction ?? 'OUT'} ${r.pickupTimeSet === false ? 'unset' : ''}`;
    g.times.set(slot, [...(g.times.get(slot) ?? []), r]);
    groups.set(key, g);
  }
  const ordered = [...groups.values()].sort((a, b) => Number(a.label === NO_ROUTE && !a.tripId) - Number(b.label === NO_ROUTE && !b.tripId));
  const count = (n: number) => `${n} ${n === 1 ? 'ride' : 'rides'}`;
  const pickable = (list: BookingRow[]) => list.filter((r) => ASSIGNABLE.includes(r.status)).map((r) => r._id);
  // The time a group is about: OUT = when the cab leaves the office; IN = the pickup once set, else the reach-office time.
  const groupTime = (r: BookingRow) => (r.direction === 'IN' && r.pickupTimeSet === false ? r.reportBy ?? r.pickupTime : r.pickupTime);
  /** Phones: "Leaves 4:00 AM", "Reach by 9:00 PM" or "Pickup 8:00 PM" (the badge says IN or OUT). */
  const slotShort = (r: BookingRow) =>
    r.direction === 'IN' ? (r.pickupTimeSet === false ? `Reach by ${fmt12h(groupTime(r))}` : `Pickup ${fmt12h(r.pickupTime)}`) : `Leaves ${fmt12h(r.pickupTime)}`;
  /** "Leaves office 4:00 AM", "Reach office by 9:00 PM" or "Pickup 8:00 PM · reach by 9:00 PM". */
  const slotTitle = (r: BookingRow) =>
    r.direction === 'IN'
      ? r.pickupTimeSet === false
        ? `Reach office by ${fmt12h(groupTime(r))}`
        : `Pickup ${fmt12h(r.pickupTime)}${r.reportBy ? ` · reach by ${fmt12h(r.reportBy)}` : ''}`
      : `Leaves office ${fmt12h(r.pickupTime)}`;
  const colOf = (key: string) => columns.find((c) => c.key === key);
  /** Phones: a ride's buttons, with Cancel taken out (it becomes an X beside the name). */
  const phoneActions = (b: BookingRow) => {
    const el = colOf('actions')?.render(b);
    const items = isValidElement<{ children?: ReactNode }>(el) ? Children.toArray(el.props.children) : [];
    const cancel = items.find((c) => isValidElement(c) && String(c.key).endsWith('cn')) as ReactElement<{ onClick?: () => void }> | undefined;
    return { cancel: cancel?.props.onClick, rest: items.filter((c) => c !== cancel) };
  };
  const cols: Column<BookingRow>[] = selection
    ? [
        {
          key: 'pick',
          header: <span className="sr-only">Select</span>,
          hideInCard: false,
          cardLabel: 'Select',
          render: (b) =>
            ASSIGNABLE.includes(b.status) ? (
              <input
                type="checkbox"
                aria-label={`Select ${b.employee?.fullName ?? b.reference}`}
                className="h-5 w-5 cursor-pointer rounded-sm border-slate-300 accent-indigo-600"
                checked={selection.selected.has(b._id)}
                onChange={(e) => selection.onChange([b._id], e.target.checked)}
              />
            ) : null,
        },
        ...columns,
      ]
    : columns;

  return (
    <div className="space-y-3">
      {ordered.map((g) => {
        const all = [...g.times.values()].flat();
        const shared = g.tripId ? g.first : null;
        // The cab's only time slot (most cabs): it goes in the cab's own header, with no separate strip.
        const only = g.times.size === 1 ? [...g.times.values()][0] : null;
        return (
          <details key={g.key} open className="group overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs max-lg:rounded-none max-lg:border-x-0 max-lg:shadow-none max-sm:-mx-4 sm:max-lg:-mx-6">
            {/* The cab or route: a grey band; each time strip is tinted by direction (OUT purple, IN blue); riders white. */}
            <summary className="flex cursor-pointer list-none items-start justify-between gap-3 bg-slate-100 px-4 py-3 lg:items-center [&::-webkit-details-marker]:hidden">
              {/* Select all of this cab's riders: first, in line with each rider's own checkbox. */}
              {only && selection && pickable(only).length > 1 && (
                <span className="mt-0.5 flex shrink-0 lg:mt-0">
                  <GroupCheckbox ids={pickable(only)} selected={selection.selected} onChange={selection.onChange} label={`Select all ${fmt12h(groupTime(only[0]))} rides on ${g.label}`} />
                </span>
              )}
              <Car className="mt-0.5 h-5 w-5 shrink-0 text-slate-400 lg:mt-0" aria-hidden />
              {/* Phones: three short lines that never wrap — cab and seats; direction, time and date; cab, driver and call. */}
              <div className="min-w-0 flex-1 space-y-1.5 lg:hidden">
                <div className="flex items-center gap-2">
                  <span className={cn('min-w-0 truncate font-semibold', g.label === NO_ROUTE && !g.tripId ? 'text-slate-500' : 'text-slate-900')}>{g.label}</span>
                  <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-xs font-medium text-slate-700 ring-1 ring-slate-200">{count(all.length)}</span>
                  {shared?.vehicle?.capacity ? (
                    <span className="ml-auto shrink-0">
                      <SeatsFree capacity={shared.vehicle.capacity} used={all.reduce((n, r) => n + (r.passengers || 1), 0)} needed={0} />
                    </span>
                  ) : null}
                </div>
                {only && (
                  <div className="flex items-center gap-2 whitespace-nowrap text-sm">
                    <DirectionBadge direction={only[0].direction} />
                    <span className="font-semibold text-slate-900">{slotShort(only[0])}</span>
                    <span className="truncate text-slate-500">· {fmtShortDate(only[0].travelDate)}</span>
                  </div>
                )}
                {shared && (
                  <div className="flex items-center gap-2">
                    {shared.vehicle?.registrationNumber ? <Plate reg={shared.vehicle.registrationNumber} size="sm" /> : null}
                    <span className="min-w-0 truncate text-sm font-medium text-slate-800">{shared.driver?.fullName ?? '—'}</span>
                    <CallButton phone={shared.driver?.phone} name={shared.driver?.fullName} compact className="ml-auto" />
                  </div>
                )}
              </div>
              {/* Desktop: cab · time · driver on one line at every laptop width. */}
              <div className="min-w-0 flex-1 max-lg:hidden lg:flex lg:items-center lg:gap-x-6">
                <p className="flex flex-wrap items-center gap-2 lg:shrink-0 lg:flex-nowrap">
                  <span className={cn('font-semibold', g.label === NO_ROUTE && !g.tripId ? 'text-slate-500' : 'text-slate-900')}>{g.label}</span>
                  <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-xs font-medium text-slate-700 ring-1 ring-slate-200">{count(all.length)}</span>
                  {shared?.vehicle?.capacity ? <SeatsFree capacity={shared.vehicle.capacity} used={all.reduce((n, r) => n + (r.passengers || 1), 0)} needed={0} /> : null}
                </p>
                {only && (
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 lg:min-w-0 lg:flex-nowrap lg:overflow-hidden lg:whitespace-nowrap">
                    <DirectionBadge direction={only[0].direction} />
                    <span className="font-semibold text-slate-900 max-lg:text-sm">{slotTitle(only[0])}</span>
                    <span className="text-sm text-slate-500">{fmtShortDate(only[0].travelDate)}</span>
                  </p>
                )}
                {/* Which cab it is, on every screen size: plate first, then a one-tap call to the driver. */}
                {shared && (
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-600 lg:ml-auto lg:shrink-0 lg:flex-nowrap lg:whitespace-nowrap">
                    {shared.vehicle?.registrationNumber ? <Plate reg={shared.vehicle.registrationNumber} size="sm" /> : null}
                    <span className="font-medium text-slate-800">{shared.driver?.fullName ?? '—'}</span>
                    <CallButton phone={shared.driver?.phone} name={shared.driver?.fullName} compact />
                  </p>
                )}
              </div>
              <span className="flex shrink-0 items-center gap-2 text-sm text-slate-500 lg:self-center">
                {/* One time is already in the header line below; list times here only when the cab has several. */}
                {g.times.size > 1 && <span className="hidden sm:inline">{[...g.times.values()].map((list) => `${list[0].direction === 'IN' ? 'IN' : 'OUT'} ${fmt12h(groupTime(list[0]))}`).join(' · ')}</span>}
                <ChevronDown className="h-5 w-5 transition-transform group-open:rotate-180" aria-hidden />
              </span>
            </summary>
            <div className="space-y-2 border-t border-slate-100 p-3 max-lg:space-y-0 max-lg:p-0">
              {[...g.times.entries()].map(([slot, list]) => (
                <details key={slot} open className={cn('group/time rounded-lg border border-slate-100 max-lg:rounded-none max-lg:border-0', only && 'border-0')}>
                  <summary className={cn('flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 max-lg:px-4 [&::-webkit-details-marker]:hidden', list[0].direction === 'IN' ? 'bg-sky-50' : 'bg-violet-50', only && 'hidden')}>
                    <span className="flex flex-wrap items-center gap-2 max-lg:flex-1">
                      {selection && (
                        // Phones: with one ride, its own checkbox is enough.
                        <span className={cn(pickable(list).length <= 1 && 'max-lg:hidden')}>
                          <GroupCheckbox ids={pickable(list)} selected={selection.selected} onChange={selection.onChange} label={`Select all ${fmt12h(groupTime(list[0]))} rides on ${g.label}`} />
                        </span>
                      )}
                      <DirectionBadge direction={list[0].direction} />
                      <Clock className="h-4 w-4 text-slate-400 max-lg:hidden" aria-hidden />
                      {list[0].direction === 'IN' ? (
                        list[0].pickupTimeSet === false ? (
                          <span className="font-semibold text-slate-900 max-lg:min-w-0 max-lg:flex-1">Reach office by {fmt12h(groupTime(list[0]))}</span>
                        ) : (
                          <span className="font-semibold text-slate-900 max-lg:min-w-0 max-lg:flex-1">
                            Pickup {fmt12h(list[0].pickupTime)}
                            {list[0].reportBy ? <span className="font-normal text-slate-500"> · reach by {fmt12h(list[0].reportBy)}</span> : null}
                          </span>
                        )
                      ) : (
                        <span className="font-semibold text-slate-900 max-lg:min-w-0 max-lg:flex-1">Leaves office {fmt12h(list[0].pickupTime)}</span>
                      )}
                      {/* Phones: date and count on their own line under the time (desktop: in line, as before). */}
                      <span className="contents max-lg:flex max-lg:basis-full max-lg:items-center max-lg:gap-2">
                        <span className="text-sm text-slate-500">{fmtShortDate(list[0].travelDate)}</span>
                        {/* Phones: the cab's header already counts the rides when there's only this one time. */}
                        <span className={cn('rounded-full bg-white px-2 py-0.5 text-xs font-medium text-slate-700 ring-1 ring-slate-200', g.times.size === 1 && 'max-lg:hidden')}>{count(list.length)}</span>
                      </span>
                    </span>
                    <ChevronDown className="h-4 w-4 text-slate-400 transition-transform group-open/time:rotate-180 max-lg:hidden" aria-hidden />
                  </summary>
                  <div className="p-2 max-lg:hidden">
                    {/* In a shared cab the header already shows the cab and driver. */}
                    <DataTable columns={g.tripId ? cols.filter((c) => c.key !== 'cab') : cols} rows={list} rowKey={(b) => b._id} hideHeader />
                  </div>
                  {/* Phones: one compact row per ride — select, who, their home, the cab, what to do. */}
                  <ul className="divide-y divide-slate-100 lg:hidden">
                    {list.map((b) => {
                      const { cancel, rest } = phoneActions(b);
                      const pickable = !!selection && ASSIGNABLE.includes(b.status);
                      // A ride that can be ticked: tapping anywhere on it (except its buttons) ticks it.
                      const Row = pickable ? 'label' : 'div';
                      return (
                        <li key={b._id}>
                          <Row className={cn('flex items-center gap-3 px-4 py-3', pickable && 'cursor-pointer active:bg-slate-50')}>
                            {pickable && (
                              <input
                                type="checkbox"
                                aria-label={`Select ${b.employee?.fullName ?? b.reference}`}
                                className="h-5 w-5 shrink-0 cursor-pointer rounded-sm border-slate-300 accent-indigo-600"
                                checked={selection!.selected.has(b._id)}
                                onChange={(e) => selection!.onChange([b._id], e.target.checked)}
                              />
                            )}
                            <div className="min-w-0 flex-1 space-y-1.5">
                              <div className="flex items-start gap-2">
                                <div className="min-w-0 flex-1">{colOf('employee')?.render(b)}</div>
                                {cancel && (
                                  <button
                                    type="button"
                                    aria-label={`Cancel ${b.employee?.fullName ?? b.reference}'s ride`}
                                    title="Cancel ride"
                                    onClick={cancel}
                                    className="-mr-2 -mt-1 grid h-9 w-9 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600 active:bg-red-50"
                                  >
                                    <X className="h-5 w-5" aria-hidden />
                                  </button>
                                )}
                              </div>
                              {/* The office end is the same for everyone in the group: show the home. */}
                              <p className="flex min-w-0 items-start gap-1.5 text-sm text-slate-600">
                                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                                <span className="min-w-0 truncate">{b.direction === 'IN' ? b.pickupLocation : b.dropLocation}</span>
                              </p>
                              {!g.tripId && (b.driver || b.vehicle) && colOf('cab')?.render(b)}
                              {/* Two buttons share the row evenly; one takes its natural width. */}
                              {rest.length > 0 && <div className={cn('gap-2 pt-1', rest.length > 1 ? 'grid grid-cols-2 [&>*]:w-full' : 'flex')}>{rest}</div>}
                            </div>
                          </Row>
                        </li>
                      );
                    })}
                  </ul>
                </details>
              ))}
            </div>
          </details>
        );
      })}
    </div>
  );
}

type RowAction = 'cancel' | 'delay' | 'approve' | 'reject' | 'approveCancel' | 'declineCancel';

/** Row actions: endpoint, wording, and whether a reason is asked (it is sent to the employee). */
/** Why the transport team cancels a ride: picked from a list (the employee is told); "Other" is typed. */
export const CANCEL_REASONS = ['No cab available', 'Cab broke down', 'Cab out of fuel', 'Driver not available', 'Employee asked to cancel', 'Employee not coming', 'Booked by mistake'] as const;

const ROW_ACTIONS: Record<RowAction, { path: string; title: string; confirm: string; done: string; danger?: boolean; reasonLabel?: string; reasons?: readonly string[]; keep?: string }> = {
  cancel: { path: 'cancel', title: 'Cancel this ride?', confirm: 'Cancel ride', done: 'Ride cancelled', danger: true, reasonLabel: 'Reason (sent to the employee)', reasons: CANCEL_REASONS, keep: 'Keep ride' },
  delay: { path: 'delay', title: 'Mark this ride as delayed?', confirm: 'Mark delayed', done: 'Marked delayed — the employee is told', reasonLabel: 'Reason for the delay (sent to the employee)' },
  approve: { path: 'approve', title: 'Approve this request?', confirm: 'Approve', done: 'Request approved' },
  reject: { path: 'reject', title: 'Reject this request?', confirm: 'Reject', done: 'Request rejected', danger: true, reasonLabel: 'Reason (sent to the employee)' },
  approveCancel: { path: 'cancellation-request/approve', title: 'Approve the cancellation?', confirm: 'Cancel ride', done: 'Ride cancelled as requested', danger: true },
  declineCancel: { path: 'cancellation-request/decline', title: 'Decline the cancellation?', confirm: 'Decline', done: 'Cancellation declined — the ride stays booked', reasonLabel: 'Reason (sent to the employee)' },
};
