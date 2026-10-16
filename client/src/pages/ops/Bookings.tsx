import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Car, CheckCircle2, Clock, MapPin, User, Users } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
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
import { ApiError, errorMessage, get, post, qs, type Paged } from '../../lib/api';
import { usePaged } from '../../lib/hooks';
import { fmtDateTime, fmtTravelDate, humanize, todayISO, uuid } from '../../lib/format';
import { DayPicker, OfficeSelect, useOpsOffices } from './OpsDashboard';

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
  employee: { _id: string; fullName: string; employeeId: string; email?: string; phone?: string };
  assignment?: { _id?: string; acknowledgedAt?: string; status?: string };
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
            {fmtTravelDate(b.travelDate)} · {b.pickupTime}
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

const SERVER_ASSIGN_ERRORS = ['SCHEDULE_CONFLICT', 'ALREADY_ASSIGNED', 'NOT_ELIGIBLE', 'INVALID_TRANSITION', 'IDEMPOTENCY_KEY_REUSED'];

export function AssignModal({ open, onClose, booking, mode = 'assign' }: { open: boolean; onClose: () => void; booking: AssignTarget | null; mode?: 'assign' | 'reassign' }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [step, setStep] = useState<1 | 2>(1);
  const [driverId, setDriverId] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const [reason, setReason] = useState('');
  const [showIneligible, setShowIneligible] = useState(false);
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
      setShowIneligible(false);
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
  const eligibleDrivers = drivers.filter((d) => d.eligible).length;
  const eligibleVehicles = vehicles.filter((v) => v.eligible).length;

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

  const visibleDrivers = showIneligible ? drivers : drivers.filter((d) => d.eligible || d._id === driverId);
  const visibleVehicles = showIneligible ? vehicles : vehicles.filter((v) => v.eligible || v._id === vehicleId);
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
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600">
                  <span>
                    {eligibleDrivers} of {drivers.length} drivers and {eligibleVehicles} of {vehicles.length} vehicles can take this trip.
                  </span>
                  <span className="flex items-center gap-2">
                    <label className="inline-flex items-center gap-1.5">
                      <input type="checkbox" className="h-4 w-4 rounded-sm border-slate-300" checked={showIneligible} onChange={(e) => setShowIneligible(e.target.checked)} />
                      Show unavailable
                    </label>
                    <Button size="sm" variant="ghost" onClick={() => eligible.refetch()} loading={eligible.isFetching}>
                      Refresh
                    </Button>
                  </span>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <section aria-label="Drivers">
                    <h3 className="mb-2 text-sm font-semibold text-slate-800">1. Driver</h3>
                    <div role="radiogroup" aria-label="Driver" className="max-h-[45vh] space-y-2 overflow-y-auto pr-1">
                      {!visibleDrivers.length ? (
                        <EmptyState title="No available drivers" description={drivers.length ? 'Tick "Show unavailable" to see why each driver cannot take this trip.' : 'No drivers are registered for this office.'} />
                      ) : (
                        visibleDrivers.map((d) => (
                          <Choice key={d._id} selected={d._id === driverId} disabled={!d.eligible} onSelect={() => pickDriver(d)}>
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
                              {d.phone} · {d.onDuty ? 'On duty' : 'Off duty'} · Vehicle: {d.currentVehicle ? `${d.currentVehicle.registrationNumber} (${d.currentVehicle.capacity} seats)` : 'none linked'}
                            </p>
                            <Problems problems={d.problems} />
                          </Choice>
                        ))
                      )}
                    </div>
                  </section>
                  <section aria-label="Vehicles">
                    <h3 className="mb-2 text-sm font-semibold text-slate-800">2. Vehicle</h3>
                    <div role="radiogroup" aria-label="Vehicle" className="max-h-[45vh] space-y-2 overflow-y-auto pr-1">
                      {!visibleVehicles.length ? (
                        <EmptyState title="No available vehicles" description={vehicles.length ? 'Tick "Show unavailable" to see why each vehicle cannot be used.' : 'No vehicles are registered for this office.'} />
                      ) : (
                        visibleVehicles.map((v) => (
                          <Choice key={v._id} selected={v._id === vehicleId} disabled={!v.eligible} onSelect={() => setVehicleId(v._id)}>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-medium text-slate-900">{v.registrationNumber}</span>
                              <StatusBadge status={v.status} />
                            </div>
                            <p className="mt-0.5 text-xs text-slate-500">
                              {v.model} · {v.capacity} seats · Linked driver: {v.currentDriver?.fullName ?? 'none'}
                              {driver?.currentVehicle?._id === v._id ? ' · linked to selected driver' : ''}
                            </p>
                            <Problems problems={v.problems} />
                          </Choice>
                        ))
                      )}
                    </div>
                  </section>
                </div>
              </>
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
                    {vehicle?.model} · {vehicle?.capacity} seats
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
// Bookings page
// ---------------------------------------------------------------------------
const PRESETS = [
  { value: 'needs', label: 'Needs assignment', status: 'REQUESTED,APPROVED' },
  { value: 'approval', label: 'Pending approval', status: 'PENDING_APPROVAL' },
  { value: 'assigned', label: 'Assigned / en route', status: 'ASSIGNED,DRIVER_EN_ROUTE,ARRIVED' },
  { value: 'progress', label: 'In progress', status: 'IN_PROGRESS' },
  { value: 'completed', label: 'Completed', status: 'COMPLETED' },
  { value: 'closed', label: 'Cancelled / rejected / no-show', status: 'CANCELLED,REJECTED,NO_SHOW' },
  { value: 'all', label: 'All', status: '' },
] as const;
type PresetKey = (typeof PRESETS)[number]['value'] | 'custom';

const normStatus = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean)
    .sort()
    .join(',');
