import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Loader2, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Alert, Button, Card, Checkbox, ErrorState, Input, PageHeader, Select, Spinner } from '../../components/ui';
import { errorMessage, get, put } from '../../lib/api';
import { fmt12h, fmtDateTime } from '../../lib/format';
import { fieldErrors } from '../../lib/hooks';
import type { Office, Shift } from '../../lib/policy';
import { changed, useUnsavedChanges } from '../../lib/unsaved';
import { MapLinkField, sameSpot } from '../../components/LocationPicker';

type FullPolicy = {
  _id: string;
  version: number;
  updatedAt?: string;
  officeLocations: Office[];
  shifts: Shift[];
  booking: { maxDaysAhead: number; minLeadMinutes: number; dailyCutoffTime: string; cancellationDeadlineMinutes: number; approvalRequired: boolean; maxPassengers: number; allowRoundTrip: boolean; cabWindowStart?: string; cabWindowEnd?: string; requireShift?: boolean };
  assignment: { defaultTripDurationMinutes: number; bufferMinutes: number; requireVerifiedDriver: boolean; acknowledgementTimeoutMinutes: number };
  pin: { digits?: number; maxAttempts: number; validAfterPickupMinutes: number };
  exceptions: { latePickupThresholdMinutes: number; overdueTripMinutes: number };
  notifications: Record<string, boolean>;
  reminders?: { dailyTime?: string };
};

type SectionKey = 'booking' | 'assignment' | 'pin' | 'exceptions';
type FieldDef = { key: string; label: string; type: 'number' | 'boolean' | 'time'; min?: number; max?: number; hint?: string };

const SECTIONS: Array<{ key: SectionKey; title: string; description: string; fields: FieldDef[] }> = [
  {
    key: 'booking',
    title: 'Booking rules',
    description: 'What employees may request and when.',
    fields: [
      { key: 'cabWindowStart', label: 'Cabs run from', type: 'time', hint: 'Start of daily cab hours (e.g. 8:00 PM). Leave both empty for any time.' },
      { key: 'cabWindowEnd', label: 'Cabs run until', type: 'time', hint: 'End of daily cab hours (e.g. 6:00 AM, next morning).' },
      { key: 'requireShift', label: 'Employees must pick their shift (the cab time comes from the shift)', type: 'boolean' },
      { key: 'maxDaysAhead', label: 'Maximum days in advance', type: 'number', min: 0, max: 90 },
      { key: 'minLeadMinutes', label: 'Minimum lead time (minutes before pickup)', type: 'number', min: 0, max: 10080 },
      { key: 'dailyCutoffTime', label: 'Daily cut-off for next-day bookings', type: 'time', hint: 'Optional, office local time. Leave empty for none.' },
      { key: 'maxPassengers', label: 'Maximum passengers per booking', type: 'number', min: 1, max: 60 },
      { key: 'approvalRequired', label: 'Bookings require approval before assignment', type: 'boolean' },
      { key: 'allowRoundTrip', label: 'Allow round-trip bookings', type: 'boolean' },
    ],
  },
  {
    key: 'assignment',
    title: 'Assignment rules',
    description: 'How drivers and vehicles are reserved for a booking.',
    fields: [
      { key: 'defaultTripDurationMinutes', label: 'Default trip duration (minutes)', type: 'number', min: 10, max: 1440 },
      { key: 'bufferMinutes', label: 'Buffer between trips (minutes)', type: 'number', min: 0, max: 240 },
    ],
  },
  {
    key: 'pin',
    title: 'Trip PIN rules',
    description: 'The PIN the employee gives the driver to start the trip.',
    fields: [
      { key: 'maxAttempts', label: 'Maximum wrong attempts before lock', type: 'number', min: 3, max: 10 },
      { key: 'validAfterPickupMinutes', label: 'PIN valid after scheduled pickup (minutes)', type: 'number', min: 30, max: 1440 },
    ],
  },
  {
    key: 'exceptions',
    title: 'Alert thresholds',
    description: 'When coordinators get a notification about a late pickup or a trip that is taking too long.',
    fields: [
      { key: 'latePickupThresholdMinutes', label: 'Late pickup after (minutes)', type: 'number', min: 1, max: 240 },
      { key: 'overdueTripMinutes', label: 'Trip overdue after (minutes)', type: 'number', min: 10, max: 1440 },
    ],
  },
];

