import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, CheckCircle2, MapPin, Navigation, Phone, PlayCircle, ThumbsUp } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, Button, Card, ConfirmDialog, DescriptionList, ErrorState, Spinner, StatusBadge, Textarea, cn, useToast } from '../../components/ui';
import { ApiError, errorMessage, get, post } from '../../lib/api';
import { fmtDateTime, fmtTime, fmtTravelDate } from '../../lib/format';

type Ride = {
  assignmentId: string;
  assignmentStatus: string;
  acknowledgedAt?: string | null;
  enRouteAt?: string | null;
  arrivedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  endReason?: string | null;
  scheduledPickupAt: string;
  vehicle?: { registrationNumber?: string; model?: string; capacity?: number } | null;
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
  pin: { status: string; attemptsRemaining: number } | null;
  driverNotes?: string;
};

const STEPS = [
  { key: 'ASSIGNED', label: 'Assigned', at: (r: Ride) => r.acknowledgedAt },
  { key: 'DRIVER_EN_ROUTE', label: 'En route', at: (r: Ride) => r.enRouteAt },
  { key: 'ARRIVED', label: 'Arrived', at: (r: Ride) => r.arrivedAt },
  { key: 'IN_PROGRESS', label: 'In progress', at: (r: Ride) => r.startedAt },
  { key: 'COMPLETED', label: 'Completed', at: (r: Ride) => r.completedAt },
] as const;

function Stepper({ ride, tz }: { ride: Ride; tz?: string }) {
  const status = ride.assignmentStatus === 'COMPLETED' ? 'COMPLETED' : ride.booking?.status ?? 'ASSIGNED';
  const current = Math.max(0, STEPS.findIndex((s) => s.key === status));
  const ended = ride.assignmentStatus !== 'ACTIVE' && ride.assignmentStatus !== 'COMPLETED';
  return (
    <ol className="flex items-start justify-between gap-1" aria-label="Trip progress">
      {STEPS.map((s, i) => {
        const done = i < current || (i === current && status === 'COMPLETED');
        const isCurrent = i === current && !done && !ended;
        const at = s.at(ride);
        return (
          <li key={s.key} className="flex min-w-0 flex-1 flex-col items-center text-center" aria-current={isCurrent ? 'step' : undefined}>
            <div className="flex w-full items-center">
              <span className={cn('h-0.5 flex-1', i === 0 ? 'bg-transparent' : i <= current ? 'bg-emerald-500' : 'bg-slate-200')} aria-hidden />
              <span
                className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold',
                  done ? 'border-emerald-500 bg-emerald-500 text-white' : isCurrent ? 'border-slate-900 bg-white text-slate-900' : 'border-slate-200 bg-white text-slate-400',
                )}
              >
                {done ? <Check className="h-4 w-4" aria-hidden /> : i + 1}
              </span>
              <span className={cn('h-0.5 flex-1', i === STEPS.length - 1 ? 'bg-transparent' : i < current ? 'bg-emerald-500' : 'bg-slate-200')} aria-hidden />
            </div>
            <span className={cn('mt-1 text-[11px] font-medium leading-tight sm:text-xs', isCurrent ? 'text-slate-900' : 'text-slate-500')}>{s.label}</span>
            {at && <span className="text-[10px] text-slate-400">{fmtTime(at, tz)}</span>}
          </li>
        );
      })}
    </ol>
  );
}

type PinMsg = { tone: 'error' | 'warn' | 'success'; title: string; text: string } | null;

