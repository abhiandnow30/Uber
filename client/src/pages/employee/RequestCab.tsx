import { useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, Card, ErrorState, Input, PageHeader, Select, Spinner, Textarea, useToast } from '../../components/ui';
import { ApiError, errorMessage, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { addDaysISO, fmtTravelDate, todayISO, uuid } from '../../lib/format';
import { fieldErrors } from '../../lib/hooks';
import { cabFor, DIRECTION_LABEL, fmt12h, usePolicy } from '../../lib/policy';

type Form = {
  travelDate: string;
  pickupTime: string;
  pickupLocation: string;
  dropLocation: string;
  passengers: string;
  shift: string;
  tripType: 'ONE_WAY' | 'ROUND_TRIP';
  returnPickupTime: string;
  notes: string;
};

type CreateResult = { booking: { _id: string; reference: string; status: string }; legs?: Array<{ _id: string; reference: string }>; duplicate: boolean };

const FIELD_FOR_CODE: Record<string, keyof Form> = { PASSENGER_LIMIT: 'passengers', BOOKING_WINDOW: 'travelDate', BOOKING_CUTOFF: 'shift', OUTSIDE_CAB_HOURS: 'shift' };

function minutesLabel(m: number) {
  if (m < 60) return `${m} minutes`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return `${h} hour${h === 1 ? '' : 's'}${r ? ` ${r} min` : ''}`;
}

export default function RequestCab() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const policyQ = usePolicy();
  const policy = policyQ.data;

  // One idempotency key per form instance: retries / double-clicks resolve to the same booking.
  const requestId = useRef(uuid());
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [formError, setFormError] = useState<{ title: string; message: string } | null>(null);

  const myOffice = (me?.profile?.officeLocation as string | undefined) ?? '';
  const activeOffices = useMemo(() => policy?.officeLocations.filter((o) => o.active) ?? [], [policy]);
  const activeShifts = useMemo(() => policy?.shifts.filter((s) => s.active) ?? [], [policy]);

  const [form, setForm] = useState<Form>({
    travelDate: '',
    pickupTime: '',
    pickupLocation: '',
    dropLocation: '',
    passengers: '1',
    shift: '',
    tripType: 'ONE_WAY',
    returnPickupTime: '',
    notes: '',
  });

  // Cabs are always booked for the employee's own office (that office's coordinators assign them).
  const office = activeOffices.find((o) => o.code === myOffice);
  const tz = office?.timezone ?? 'Asia/Kolkata';
  const today = todayISO(tz);
  const maxDate = policy ? addDaysISO(today, policy.booking.maxDaysAhead) : undefined;
  const travelDate = form.travelDate || today;
  // With shift hours configured, the cab time comes from the shift (and may be the next day).
  const selectedShift = activeShifts.find((s) => s.code === form.shift);
  const cab = cabFor(selectedShift, travelDate);
  const shiftRequired = !!policy?.booking.requireShift;
  const cabDate = cab?.date ?? travelDate;
  const cabTime = cab?.time ?? form.pickupTime;

  // Saved home address + office address let us fill the route automatically.
  const homeText = (() => {
    const p = (me?.profile ?? {}) as { homeAddress?: string };
    return p.homeAddress ?? '';
  })();
  const officeText = office ? `${office.name}${office.address ? `, ${office.address}` : ''}` : '';
  const fillRoute = (direction: 'TO_OFFICE' | 'FROM_OFFICE') => {
    if (!homeText || !officeText) return;
    setForm((f) => ({
      ...f,
      pickupLocation: direction === 'TO_OFFICE' ? homeText : officeText,
      dropLocation: direction === 'TO_OFFICE' ? officeText : homeText,
    }));
    setErrors((e) => ({ ...e, pickupLocation: undefined, dropLocation: undefined }));
  };
  const prefilled = useRef(false);
  useEffect(() => {
    // First visit: home -> office by default (only if the employee has not typed anything).
    if (prefilled.current || !homeText || !officeText) return;
    prefilled.current = true;
    setForm((f) => (f.pickupLocation || f.dropLocation ? f : { ...f, pickupLocation: homeText, dropLocation: officeText }));
  }, [homeText, officeText]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const onShift = (code: string) => {
    const s = activeShifts.find((x) => x.code === code);
    setForm((f) => ({ ...f, shift: code, pickupTime: !f.pickupTime && s?.defaultPickupTime ? s.defaultPickupTime : f.pickupTime }));
    // Shifts know their direction: evening shifts go office -> home.
    if (s?.direction === 'TO_OFFICE' || s?.direction === 'FROM_OFFICE') fillRoute(s.direction);
  };

  const validate = (): Partial<Record<keyof Form, string>> => {
    const e: Partial<Record<keyof Form, string>> = {};
    if (!policy) return e;
    const rules = policy.booking;
    if (!travelDate) e.travelDate = 'Choose a travel date';
    else if (travelDate < today) e.travelDate = 'Travel date cannot be in the past';
    else if (maxDate && travelDate > maxDate) e.travelDate = `You can book at most ${rules.maxDaysAhead} days ahead`;
    if (shiftRequired && !form.shift) e.shift = 'Select your shift';
    if (!cab && !/^\d{2}:\d{2}$/.test(form.pickupTime)) e.pickupTime = 'Choose a pickup time';
    else if (!e.travelDate && !e.shift) {
      const scheduled = DateTime.fromISO(`${cabDate}T${cabTime}`, { zone: tz });
      const now = DateTime.now().setZone(tz);
      const tooSoon = `The cab must be booked at least ${minutesLabel(rules.minLeadMinutes)} before it leaves`;
      if (scheduled < now.plus({ minutes: rules.minLeadMinutes })) {
        if (cab) e.shift = tooSoon;
        else e.pickupTime = tooSoon;
      } else if (rules.dailyCutoffTime) {
        const cutoff = DateTime.fromISO(`${cabDate}T${rules.dailyCutoffTime}`, { zone: tz }).minus({ days: 1 });
        if (now > cutoff) e.travelDate = `Bookings for this date closed at ${rules.dailyCutoffTime} the previous day`;
      }
    }
    if (form.pickupLocation.trim().length < 3) e.pickupLocation = 'Enter the pickup location';
    if (form.dropLocation.trim().length < 3) e.dropLocation = 'Enter the drop-off location';
    if (!e.pickupLocation && !e.dropLocation && form.pickupLocation.trim().toLowerCase() === form.dropLocation.trim().toLowerCase()) e.dropLocation = 'Pickup and drop-off must differ';
    const n = Number(form.passengers);
    if (!Number.isInteger(n) || n < 1 || n > rules.maxPassengers) e.passengers = `Between 1 and ${rules.maxPassengers} passengers`;
    if (form.tripType === 'ROUND_TRIP') {
      if (!/^\d{2}:\d{2}$/.test(form.returnPickupTime)) e.returnPickupTime = 'Choose a return pickup time';
      else if (form.pickupTime && form.returnPickupTime <= form.pickupTime) e.returnPickupTime = 'Must be later than the outbound pickup time';
    }
    return e;
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (submitting) return;
    setFormError(null);
    const v = validate();
    setErrors(v);
    if (Object.values(v).some(Boolean)) return;
    if (!office) {
      setFormError({ title: 'Your office is not accepting cab requests', message: 'Please contact your administrator.' });
      return;
    }
    setSubmitting(true);
    try {
      const res = await post<CreateResult>('/me/bookings', {
        travelDate,
        ...(cab ? {} : { pickupTime: form.pickupTime }),
        pickupLocation: form.pickupLocation.trim(),
        dropLocation: form.dropLocation.trim(),
        passengers: Number(form.passengers),
        tripType: form.tripType,
        ...(form.tripType === 'ROUND_TRIP' ? { returnPickupTime: form.returnPickupTime } : {}),
        shift: form.shift || undefined,
        officeLocation: myOffice,
        notes: form.notes.trim(),
        clientRequestId: requestId.current,
      });
      requestId.current = uuid();
      qc.invalidateQueries({ queryKey: ['my-bookings'] });
      qc.invalidateQueries({ queryKey: ['employee-home'] });
      const awaiting = res.booking.status === 'PENDING_APPROVAL';
      const legs = res.legs && res.legs.length > 1 ? ` (${res.legs.map((l) => l.reference).join(' & ')})` : '';
      toast.success(
        res.duplicate ? 'Booking already submitted' : `Cab requested · ${res.booking.reference}${legs}`,
        awaiting ? 'Your request is awaiting approval. You will be notified once it is approved and a cab is assigned.' : 'You will be notified when a cab and driver are assigned.',
      );
      navigate(`/employee/bookings/${res.booking._id}`);
    } catch (err) {
      const fields = fieldErrors(err) as Partial<Record<keyof Form, string>>;
      if (err instanceof ApiError) {
        const target = FIELD_FOR_CODE[err.code];
        if (target) fields[target] = err.message;
        const titles: Record<string, string> = {
          BOOKING_CUTOFF: 'Booking window closed',
          BOOKING_WINDOW: 'Too far in advance',
          DUPLICATE_BOOKING: 'You already have a booking at this time',
          PASSENGER_LIMIT: 'Too many passengers',
        };
        setFormError({ title: titles[err.code] ?? 'Could not submit your request', message: err.message });
      } else {
        setFormError({ title: 'Could not submit your request', message: errorMessage(err) });
      }
      setErrors(fields);
    } finally {
      setSubmitting(false);
    }
  };

  if (policyQ.isLoading) return <Spinner />;
  if (policyQ.error || !policy) return <ErrorState error={policyQ.error} onRetry={policyQ.refetch} />;
  const rules = policy.booking;

  return (
    <>
      <PageHeader title="Request a cab" subtitle={<Link to="/employee" className="text-indigo-700 hover:underline">← Back to home</Link>} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <form onSubmit={submit} noValidate className="space-y-4">
            {formError && (
              <Alert tone="error" title={formError.title}>
                {formError.message}
              </Alert>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Select label="Your shift" required={shiftRequired} value={form.shift} onChange={(e) => onShift(e.target.value)} error={errors.shift}>
                <option value="">{shiftRequired ? 'Select your shift…' : 'No shift'}</option>
                {activeShifts.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name}
                    {s.startTime && s.defaultPickupTime ? ` · cab ${fmt12h(s.defaultPickupTime)}` : s.defaultPickupTime ? ` · ${s.defaultPickupTime}` : ''}
                  </option>
                ))}
              </Select>
              <Input
                label={cab || shiftRequired ? 'Shift date' : 'Travel date'}
                type="date"
                required
                min={today}
                max={maxDate}
                value={travelDate}
                onChange={(e) => set('travelDate', e.target.value)}
                error={errors.travelDate}
                hint={travelDate ? fmtTravelDate(travelDate) : undefined}
              />
            </div>
            {cab ? (
              <Alert tone="info" title={`Cab at ${fmt12h(cab.time)} on ${fmtTravelDate(cab.date)}`}>
                {DIRECTION_LABEL[selectedShift?.direction ?? ''] ?? ''}
                {cab.nextDay ? ' · the day after your shift starts' : ''}
              </Alert>
            ) : shiftRequired ? (
              <p className="text-sm text-slate-500">Select your shift to see when the cab will come.</p>
            ) : (
              <Input label="Pickup time" type="time" required value={form.pickupTime} onChange={(e) => set('pickupTime', e.target.value)} error={errors.pickupTime} hint={`Local time (${tz})`} />
            )}
            {homeText ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-slate-500">Quick fill:</span>
                <Button size="sm" variant="secondary" onClick={() => fillRoute('TO_OFFICE')}>
                  Home → Office
                </Button>
                <Button size="sm" variant="secondary" onClick={() => fillRoute('FROM_OFFICE')}>
                  Office → Home
                </Button>
              </div>
            ) : (
              <p className="text-sm text-slate-500">
                Tip: <Link to="/account" className="font-medium text-indigo-600 hover:underline">save your present address</Link> to fill these in automatically.
              </p>
            )}
            <Input label="Pickup location" required maxLength={300} autoComplete="street-address" value={form.pickupLocation} onChange={(e) => set('pickupLocation', e.target.value)} error={errors.pickupLocation} placeholder="e.g. Present address or landmark" />
            <Input label="Drop-off location" required maxLength={300} value={form.dropLocation} onChange={(e) => set('dropLocation', e.target.value)} error={errors.dropLocation} placeholder="e.g. Office main gate" />
            <p className="text-sm text-slate-600">
              Office: <span className="font-medium text-slate-900">{office ? `${office.name} (${office.code})` : myOffice || '—'}</span>
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Passengers"
                type="number"
                inputMode="numeric"
                required
                min={1}
                max={rules.maxPassengers}
                value={form.passengers}
                onChange={(e) => set('passengers', e.target.value)}
                error={errors.passengers}
                hint={`Up to ${rules.maxPassengers}`}
              />
              <Select label="Trip type" value={form.tripType} onChange={(e) => set('tripType', e.target.value as Form['tripType'])} error={errors.tripType}>
                <option value="ONE_WAY">One way</option>
                {rules.allowRoundTrip && <option value="ROUND_TRIP">Round trip (same day)</option>}
              </Select>
            </div>
            {form.tripType === 'ROUND_TRIP' && (
              <Input
                label="Return pickup time"
                type="time"
                required
                value={form.returnPickupTime}
                onChange={(e) => set('returnPickupTime', e.target.value)}
                error={errors.returnPickupTime}
                hint="The return leg picks you up at the drop-off location"
              />
            )}
            <Textarea label="Notes for the transport team (optional)" maxLength={500} value={form.notes} onChange={(e) => set('notes', e.target.value)} error={errors.notes} />
            <div className="flex flex-wrap gap-2 pt-2">
              <Button type="submit" size="lg" loading={submitting} disabled={submitting}>
                Submit request
              </Button>
              <Button variant="ghost" size="lg" onClick={() => navigate('/employee')} disabled={submitting}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
        <div className="space-y-4">
          <Alert tone="info" title="Booking rules">
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {rules.cabWindowStart && rules.cabWindowEnd && (
                <li>
                  Cabs run only between {fmt12h(rules.cabWindowStart)} and {fmt12h(rules.cabWindowEnd)}, one way.
                </li>
              )}
              <li>Book at least {minutesLabel(rules.minLeadMinutes)} before the cab leaves.</li>
              {rules.dailyCutoffTime && <li>Bookings for a day close at {rules.dailyCutoffTime} on the previous day.</li>}
              <li>You can book up to {rules.maxDaysAhead} days in advance.</li>
              <li>You can cancel yourself until a cab is assigned; after that, send a cancellation request from the booking and the transport team will decide.</li>
              <li>{rules.approvalRequired ? 'Requests need approval before a cab is assigned.' : 'No approval needed — requests go straight to the transport team.'}</li>
              <li>Maximum {rules.maxPassengers} passengers per booking.</li>
            </ul>
          </Alert>
        </div>
      </div>
    </>
  );
}