const presetFor = (status: string): PresetKey => PRESETS.find((p) => normStatus(p.status) === normStatus(status))?.value ?? 'custom';

type Option = { _id: string; label: string };

function NotificationCell({ n }: { n?: BookingRow['notification'] }) {
  if (!n?.status) return <span className="text-slate-400">—</span>;
  const tip = [n.lastError ? `Last error: ${n.lastError}` : '', n.attempts ? `Attempts: ${n.attempts}` : '', n.acceptedAt ? `Accepted ${fmtDateTime(n.acceptedAt)}` : ''].filter(Boolean).join(' · ');
  return (
    <span title={tip || undefined}>
      <StatusBadge status={n.status} />
    </span>
  );
}

export default function Bookings() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { timezone, policy } = useOpsOffices();

  const initialDate = params.get('date');
  const [date, setDate] = useState(initialDate === 'today' || initialDate === null ? todayISO(timezone) : initialDate === 'all' ? '' : initialDate);
  const initialStatus = params.get('status');
  const [status, setStatus] = useState(initialStatus === null ? 'REQUESTED,APPROVED' : initialStatus.toUpperCase() === 'ALL' ? '' : initialStatus);
  const [office, setOffice] = useState(params.get('office') ?? '');
  const [shift, setShift] = useState(params.get('shift') ?? '');
  const [driverId, setDriverId] = useState(params.get('driverId') ?? '');
  const [vehicleId, setVehicleId] = useState(params.get('vehicleId') ?? '');
  const [flags, setFlags] = useState(params.get('delayed') === 'true' ? 'delayed' : params.get('flagged') === 'true' ? 'flagged' : params.get('cancellationRequested') === 'true' ? 'cancelRequested' : '');
  const [q, setQ] = useState(params.get('q') ?? '');
  const [sort, setSort] = useState('scheduledPickupAt');
  const [page, setPage] = useState(1);
  const [assignFor, setAssignFor] = useState<AssignTarget | null>(null);
  const pageSize = 25;

  // Keep the URL in sync so the view can be bookmarked / shared / refreshed.
  useEffect(() => {
    const next = qs({
      date: date || 'all',
      status: status || 'ALL',
      office,
      shift,
      driverId,
      vehicleId,
      q,
      delayed: flags === 'delayed' ? 'true' : '',
      flagged: flags === 'flagged' ? 'true' : '',
      cancellationRequested: flags === 'cancelRequested' ? 'true' : '',
    });
    if (`?${params.toString()}` !== next) setParams(new URLSearchParams(next), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, status, office, shift, driverId, vehicleId, q, flags]);

  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };

  const query = qs({
    page,
    pageSize,
    sort,
    q,
    date,
    status,
    officeLocation: office,
    shift,
    driverId,
    vehicleId,
    delayed: flags === 'delayed' ? 'true' : undefined,
    flagged: flags === 'flagged' ? 'true' : undefined,
    cancellationRequested: flags === 'cancelRequested' ? 'true' : undefined,
  });
  const { data, isLoading, error, refetch, isFetching } = usePaged<BookingRow>(['ops', 'bookings'], '/ops/bookings', query);

  const driverOptions = useQuery({
    queryKey: ['ops', 'drivers', 'options'],
    queryFn: async () => (await get<Paged<{ _id: string; fullName: string; driverCode: string }>>('/ops/drivers?pageSize=100&sort=fullName')).items.map<Option>((d) => ({ _id: d._id, label: `${d.fullName} (${d.driverCode})` })),
    staleTime: 60_000,
  });
  const vehicleOptions = useQuery({
    queryKey: ['ops', 'vehicles', 'options'],
    queryFn: async () => (await get<Paged<{ _id: string; registrationNumber: string; model: string }>>('/ops/vehicles?pageSize=100')).items.map<Option>((v) => ({ _id: v._id, label: `${v.registrationNumber} · ${v.model}` })),
    staleTime: 60_000,
  });

  const preset = presetFor(status);
  const tabs = useMemo(() => {
    const t: Array<{ value: PresetKey; label: string }> = PRESETS.map((p) => ({ value: p.value, label: p.label }));
    if (preset === 'custom') t.push({ value: 'custom', label: `Custom: ${humanize(status)}` });
    return t;
  }, [preset, status]);

  const columns: Column<BookingRow>[] = [
    {
      key: 'ref',
      header: 'Reference',
      sortKey: 'reference',
      render: (b) => (
        <Link to={`/ops/bookings/${b._id}`} onClick={(e) => e.stopPropagation()} className="font-medium text-indigo-600 hover:underline">
          {b.reference}
        </Link>
      ),
    },
    {
      key: 'employee',
      header: 'Employee',
      render: (b) => (
        <div className="min-w-36">
          <p className="font-medium text-slate-900">{b.employee?.fullName}</p>
          <p className="text-xs text-slate-500">{b.employee?.employeeId}</p>
        </div>
      ),
    },
    { key: 'pickup', header: 'Pickup', render: (b) => <span className="line-clamp-2 min-w-40" title={b.pickupLocation}>{b.pickupLocation}</span> },
    { key: 'drop', header: 'Destination', render: (b) => <span className="line-clamp-2 min-w-40" title={b.dropLocation}>{b.dropLocation}</span> },
    { key: 'date', header: 'Travel date', render: (b) => <span className="whitespace-nowrap">{fmtTravelDate(b.travelDate)}</span> },
    { key: 'time', header: 'Pickup time', sortKey: 'scheduledPickupAt', render: (b) => <span className="whitespace-nowrap font-medium">{b.pickupTime}</span> },
    { key: 'pax', header: 'Pax', render: (b) => b.passengers, className: 'text-center' },
    {
      key: 'shift',
      header: 'Shift / trip',
      render: (b) => (
        <div className="whitespace-nowrap text-xs">
          <p>{b.shift || '—'}</p>
          <p className="text-slate-500">
            {humanize(b.tripType)}
            {b.tripType === 'ROUND_TRIP' && b.leg ? ` · ${humanize(b.leg)}` : ''}
          </p>
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
            <span title={b.delayReason}>
              <StatusBadge status="DELAYED" />
            </span>
          )}
          {b.flaggedForReview && (
            <span title={b.flagReason} className="inline-flex whitespace-nowrap rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-800">
              Needs review
            </span>
          )}
          {b.cancellationRequest?.status === 'PENDING' && (
            <span title={b.cancellationRequest.reason} className="inline-flex whitespace-nowrap rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
              Cancellation requested
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'driver',
      header: 'Driver',
      render: (b) =>
        b.driver ? (
          <div className="whitespace-nowrap">
            <p>{b.driver.fullName}</p>
            <p className="text-xs text-slate-500">{b.driver.phone}</p>
          </div>
        ) : (
          <span className="text-slate-400">—</span>
        ),
    },
    { key: 'vehicle', header: 'Vehicle', render: (b) => (b.vehicle ? <span className="whitespace-nowrap">{b.vehicle.registrationNumber}</span> : <span className="text-slate-400">—</span>) },
    { key: 'notif', header: 'Employee email', render: (b) => <NotificationCell n={b.notification} /> },
    {
      key: 'ack',
      header: 'Driver ack',
      render: (b) =>
        !b.assignment?._id ? (
          <span className="text-slate-400">—</span>
        ) : b.assignment.acknowledgedAt ? (
          <span className="inline-flex items-center gap-1 whitespace-nowrap text-emerald-700" title={`Acknowledged ${fmtDateTime(b.assignment.acknowledgedAt, b.timezone)}`}>
            <CheckCircle2 className="h-4 w-4" aria-hidden /> Yes
          </span>
        ) : (
          <span className="whitespace-nowrap text-amber-700">Waiting</span>
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      render: (b) =>
        ASSIGNABLE.includes(b.status) ? (
          <Button
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              setAssignFor(toAssignTarget(b));
            }}
          >
            Assign
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Cab requests"
        subtitle={date ? `Trips on ${fmtTravelDate(date)}` : 'All dates'}
        actions={
          <Button variant="secondary" onClick={() => refetch()} loading={isFetching && !isLoading}>
            Refresh
          </Button>
        }
      />

      <Card className="mb-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2">
            <DayPicker value={date} onChange={reset(setDate)} allowAll />
          </div>
          <OfficeSelect value={office} onChange={reset(setOffice)} />
          <Select label="Shift" value={shift} onChange={(e) => reset(setShift)(e.target.value)}>
            <option value="">All shifts</option>
            {policy?.shifts
              .filter((s) => s.active)
              .map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
          </Select>
          <Select label="Driver" value={driverId} onChange={(e) => reset(setDriverId)(e.target.value)}>
            <option value="">Any driver</option>
            {driverOptions.data?.map((d) => (
              <option key={d._id} value={d._id}>
                {d.label}
              </option>
            ))}
          </Select>
          <Select label="Vehicle" value={vehicleId} onChange={(e) => reset(setVehicleId)(e.target.value)}>
            <option value="">Any vehicle</option>
            {vehicleOptions.data?.map((v) => (
              <option key={v._id} value={v._id}>
                {v.label}
              </option>
            ))}
          </Select>
          <Select label="Flags" value={flags} onChange={(e) => reset(setFlags)(e.target.value)}>
            <option value="">No flag filter</option>
            <option value="delayed">Delayed only</option>
            <option value="flagged">Needs review only</option>
            <option value="cancelRequested">Cancellation requested</option>
          </Select>
          <div className="space-y-1">
            <span className="block text-sm font-medium text-slate-700">Search</span>
            <SearchInput value={q} onChange={reset(setQ)} placeholder="Reference, employee, location…" />
          </div>
        </div>
      </Card>

      <Tabs
        tabs={tabs}
        value={preset}
        onChange={(v) => {
          if (v === 'custom') return;
          setStatus(PRESETS.find((p) => p.value === v)!.status);
          setPage(1);
        }}
      />

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
        onRowClick={(b) => navigate(`/ops/bookings/${b._id}`)}
        empty={
          <EmptyState
            title={preset === 'needs' ? 'Nothing waiting for a cab' : 'No cab requests match these filters'}
            description={preset === 'needs' ? 'All requests for this day have been assigned. Try another date or the "All" tab.' : 'Try another date, status or office.'}
          />
        }
      />
      {data && <Pagination page={data.page} total={data.total} totalPages={data.totalPages} onPage={setPage} />}

      <AssignModal open={!!assignFor} booking={assignFor} onClose={() => setAssignFor(null)} />
    </>
  );
}
