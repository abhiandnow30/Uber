import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, ErrorState, Input, PageHeader, Select, Spinner, cn, useToast } from '../../components/ui';
import { ApiError, errorMessage, get, patch, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { addDaysISO, fmtTravelDate, todayISO, uuid } from '../../lib/format';
import { fieldErrors } from '../../lib/hooks';
import { changed, useUnsavedChanges } from '../../lib/unsaved';
import { addMinutesHHmm, cabForShift, fmt12h, IN_LEAD_MINUTES, usePolicy } from '../../lib/policy';

type Form = {
  travelDate: string;
  shift: string;
  // The shift's times for this day; prefilled from the shift and editable (e.g. 10 PM - 7 AM instead of 9 PM - 6 AM).
  shiftStart: string;
  shiftEnd: string;
  // Only asked when the times allow both an IN and an OUT cab.
  direction: '' | 'IN' | 'OUT';
  // Only for shifts without hours.
  pickupTime: string;
};

type CreateResult = { booking: { _id: string; reference: string; status: string }; legs?: Array<{ _id: string; reference: string }>; duplicate: boolean };

const FIELD_FOR_CODE: Record<string, keyof Form> = { BOOKING_WINDOW: 'travelDate', BOOKING_CUTOFF: 'shift', OUTSIDE_CAB_HOURS: 'shift', NO_CAB_FOR_SHIFT: 'shiftStart' };

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

  const [form, setForm] = useState<Form>({ travelDate: '', shift: '', shiftStart: '', shiftEnd: '', direction: '', pickupTime: '' });

  // Cabs are always booked for the employee's own office (that office's coordinators assign them).
  const office = activeOffices.find((o) => o.code === myOffice);
  const tz = office?.timezone ?? 'Asia/Kolkata';
  const today = todayISO(tz);
  const maxDate = policy ? addDaysISO(today, policy.booking.maxDaysAhead) : undefined;
  const travelDate = form.travelDate || today;
  const selectedShift = activeShifts.find((s) => s.code === form.shift);
  const hasHours = !!(selectedShift?.startTime && selectedShift.endTime);
  const shiftRequired = !!policy?.booking.requireShift;
  const winStart = policy?.booking.cabWindowStart;
  const winEnd = policy?.booking.cabWindowEnd;

  // Which cab these shift times get (same rule as the server):
  //  IN  = home → office: reach the office by the shift start; the transport team sets the pickup.
  //  OUT = office → home: the cab leaves the office when the shift ends.
  const timesOk = /^\d{2}:\d{2}$/.test(form.shiftStart) && /^\d{2}:\d{2}$/.test(form.shiftEnd) && form.shiftStart !== form.shiftEnd;
  const can = hasHours && timesOk ? cabForShift(form.shiftStart, form.shiftEnd, winStart, winEnd) : null;
  const both = !!can?.in && !!can?.out;
  const direction: 'IN' | 'OUT' | null = !can ? null : both ? form.direction || (selectedShift?.direction === 'FROM_OFFICE' ? 'OUT' : 'IN') : can.in ? 'IN' : can.out ? 'OUT' : null;
  const cab =
    direction === 'IN'
      ? { date: travelDate, time: form.shiftStart }
      : direction === 'OUT'
        ? { date: form.shiftEnd < form.shiftStart ? addDaysISO(travelDate, 1) : travelDate, time: form.shiftEnd }
        : null;

  // The route isn't asked: the server uses the saved home address and the office, and the transport team plans the cab route.
  const homeText = ((me?.profile ?? {}) as { homeAddress?: string }).homeAddress ?? '';
  // The home's exact spot (from its Google Maps link) is required before requesting a cab.
  const hasHomePin = !!((me?.profile ?? {}) as { homeLocation?: unknown }).homeLocation;
  const officeText = office ? `${office.name}${office.address ? `, ${office.address}` : ''}` : myOffice;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const onShift = (code: string) => {
    const s = activeShifts.find((x) => x.code === code);
    setForm((f) => ({ ...f, shift: code, shiftStart: s?.startTime ?? '', shiftEnd: s?.endTime ?? '', direction: '', pickupTime: s?.defaultPickupTime ?? f.pickupTime }));
    setErrors((e) => ({ ...e, shift: undefined, shiftStart: undefined, shiftEnd: undefined, pickupTime: undefined }));
  };
  const usualTimes = !!selectedShift && form.shiftStart === selectedShift.startTime && form.shiftEnd === selectedShift.endTime;

  // Changing an existing ride (?edit=<id>, only while no cab is assigned): the form starts from it.
  const [params] = useSearchParams();
  const editId = params.get('edit') ?? '';
  const editing = useQuery({
    queryKey: ['my-bookings', 'detail', editId],
    queryFn: () => get<{ _id: string; reference: string; canEdit: boolean; shift?: string; shiftDate?: string; travelDate: string; shiftStart?: string; shiftEnd?: string; direction?: 'IN' | 'OUT'; pickupTime: string }>(`/me/bookings/${editId}`),
    enabled: !!editId,
  });
  const ride = editing.data;

  // The shift saved on the employee's account is pre-selected; changing it here does not change the account.
  const savedShift = (me?.profile as { defaultShift?: string } | undefined)?.defaultShift ?? '';
  const prefilled = useRef(false);
  // What the form showed once filled in, to tell whether the person has changed anything.
  const [start, setStart] = useState<Form | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready && !start) setStart(form);
  }, [ready, start, form]);
  useEffect(() => {
    if (prefilled.current || !policy || (editId && !ride)) return;
    prefilled.current = true;
    setReady(true);
    if (ride) {
      setForm({
        travelDate: ride.shiftDate ?? ride.travelDate,
        shift: ride.shift ?? '',
        shiftStart: ride.shiftStart ?? '',
        shiftEnd: ride.shiftEnd ?? '',
        direction: ride.direction ?? '',
        pickupTime: ride.pickupTime,
      });
      return;
    }
    if (activeShifts.some((s) => s.code === savedShift)) onShift(savedShift);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policy, savedShift, ride, editId]);

  const validate = (): Partial<Record<keyof Form, string>> => {
    const e: Partial<Record<keyof Form, string>> = {};
    if (!policy) return e;
    const rules = policy.booking;
    if (!travelDate) e.travelDate = 'Choose a date';
    else if (travelDate < today) e.travelDate = 'The date cannot be in the past';
    else if (maxDate && travelDate > maxDate) e.travelDate = `You can book at most ${rules.maxDaysAhead} days ahead`;
    if (shiftRequired && !form.shift) e.shift = 'Select your shift';
    if (hasHours) {
      if (!/^\d{2}:\d{2}$/.test(form.shiftStart)) e.shiftStart = 'Enter when your shift starts';
      if (!/^\d{2}:\d{2}$/.test(form.shiftEnd)) e.shiftEnd = 'Enter when your shift ends';
      else if (form.shiftStart === form.shiftEnd) e.shiftEnd = 'Must differ from the start';
      else if (!direction) e.shiftStart = 'No cab for these hours';
    } else if (!/^\d{2}:\d{2}$/.test(form.pickupTime)) e.pickupTime = 'Choose a pickup time';
    const at = cab ?? (!hasHours && form.pickupTime ? { date: travelDate, time: form.pickupTime } : null);
    if (at && !e.travelDate && !e.shift) {
      const scheduled = DateTime.fromISO(`${at.date}T${at.time}`, { zone: tz });
      const now = DateTime.now().setZone(tz);
      if (scheduled < now.plus({ minutes: rules.minLeadMinutes })) e.travelDate = `Book at least ${minutesLabel(rules.minLeadMinutes)} before the cab — choose a later date`;
      else if (rules.dailyCutoffTime) {
        const cutoff = DateTime.fromISO(`${at.date}T${rules.dailyCutoffTime}`, { zone: tz }).minus({ days: 1 });
        if (now > cutoff) e.travelDate = `Bookings for this date closed at ${fmt12h(rules.dailyCutoffTime)} the previous day`;
      }
    }
    return e;
  };

  /** Sends the request (or the change). `stay`: don't open the ride afterwards (saving on the way elsewhere). */
  const save = async (stay = false): Promise<boolean> => {
    if (submitting) return false;
    setFormError(null);
    const v = validate();
    setErrors(v);
    if (Object.values(v).some(Boolean)) return false;
    if (!office) {
      setFormError({ title: 'Your office is not accepting cab requests', message: 'Please contact your administrator.' });
      return false;
    }
    if (!homeText || !hasHomePin) {
      setFormError({ title: !homeText ? 'Add your present address first' : 'Add your home’s Google Maps link first', message: 'Add it under Account, so the transport team and your driver find you exactly.' });
      return false;
    }
    setSubmitting(true);
    const details = {
      travelDate,
      shift: form.shift || undefined,
      ...(hasHours ? { shiftStart: form.shiftStart, shiftEnd: form.shiftEnd, ...(both && direction ? { direction } : {}) } : { pickupTime: form.pickupTime }),
      officeLocation: myOffice,
    };
    try {
      if (ride) {
        await patch(`/me/bookings/${ride._id}`, details);
        qc.invalidateQueries({ queryKey: ['my-bookings'] });
        qc.invalidateQueries({ queryKey: ['employee-home'] });
        toast.success(`Ride updated · ${ride.reference}`, 'The transport team is told about the change.');
        guard.release();
        if (!stay) navigate(`/employee/bookings/${ride._id}`);
        return true;
      }
      const res = await post<CreateResult>('/me/bookings', { ...details, clientRequestId: requestId.current });
      requestId.current = uuid();
      qc.invalidateQueries({ queryKey: ['my-bookings'] });
      qc.invalidateQueries({ queryKey: ['employee-home'] });
      const awaiting = res.booking.status === 'PENDING_APPROVAL';
      const legs = res.legs && res.legs.length > 1 ? ` (${res.legs.map((l) => l.reference).join(' & ')})` : '';
      toast.success(
        res.duplicate ? 'Booking already submitted' : `Cab requested · ${res.booking.reference}${legs}`,
        awaiting
          ? 'Your request is awaiting approval. You will be notified once it is approved and a cab is assigned.'
          : direction === 'IN'
            ? 'You will be told your pickup time when a cab and driver are assigned.'
            : 'You will be notified when a cab and driver are assigned.',
      );
      guard.release();
      if (!stay) navigate(`/employee/bookings/${res.booking._id}`);
      return true;
    } catch (err) {
      const fields = fieldErrors(err) as Partial<Record<keyof Form, string>>;
      if (err instanceof ApiError) {
        const target = FIELD_FOR_CODE[err.code];
        if (target) fields[target] = err.message;
        const titles: Record<string, string> = {
          BOOKING_CUTOFF: 'Booking window closed',
          BOOKING_WINDOW: 'Too far in advance',
          DUPLICATE_BOOKING: 'You already have a booking at this time',
          SHIFT_DAY_BOOKED: 'Already booked for this shift day',
          OUTSIDE_CAB_HOURS: 'Outside cab hours',
          NO_CAB_FOR_SHIFT: 'No cab for these shift hours',
        };
        setFormError({ title: titles[err.code] ?? 'Could not submit your request', message: err.message });
      } else {
        setFormError({ title: 'Could not submit your request', message: errorMessage(err) });
      }
      setErrors(fields);
      return false;
    } finally {
      setSubmitting(false);
    }
  };
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    void save();
  };
  const guard = useUnsavedChanges(!!start && changed(form, start), () => save(true));

  if (policyQ.isLoading || (editId && editing.isLoading)) return <Spinner />;
  if (policyQ.error || !policy) return <ErrorState error={policyQ.error} onRetry={policyQ.refetch} />;
  if (editId && (editing.error || !ride)) return <ErrorState error={editing.error ?? new Error('Ride not found')} onRetry={editing.refetch} />;
  if (ride && !ride.canEdit) {
    return (
      <>
        <PageHeader title="Change your ride" subtitle={<Link to={`/employee/bookings/${ride._id}`} className="text-indigo-700 hover:underline">← Back to the ride</Link>} />
        <Alert tone="info" title="This ride can no longer be changed">
          A cab is already assigned. You can cancel it from the ride, or ask the admin.
        </Alert>
      </>
    );
  }
  const rules = policy.booking;
  const inFrom = winStart ? addMinutesHHmm(winStart, IN_LEAD_MINUTES) : '';

  return (
    <>
      <PageHeader
        title={ride ? `Change your ride · ${ride.reference}` : 'Request a cab'}
        subtitle={
          <Link to={ride ? `/employee/bookings/${ride._id}` : '/employee'} className="text-indigo-700 hover:underline">
            {ride ? '← Back to the ride' : '← Back to home'}
          </Link>
        }
      />
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
                  </option>
                ))}
              </Select>
              <Input
                label="Shift date"
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

            {hasHours ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input label="Shift starts" type="time" required value={form.shiftStart} onChange={(e) => set('shiftStart', e.target.value)} error={errors.shiftStart} />
                  <Input
                    label="Shift ends"
                    type="time"
                    required
                    value={form.shiftEnd}
                    onChange={(e) => set('shiftEnd', e.target.value)}
                    error={errors.shiftEnd}
                    hint={usualTimes ? 'Your usual hours — change them if they differ that day' : selectedShift ? `Usual: ${fmt12h(selectedShift.startTime)} – ${fmt12h(selectedShift.endTime)}` : undefined}
                  />
                </div>

                {both && (
                  <div role="radiogroup" aria-label="Cab" className="grid gap-2 sm:grid-cols-2">
                    {(['IN', 'OUT'] as const).map((d) => (
                      <button
                        key={d}
                        type="button"
                        role="radio"
                        aria-checked={direction === d}
                        onClick={() => set('direction', d)}
                        className={cn('rounded-lg border p-3 text-left text-sm', direction === d ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500' : 'border-slate-200 hover:border-slate-400')}
                      >
                        <span className="font-semibold text-slate-900">{d === 'IN' ? 'To the office' : 'Home'}</span>
                        <span className="block text-slate-500">{d === 'IN' ? `Reach by ${fmt12h(form.shiftStart)}` : `Leave at ${fmt12h(form.shiftEnd)}`}</span>
                      </button>
                    ))}
                  </div>
                )}

                {direction && cab ? (
                  <Alert tone="info" title={direction === 'IN' ? `IN · reach the office by ${fmt12h(cab.time)} on ${fmtTravelDate(cab.date)}` : `OUT · cab leaves the office at ${fmt12h(cab.time)} on ${fmtTravelDate(cab.date)}`}>
                    {direction === 'IN'
                      ? 'Home → Office. The transport team sets your pickup time and tells you when your cab is assigned.'
                      : `Office → Home, when your shift ends${cab.date !== travelDate ? ' (the morning after your shift starts)' : ''}.`}
                  </Alert>
                ) : timesOk ? (
                  <Alert tone="warn" title="No cab for these shift hours">
                    Cabs take you to the office for shifts starting {fmt12h(inFrom)} – {fmt12h(winEnd)}, or home for shifts ending {fmt12h(winStart)} – before {fmt12h(winEnd)}.
                  </Alert>
                ) : null}
              </>
            ) : selectedShift || !shiftRequired ? (
              <Input label="Pickup time" type="time" required value={form.pickupTime} onChange={(e) => set('pickupTime', e.target.value)} error={errors.pickupTime} hint={`Local time (${tz})`} />
            ) : (
              <p className="text-sm text-slate-500">Select your shift to see your cab.</p>
            )}

            {homeText && hasHomePin ? (
              (() => {
                const toHome = direction === 'OUT';
                const stops: Array<[string, string, boolean]> = [
                  ['Pickup', toHome ? officeText : homeText, !toHome],
                  ['Drop', toHome ? homeText : officeText, toHome],
                ];
                return (
                  <div className="rounded-lg border border-slate-200 p-3">
                    <dl className="space-y-1 text-sm">
                      {stops.map(([label, place, isHome]) => (
                        <div key={label} className="flex gap-2">
                          <dt className="w-14 shrink-0 text-slate-500">{label}</dt>
                          <dd className="min-w-0 font-medium text-slate-900">
                            {place} <span className="font-normal text-slate-500">({isHome ? 'home' : 'office'})</span>
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <p className="mt-2 text-xs text-slate-500">From your present address. The transport team plans the cab route.</p>
                  </div>
                );
              })()
            ) : (
              <Alert tone="warn" title={!homeText ? 'Add your present address' : 'Add your home’s Google Maps link'}>
                {!homeText ? 'The transport team plans your cab route from it.' : 'Your driver navigates to it, so it must be exact.'}{' '}
                <Link to="/account" className="font-medium underline">
                  {!homeText ? 'Add present address' : 'Add map link in Account'}
                </Link>
              </Alert>
            )}
            <p className="text-sm text-slate-600">
              Office: <span className="font-medium text-slate-900">{office ? `${office.name} (${office.code})` : myOffice || '—'}</span>
            </p>
            <div className="flex flex-wrap gap-2 pt-2">
              <Button type="submit" size="lg" loading={submitting} disabled={submitting || (hasHours && timesOk && !direction)}>
                {ride ? 'Save changes' : 'Submit request'}
              </Button>
              <Button variant="ghost" size="lg" onClick={() => navigate(ride ? `/employee/bookings/${ride._id}` : '/employee')} disabled={submitting}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
        <div className="space-y-4">
          <Alert tone="info" title="Booking rules">
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {winStart && winEnd && (
                <>
                  <li>
                    <strong>IN</strong> (to the office): for shifts starting {fmt12h(inFrom)} – {fmt12h(winEnd)}. Your pickup time is set by the transport team.
                  </li>
                  <li>
                    <strong>OUT</strong> (home): for shifts ending {fmt12h(winStart)} – before {fmt12h(winEnd)}. The cab leaves when your shift ends.
                  </li>
                </>
              )}
              <li>One cab per shift day.</li>
              <li>Book at least {minutesLabel(rules.minLeadMinutes)} ahead.</li>
              {rules.dailyCutoffTime && <li>Bookings for a day close at {fmt12h(rules.dailyCutoffTime)} on the previous day.</li>}
              <li>You can change or cancel your ride yourself until a cab is assigned; after that, send a cancellation request to the admin from the booking.</li>
              {rules.approvalRequired && <li>Requests need approval before a cab is assigned.</li>}
            </ul>
          </Alert>
        </div>
      </div>
    </>
  );
}
