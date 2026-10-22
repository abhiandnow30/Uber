import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Checkbox, ErrorState, Input, PageHeader, Select, Spinner, useToast } from '../../components/ui';
import { errorMessage, get, put } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { fieldErrors } from '../../lib/hooks';
import type { Office, Shift } from '../../lib/policy';

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
      { key: 'acknowledgementTimeoutMinutes', label: 'Driver acknowledgement timeout (minutes)', type: 'number', min: 1, max: 1440 },
      { key: 'requireVerifiedDriver', label: 'Only verified drivers can be assigned', type: 'boolean' },
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

const NOTIFICATION_LABELS: Record<string, string> = {
  emailOnSubmitted: 'Booking submitted (confirmation to employee)',
  emailOnApprovalDecision: 'Booking approved / rejected',
  emailOnAssigned: 'Cab assigned (driver & vehicle details)',
  emailOnChanged: 'Assignment changed',
  emailOnCancelled: 'Booking cancelled',
  emailOnArrived: 'Driver arrived at pickup',
  emailOnTripStarted: 'Trip started',
  emailOnCompleted: 'Trip completed',
  emailOnDelay: 'Delay detected',
  dailyBookingReminder: 'Daily 6 PM reminder to request tomorrow’s cab',
};

/** Save helper shared by every section; returns field errors keyed relative to the section. */
function useSave() {
  const qc = useQueryClient();
  const toast = useToast();
  return async (body: Record<string, unknown>, label: string) => {
    const updated = await put<FullPolicy>('/admin/policy', body);
    qc.setQueryData(['admin-policy'], updated);
    qc.invalidateQueries({ queryKey: ['admin-policy'] });
    qc.invalidateQueries({ queryKey: ['policy'] });
    toast.success(`${label} saved`, `Policy is now version ${updated.version}`);
    return updated;
  };
}

function stripPrefix(errs: Record<string, string>, prefix: string) {
  return Object.fromEntries(Object.entries(errs).filter(([k]) => k.startsWith(prefix + '.')).map(([k, v]) => [k.slice(prefix.length + 1), v]));
}

function RuleSection({ def, values }: { def: (typeof SECTIONS)[number]; values: Record<string, unknown> }) {
  const save = useSave();
  const [form, setForm] = useState<Record<string, string | boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setForm(Object.fromEntries(def.fields.map((f) => [f.key, f.type === 'boolean' ? !!values[f.key] : String(values[f.key] ?? '')])));
  }, [values, def]);

  const submit = async () => {
    const v: Record<string, string> = {};
    const body: Record<string, unknown> = {};
    for (const f of def.fields) {
      const raw = form[f.key];
      if (f.type === 'boolean') body[f.key] = !!raw;
      else if (f.type === 'time') body[f.key] = String(raw ?? '');
      else {
        const n = Number(raw);
        if (raw === '' || !Number.isInteger(n)) v[f.key] = 'Enter a whole number';
        else if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) v[f.key] = `Must be between ${f.min} and ${f.max}`;
        body[f.key] = n;
      }
    }
    setErrors(v);
    setError('');
    if (Object.keys(v).length) return;
    setBusy(true);
    try {
      await save({ [def.key]: body }, def.title);
    } catch (err) {
      setErrors(stripPrefix(fieldErrors(err), def.key));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={def.title}
      actions={
        <Button size="sm" onClick={submit} loading={busy}>
          Save
        </Button>
      }
    >
      <p className="mb-3 text-sm text-slate-500">{def.description}</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {def.fields.map((f) =>
          f.type === 'boolean' ? (
            <Checkbox
              key={f.key}
              className="sm:col-span-2"
              label={f.label}
              checked={!!form[f.key]}
              onChange={(e) => setForm((x) => ({ ...x, [f.key]: e.target.checked }))}
            />
          ) : (
            <Input
              key={f.key}
              label={f.label}
              type={f.type}
              inputMode={f.type === 'number' ? 'numeric' : undefined}
              min={f.min}
              max={f.max}
              value={String(form[f.key] ?? '')}
              onChange={(e) => setForm((x) => ({ ...x, [f.key]: e.target.value }))}
              error={errors[f.key]}
              hint={f.hint ?? (f.min !== undefined ? `${f.min}–${f.max}` : undefined)}
            />
          ),
        )}
      </div>
      {error && !Object.keys(errors).length && (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
    </Card>
  );
}

function NotificationsSection({ values }: { values: Record<string, boolean> }) {
  const save = useSave();
  const [form, setForm] = useState(values);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(values), [values]);
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await save({ notifications: form }, 'Notification preferences');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title="Email notification preferences"
      actions={
        <Button size="sm" onClick={submit} loading={busy}>
          Save
        </Button>
      }
    >
      <p className="mb-3 text-sm text-slate-500">Which booking events send an email. In-app notifications are always delivered.</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {Object.keys(form).map((k) => (
          <Checkbox key={k} label={NOTIFICATION_LABELS[k] ?? k} checked={!!form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.checked }))} />
        ))}
      </div>
      {error && (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
    </Card>
  );
}

