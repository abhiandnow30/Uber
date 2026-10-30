import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { DateTime } from 'luxon';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, ErrorState, Input, PageHeader, Select, Spinner, cn, useToast } from '../../components/ui';
import { ApiError, errorMessage, get, patch, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { addDaysISO, currentWorkDay, fmtTravelDate, todayISO, uuid } from '../../lib/format';
import { fieldErrors } from '../../lib/hooks';
import { changed, useUnsavedChanges } from '../../lib/unsaved';
import { addMinutesHHmm, cabForShift, fmt12h, IN_LEAD_MINUTES, inCabWindow, shiftCabDate, usePolicy } from '../../lib/policy';

type Form = {
  // The day the shift starts ('' = not chosen yet: the first shift day still bookable is used).
  travelDate: string;
  shift: string;
  // Only asked when the shift allows both an IN and an OUT cab.
  direction: '' | 'IN' | 'OUT';
  // When the cab leaves the office (rides home): the shift end by default; the employee may work
  // late or leave early. Not asked for rides to the office: the transport team sets that pickup.
  pickupTime: string;
};

const HHMM = /^\d{2}:\d{2}$/;

type CreateResult = { booking: { _id: string; reference: string; status: string }; legs?: Array<{ _id: string; reference: string }>; duplicate: boolean };

const FIELD_FOR_CODE: Record<string, keyof Form> = { BOOKING_WINDOW: 'travelDate', BOOKING_CUTOFF: 'travelDate', OUTSIDE_CAB_HOURS: 'pickupTime', NO_CAB_FOR_SHIFT: 'shift' };

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

  const [form, setForm] = useState<Form>({ travelDate: '', shift: '', direction: '', pickupTime: '' });

  // Cabs are always booked for the employee's own office (that office's coordinators assign them).
  const office = activeOffices.find((o) => o.code === myOffice);
  const tz = office?.timezone ?? 'Asia/Kolkata';
  const today = todayISO(tz);
  const maxDate = policy ? addDaysISO(today, policy.booking.maxDaysAhead) : undefined;
  const selectedShift = activeShifts.find((s) => s.code === form.shift);
  const shiftStart = selectedShift?.startTime ?? '';
  const shiftEnd = selectedShift?.endTime ?? '';
  const hasHours = !!(shiftStart && shiftEnd);
  const shiftRequired = !!policy?.booking.requireShift;
  const winStart = policy?.booking.cabWindowStart;
  const winEnd = policy?.booking.cabWindowEnd;
  // Night cabs (e.g. 8 PM - 6 AM) belong to the shift that started the evening before: until cab
  // hours end, last night's shift can still be booked (its cab home may still be to come).
  const workDay = currentWorkDay(tz, winStart, winEnd);

  // Which cab the shift gets (same rule as the server):
  //  IN  = home → office: reach the office by the shift start; the transport team sets the pickup.
  //  OUT = office → home: the cab leaves the office at the time chosen, the shift end by default.
  const can = hasHours ? cabForShift(shiftStart, shiftEnd, winStart, winEnd) : null;
  const both = !!can?.in && !!can?.out;
  const direction: 'IN' | 'OUT' | null = !can ? null : both ? form.direction || (selectedShift?.direction === 'FROM_OFFICE' ? 'OUT' : 'IN') : can.in ? 'IN' : can.out ? 'OUT' : null;
  /** The cab's date and time for a shift starting on `date`. */
  const cabOn = (date: string) => {
    if (!date || (hasHours && !direction)) return null;
    if (direction === 'IN') return { date, time: shiftStart };
    if (!HHMM.test(form.pickupTime)) return null;
    if (direction === 'OUT') return { date: shiftCabDate(shiftStart, shiftEnd, date, form.pickupTime), time: form.pickupTime };
    const usual = selectedShift?.defaultPickupTime;
    return { date: shiftStart && usual ? shiftCabDate(shiftStart, usual, date, form.pickupTime) : date, time: form.pickupTime };
  };
  // No date chosen yet: the first shift day whose cab can still be booked. Just after midnight that
  // is last night's shift when its cab home is still to come, otherwise today's (or tomorrow's).
  const suggestedDate = (() => {
    if (!policy) return today;
    const bookableFrom = DateTime.now().setZone(tz).plus({ minutes: policy.booking.minLeadMinutes });
    for (let d = workDay, i = 0; i < 3; d = addDaysISO(d, 1), i++) {
      const c = cabOn(d);
      if (!c) return today;
      if (DateTime.fromISO(`${c.date}T${c.time}`, { zone: tz }) >= bookableFrom) return d;
    }
    return today;
  })();
  const travelDate = form.travelDate || suggestedDate;
  const cab = cabOn(travelDate);

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
    // A ride home leaves when the shift ends unless the employee changes it.
    setForm((f) => ({ ...f, shift: code, direction: '', pickupTime: s?.endTime || s?.defaultPickupTime || f.pickupTime }));
    setErrors((e) => ({ ...e, shift: undefined, pickupTime: undefined }));
  };

  // Changing an existing ride (?edit=<id>, only while no cab is assigned): the form starts from it.
  const [params] = useSearchParams();
  const editId = params.get('edit') ?? '';
  const editing = useQuery({
    queryKey: ['my-bookings', 'detail', editId],
    queryFn: () => get<{ _id: string; reference: string; canEdit: boolean; shift?: string; shiftDate?: string; travelDate: string; direction?: 'IN' | 'OUT'; pickupTime: string }>(`/me/bookings/${editId}`),
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
      const s = activeShifts.find((x) => x.code === ride.shift);
      setForm({
        travelDate: ride.shiftDate ?? ride.travelDate,
        shift: ride.shift ?? '',
        direction: ride.direction ?? '',
        // A ride to the office has no pickup of the employee's: switched to a ride home, it starts at the shift end.
        pickupTime: ride.direction === 'IN' ? s?.endTime || s?.defaultPickupTime || '' : ride.pickupTime,
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
    else if (travelDate < workDay) e.travelDate = 'The date cannot be in the past';
    else if (maxDate && travelDate > maxDate) e.travelDate = `You can book at most ${rules.maxDaysAhead} days ahead`;
    if (shiftRequired && !form.shift) e.shift = 'Select your shift';
    if (hasHours && !direction) e.shift = 'There is no cab for this shift';
    else if (direction !== 'IN' && (form.shift || !shiftRequired)) {
      if (!HHMM.test(form.pickupTime)) e.pickupTime = 'Choose when the cab leaves the office';
      else if (!inCabWindow(form.pickupTime, winStart, winEnd)) e.pickupTime = `Cabs run between ${fmt12h(winStart)} and ${fmt12h(winEnd)}`;
    }
    const at = cab;
    if (at && !e.travelDate && !e.shift && !e.pickupTime) {
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
      ...(both && direction ? { direction } : {}),
      // Rides home: when the cab leaves the office. Rides to the office: the transport team sets the pickup.
      ...(direction !== 'IN' ? { pickupTime: form.pickupTime } : {}),
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
        <PageHeader title="Change your ride" />
        <Alert tone="info" title="This ride can no longer be changed">
          A cab is already assigned. You can cancel it from the ride, or ask the admin.
        </Alert>
      </>
    );
  }
  const rules = policy.booking;
  const inFrom = winStart ? addMinutesHHmm(winStart, IN_LEAD_MINUTES) : '';
  const tips = (
    <ul className="mt-1 list-inside list-disc space-y-1">
      {winStart && winEnd && (
        <>
          <li>
            <strong>To the office:</strong> shifts starting {fmt12h(inFrom)} – {fmt12h(winEnd)}; the transport team sets your pickup time.
          </li>
          <li>
            <strong>Home:</strong> shifts ending {fmt12h(winStart)} – {fmt12h(winEnd)}; the cab leaves at the time you choose (your shift end unless you change it).
          </li>
        </>
      )}
      <li>One cab per shift day, booked at least {minutesLabel(rules.minLeadMinutes)} ahead.</li>
      {rules.dailyCutoffTime && <li>Bookings for a day close at {fmt12h(rules.dailyCutoffTime)} on the previous day.</li>}
      <li>Change or cancel it yourself until a cab is assigned.</li>
      {rules.approvalRequired && <li>Requests need approval before a cab is assigned.</li>}
    </ul>
  );

  return (
    <>
      <PageHeader title={ride ? `Change your ride · ${ride.reference}` : 'Request a cab'} />
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
                min={workDay}
                max={maxDate}
                value={travelDate}
                onChange={(e) => set('travelDate', e.target.value)}
                error={errors.travelDate}
                hint={travelDate ? `The day your shift starts · ${fmtTravelDate(travelDate)}${travelDate < today ? ' (last night’s shift)' : ''}` : undefined}
              />
            </div>

            {hasHours ? (
              <>
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
                        <span className="block text-slate-500">{d === 'IN' ? `Reach by ${fmt12h(shiftStart)}` : `Leave around ${fmt12h(shiftEnd)}`}</span>
                      </button>
                    ))}
                  </div>
                )}

                {direction === 'OUT' && (
                  <Input
                    label="Cab leaves the office at"
                    type="time"
                    required
                    value={form.pickupTime}
                    onChange={(e) => set('pickupTime', e.target.value)}
                    error={errors.pickupTime}
                    hint={form.pickupTime === shiftEnd ? 'When your shift ends — change it if you leave earlier or work late' : `Your shift ends at ${fmt12h(shiftEnd)}`}
                  />
                )}

                {direction && cab ? (
                  <Alert
                    tone="info"
                    title={direction === 'IN' ? `To the office · reach by ${fmt12h(cab.time)} on ${fmtTravelDate(cab.date)}` : `Home · cab leaves the office at ${fmt12h(cab.time)} on ${fmtTravelDate(cab.date)}`}
                  >
                    {direction === 'IN'
                      ? 'The transport team sets your pickup time when they assign your cab, and you are told then.'
                      : cab.date !== travelDate
                        ? 'The morning after your shift starts.'
                        : 'The same evening your shift starts.'}
                  </Alert>
                ) : !direction ? (
                  <Alert tone="warn" title="No cab for this shift">
                    Cabs take you to the office for shifts starting {fmt12h(inFrom)} – {fmt12h(winEnd)}, or home for shifts ending {fmt12h(winStart)} – before {fmt12h(winEnd)}.
                  </Alert>
                ) : null}
              </>
            ) : selectedShift || !shiftRequired ? (
              <Input label="Cab leaves the office at" type="time" required value={form.pickupTime} onChange={(e) => set('pickupTime', e.target.value)} error={errors.pickupTime} hint={`Local time (${tz})`} />
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
            {/* Phones: two equal buttons, Cancel on the left and the main action on the right. */}
            <div className="flex flex-wrap gap-2 pt-2 max-sm:grid max-sm:grid-cols-2">
              <Button type="submit" size="lg" className="max-sm:order-last max-sm:w-full" loading={submitting} disabled={submitting || (hasHours && !direction)}>
                {ride ? 'Save changes' : 'Submit'}
              </Button>
              <Button
                variant="ghost"
                size="lg"
                className="max-sm:w-full max-sm:border max-sm:border-slate-300 max-sm:bg-white"
                onClick={() => navigate(ride ? `/employee/bookings/${ride._id}` : '/employee')}
                disabled={submitting}
              >
                Cancel
              </Button>
            </div>
          </form>
        </Card>
        <div className="space-y-4">
          {/* Phones: the tips start open and can be folded away. Desktop: the full box. */}
          <details open className="group rounded-xl border border-sky-200 bg-sky-50 text-sm text-sky-900 lg:hidden">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 font-semibold [&::-webkit-details-marker]:hidden">
              Good to know
              <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden />
            </summary>
            <div className="border-t border-sky-200 px-4 py-3">{tips}</div>
          </details>
          <div className="max-lg:hidden">
            <Alert tone="info" title="Good to know">
              {tips}
            </Alert>
          </div>
        </div>
      </div>
    </>
  );
}