const APP_ONLY_EVENTS = ['emailOnSubmitted', 'emailOnApprovalDecision'];

const NOTIFICATION_LABELS: Record<string, string> = {
  emailOnAssigned: 'Cab assigned (driver & vehicle details)',
  emailOnChanged: 'Assignment changed',
  emailOnCancelled: 'Booking cancelled',
  emailOnArrived: 'Driver arrived at pickup',
  emailOnTripStarted: 'Trip started',
  emailOnCompleted: 'Trip completed',
  emailOnDelay: 'Delay detected',
  dailyBookingReminder: 'Daily reminder to request tomorrow’s cab',
};

function stripPrefix(errs: Record<string, string>, prefix: string) {
  return Object.fromEntries(Object.entries(errs).filter(([k]) => k.startsWith(prefix + '.')).map(([k, v]) => [k.slice(prefix.length + 1), v]));
}

type Status = 'idle' | 'saving' | 'saved' | 'invalid' | 'error';

/**
 * Auto-save for one settings section. `saved` is the section as stored, in the form's own shape.
 * `set` changes the form without saving (while typing); `commit` saves now (a tick, a dropdown, leaving
 * a field). Saves run one after another; a section with an invalid field isn't saved until it is fixed.
 * When the stored policy changes (this or another section saved), fields not being edited follow it.
 */