function OfficesSection({ values }: { values: Office[] }) {
  const save = useSave();
  const [rows, setRows] = useState<Office[]>(values);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setRows(values), [values]);
  const update = (i: number, patch: Partial<Office>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const submit = async () => {
    const v: Record<string, string> = {};
    const codes = rows.map((r) => r.code.trim().toUpperCase());
    rows.forEach((r, i) => {
      if (!/^[A-Za-z0-9_-]{2,10}$/.test(r.code.trim())) v[`${i}.code`] = '2-10 letters, digits, - or _';
      else if (codes.indexOf(codes[i]) !== i) v[`${i}.code`] = 'Duplicate code';
      if (r.name.trim().length < 2) v[`${i}.name`] = 'Name is required';
      if (!r.timezone.trim()) v[`${i}.timezone`] = 'Time zone is required';
    });
    if (!rows.length) v._ = 'At least one office is required';
    setErrors(v);
    setError(v._ ?? '');
    if (Object.keys(v).length) return;
    setBusy(true);
    try {
      await save(
        { officeLocations: rows.map((r) => ({ code: r.code.trim().toUpperCase(), name: r.name.trim(), address: r.address?.trim() ?? '', timezone: r.timezone.trim(), active: r.active })) },
        'Office locations',
      );
    } catch (err) {
      setErrors(stripPrefix(fieldErrors(err), 'officeLocations'));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Office locations"
      actions={
        <>
          <Button size="sm" variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => setRows((r) => [...r, { code: '', name: '', address: '', timezone: 'Asia/Kolkata', active: true }])}>
            Add office
          </Button>
          <Button size="sm" onClick={submit} loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <Alert tone="warn">Prefer marking an office inactive over removing it: existing employees, drivers and bookings keep referring to its code.</Alert>
      <div className="mt-3 space-y-3">
        {rows.map((r, i) => (
          <fieldset key={i} className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-2 lg:grid-cols-12">
            <legend className="sr-only">Office {i + 1}</legend>
            <Input className="lg:col-span-2" label="Code" value={r.code} onChange={(e) => update(i, { code: e.target.value.toUpperCase() })} error={errors[`${i}.code`]} required />
            <Input className="lg:col-span-3" label="Name" value={r.name} onChange={(e) => update(i, { name: e.target.value })} error={errors[`${i}.name`]} required />
            <Input className="lg:col-span-3" label="Address" value={r.address ?? ''} onChange={(e) => update(i, { address: e.target.value })} error={errors[`${i}.address`]} />
            <Input className="lg:col-span-2" label="Time zone (IANA)" value={r.timezone} onChange={(e) => update(i, { timezone: e.target.value })} error={errors[`${i}.timezone`]} required />
            <div className="flex items-end justify-between gap-2 lg:col-span-2">
              <Checkbox label="Active" checked={r.active} onChange={(e) => update(i, { active: e.target.checked })} className="pb-2" />
              <Button size="sm" variant="ghost" aria-label={`Remove office ${r.code || i + 1}`} icon={<Trash2 className="h-4 w-4" />} onClick={() => setRows((x) => x.filter((_, j) => j !== i))} />
            </div>
          </fieldset>
        ))}
      </div>
      {error && (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
    </Card>
  );
}

function ShiftsSection({ values }: { values: Shift[] }) {
  const save = useSave();
  const [rows, setRows] = useState<Shift[]>(values);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setRows(values), [values]);
  const update = (i: number, patch: Partial<Shift>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const submit = async () => {
    const v: Record<string, string> = {};
    const codes = rows.map((r) => r.code.trim().toUpperCase());
    rows.forEach((r, i) => {
      if (!/^[A-Za-z0-9_-]{2,20}$/.test(r.code.trim())) v[`${i}.code`] = '2-20 letters, digits, - or _';
      else if (codes.indexOf(codes[i]) !== i) v[`${i}.code`] = 'Duplicate code';
      if (r.name.trim().length < 2) v[`${i}.name`] = 'Name is required';
      if (!!r.startTime !== !!r.endTime) v[`${i}.${r.startTime ? 'endTime' : 'startTime'}`] = 'Set both start and end';
      if (r.startTime && !r.defaultPickupTime) v[`${i}.defaultPickupTime`] = 'Set the cab time';
    });
    setErrors(v);
    setError('');
    if (Object.keys(v).length) return;
    setBusy(true);
    try {
      await save(
        {
          shifts: rows.map((r) => ({ code: r.code.trim().toUpperCase(), name: r.name.trim(), startTime: r.startTime ?? '', endTime: r.endTime ?? '', direction: r.direction, defaultPickupTime: r.defaultPickupTime ?? '', active: r.active })),
        },
        'Shifts',
      );
    } catch (err) {
      setErrors(stripPrefix(fieldErrors(err), 'shifts'));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Shifts"
      actions={
        <>
          <Button size="sm" variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => setRows((r) => [...r, { code: '', name: '', startTime: '', endTime: '', direction: 'FROM_OFFICE', defaultPickupTime: '', active: true }])}>
            Add shift
          </Button>
          <Button size="sm" onClick={submit} loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {!rows.length && <p className="text-sm text-slate-500">No shifts configured.</p>}
        {rows.map((r, i) => (
          <fieldset key={i} className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-2 lg:grid-cols-12">
            <legend className="sr-only">Shift {i + 1}</legend>
            <Input className="lg:col-span-2" label="Code" value={r.code} onChange={(e) => update(i, { code: e.target.value.toUpperCase() })} error={errors[`${i}.code`]} required />
            <Input className="lg:col-span-3" label="Name" value={r.name} onChange={(e) => update(i, { name: e.target.value })} error={errors[`${i}.name`]} required />
            <Input className="lg:col-span-2" label="Shift starts" type="time" value={r.startTime ?? ''} onChange={(e) => update(i, { startTime: e.target.value })} error={errors[`${i}.startTime`]} />
            <Input className="lg:col-span-2" label="Shift ends" type="time" value={r.endTime ?? ''} onChange={(e) => update(i, { endTime: e.target.value })} error={errors[`${i}.endTime`]} />
            <Select className="lg:col-span-3" label="Cab trip" value={r.direction} onChange={(e) => update(i, { direction: e.target.value })}>
              <option value="FROM_OFFICE">Office → Home</option>
              <option value="TO_OFFICE">Home → Office</option>
              <option value="ANY">Either</option>
            </Select>
            <Input
              className="lg:col-span-2"
              label="Cab time"
              type="time"
              value={r.defaultPickupTime ?? ''}
              onChange={(e) => update(i, { defaultPickupTime: e.target.value })}
              error={errors[`${i}.defaultPickupTime`]}
            />
            <div className="flex items-end justify-between gap-2 lg:col-span-2">
              <Checkbox label="Active" checked={r.active} onChange={(e) => update(i, { active: e.target.checked })} className="pb-2" />
              <Button size="sm" variant="ghost" aria-label={`Remove shift ${r.code || i + 1}`} icon={<Trash2 className="h-4 w-4" />} onClick={() => setRows((x) => x.filter((_, j) => j !== i))} />
            </div>
          </fieldset>
        ))}
      </div>
      {error && (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
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

  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} onRetry={refetch} />;

  return (
    <>
      <PageHeader
        title="Booking policy"
        subtitle={
          <>
            Version <strong>{data.version}</strong>
            {data.updatedAt ? ` · last updated ${fmtDateTime(data.updatedAt)}` : ''}. Each section saves independently and every change is recorded in the audit log.
          </>
        }
      />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {SECTIONS.map((s) => (
          <RuleSection key={s.key} def={s} values={data[s.key] as unknown as Record<string, unknown>} />
        ))}
      </div>
      <div className="mt-4 space-y-4">
        <NotificationsSection values={data.notifications ?? {}} />
        <OfficesSection values={data.officeLocations} />
        <ShiftsSection values={data.shifts} />
      </div>
    </>
  );
}
