import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, KeyRound, MapPin, Navigation, PlayCircle } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, Button, Card, DescriptionList, ErrorState, Modal, Select, Spinner, StatusBadge, Textarea, cn, useToast } from '../../components/ui';
import { ApiError, errorMessage, get, post } from '../../lib/api';
import { useUnsavedChanges } from '../../lib/unsaved';
import { fmt12h, fmtDateTime, fmtTravelDate, mapsDirectionsUrl } from '../../lib/format';

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
  employee: { name?: string } | null;
  pin: { status: string; attemptsRemaining: number } | null;
  driverNotes?: string;
};

type PinMsg = { tone: 'error' | 'warn' | 'success'; title: string; text: string } | null;

function PinPanel({ ride, onStarted, onNotActive }: { ride: Ride; onStarted: () => void; onNotActive: (msg: string) => void }) {
  const [typed, setPin] = useState('');
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

  const submit = async (e?: FormEvent, pin = typed) => {
    e?.preventDefault();
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
    <section className="rounded-xl border-2 border-violet-300 bg-violet-50 p-5 text-center" aria-labelledby="pin-heading">
      <KeyRound className="mx-auto h-8 w-8 text-violet-600" aria-hidden />
      <h2 id="pin-heading" className="mt-2 text-xl font-semibold text-slate-900">
        Enter the passenger&apos;s PIN
      </h2>
      <p className="mt-1 text-sm text-slate-700">Ask the passenger for their 4-digit PIN once they are in the cab.</p>
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
        <form onSubmit={submit} className="mt-4 space-y-3">
          <label htmlFor="ride-pin" className="sr-only">
            Passenger PIN
          </label>
          {/* One real input under four digit boxes: tapping anywhere opens the number pad. */}
          <div className="relative mx-auto flex w-fit gap-3" onClick={() => inputRef.current?.focus()}>
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                className={cn(
                  'flex h-16 w-14 items-center justify-center rounded-xl border-2 bg-white font-mono text-3xl font-semibold text-slate-900',
                  i === typed.length && !busy ? 'border-violet-500 ring-2 ring-violet-200' : typed[i] ? 'border-violet-300' : 'border-slate-300',
                )}
                aria-hidden
              >
                {typed[i] ?? ''}
              </span>
            ))}
            <input
              ref={inputRef}
              id="ride-pin"
              name="pin"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              pattern="[0-9]*"
              maxLength={4}
              value={typed}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, '').slice(0, 4);
                setPin(v);
                if (v.length === 4) void submit(undefined, v);
              }}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              aria-describedby="pin-attempts"
              disabled={busy}
            />
          </div>
          <p id="pin-attempts" className="min-h-5 text-sm text-slate-600">
            {remaining !== null ? `${remaining} attempt${remaining === 1 ? '' : 's'} left` : ''}
          </p>
          <Button type="submit" size="xl" variant="success" loading={busy} disabled={busy || typed.length < 4} icon={<PlayCircle className="h-6 w-6" aria-hidden />}>
            Verify PIN &amp; start ride
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
  const [dialog, setDialog] = useState<'cancel' | null>(null);
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

  /** Complete in one tap, then back to the driver's dashboard. */
  const complete = async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await post(`/driver/rides/${id}/complete`, {});
      toast.success('Trip completed');
      refresh();
      navigate('/driver');
    } catch (err) {
      handleError(err);
      setBusy(false);
    }
  };

  /** For the cancel dialog: rethrow so it shows the message inline. */
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

  const saveNote = async (): Promise<boolean> => {
    setNoteBusy(true);
    try {
      await post(`/driver/rides/${id}/notes`, { note: note.trim() });
      toast.success('Note saved');
      setNoteDirty(false);
      refresh();
      return true;
    } catch (err) {
      toast.error('Could not save note', errorMessage(err));
      return false;
    } finally {
      setNoteBusy(false);
    }
  };
  useUnsavedChanges(noteDirty && note.trim() !== (ride?.driverNotes ?? ''), saveNote);

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

  // Drivers may cancel only because of the employee (not coming, didn't show up, other); for their
  // own reasons they call the coordinator, who changes the cab.
  const cancelButton = (
    <div className="space-y-1 text-center">
      <Button size="lg" variant="secondary" className="w-full" disabled={busy} onClick={() => setDialog('cancel')}>
        Cancel ride
      </Button>
      <p className="text-xs text-slate-500">Only if the passenger isn&apos;t coming. Can&apos;t make it yourself? Call your transport coordinator.</p>
    </div>
  );

  const navigateTo = (place: string, label: string) => (
    <a
      href={mapsDirectionsUrl(place)}
      target="_blank"
      rel="noopener noreferrer"
      className="flex h-14 w-full items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white text-lg font-semibold text-indigo-700 shadow-xs active:bg-slate-50"
    >
      <MapPin className="h-5 w-5" aria-hidden />
      {label}
    </a>
  );

  // One step at a time: start the trip → (navigate, arrived) → PIN → (navigate to drop, complete).
  let primary: ReactNode = null;
  if (!terminal && b) {
    if (status === 'ASSIGNED') {
      primary = (
        <div className="space-y-3">
          <Button size="xl" loading={busy} onClick={() => run('en-route', 'Trip started — the passenger has been notified')} icon={<Navigation className="h-6 w-6" aria-hidden />}>
            Start the trip
          </Button>
          {cancelButton}
        </div>
      );
    } else if (status === 'DRIVER_EN_ROUTE') {
      primary = (
        <div className="space-y-3">
          {navigateTo(b.pickupLocation, 'Navigate to pickup')}
          <Button size="xl" loading={busy} onClick={() => run('arrived', 'Arrival recorded — the passenger has been notified')} icon={<MapPin className="h-6 w-6" aria-hidden />}>
            I have arrived
          </Button>
          {cancelButton}
        </div>
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
          {cancelButton}
        </div>
      );
    } else if (status === 'IN_PROGRESS') {
      primary = (
        <div className="space-y-3">
          {navigateTo(b.dropLocation, 'Navigate to drop')}
          <Button size="xl" variant="success" loading={busy} onClick={complete} icon={<CheckCircle2 className="h-6 w-6" aria-hidden />}>
            Complete trip
          </Button>
        </div>
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
            <p className="text-3xl font-semibold text-slate-900">{fmt12h(b?.pickupTime)}</p>
            <p className="text-sm text-slate-600">{b ? fmtTravelDate(b.travelDate) : '—'}</p>
          </div>
          <div className="flex flex-col items-end gap-1">
            {ride.assignmentStatus === 'ACTIVE' ? <StatusBadge status={status} /> : <StatusBadge status={ride.assignmentStatus} />}
            {b?.isDelayed && <StatusBadge status="DELAYED" />}
          </div>
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
              ride.employee?.name ?? null,
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

      <DriverCancelDialog
        open={dialog === 'cancel'}
        arrived={status === 'ARRIVED'}
        onClose={() => setDialog(null)}
        onConfirm={(reason, note) =>
          confirmAction('cancel', reason === 'NO_SHOW' ? 'Ride closed as no-show' : 'Ride cancelled — the coordinator is informed', { reason, ...(note ? { note } : {}) }).then(() => refetch())
        }
      />
    </div>
  );
}

type DriverCancelReason = 'NOT_COMING' | 'NO_SHOW' | 'OTHER';

/**
 * Driver cancels because of the passenger. "Didn't show up" is only offered at the pickup (after
 * "Arrived") and is recorded as a no-show; "Other" needs a reason. The coordinator is informed.
 */
function DriverCancelDialog({ open, arrived, onClose, onConfirm }: { open: boolean; arrived: boolean; onClose: () => void; onConfirm: (reason: DriverCancelReason, note: string) => Promise<unknown> }) {
  const [reason, setReason] = useState<DriverCancelReason | ''>('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setReason('');
      setNote('');
      setError('');
    }
  }, [open]);
  // Saving here would mean cancelling the ride, so a chosen reason can only be kept or discarded.
  const guard = useUnsavedChanges(open && (!!reason || !!note.trim()));
  const close = () => guard(onClose);
  const submit = async () => {
    if (!reason) return setError('Choose a reason');
    if (reason === 'OTHER' && note.trim().length < 3) return setError('Say why the ride is cancelled');
    setBusy(true);
    setError('');
    try {
      await onConfirm(reason, note.trim());
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : close}
      title="Cancel this ride?"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            Keep ride
          </Button>
          <Button variant="danger" onClick={submit} loading={busy} disabled={!reason}>
            Cancel ride
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Select label="Reason" required value={reason} onChange={(e) => setReason(e.target.value as DriverCancelReason)}>
          <option value="">Choose a reason…</option>
          <option value="NOT_COMING">Passenger said they&apos;re not coming</option>
          {arrived && <option value="NO_SHOW">Passenger didn&apos;t show up</option>}
          <option value="OTHER">Other</option>
        </Select>
        {!arrived && <p className="text-xs text-slate-500">&quot;Passenger didn&apos;t show up&quot; is available once you tap &quot;I have arrived at pickup&quot;.</p>}
        <Textarea
          label={reason === 'OTHER' ? 'What happened?' : 'Details (optional)'}
          required={reason === 'OTHER'}
          maxLength={300}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <p className="text-xs text-slate-500">The passenger and the transport coordinator are informed.</p>
        {error && <Alert tone="error">{error}</Alert>}
      </div>
    </Modal>
  );
}