function useAutoSave<T>(saved: T, opts: { prefix: string; validate: (v: T) => Record<string, string>; toBody: (v: T) => Record<string, unknown>; merge?: (v: T, prev: T, next: T) => T }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(saved);
  const valueRef = useRef(saved);
  const savedRef = useRef(saved);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const update = (v: T) => {
    valueRef.current = v;
    setValue(v);
  };

  useEffect(() => {
    const prev = savedRef.current;
    savedRef.current = saved;
    const v = valueRef.current;
    update(!changed(v, prev) ? saved : optsRef.current.merge ? optsRef.current.merge(v, prev, saved) : v);
  }, [saved]);

  const doSave = async (v: T) => {
    if (!changed(v, savedRef.current)) return true;
    setStatus('saving');
    setMessage('');
    try {
      const updated = await put<FullPolicy>('/admin/policy', optsRef.current.toBody(v));
      savedRef.current = v;
      qc.setQueryData(['admin-policy'], updated);
      qc.invalidateQueries({ queryKey: ['policy'] });
      setStatus(changed(valueRef.current, v) ? 'idle' : 'saved');
      return true;
    } catch (err) {
      setErrors(stripPrefix(fieldErrors(err), optsRef.current.prefix));
      setMessage(errorMessage(err));
      setStatus('error');
      return false;
    }
  };

  const commit = useCallback((next?: T): Promise<boolean> => {
    const v = next ?? valueRef.current;
    update(v);
    const errs = optsRef.current.validate(v);
    setErrors(errs);
    if (Object.keys(errs).length) {
      setStatus('invalid');
      return Promise.resolve(false);
    }
    const run = chain.current.then(() => doSave(v));
    chain.current = run.catch(() => {});
    return run;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = changed(value, saved);
  return { value, set: update, commit, errors, status: dirty && status === 'saved' ? 'idle' : status, message, dirty };
}

/** Typed fields save when the person leaves them; Enter does the same. */
const blurOnEnter = (e: KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && e.currentTarget.blur();

function SaveStatus({ status, dirty }: { status: Status; dirty: boolean }) {
  if (status === 'saving')
    return (
      <span className="flex items-center gap-1.5 text-sm text-slate-500" aria-live="polite">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Saving…
      </span>
    );
  if (status === 'invalid' || status === 'error')
    return (
      <span className="flex items-center gap-1.5 text-sm font-medium text-amber-700" aria-live="polite">
        <AlertTriangle className="h-4 w-4" aria-hidden /> Not saved — fix the highlighted field
      </span>
    );
  if (status === 'saved' && !dirty)
    return (
      <span className="flex items-center gap-1.5 text-sm font-medium text-emerald-700" aria-live="polite">
        <Check className="h-4 w-4" aria-hidden /> Saved
      </span>
    );
  return <span className="text-xs text-slate-400">Saves automatically</span>;
}

type AutoSave = { dirty: boolean; commit: () => Promise<boolean> };

function RuleSection({ def, values, onState }: { def: (typeof SECTIONS)[number]; values: Record<string, unknown>; onState: (s: AutoSave) => void }) {
  const saved = useMemo(() => Object.fromEntries(def.fields.map((f) => [f.key, f.type === 'boolean' ? !!values[f.key] : String(values[f.key] ?? '')])) as Record<string, string | boolean>, [values, def]);
  const s = useAutoSave(saved, {
    prefix: def.key,
    validate: (form) => {
      const v: Record<string, string> = {};
      for (const f of def.fields) {
        if (f.type !== 'number') continue;
        const n = Number(form[f.key]);
        if (form[f.key] === '' || !Number.isInteger(n)) v[f.key] = 'Enter a whole number';
        else if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) v[f.key] = `Must be between ${f.min} and ${f.max}`;
      }
      return v;
    },
    toBody: (form) => ({ [def.key]: Object.fromEntries(def.fields.map((f) => [f.key, f.type === 'boolean' ? !!form[f.key] : f.type === 'number' ? Number(form[f.key]) : String(form[f.key] ?? '')])) }),
    // keep what is being typed; take everything else from the stored policy
    merge: (v, prev, next) => Object.fromEntries(Object.keys(next).map((k) => [k, v[k] === prev[k] ? next[k] : v[k]])),
  });
  useEffect(() => onState({ dirty: s.dirty && s.status !== 'saving', commit: () => s.commit() }), [s.dirty, s.status, s.commit, onState]);

  return (
    <Card title={def.title} actions={<SaveStatus status={s.status} dirty={s.dirty} />}>
      <p className="mb-3 text-sm text-slate-500">{def.description}</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {def.fields.map((f) =>
          f.type === 'boolean' ? (
            <Checkbox key={f.key} className="sm:col-span-2" label={f.label} checked={!!s.value[f.key]} onChange={(e) => s.commit({ ...s.value, [f.key]: e.target.checked })} />
          ) : (
            <Input
              key={f.key}
              label={f.label}
              type={f.type}
              inputMode={f.type === 'number' ? 'numeric' : undefined}
              min={f.min}
              max={f.max}
              value={String(s.value[f.key] ?? '')}
              onChange={(e) => s.set({ ...s.value, [f.key]: e.target.value })}
              onBlur={() => s.commit()}
              onKeyDown={blurOnEnter}
              error={s.errors[f.key]}
              hint={f.hint ?? (f.min !== undefined ? `${f.min}–${f.max}` : undefined)}
            />
          ),
        )}
      </div>
      {s.message && !Object.keys(s.errors).length && (
        <div className="mt-3">
          <Alert tone="error">{s.message}</Alert>
        </div>
      )}
    </Card>
  );
}

/** When the daily reminder goes out; shown while the reminder is switched on. */
function ReminderTime({ value, onState }: { value: string; onState: (s: AutoSave) => void }) {
  const saved = useMemo(() => ({ dailyTime: value }), [value]);
  const s = useAutoSave(saved, {
    prefix: 'reminders',
    validate: (v): Record<string, string> => (/^\d{2}:\d{2}$/.test(v.dailyTime) ? {} : { dailyTime: 'Choose a time' }),
    toBody: (v) => ({ reminders: { dailyTime: v.dailyTime } }),
  });
  useEffect(() => onState({ dirty: s.dirty && s.status !== 'saving', commit: () => s.commit() }), [s.dirty, s.status, s.commit, onState]);
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg bg-slate-50 p-3 sm:col-span-2">
      <Input
        className="w-44"
        label="Send the reminder at"
        type="time"
        value={s.value.dailyTime}
        onChange={(e) => s.set({ dailyTime: e.target.value })}
        onBlur={() => s.commit()}
        onKeyDown={blurOnEnter}
        error={s.errors.dailyTime}
      />
      <p className="pb-2 text-xs text-slate-500">
        Each office&apos;s local time. Employees who haven&apos;t requested a cab for the next day get it then.
        {s.value.dailyTime ? ` Now: ${fmt12h(s.value.dailyTime)}.` : ''}
      </p>
      <div className="ml-auto pb-2">
        <SaveStatus status={s.status} dirty={s.dirty} />
      </div>
    </div>
  );
}

function NotificationsSection({ values, reminderTime, onState, onReminderState }: { values: Record<string, boolean>; reminderTime: string; onState: (s: AutoSave) => void; onReminderState: (s: AutoSave) => void }) {
  const s = useAutoSave(values, {
    prefix: 'notifications',
    validate: () => ({}),
    toBody: (form) => ({ notifications: form }),
    merge: (v, prev, next) => Object.fromEntries(Object.keys(next).map((k) => [k, v[k] === prev[k] ? next[k] : v[k]])),
  });
  useEffect(() => onState({ dirty: s.dirty && s.status !== 'saving', commit: () => s.commit() }), [s.dirty, s.status, s.commit, onState]);
  return (
    <Card title="Email notification preferences" actions={<SaveStatus status={s.status} dirty={s.dirty} />}>
      <p className="mb-3 text-sm text-slate-500">Which booking events send an email. In-app notifications are always delivered.</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {/* New requests and approval decisions never email the employee, so those switches aren't shown. */}
        {Object.keys(s.value)
          .filter((k) => !APP_ONLY_EVENTS.includes(k))
          .map((k) => (
            <Checkbox key={k} label={NOTIFICATION_LABELS[k] ?? k} checked={!!s.value[k]} onChange={(e) => s.commit({ ...s.value, [k]: e.target.checked })} />
          ))}
        {s.value.dailyBookingReminder && <ReminderTime value={reminderTime} onState={onReminderState} />}
      </div>
      {s.message && (
        <div className="mt-3">
          <Alert tone="error">{s.message}</Alert>
        </div>
      )}
    </Card>
  );
}

/**
 * Lists (offices, shifts): a row's problems show once the person has left one of its fields, so a
 * new empty row isn't flagged before they've started on it.
 */
function useTouchedRows() {
  const [touched, setTouched] = useState<Set<number>>(new Set());
  return {
    touch: (i: number) => setTouched((t) => new Set(t).add(i)),
    reset: () => setTouched(new Set()),
    shown: (errors: Record<string, string>) => Object.fromEntries(Object.entries(errors).filter(([k]) => touched.has(Number(k.split('.')[0])))),
  };
}

/** Whether an office row's location (link + spot) is what's stored for that office. */
function officeSpotSaved(r: Office, stored: Office[]) {
  const o = stored.find((x) => x.code === r.code);
  return !!o && sameSpot({ link: r.mapLink ?? '', pin: r.location ?? null }, { link: o.mapLink ?? '', pin: o.location ?? null });
}

function OfficesSection({ values, onState }: { values: Office[]; onState: (s: AutoSave) => void }) {
  const t = useTouchedRows();
  const s = useAutoSave(values, {
    prefix: 'officeLocations',
    validate: (rows) => {
      const v: Record<string, string> = {};
      const codes = rows.map((r) => r.code.trim().toUpperCase());
      rows.forEach((r, i) => {
        if (!/^[A-Za-z0-9_-]{2,10}$/.test(r.code.trim())) v[`${i}.code`] = '2-10 letters, digits, - or _';
        else if (codes.indexOf(codes[i]) !== i) v[`${i}.code`] = 'Duplicate code';
        if (r.name.trim().length < 2) v[`${i}.name`] = 'Name is required';
        if (!r.timezone.trim()) v[`${i}.timezone`] = 'Time zone is required';
      });
      if (!rows.length) v._ = 'At least one office is required';
      return v;
    },
    toBody: (rows) => ({
      officeLocations: rows.map((r) => ({
        code: r.code.trim().toUpperCase(),
        name: r.name.trim(),
        address: r.address?.trim() ?? '',
        timezone: r.timezone.trim(),
        active: r.active,
        ...(r.location ? { location: r.location, mapLink: r.mapLink?.trim() ?? '' } : {}),
      })),
    }),
  });
  useEffect(() => onState({ dirty: s.dirty && s.status !== 'saving', commit: () => s.commit() }), [s.dirty, s.status, s.commit, onState]);
  const rows = s.value;
  const errors = t.shown(s.errors);
  const edit = (i: number, patch: Partial<Office>) => rows.map((x, j) => (j === i ? { ...x, ...patch } : x));
  const leave = (i: number) => {
    t.touch(i);
    void s.commit();
  };

  return (
    <Card
      title="Office locations"
      actions={
        <>
          <SaveStatus status={s.status === 'invalid' && !Object.keys(errors).length ? 'idle' : s.status} dirty={s.dirty} />
          <Button size="sm" variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => s.set([...rows, { code: '', name: '', address: '', timezone: 'Asia/Kolkata', active: true }])}>
            Add office
          </Button>
        </>
      }
    >
      <Alert tone="warn">Prefer marking an office inactive over removing it: existing employees, drivers and bookings keep referring to its code.</Alert>
      <div className="mt-3 space-y-3">
        {rows.map((r, i) => (
          <fieldset key={i} className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-2 lg:grid-cols-12">
            <legend className="sr-only">Office {i + 1}</legend>
            <Input className="lg:col-span-2" label="Code" value={r.code} onChange={(e) => s.set(edit(i, { code: e.target.value.toUpperCase() }))} onBlur={() => leave(i)} onKeyDown={blurOnEnter} error={errors[`${i}.code`]} required />
            <Input className="lg:col-span-3" label="Name" value={r.name} onChange={(e) => s.set(edit(i, { name: e.target.value }))} onBlur={() => leave(i)} onKeyDown={blurOnEnter} error={errors[`${i}.name`]} required />
            <Input className="lg:col-span-3" label="Address" value={r.address ?? ''} onChange={(e) => s.set(edit(i, { address: e.target.value }))} onBlur={() => leave(i)} onKeyDown={blurOnEnter} error={errors[`${i}.address`]} />
            <Input className="lg:col-span-2" label="Time zone (IANA)" value={r.timezone} onChange={(e) => s.set(edit(i, { timezone: e.target.value }))} onBlur={() => leave(i)} onKeyDown={blurOnEnter} error={errors[`${i}.timezone`]} required />
            <div className="flex items-end justify-between gap-2 lg:col-span-2">
              <Checkbox
                label="Active"
                checked={r.active}
                onChange={(e) => {
                  t.touch(i);
                  void s.commit(edit(i, { active: e.target.checked }));
                }}
                className="pb-2"
              />
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove office ${r.code || i + 1}`}
                icon={<Trash2 className="h-4 w-4" />}
                onClick={() => {
                  t.reset();
                  void s.commit(rows.filter((_, j) => j !== i));
                }}
              />
            </div>
            <div className="sm:col-span-2 lg:col-span-12">
              <MapLinkField
                label="Google Maps link of the office"
                spot={{ link: r.mapLink ?? '', pin: r.location ?? null }}
                saved={officeSpotSaved(r, values)}
                onSpot={(v) => {
                  const next = edit(i, { mapLink: v.link, location: v.pin ?? undefined });
                  // Typing only changes the box; the office saves once its location is read (or removed).
                  if (JSON.stringify(v.pin) !== JSON.stringify(r.location ?? null)) {
                    t.touch(i);
                    void s.commit(next);
                  } else s.set(next);
                }}
              />
            </div>
          </fieldset>
        ))}
      </div>
      {(s.errors._ || (s.message && s.status === 'error')) && (
        <div className="mt-3">
          <Alert tone="error">{s.errors._ ?? s.message}</Alert>
        </div>
      )}
    </Card>
  );
}

function ShiftsSection({ values, onState }: { values: Shift[]; onState: (s: AutoSave) => void }) {
  const t = useTouchedRows();
  const s = useAutoSave(values, {
    prefix: 'shifts',
    validate: (rows) => {
      const v: Record<string, string> = {};
      const codes = rows.map((r) => r.code.trim().toUpperCase());
      rows.forEach((r, i) => {
        if (!/^[A-Za-z0-9_-]{2,20}$/.test(r.code.trim())) v[`${i}.code`] = '2-20 letters, digits, - or _';
        else if (codes.indexOf(codes[i]) !== i) v[`${i}.code`] = 'Duplicate code';
        if (r.name.trim().length < 2) v[`${i}.name`] = 'Name is required';
        if (!!r.startTime !== !!r.endTime) v[`${i}.${r.startTime ? 'endTime' : 'startTime'}`] = 'Set both start and end';
        if (r.startTime && !r.defaultPickupTime) v[`${i}.defaultPickupTime`] = 'Set the cab time';
      });
      return v;
    },
    toBody: (rows) => ({
      shifts: rows.map((r) => ({ code: r.code.trim().toUpperCase(), name: r.name.trim(), startTime: r.startTime ?? '', endTime: r.endTime ?? '', direction: r.direction, defaultPickupTime: r.defaultPickupTime ?? '', active: r.active })),
    }),
  });
  useEffect(() => onState({ dirty: s.dirty && s.status !== 'saving', commit: () => s.commit() }), [s.dirty, s.status, s.commit, onState]);
  const rows = s.value;
  const errors = t.shown(s.errors);
  const edit = (i: number, patch: Partial<Shift>) => rows.map((x, j) => (j === i ? { ...x, ...patch } : x));
  const leave = (i: number) => {
    t.touch(i);
    void s.commit();
  };
  const field = (i: number) => ({ onBlur: () => leave(i), onKeyDown: blurOnEnter });

  return (
    <Card
      title="Shifts"
      actions={
        <>
          <SaveStatus status={s.status === 'invalid' && !Object.keys(errors).length ? 'idle' : s.status} dirty={s.dirty} />
          <Button size="sm" variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => s.set([...rows, { code: '', name: '', startTime: '', endTime: '', direction: 'FROM_OFFICE', defaultPickupTime: '', active: true }])}>
            Add shift
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {!rows.length && <p className="text-sm text-slate-500">No shifts configured.</p>}
        {rows.map((r, i) => (
          <fieldset key={i} className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-2 lg:grid-cols-12">
            <legend className="sr-only">Shift {i + 1}</legend>
            <Input className="lg:col-span-2" label="Code" value={r.code} onChange={(e) => s.set(edit(i, { code: e.target.value.toUpperCase() }))} {...field(i)} error={errors[`${i}.code`]} required />
            <Input className="lg:col-span-3" label="Name" value={r.name} onChange={(e) => s.set(edit(i, { name: e.target.value }))} {...field(i)} error={errors[`${i}.name`]} required />
            <Input className="lg:col-span-2" label="Shift starts" type="time" value={r.startTime ?? ''} onChange={(e) => s.set(edit(i, { startTime: e.target.value }))} {...field(i)} error={errors[`${i}.startTime`]} />
            <Input className="lg:col-span-2" label="Shift ends" type="time" value={r.endTime ?? ''} onChange={(e) => s.set(edit(i, { endTime: e.target.value }))} {...field(i)} error={errors[`${i}.endTime`]} />
            <Select
              className="lg:col-span-3"
              label="Cab trip"
              value={r.direction}
              onChange={(e) => {
                t.touch(i);
                void s.commit(edit(i, { direction: e.target.value }));
              }}
            >
              <option value="FROM_OFFICE">Office → Home</option>
              <option value="TO_OFFICE">Home → Office</option>
              <option value="ANY">Either</option>
            </Select>
            <Input
              className="lg:col-span-2"
              label="Cab time"
              type="time"
              value={r.defaultPickupTime ?? ''}
              onChange={(e) => s.set(edit(i, { defaultPickupTime: e.target.value }))}
              {...field(i)}
              error={errors[`${i}.defaultPickupTime`]}
            />
            <div className="flex items-end justify-between gap-2 lg:col-span-2">
              <Checkbox
                label="Active"
                checked={r.active}
                onChange={(e) => {
                  t.touch(i);
                  void s.commit(edit(i, { active: e.target.checked }));
                }}
                className="pb-2"
              />
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove shift ${r.code || i + 1}`}
                icon={<Trash2 className="h-4 w-4" />}
                onClick={() => {
                  t.reset();
                  void s.commit(rows.filter((_, j) => j !== i));
                }}
              />
            </div>
          </fieldset>
        ))}
      </div>
      {s.message && s.status === 'error' && (
        <div className="mt-3">
          <Alert tone="error">{s.message}</Alert>
        </div>
      )}
    </Card>
  );
}

