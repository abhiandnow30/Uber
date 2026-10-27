import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Car, CheckCircle2, ChevronLeft, ChevronRight, Users } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, ErrorState, PageHeader, Select, Spinner, StatCard, cn } from '../../components/ui';
import { get, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { addDaysISO, fmt12h, fmtShortDate, fmtTravelDate, todayISO } from '../../lib/format';
import { usePolicy, type Office } from '../../lib/policy';

// ---------------------------------------------------------------------------
// Shared helpers for the operations pages
// ---------------------------------------------------------------------------

/**
 * Offices the current user may operate on. Admins: every office in the policy.
 * Coordinators: only the offices assigned to them (profile.officeLocations).
 */
export function useOpsOffices() {
  const { me } = useAuth();
  const policy = usePolicy();
  const isAdmin = me?.user.role === 'ADMIN';
  const offices = useMemo<Office[]>(() => {
    const all = policy.data?.officeLocations ?? [];
    if (isAdmin) return all;
    const mine = ((me?.profile as { officeLocations?: string[] } | null)?.officeLocations ?? []).map((s) => s.toUpperCase());
    return all.filter((o) => mine.includes(o.code));
  }, [policy.data, isAdmin, me]);
  const timezone = offices[0]?.timezone ?? policy.data?.officeLocations[0]?.timezone ?? 'Asia/Kolkata';
  return { offices, isAdmin, timezone, policy: policy.data, loading: policy.isLoading };
}

/** Office filter select; "All offices" means all offices in the user's scope. */
export function OfficeSelect({ value, onChange, label = 'Office', allLabel = 'All my offices', className }: { value: string; onChange: (v: string) => void; label?: string; allLabel?: string; className?: string }) {
  const { offices, isAdmin } = useOpsOffices();
  return (
    <Select label={label} value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      <option value="">{isAdmin ? 'All offices' : allLabel}</option>
      {offices.map((o) => (
        <option key={o.code} value={o.code}>
          {o.name} ({o.code})
        </option>
      ))}
    </Select>
  );
}

/** Date picker with previous/next day buttons. */
export function DayPicker({ value, onChange, allowAll, label = 'Travel date' }: { value: string; onChange: (v: string) => void; allowAll?: boolean; label?: string }) {
  const { timezone } = useOpsOffices();
  const today = todayISO(timezone);
  return (
    <div className="space-y-1">
      <span className="block text-sm font-medium text-slate-700">{label}</span>
      <div className="flex flex-wrap items-center gap-1">
        <Button variant="secondary" size="sm" className="h-10" aria-label="Previous day" disabled={!value} onClick={() => onChange(addDaysISO(value || today, -1))} icon={<ChevronLeft className="h-4 w-4" />} />
        <input
          type="date"
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm shadow-xs focus:border-indigo-500"
        />
        <Button variant="secondary" size="sm" className="h-10" aria-label="Next day" disabled={!value} onClick={() => onChange(addDaysISO(value || today, 1))} icon={<ChevronRight className="h-4 w-4" />} />
        {value !== today && (
          <Button variant="ghost" size="sm" className="h-10" onClick={() => onChange(today)}>
            Today
          </Button>
        )}
        {allowAll && value && (
          <Button variant="ghost" size="sm" className="h-10" onClick={() => onChange('')}>
            All dates
          </Button>
        )}
      </div>
    </div>
  );
}

/** Days until a date (negative when past). */
export function daysUntil(iso?: string | null) {
  if (!iso) return null;
  return Math.floor((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

/** Expiry date with colour warning: red when past or < warnDays away. */
export function ExpiryText({ iso, warnDays = 30 }: { iso?: string | null; warnDays?: number }) {
  if (!iso) return <span className="text-slate-400">—</span>;
  const d = daysUntil(iso)!;
  const text = new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  return (
    <span className={cn('whitespace-nowrap', d < 0 ? 'font-medium text-red-700' : d < warnDays ? 'font-medium text-red-600' : 'text-slate-700')} title={d < 0 ? 'Expired' : `${d} days left`}>
      {text}
      {d < 0 ? ' (expired)' : d < warnDays ? ` (${d}d)` : ''}
    </span>
  );
}

/** ISO → value for <input type="date">. */
export const toDateInput = (iso?: string | null) => (iso ? iso.slice(0, 10) : '');

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
type Dashboard = {
  date: string;
  offices: string[] | null;
  bookings: {
    total: number;
    pendingAssignment: number;
    pendingApproval: number;
    assigned: number;
    activeTrips: number;
    completed: number;
    cancelledOrRejected: number;
    delayed: number;
  };
  nextWaiting: Array<{
    _id: string;
    reference: string;
    travelDate: string;
    pickupTime: string;
    pickupLocation: string;
    dropLocation: string;
    status: string;
    employee?: { fullName: string; employeeId: string; route?: string } | null;
  }>;
  cancellationRequests: number;
  driversOnDuty: number;
  driversAvailable: number;
  cabs: { active: number; withoutDriver: number };
};

const WAITING = 'REQUESTED,APPROVED,PENDING_APPROVAL';
const ASSIGNED = 'ASSIGNED,DRIVER_EN_ROUTE,ARRIVED';
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The coordinator's night at a glance: what needs action, the next waiting rides, and the fleet. */
export default function OpsDashboard() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { offices } = useOpsOffices();
  const day: 'today' | 'tomorrow' = params.get('day') === 'tomorrow' ? 'tomorrow' : 'today';

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['ops', 'dashboard', day],
    queryFn: ({ signal }) => get<Dashboard>(`/ops/dashboard${qs({ day })}`, signal),
    refetchInterval: 60_000,
  });
  // Cab requests for this work day, on a given tab (and optionally only rows with a flag).
  const requestsUrl = (status: string, extra: Record<string, string> = {}) => `/ops/bookings${qs({ status, day: day === 'tomorrow' ? day : '', ...extra })}`;

  const b = data?.bookings;
  const waiting = (b?.pendingAssignment ?? 0) + (b?.pendingApproval ?? 0);
  const cancelAsks = data?.cancellationRequests ?? 0;
  const late = b?.delayed ?? 0;
  const dayLabel = day === 'today' ? "Today's shifts" : "Tomorrow's shifts";

  const actions: Array<{ key: string; tone: 'warn' | 'error'; text: string; button: string; to: string }> = [];
  if (waiting) actions.push({ key: 'waiting', tone: 'warn', text: `${plural(waiting, 'ride is', 'rides are')} waiting for a cab`, button: 'Assign cabs', to: requestsUrl(WAITING) });
  if (cancelAsks)
    actions.push({ key: 'cancel', tone: 'warn', text: `${plural(cancelAsks, 'employee wants', 'employees want')} to cancel an assigned ride`, button: 'Review', to: `/ops/bookings${qs({ date: 'all', status: ASSIGNED, cancellationRequested: 'true' })}` });
  if (late) actions.push({ key: 'late', tone: 'error', text: `${plural(late, 'ride is', 'rides are')} running late`, button: 'See rides', to: requestsUrl(`${ASSIGNED},IN_PROGRESS`, { delayed: 'true' }) });

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={data ? `${dayLabel} · ${fmtTravelDate(data.date)}${offices.length === 1 ? ` · ${offices[0].name}` : ''}` : dayLabel}
        actions={
          <div className="flex items-center gap-2">
            {isFetching && !isLoading && <span className="text-xs text-slate-400">Updating…</span>}
            <div className="inline-flex rounded-lg border border-slate-300 bg-white p-1" role="group" aria-label="Day">
              {(['today', 'tomorrow'] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={day === d}
                  onClick={() => setParams(d === 'today' ? {} : { day: d }, { replace: true })}
                  className={cn('min-h-9 rounded-md px-4 text-sm font-medium', day === d ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100')}
                >
                  {d === 'today' ? 'Today' : 'Tomorrow'}
                </button>
              ))}
            </div>
          </div>
        }
      />

      {data?.offices && data.offices.length === 0 && (
        <div className="mb-4">
          <Alert tone="warn">You have no offices assigned yet. Ask an administrator to add your office to your profile.</Alert>
        </div>
      )}

      {isLoading ? (
        <Spinner />
      ) : error || !data ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : (
        <div className="space-y-6">
          {/* 1. What needs action now */}
          {actions.length ? (
            <ul className="space-y-2" aria-label="Needs action">
              {actions.map((a) => (
                <li
                  key={a.key}
                  className={cn(
                    'flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 sm:p-4',
                    a.tone === 'error' ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50',
                  )}
                >
                  <span className={cn('flex items-center gap-2 font-medium', a.tone === 'error' ? 'text-red-900' : 'text-amber-900')}>
                    <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden /> {a.text}
                  </span>
                  <Link to={a.to}>
                    <Button size="sm" variant={a.key === 'waiting' ? 'primary' : 'secondary'}>
                      {a.button}
                    </Button>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900" role="status">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
              <span className="font-medium">All set — every ride {day === 'today' ? 'today' : 'tomorrow'} has a cab and nothing needs your attention.</span>
            </div>
          )}

          {/* 2. The day in four numbers */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Waiting for a cab" value={waiting} tone={waiting ? 'warn' : 'default'} onClick={() => navigate(requestsUrl(WAITING))} />
            <StatCard label="Cab assigned" value={b?.assigned ?? 0} onClick={() => navigate(requestsUrl(ASSIGNED))} />
            <StatCard label="On trip now" value={b?.activeTrips ?? 0} onClick={() => navigate(requestsUrl('IN_PROGRESS'))} />
            <StatCard label="Completed" value={b?.completed ?? 0} tone="good" hint={b?.cancelledOrRejected ? `${b.cancelledOrRejected} cancelled` : undefined} onClick={() => navigate(`/ops/history${qs({ status: 'COMPLETED' })}`)} />
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            {/* 3. Next rides that still need a cab */}
            <Card
              title="Next rides waiting for a cab"
              className="lg:col-span-2"
              actions={
                waiting > data.nextWaiting.length ? (
                  <Link to={requestsUrl(WAITING)} className="text-sm font-medium text-indigo-600 hover:underline">
                    See all {waiting}
                  </Link>
                ) : undefined
              }
            >
              {!data.nextWaiting.length ? (
                <p className="text-sm text-slate-500">No one is waiting for a cab {day === 'today' ? 'today' : 'tomorrow'}.</p>
              ) : (
                <ul className="-my-2 divide-y divide-slate-100">
                  {data.nextWaiting.map((r) => (
                    <li key={r._id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
                      <span className="w-20 shrink-0">
                        <span className="block font-semibold text-slate-900">{fmt12h(r.pickupTime)}</span>
                        <span className="block text-xs text-slate-500">{fmtShortDate(r.travelDate)}</span>
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-slate-900">
                          {r.employee?.fullName ?? '—'}
                          {r.employee?.route ? <span className="font-normal text-slate-500"> · {r.employee.route}</span> : null}
                        </span>
                        <span className="block truncate text-sm text-slate-500" title={`${r.pickupLocation} → ${r.dropLocation}`}>
                          {r.pickupLocation} → {r.dropLocation}
                        </span>
                      </span>
                      <Link to={requestsUrl(WAITING, { q: r.reference })}>
                        <Button size="sm" variant="secondary">
                          {r.status === 'PENDING_APPROVAL' ? 'Review' : 'Assign'}
                        </Button>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* 4. Can we cover them? */}
            <Card title="Fleet now">
              <dl className="space-y-3 text-sm">
                <FleetRow icon={<Users className="h-4 w-4" />} label="Drivers on duty" value={data.driversOnDuty} to="/ops/drivers" />
                <FleetRow icon={<Users className="h-4 w-4" />} label="Free to take a ride" value={data.driversAvailable} to={`/ops/drivers${qs({ availability: 'AVAILABLE' })}`} warn={waiting > 0 && data.driversAvailable === 0} />
                <FleetRow icon={<Car className="h-4 w-4" />} label="Active cabs" value={data.cabs.active} to="/ops/vehicles" />
                <FleetRow icon={<Car className="h-4 w-4" />} label="Cabs without a driver" value={data.cabs.withoutDriver} to="/ops/vehicles" warn={data.cabs.withoutDriver > 0} />
              </dl>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}

function FleetRow({ icon, label, value, to, warn }: { icon: ReactNode; label: string; value: number; to: string; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="flex items-center gap-2 text-slate-600">
        <span className="text-slate-400" aria-hidden>
          {icon}
        </span>
        {label}
      </dt>
      <dd>
        <Link to={to} className={cn('font-semibold hover:underline', warn ? 'text-amber-600' : 'text-slate-900')}>
          {value}
        </Link>
      </dd>
    </div>
  );
}
