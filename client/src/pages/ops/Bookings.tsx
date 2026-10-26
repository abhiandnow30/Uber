import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Car, CheckCircle2, ChevronDown, Clock, MapPin, User, Users } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Input,
  Modal,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  Spinner,
  StatusBadge,
  Tabs,
  Textarea,
  cn,
  useToast,
  type Column,
} from '../../components/ui';
import { ApiError, errorMessage, get, patch, post, qs } from '../../lib/api';
import { usePaged } from '../../lib/hooks';
import { addDaysISO, currentWorkDay, fmt12h, fmtTravelDate, humanize, uuid } from '../../lib/format';
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
  notification?: { status: string; lastError?: string; acceptedAt?: string; attempts?: number } | null;
};

/** Minimal trip info shown at the top of the assignment modal. */
export type AssignTarget = {
  _id: string;
  reference: string;
  status: string;
  travelDate: string;
  pickupTime: string;
  timezone?: string;
  pickupLocation: string;
  dropLocation: string;
  passengers: number;
  employee?: { fullName: string; employeeId: string } | null;
  currentDriver?: string;
  currentVehicle?: string;
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
type Eligible = { booking: { _id: string; reference: string; passengers: number; scheduledPickupAt: string; status: string }; window: { start: string; end: string }; drivers: EligibleDriver[]; vehicles: EligibleVehicle[] };

export const ASSIGNABLE = ['REQUESTED', 'APPROVED'];
export const REASSIGNABLE = ['ASSIGNED', 'DRIVER_EN_ROUTE'];

export function toAssignTarget(b: BookingRow): AssignTarget {
  return {
    _id: b._id,
    reference: b.reference,
    status: b.status,
    travelDate: b.travelDate,
    pickupTime: b.pickupTime,
    timezone: b.timezone,
    pickupLocation: b.pickupLocation,
    dropLocation: b.dropLocation,
    passengers: b.passengers,
    employee: b.employee,
    currentDriver: b.driver ? `${b.driver.fullName} (${b.driver.driverCode})` : undefined,
    currentVehicle: b.vehicle?.registrationNumber,
  };
}

// ---------------------------------------------------------------------------
// Assign / reassign modal
// ---------------------------------------------------------------------------
function TripSummary({ b }: { b: AssignTarget }) {
  return (
    <div className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm sm:grid-cols-2">
      <div className="flex items-start gap-2">
        <User className="mt-0.5 h-4 w-4 text-slate-400" aria-hidden />
        <div>
          <p className="font-medium text-slate-900">{b.employee?.fullName ?? '—'}</p>
          <p className="text-xs text-slate-500">
            {b.employee?.employeeId} · {b.reference}
          </p>
        </div>
      </div>
      <div className="flex items-start gap-2">
        <Clock className="mt-0.5 h-4 w-4 text-slate-400" aria-hidden />
        <div>
          <p className="font-medium text-slate-900">
            {fmtTravelDate(b.travelDate)} · {fmt12h(b.pickupTime)}
          </p>
          <p className="text-xs text-slate-500">{b.timezone ? `Office time (${b.timezone})` : 'Office time'}</p>
        </div>
      </div>
      <div className="flex items-start gap-2 sm:col-span-2">
        <MapPin className="mt-0.5 h-4 w-4 text-slate-400" aria-hidden />
        <p>
          <span className="font-medium text-slate-900">{b.pickupLocation}</span>
          <span className="mx-1 text-slate-400">→</span>
          <span className="font-medium text-slate-900">{b.dropLocation}</span>
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Users className="h-4 w-4 text-slate-400" aria-hidden />
        <span>
          {b.passengers} passenger{b.passengers === 1 ? '' : 's'}
        </span>
      </div>
      {(b.currentDriver || b.currentVehicle) && (
        <div className="flex items-center gap-2">
          <Car className="h-4 w-4 text-slate-400" aria-hidden />
          <span>
            Current: {b.currentDriver ?? '—'} / {b.currentVehicle ?? '—'}
          </span>
        </div>
      )}
    </div>
  );
}

function Choice({ selected, disabled, onSelect, children }: { selected: boolean; disabled: boolean; onSelect: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-disabled={disabled}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'w-full rounded-lg border p-3 text-left text-sm transition-colors',
        disabled ? 'cursor-not-allowed border-slate-200 bg-slate-50 opacity-70' : selected ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500' : 'border-slate-200 bg-white hover:border-slate-400',
      )}
    >
      {children}
    </button>
  );
}