export default function PolicyPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-policy'],
    queryFn: ({ signal }) => get<FullPolicy>('/admin/policy', signal),
  });

  // Every section reports whether it has changes not saved yet (e.g. a field left invalid, or a new
  // row not finished), so leaving the page can warn and offer to save them.
  const [sections, setSections] = useState<Record<string, AutoSave>>({});
  const report = useMemo(() => {
    const cache: Record<string, (s: AutoSave) => void> = {};
    return (key: string) =>
      (cache[key] ??= (s: AutoSave) =>
        setSections((all) => (all[key]?.dirty === s.dirty && all[key]?.commit === s.commit ? all : { ...all, [key]: s })));
  }, []);
  const unsaved = Object.values(sections).filter((s) => s.dirty);
  useUnsavedChanges(unsaved.length > 0, async () => (await Promise.all(unsaved.map((s) => s.commit()))).every(Boolean));

  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} onRetry={refetch} />;

  return (
    <>
      <PageHeader
        title="Booking policy"
        subtitle={
          <>
            Version <strong>{data.version}</strong>
            {data.updatedAt ? ` · last updated ${fmtDateTime(data.updatedAt)}` : ''}. Changes save automatically and are recorded in the audit log.
          </>
        }
      />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {SECTIONS.map((s) => (
          <RuleSection key={s.key} def={s} values={data[s.key] as unknown as Record<string, unknown>} onState={report(s.key)} />
        ))}
      </div>
      <div className="mt-4 space-y-4">
        <NotificationsSection
          values={data.notifications ?? {}}
          reminderTime={data.reminders?.dailyTime ?? '18:00'}
          onState={report('notifications')}
          onReminderState={report('reminders')}
        />
        <OfficesSection values={data.officeLocations} onState={report('offices')} />
        <ShiftsSection values={data.shifts} onState={report('shifts')} />
      </div>
    </>
  );
}