function PinPanel({ ride, onStarted, onNotActive }: { ride: Ride; onStarted: () => void; onNotActive: (msg: string) => void }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<PinMsg>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(ride.pin?.attemptsRemaining ?? null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setRemaining(ride.pin?.attemptsRemaining ?? null);
  }, [ride.pin?.attemptsRemaining]);

  const pinState = ride.pin?.status;
  const preBlocked = pinState === 'LOCKED' ? 'locked' : pinState === 'EXPIRED' ? 'expired' : pinState === 'REVOKED' ? 'revoked' : null;
  const lockedOut = blocked ?? preBlocked;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || lockedOut) return;
    if (!/^\d{4,6}$/.test(pin)) {
      setMsg({ tone: 'error', title: 'Check the PIN', text: 'Enter the numeric PIN the passenger tells you.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await post(`/driver/rides/${ride.assignmentId}/start`, { pin });
      setMsg({ tone: 'success', title: 'PIN verified', text: 'Trip started. Drive safely.' });
      setPin('');
      onStarted();
    } catch (err) {
      setPin('');
      if (err instanceof ApiError) {
        if (err.code === 'INVALID_PIN') {
          const left = typeof err.details?.attemptsRemaining === 'number' ? (err.details.attemptsRemaining as number) : null;
          if (left !== null) setRemaining(left);
          setMsg({ tone: 'error', title: 'Incorrect PIN', text: left !== null ? `${left} attempt${left === 1 ? '' : 's'} remaining. Ask the passenger to read the PIN again.` : err.message });
        } else if (err.status === 423 || err.code === 'PIN_LOCKED') {
          setBlocked('locked');
          setRemaining(0);
        } else if (err.status === 410 || err.code === 'PIN_EXPIRED') {
          setBlocked('expired');
        } else if (err.code === 'ALREADY_STARTED') {
          setMsg({ tone: 'warn', title: 'Trip already started', text: err.message });
          onStarted();
        } else if (err.code === 'ASSIGNMENT_NOT_ACTIVE') {
          onNotActive(err.message);
        } else {
          setMsg({ tone: 'error', title: 'Could not start the trip', text: err.message });
        }
      } else {
        setMsg({ tone: 'error', title: 'Could not start the trip', text: errorMessage(err) });
      }
      setTimeout(() => inputRef.current?.focus(), 0);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border-2 border-violet-300 bg-violet-50 p-4" aria-labelledby="pin-heading">
      <h2 id="pin-heading" className="text-lg font-semibold text-slate-900">
        Verify the passenger's PIN
      </h2>
      <p className="mt-1 text-sm text-slate-700">Once the passenger is inside the vehicle, ask them to tell you their ride-start PIN and type it below.</p>
      <div aria-live="assertive" aria-atomic="true" className="mt-3 space-y-2 empty:hidden">
        {lockedOut && (
          <Alert tone="error" title={lockedOut === 'locked' ? 'PIN locked' : lockedOut === 'expired' ? 'PIN expired' : 'PIN no longer valid'}>
            {lockedOut === 'locked' ? 'Too many incorrect attempts.' : lockedOut === 'expired' ? 'The PIN has expired.' : 'This PIN has been revoked.'} Do not start the trip — please contact the transport coordinator.
          </Alert>
        )}
        {msg && !lockedOut && (
          <Alert tone={msg.tone} title={msg.title}>
            {msg.text}
          </Alert>
        )}
      </div>
      {!lockedOut && (
        <form onSubmit={submit} className="mt-3 space-y-3">
          <label htmlFor="ride-pin" className="block text-sm font-medium text-slate-800">
            Passenger PIN
          </label>
          <input
            ref={inputRef}
            id="ride-pin"
            name="pin"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            className="block h-16 w-full rounded-xl border-2 border-slate-300 bg-white text-center font-mono text-3xl tracking-[0.5em] focus:border-violet-500"
            aria-describedby="pin-attempts"
            disabled={busy}
          />
          <p id="pin-attempts" className="text-sm text-slate-600">
            {remaining !== null ? `${remaining} attempt${remaining === 1 ? '' : 's'} remaining` : ' '}
          </p>
          <Button type="submit" size="xl" variant="success" loading={busy} disabled={busy || pin.length < 4} icon={<PlayCircle className="h-6 w-6" aria-hidden />}>
            Verify PIN & start trip
          </Button>
        </form>
      )}
    </section>
  );
}

export default function DriverRide() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notActive, setNotActive] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'decline' | 'noshow' | 'complete' | null>(null);
  const [note, setNote] = useState('');
  const [noteDirty, setNoteDirty] = useState(false);
  const [noteBusy, setNoteBusy] = useState(false);

  const { data: ride, isLoading, error, refetch } = useQuery({
    queryKey: ['driver', 'ride', id],
    queryFn: () => get<Ride>(`/driver/rides/${id}`),
    refetchInterval: 30_000,
  });

  useEffect(() => {
    if (ride && !noteDirty) setNote(ride.driverNotes ?? '');
  }, [ride, noteDirty]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['driver'] });
  };

  const handleError = (err: unknown) => {
    if (err instanceof ApiError && err.code === 'ASSIGNMENT_NOT_ACTIVE') {
      setNotActive('This ride is no longer assigned to you.');
      refresh();
      return;
    }
    setActionError(errorMessage(err));
    refresh();
  };

  /** Runs a lifecycle action; errors are shown inline (not thrown). */
  const run = async (path: string, success: string, payload: unknown = {}) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await post(`/driver/rides/${id}/${path}`, payload);
      toast.success(success);
      refresh();
      await refetch();
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  };

  /** For ConfirmDialog: rethrow so the dialog shows the message inline. */
  const confirmAction = async (path: string, success: string, payload: unknown) => {
    setActionError(null);
    try {
      await post(`/driver/rides/${id}/${path}`, payload);
      toast.success(success);
      refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ASSIGNMENT_NOT_ACTIVE') {
        setNotActive('This ride is no longer assigned to you.');
        refresh();
      }
      throw err;
    }
  };

  const saveNote = async () => {
    setNoteBusy(true);
    try {
      await post(`/driver/rides/${id}/notes`, { note: note.trim() });
      toast.success('Note saved');
      setNoteDirty(false);
      refresh();
    } catch (err) {
      toast.error('Could not save note', errorMessage(err));
    } finally {
      setNoteBusy(false);
    }
  };

  const back = (
    <Link to="/driver" className="inline-flex items-center gap-1 text-sm font-medium text-slate-600 hover:text-slate-900">
      <ArrowLeft className="h-4 w-4" aria-hidden /> My rides
    </Link>
  );

  if (isLoading) return <Spinner />;
  if (error || !ride) {
    return (
      <div className="space-y-4">
        {back}
        {error instanceof ApiError && error.status === 404 ? (
          <Alert tone="error" title="Ride not found">This ride does not exist or is not assigned to you.</Alert>
        ) : (
          <ErrorState error={error} onRetry={refetch} />
        )}
      </div>
    );
  }

  const b = ride.booking;
  const tz = b?.timezone;
  const isActive = ride.assignmentStatus === 'ACTIVE' && !notActive;
  const status = b?.status;
  const terminal = !isActive || !status || ['COMPLETED', 'CANCELLED', 'NO_SHOW', 'REJECTED'].includes(status);

  let primary: ReactNode = null;
  if (!terminal) {
    if (status === 'ASSIGNED' && !ride.acknowledgedAt) {
      primary = (
        <div className="space-y-3">
          <Button size="xl" loading={busy} onClick={() => run('acknowledge', 'Assignment acknowledged')} icon={<ThumbsUp className="h-6 w-6" aria-hidden />}>
            Acknowledge assignment
          </Button>
          <Button size="lg" variant="secondary" className="w-full" disabled={busy} onClick={() => setDialog('decline')}>
            Can't take this ride
          </Button>
        </div>
      );
    } else if (status === 'ASSIGNED') {
      primary = (
        <div className="space-y-3">
          <Button size="xl" loading={busy} onClick={() => run('en-route', 'On your way — the passenger has been notified')} icon={<Navigation className="h-6 w-6" aria-hidden />}>
            Start driving to pickup
          </Button>
          <Button size="lg" variant="secondary" className="w-full" disabled={busy} onClick={() => setDialog('decline')}>
            Can't take this ride
          </Button>
        </div>
      );
    } else if (status === 'DRIVER_EN_ROUTE') {
      primary = (
        <Button size="xl" loading={busy} onClick={() => run('arrived', 'Arrival recorded — the passenger has been notified')} icon={<MapPin className="h-6 w-6" aria-hidden />}>
          I have arrived at pickup
        </Button>
      );
    } else if (status === 'ARRIVED') {
      primary = (
        <div className="space-y-3">
          <PinPanel
            ride={ride}
            onStarted={() => {
              refresh();
              refetch();
            }}
            onNotActive={() => {
              setNotActive('This ride is no longer assigned to you.');
              refresh();
            }}
          />
          <Button size="lg" variant="secondary" className="w-full" onClick={() => setDialog('noshow')}>
            Passenger did not show up
          </Button>
        </div>
      );
    } else if (status === 'IN_PROGRESS') {
      primary = (
        <Button size="xl" variant="success" onClick={() => setDialog('complete')} icon={<CheckCircle2 className="h-6 w-6" aria-hidden />}>
          Complete trip
        </Button>
      );
    }
  }

  return (
    <div className="space-y-4">
      {back}

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-mono text-sm text-slate-500">{b?.reference}</p>
            <p className="text-3xl font-semibold text-slate-900">{b?.pickupTime}</p>
            <p className="text-sm text-slate-600">{b ? fmtTravelDate(b.travelDate) : '—'}</p>
          </div>
          <div className="flex flex-col items-end gap-1">
            {ride.assignmentStatus === 'ACTIVE' ? <StatusBadge status={status} /> : <StatusBadge status={ride.assignmentStatus} />}
            {b?.isDelayed && <StatusBadge status="DELAYED" />}
          </div>
        </div>
        <div className="mt-4">
          <Stepper ride={ride} tz={tz} />
        </div>
      </section>

      {notActive && (
        <Alert tone="error" title={notActive}>
          The coordinator may have cancelled or reassigned it.{' '}
          <button className="font-medium underline" onClick={() => navigate('/driver')}>
            Back to my rides
          </button>
        </Alert>
      )}
      {actionError && (
        <div aria-live="assertive">
          <Alert tone="error" title="Action failed">
            {actionError}
          </Alert>
        </div>
      )}
      {b?.isDelayed && isActive && <Alert tone="warn">This ride has been flagged as delayed by the transport team.</Alert>}

      {primary && <div>{primary}</div>}

      {terminal && (
        <Card title="Ride summary">
          {ride.assignmentStatus !== 'ACTIVE' && ride.assignmentStatus !== 'COMPLETED' && (
            <div className="mb-3">
              <Alert tone="info" title={`This ride was ${ride.assignmentStatus.toLowerCase().replace('_', '-')}`}>
                {ride.endReason ?? 'It is no longer assigned to you.'}
              </Alert>
            </div>
          )}
          <DescriptionList
            items={[
              ['Outcome', <StatusBadge key="o" status={ride.assignmentStatus === 'ACTIVE' ? status : ride.assignmentStatus} />],
              ['Acknowledged', ride.acknowledgedAt ? fmtDateTime(ride.acknowledgedAt, tz) : null],
              ['En route', ride.enRouteAt ? fmtDateTime(ride.enRouteAt, tz) : null],
              ['Arrived', ride.arrivedAt ? fmtDateTime(ride.arrivedAt, tz) : null],
              ['Started', ride.startedAt ? fmtDateTime(ride.startedAt, tz) : null],
              ['Completed', ride.completedAt ? fmtDateTime(ride.completedAt, tz) : null],
            ]}
          />
        </Card>
      )}

      <Card title="Ride details">
        <DescriptionList
          items={[
            ['Pickup', <span key="p" className="text-base">{b?.pickupLocation}</span>],
            ['Destination', <span key="d" className="text-base">{b?.dropLocation}</span>],
            ['Passengers', b?.passengers],
            [
              'Passenger',
              ride.employee ? (
                <span key="e">
                  {ride.employee.name}
                  {ride.employee.phone && isActive && (
                    <a href={`tel:${ride.employee.phone}`} className="mt-1 flex min-h-11 items-center gap-1.5 text-base font-medium text-indigo-700 underline">
                      <Phone className="h-4 w-4" aria-hidden /> {ride.employee.phone}
                    </a>
                  )}
                </span>
              ) : null,
            ],
            ['Vehicle', ride.vehicle?.registrationNumber ? `${ride.vehicle.registrationNumber}${ride.vehicle.model ? ` · ${ride.vehicle.model}` : ''}` : null],
            ['Passenger notes', b?.notes || null],
          ]}
          columns={1}
        />
      </Card>

      <Card title="My notes">
        <Textarea
          label="Notes about this ride (visible to the transport team)"
          maxLength={1000}
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            setNoteDirty(true);
          }}
        />
        <div className="mt-2 flex justify-end">
          <Button variant="secondary" onClick={saveNote} loading={noteBusy} disabled={!noteDirty}>
            Save note
          </Button>
        </div>
      </Card>

      <ConfirmDialog
        open={dialog === 'decline'}
        onClose={() => setDialog(null)}
        onConfirm={(reason) => confirmAction('decline', 'Ride declined — the coordinator will reassign it', { reason }).then(() => navigate('/driver'))}
        title="Can't take this ride?"
        message="The ride goes back to the transport coordinator, who will reassign it to another driver. Please tell them why."
        confirmLabel="Decline ride"
        reasonLabel="Reason"
      />
      <ConfirmDialog
        open={dialog === 'noshow'}
        onClose={() => setDialog(null)}
        onConfirm={(reason) => confirmAction('no-show', 'Ride closed as no-show', { reason }).then(() => refetch())}
        title="Passenger did not show up?"
        message="Only do this after waiting at the pickup point and trying to call the passenger. The coordinator will be informed."
        confirmLabel="Mark as no-show"
        reasonLabel="What happened?"
      />
      <ConfirmDialog
        open={dialog === 'complete'}
        onClose={() => setDialog(null)}
        onConfirm={(notes) => confirmAction('complete', 'Trip completed', notes ? { notes } : {}).then(() => refetch())}
        title="Complete this trip?"
        message="Confirm the passenger has been dropped at the destination."
        confirmLabel="Complete trip"
        tone="primary"
        reasonLabel="Trip notes (optional)"
        reasonMinLength={0}
      />
    </div>
  );
}