function Problems({ problems }: { problems: string[] }) {
  if (!problems.length) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-red-700">
      {problems.map((p) => (
        <li key={p}>• {p}</li>
      ))}
    </ul>
  );
}

/** Driver and cab choosers with eligibility explained; shared by the single-ride and shared-trip dialogs. */
function ResourceLists({
  drivers,
  vehicles,
  driverId,
  vehicleId,
  onDriver,
  onVehicle,
  refreshing,
  onRefresh,
}: {
  drivers: EligibleDriver[];
  vehicles: EligibleVehicle[];
  driverId: string;
  vehicleId: string;
  onDriver: (d: EligibleDriver) => void;
  onVehicle: (id: string) => void;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const [showIneligible, setShowIneligible] = useState(false);
  const driver = drivers.find((d) => d._id === driverId);
  const visibleDrivers = showIneligible ? drivers : drivers.filter((d) => d.eligible || d._id === driverId);
  const visibleVehicles = showIneligible ? vehicles : vehicles.filter((v) => v.eligible || v._id === vehicleId);
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600">
        <span>
          {drivers.filter((d) => d.eligible).length} of {drivers.length} drivers and {vehicles.filter((v) => v.eligible).length} of {vehicles.length} cabs can take this.
        </span>
        <span className="flex items-center gap-2">
          <label className="inline-flex items-center gap-1.5">
            <input type="checkbox" className="h-4 w-4 rounded-sm border-slate-300" checked={showIneligible} onChange={(e) => setShowIneligible(e.target.checked)} />
            Show unavailable
          </label>
          <Button size="sm" variant="ghost" onClick={onRefresh} loading={refreshing}>
            Refresh
          </Button>
        </span>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <section aria-label="Drivers">
          <h3 className="mb-2 text-sm font-semibold text-slate-800">1. Driver</h3>
          <div role="radiogroup" aria-label="Driver" className="max-h-[45vh] space-y-2 overflow-y-auto pr-1">
            {!visibleDrivers.length ? (
              <EmptyState title="No available drivers" description={drivers.length ? 'Tick "Show unavailable" to see why each driver cannot take this.' : 'No drivers are registered for this office.'} />
            ) : (
              visibleDrivers.map((d) => (
                <Choice key={d._id} selected={d._id === driverId} disabled={!d.eligible} onSelect={() => onDriver(d)}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-slate-900">
                      {d.fullName} <span className="font-normal text-slate-500">({d.driverCode})</span>
                    </span>
                    <span className="flex gap-1">
                      <StatusBadge status={d.availability} />
                      {d.onDuty ? <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">On duty</span> : null}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {d.phone} · Cab: {d.currentVehicle ? `${d.currentVehicle.registrationNumber} (${d.currentVehicle.capacity} seats)` : 'none'}
                  </p>
                  <Problems problems={d.problems} />
                </Choice>
              ))
            )}
          </div>
        </section>
        <section aria-label="Cabs">
          <h3 className="mb-2 text-sm font-semibold text-slate-800">2. Cab</h3>
          <div role="radiogroup" aria-label="Cab" className="max-h-[45vh] space-y-2 overflow-y-auto pr-1">
            {!visibleVehicles.length ? (
              <EmptyState title="No available cabs" description={vehicles.length ? 'Tick "Show unavailable" to see why each cab cannot be used.' : 'No cabs are registered for this office.'} />
            ) : (
              visibleVehicles.map((v) => (
                <Choice key={v._id} selected={v._id === vehicleId} disabled={!v.eligible} onSelect={() => onVehicle(v._id)}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono font-medium text-slate-900">{v.registrationNumber}</span>
                    <StatusBadge status={v.status} />
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {v.capacity} seats · Driver: {v.currentDriver?.fullName ?? 'none'}
                    {driver?.currentVehicle?._id === v._id ? ' · this driver’s cab' : ''}
                  </p>
                  <Problems problems={v.problems} />
                </Choice>
              ))
            )}
          </div>
        </section>
      </div>
    </>
  );
}

const SERVER_ASSIGN_ERRORS =['SCHEDULE_CONFLICT', 'ALREADY_ASSIGNED', 'NOT_ELIGIBLE', 'INVALID_TRANSITION', 'IDEMPOTENCY_KEY_REUSED'];

export function AssignModal({ open, onClose, booking, mode = 'assign' }: { open: boolean; onClose: () => void; booking: AssignTarget | null; mode?: 'assign' | 'reassign' }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [step, setStep] = useState<1 | 2>(1);
  const [driverId, setDriverId] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState('');

  // New idempotency key + clean state for every time the modal opens.
  useEffect(() => {
    if (open) {
      setKey(uuid());
      setStep(1);
      setDriverId('');
      setVehicleId('');
      setReason('');
      setError('');
    }
  }, [open, booking?._id]);

  const eligible = useQuery({
    queryKey: ['ops', 'eligible', booking?._id],
    queryFn: ({ signal }) => get<Eligible>(`/ops/bookings/${booking!._id}/eligible`, signal),
    enabled: open && !!booking,
    staleTime: 0,
  });

  const drivers = eligible.data?.drivers ?? [];
  const vehicles = eligible.data?.vehicles ?? [];
  const driver = drivers.find((d) => d._id === driverId);
  const vehicle = vehicles.find((v) => v._id === vehicleId);

  // Drop a selection that became ineligible after a refresh.
  useEffect(() => {
    if (driver && !driver.eligible) setDriverId('');
    if (vehicle && !vehicle.eligible) setVehicleId('');
  }, [driver, vehicle]);

  const pickDriver = (d: EligibleDriver) => {
    setDriverId(d._id);
    const linked = d.currentVehicle && vehicles.find((v) => v._id === d.currentVehicle!._id);
    if (linked && linked.eligible) setVehicleId(linked._id);
  };

  const confirm = async () => {
    if (!booking || !driver || !vehicle) return;
    if (mode === 'reassign' && reason.trim().length < 3) {
      setError('Please give a reason for the reassignment (at least 3 characters).');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (mode === 'assign') {
        await post(`/ops/bookings/${booking._id}/assign`, { driverId: driver._id, vehicleId: vehicle._id }, { 'Idempotency-Key': key });
        toast.success('Cab assigned — employee email queued, driver notified', `${booking.reference}: ${vehicle.registrationNumber} · ${driver.fullName}`);
      } else {
        await post(`/ops/bookings/${booking._id}/reassign`, { driverId: driver._id, vehicleId: vehicle._id, reason: reason.trim() });
        toast.success('Cab reassigned — employee email queued, driver notified', `${booking.reference}: ${vehicle.registrationNumber} · ${driver.fullName}`);
      }
      qc.invalidateQueries({ queryKey: ['ops'] });
      onClose();
    } catch (e) {
      const msg = errorMessage(e);
      if (e instanceof ApiError && SERVER_ASSIGN_ERRORS.includes(e.code)) {
        const extra = e.details as { driverConflicts?: string[]; vehicleConflicts?: string[] } | undefined;
        const conflicts = [
          extra?.driverConflicts?.length ? `driver busy with ${extra.driverConflicts.join(', ')}` : '',
          extra?.vehicleConflicts?.length ? `vehicle busy with ${extra.vehicleConflicts.join(', ')}` : '',
        ].filter(Boolean);
        setError(conflicts.length ? `${msg} (${conflicts.join('; ')})` : msg);
        if (e.code === 'ALREADY_ASSIGNED' || e.code === 'INVALID_TRANSITION') qc.invalidateQueries({ queryKey: ['ops'] });
        else {
          setStep(1);
          eligible.refetch();
        }
      } else setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const title = mode === 'assign' ? 'Assign cab' : 'Reassign cab';

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title={step === 1 ? `${title} — select driver & vehicle` : `${title} — review`}
      size="xl"
      footer={
        step === 1 ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => setStep(2)} disabled={!driver || !vehicle}>
              Review assignment
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={() => setStep(1)} disabled={busy} icon={<ArrowLeft className="h-4 w-4" />}>
              Back
            </Button>
            <Button variant="success" onClick={confirm} loading={busy} icon={<CheckCircle2 className="h-4 w-4" />}>
              {mode === 'assign' ? 'Confirm assignment' : 'Confirm reassignment'}
            </Button>
          </>
        )
      }
    >
      {!booking ? null : (
        <div className="space-y-4">
          <TripSummary b={booking} />
          {error && <Alert tone="error">{error}</Alert>}

          {step === 1 ? (
            eligible.isLoading ? (
              <Spinner label="Checking driver and vehicle availability…" />
            ) : eligible.error ? (
              <ErrorState error={eligible.error} onRetry={eligible.refetch} />
            ) : (
              <ResourceLists
                drivers={drivers}
                vehicles={vehicles}
                driverId={driverId}
                vehicleId={vehicleId}
                onDriver={pickDriver}
                onVehicle={setVehicleId}
                refreshing={eligible.isFetching}
                onRefresh={() => eligible.refetch()}
              />
            )
          ) : (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-slate-200 p-3 text-sm">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Driver</p>
                  <p className="mt-1 font-medium text-slate-900">
                    {driver?.fullName} ({driver?.driverCode})
                  </p>
                  <p className="text-slate-600">{driver?.phone}</p>
                </div>
                <div className="rounded-lg border border-slate-200 p-3 text-sm">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Vehicle</p>
                  <p className="mt-1 font-medium text-slate-900">{vehicle?.registrationNumber}</p>
                  <p className="text-slate-600">
                    {vehicle?.model ? `${vehicle.model} · ` : ''}{vehicle?.capacity} seats
                  </p>
                </div>
              </div>
              {mode === 'reassign' && (
                <Textarea label="Reason for reassignment" required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Original driver reported a breakdown" />
              )}
              <Alert tone="info" title="What happens next">
                <ul className="list-disc space-y-0.5 pl-4">
                  <li>The employee is emailed the vehicle number and driver details, and sees a ride-start PIN in their booking.</li>
                  <li>The driver is notified in their dashboard and must acknowledge the ride.</li>
                  {mode === 'reassign' && <li>The previous assignment is closed and its PIN revoked; a new PIN is issued.</li>}
                </ul>
              </Alert>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

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
function PoolBar({ rides, onClear, onDone, change = false }: { rides: BookingRow[]; onClear: () => void; onDone: () => void; change?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const ids = useMemo(() => rides.map((r) => r._id).sort(), [rides]);
  // Change mode: one assigned ride moves to another free cab (with a reason); the list opens at once.
  const [open, setOpen] = useState(change);
  const [reason, setReason] = useState('');
  const current = change ? rides[0] : undefined;
  const [vehicleId, setVehicleId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(uuid());
  const seats = seatsOf(rides);

  // IN rides (home → office): the coordinator sets when the cab picks them up, before everyone's
  // reach-office time — earlier than cab hours if the ride is long. Suggested: an hour before.
  const ins = rides.filter((r) => r.direction === 'IN');
  const mixed = ins.length > 0 && ins.length !== rides.length;
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
  // Cabs already going at this time with room: the riders can be added to that trip (new rides only).
  const joinable = change ? [] : cabs.filter((c) => !c.usable && c.v.join);
  // Cabs with another trip at a different time close by: selectable, the coordinator decides (new rides only).
  const nearbyCabs = change ? [] : cabs.filter((c) => !c.usable && !c.v.join && c.v.nearby && c.driver);
  const unusable = cabs.filter((c) => !c.usable && !joinable.includes(c) && !nearbyCabs.includes(c));
  const chosenFree = usable.find((c) => c.v._id === vehicleId) ?? nearbyCabs.find((c) => c.v._id === vehicleId);
  const chosenJoin = joinable.find((c) => c.v._id === vehicleId);
  const chosen = chosenFree ?? (chosenJoin ? { ...chosenJoin, driver: { ...chosenJoin.v.join!.driver } } : undefined);
  const join = chosenJoin?.v.join ?? null;
  const nearby = !join ? (chosenFree?.v.nearby ?? null) : null;
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
      await post(`/ops/bookings/${current._id}/reassign`, { driverId: chosen.driver._id, vehicleId: chosen.v._id, reason: reason.trim() });
      toast.success('Cab changed', `${current.employee?.fullName}: now ${chosen.v.registrationNumber} · ${chosen.driver.fullName}. The employee and both drivers are notified.`);
      qc.invalidateQueries({ queryKey: ['ops'] });
      onDone();
    } catch (e) {
      setError(errorMessage(e));
      const code = e instanceof ApiError ? e.code : '';
      if (code === 'SCHEDULE_CONFLICT' || code === 'NOT_ELIGIBLE') {
        setVehicleId('');
        eligible.refetch();
      } else if (code === 'INVALID_TRANSITION') qc.invalidateQueries({ queryKey: ['ops'] });
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
        // The cab is named after the riders' routes on the server; it can be renamed later.
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
            {current ? `Change cab · ${current.employee?.fullName ?? current.reference}` : `${rides.length} ${rides.length === 1 ? 'ride' : 'rides'} selected`}
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
          <Button variant="ghost" onClick={onClear} disabled={busy}>
            {current ? 'Close' : 'Clear'}
          </Button>
          {!current && (
            <Button variant={open ? 'secondary' : 'primary'} icon={<Car className="h-4 w-4" />} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              {open ? 'Hide cabs' : 'Assign to one cab'}
            </Button>
          )}
        </div>
      </div>

      {open && (
        <div className="max-h-[55vh] space-y-3 overflow-y-auto border-t border-slate-100 p-3 sm:p-4">
          {eligible.isLoading ? (
            <Spinner label="Finding cabs free for every ride…" />
          ) : eligible.error ? (
            <ErrorState error={eligible.error} onRetry={eligible.refetch} />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                {!usable.length && !joinable.length && !nearbyCabs.length ? <span className="font-medium text-slate-900">No cab is free for these rides</span> : <span />}
                <Button size="sm" variant="ghost" onClick={() => eligible.refetch()} loading={eligible.isFetching}>
                  Refresh
                </Button>
              </div>

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
                          {driver?.phone} · {driver?.onDuty ? 'On duty' : 'Off duty'}
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

              {mixed ? (
                <Alert tone="warn" title="IN and OUT rides need separate cabs">
                  Tick only rides to the office (IN) or only rides home (OUT), then assign.
                </Alert>
              ) : (
                chosen && (
                  <div className="flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3">
                    {current && (
                      <div className="min-w-56 flex-1">
                        <Input label="Reason for the change" required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Original cab broke down" />
                      </div>
                    )}
                    {!current && ins.length > 0 && !join && (
                      <div className="w-44">
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
                    <Button variant="success" size="lg" className="ml-auto" loading={busy} onClick={assign} icon={<CheckCircle2 className="h-5 w-5" />}>
                      {current ? `Move to ${chosen.v.registrationNumber}` : `${join ? 'Add' : 'Assign'} ${rides.length} ${rides.length === 1 ? 'ride' : 'rides'} to ${chosen.v.registrationNumber}`}
                    </Button>
                  </div>
                )
              )}
              {error && <Alert tone="error">{error}</Alert>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function RenameTripModal({ trip, onClose }: { trip: { tripId: string; name: string } | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setName(trip?.name ?? '');
    setError('');
  }, [trip]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!trip) return;
    setBusy(true);
    setError('');
    try {
      await patch(`/ops/trips/${trip.tripId}`, { name: name.trim() });
      toast.success('Cab renamed', name.trim());
      qc.invalidateQueries({ queryKey: ['ops'] });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={!!trip}
      onClose={onClose}
      title="Rename shared cab"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="rename-trip" loading={busy} disabled={name.trim().length < 2 || name.trim() === trip?.name}>
            Save
          </Button>
        </>
      }
    >
      <form id="rename-trip" onSubmit={save} className="space-y-3">
        <Input label="Cab name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} hint='e.g. "Kondapur & Madhapur Cab"' />
        {error && <Alert tone="error">{error}</Alert>}
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Bookings page
// ---------------------------------------------------------------------------
// Plain-language tabs. `also` lists other status sets (used by dashboard links) that open the same tab.
// "Cab requests" is today's and tomorrow's live work; finished and all bookings live on the History page.
const LIVE_PRESETS = [
  { value: 'waiting', label: 'Waiting for a cab', status: 'REQUESTED,APPROVED,PENDING_APPROVAL', also: ['REQUESTED,APPROVED', 'PENDING_APPROVAL'] },
  { value: 'assigned', label: 'Cab assigned', status: 'ASSIGNED,DRIVER_EN_ROUTE,ARRIVED', also: [] },
  { value: 'trip', label: 'On trip', status: 'IN_PROGRESS', also: [] },
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
  // History only: pickup date range.
  const [dateFrom, setDateFrom] = useState(params.get('from') ?? '');
  const [dateTo, setDateTo] = useState(params.get('to') ?? '');
  const [sort, setSort] = useState(history ? '-scheduledPickupAt' : 'scheduledPickupAt');
  const [page, setPage] = useState(1);
  // The assigned ride whose cab is being changed (in the bar at the bottom, no pop-up).
  const [changing, setChanging] = useState<BookingRow | null>(null);
  const [action, setAction] = useState<{ kind: RowAction; b: BookingRow } | null>(null);
  // Waiting rides ticked to share one cab, and the shared cab being renamed.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<{ tripId: string; name: string } | null>(null);
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
  const { data, isLoading, error, refetch, isFetching } = usePaged<BookingRow>(['ops', 'bookings'], '/ops/bookings', query);
  // Only rides still waiting (and on screen) can be pooled; anything else drops out of the selection.
  const selectedRides = useMemo(() => (data?.items ?? []).filter((r) => selected.has(r._id) && ASSIGNABLE.includes(r.status)), [data, selected]);
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
    const t: Array<{ value: PresetKey; label: string }> = presets.map((p) => ({ value: p.value, label: p.label }));
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
          <p className="text-xs text-slate-500">{fmtTravelDate(b.travelDate)}</p>
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
          {b.notification?.status === 'FAILED' && (
            <Pill tone="red" title={b.notification.lastError}>
              Email not sent
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
            <p className="font-medium text-slate-900">{b.vehicle?.registrationNumber ?? '—'}</p>
            <p className="text-slate-600">
              {b.driver?.fullName ?? '—'}
              {b.driver?.phone ? <span className="text-slate-400"> · {b.driver.phone}</span> : null}
            </p>
            {b.assignment?._id && !b.assignment.acknowledgedAt && <p className="text-xs text-amber-700">Driver hasn't confirmed yet</p>}
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
          if (REASSIGNABLE.includes(b.status))
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
          if (!b.isDelayed)
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
        return buttons.length ? <div className="flex flex-wrap justify-end gap-2 lg:flex-nowrap [&>button]:whitespace-nowrap">{buttons}</div> : <span className="text-sm text-slate-400">—</span>;
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
        subtitle={history ? 'All bookings, newest first' : linkedDate ? linkedLabel : `${day === 'today' ? "Today's" : "Tomorrow's"} shifts · ${fmtTravelDate(workDay)}`}
        actions={
          <Button variant="secondary" onClick={() => refetch()} loading={isFetching && !isLoading}>
            Refresh
          </Button>
        }
      />

      {history ? (
        <Card className="mb-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6 lg:items-end">
            <div className="sm:col-span-2 lg:col-span-2">
              <SearchInput value={q} onChange={reset(setQ)} placeholder="Search name, employee ID, reference or place" />
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
          <div className="min-w-56 flex-1">
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
            onRename={(tripId, name) => setRenaming({ tripId, name })}
          />
          {data.totalPages > 1 && <Pagination page={data.page} total={data.total} totalPages={data.totalPages} onPage={setPage} />}
          {preset === 'waiting' && !changing && selectedRides.length > 0 && <PoolBar rides={selectedRides} onClear={() => setSelected(new Set())} onDone={() => setSelected(new Set())} />}
        </>
      )}

      {changing && <PoolBar key={changing._id} rides={[changing]} change onClear={() => setChanging(null)} onDone={() => setChanging(null)} />}
      <RenameTripModal trip={renaming} onClose={() => setRenaming(null)} />
      {action && (
        <ConfirmDialog
          open
          onClose={() => setAction(null)}
          onConfirm={(reason) => runAction(action, reason)}
          title={ROW_ACTIONS[action.kind].title}
          message={
            <p>
              {action.b.employee?.fullName} · {action.b.reference} · {fmtTravelDate(action.b.travelDate)} at {fmt12h(action.b.pickupTime)}
              {action.kind === 'approveCancel' && action.b.cancellationRequest?.reason ? <span className="mt-1 block text-slate-500">Reason given: “{action.b.cancellationRequest.reason}”</span> : null}
            </p>
          }
          confirmLabel={ROW_ACTIONS[action.kind].confirm}
          tone={ROW_ACTIONS[action.kind].danger ? 'danger' : 'primary'}
          reasonLabel={ROW_ACTIONS[action.kind].reasonLabel}
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
  onRename,
}: {
  rows: BookingRow[];
  columns: Column<BookingRow>[];
  byTrip?: boolean;
  selection?: { selected: Set<string>; onChange: (ids: string[], on: boolean) => void };
  onRename?: (tripId: string, name: string) => void;
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
        return (
          <details key={g.key} open className="group rounded-xl border border-slate-200 bg-white shadow-xs">
            <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
              <span className="flex min-w-0 items-center gap-2">
                <Car className="h-5 w-5 shrink-0 text-slate-400" aria-hidden />
                <span className={cn('truncate font-semibold', g.label === NO_ROUTE && !g.tripId ? 'text-slate-500' : 'text-slate-900')}>{g.label}</span>
                <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">{count(all.length)}</span>
                {shared && (
                  <span className="hidden truncate text-sm text-slate-600 md:inline">
                    · <span className="font-mono">{shared.vehicle?.registrationNumber ?? '—'}</span> · {shared.driver?.fullName ?? '—'}
                    {shared.driver?.phone ? <span className="text-slate-400"> · {shared.driver.phone}</span> : null}
                  </span>
                )}
                {shared?.vehicle?.capacity ? <SeatsFree capacity={shared.vehicle.capacity} used={all.reduce((n, r) => n + (r.passengers || 1), 0)} needed={0} /> : null}
                {shared && all.some((r) => r.assignment?._id && !r.assignment.acknowledgedAt) && (
                  <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">Driver hasn&apos;t confirmed</span>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-2 text-sm text-slate-500">
                <span className="hidden sm:inline">{[...g.times.values()].map((list) => `${list[0].direction === 'IN' ? 'IN' : 'OUT'} ${fmt12h(groupTime(list[0]))}`).join(' · ')}</span>
                {g.tripId && onRename && (
                  <Button size="sm" variant="ghost" onClick={() => onRename(g.tripId!, g.label)}>
                    Rename
                  </Button>
                )}
                <ChevronDown className="h-5 w-5 transition-transform group-open:rotate-180" aria-hidden />
              </span>
            </summary>
            <div className="space-y-2 border-t border-slate-100 p-3">
              {[...g.times.entries()].map(([slot, list]) => (
                <details key={slot} open className="group/time rounded-lg border border-slate-100">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 bg-slate-50 px-3 py-2 [&::-webkit-details-marker]:hidden">
                    <span className="flex flex-wrap items-center gap-2">
                      {selection && <GroupCheckbox ids={pickable(list)} selected={selection.selected} onChange={selection.onChange} label={`Select all ${fmt12h(groupTime(list[0]))} rides on ${g.label}`} />}
                      <DirectionBadge direction={list[0].direction} />
                      <Clock className="h-4 w-4 text-slate-400" aria-hidden />
                      {list[0].direction === 'IN' ? (
                        list[0].pickupTimeSet === false ? (
                          <span className="font-semibold text-slate-900">Reach office by {fmt12h(groupTime(list[0]))}</span>
                        ) : (
                          <span className="font-semibold text-slate-900">
                            Pickup {fmt12h(list[0].pickupTime)}
                            {list[0].reportBy ? <span className="font-normal text-slate-500"> · reach by {fmt12h(list[0].reportBy)}</span> : null}
                          </span>
                        )
                      ) : (
                        <span className="font-semibold text-slate-900">Leaves office {fmt12h(list[0].pickupTime)}</span>
                      )}
                      <span className="text-sm text-slate-500">{fmtTravelDate(list[0].travelDate)}</span>
                      <span className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-slate-700 ring-1 ring-slate-200">{count(list.length)}</span>
                    </span>
                    <ChevronDown className="h-4 w-4 text-slate-400 transition-transform group-open/time:rotate-180" aria-hidden />
                  </summary>
                  <div className="p-2">
                    {/* In a shared cab the header already shows the cab and driver. */}
                    <DataTable columns={g.tripId ? cols.filter((c) => c.key !== 'cab') : cols} rows={list} rowKey={(b) => b._id} hideHeader />
                  </div>
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
const ROW_ACTIONS: Record<RowAction, { path: string; title: string; confirm: string; done: string; danger?: boolean; reasonLabel?: string }> = {
  cancel: { path: 'cancel', title: 'Cancel this ride?', confirm: 'Cancel ride', done: 'Ride cancelled', danger: true, reasonLabel: 'Reason (sent to the employee)' },
  delay: { path: 'delay', title: 'Mark this ride as delayed?', confirm: 'Mark delayed', done: 'Marked delayed — the employee is told', reasonLabel: 'Reason for the delay (sent to the employee)' },
  approve: { path: 'approve', title: 'Approve this request?', confirm: 'Approve', done: 'Request approved' },
  reject: { path: 'reject', title: 'Reject this request?', confirm: 'Reject', done: 'Request rejected', danger: true, reasonLabel: 'Reason (sent to the employee)' },
  approveCancel: { path: 'cancellation-request/approve', title: 'Approve the cancellation?', confirm: 'Cancel ride', done: 'Ride cancelled as requested', danger: true },
  declineCancel: { path: 'cancellation-request/decline', title: 'Decline the cancellation?', confirm: 'Decline', done: 'Cancellation declined — the ride stays booked', reasonLabel: 'Reason (sent to the employee)' },
};
