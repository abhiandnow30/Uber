import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ClipboardList } from 'lucide-react';
import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, ErrorState, PageHeader, Select, Spinner, StatCard, cn } from '../../components/ui';
import { get, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { addDaysISO, fmtTravelDate, todayISO } from '../../lib/format';
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
    byStatus: Record<string, number>;
  };
  unacknowledgedAssignments: number;
  driversOnDuty: number;
  driversAvailable: number;
};



export default function OpsDashboard() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { timezone, offices } = useOpsOffices();
  const date = params.get('date') ?? '';
  const office = params.get('office') ?? '';
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['ops', 'dashboard', date, office],
    queryFn: ({ signal }) => get<Dashboard>(`/ops/dashboard${qs({ date, officeLocation: office })}`, signal),
  });
  const shownDate = date || data?.date || todayISO(timezone);
  const bookingsUrl = (status: string, extra: Record<string, string> = {}) => `/ops/bookings${qs({ status: status || 'ALL', date: shownDate, office, ...extra })}`;

  const b = data?.bookings;
  const waiting = (b?.pendingAssignment ?? 0) + (b?.pendingApproval ?? 0);
  const waitingStatus = b?.pendingApproval ? 'REQUESTED,APPROVED,PENDING_APPROVAL' : 'REQUESTED,APPROVED';
  const unconfirmed = data?.unacknowledgedAssignments ?? 0;
  const onTheRoad = (b?.assigned ?? 0) + (b?.activeTrips ?? 0);
  const officeLabel = office ? offices.find((o) => o.code === office)?.name ?? office : offices.length > 1 ? 'All my offices' : offices[0]?.name ?? '';

  return (
    <>
      <PageHeader title="Today" subtitle={[fmtTravelDate(shownDate), officeLabel].filter(Boolean).join(' · ')} />

      <div className="mb-6 flex flex-wrap items-end gap-3">
        <DayPicker value={shownDate} onChange={(v) => setParam('date', v)} label="Date" />
        {offices.length > 1 && <OfficeSelect value={office} onChange={(v) => setParam('office', v)} className="w-56" />}
        {isFetching && !isLoading && <span className="pb-2 text-xs text-slate-400">Updating…</span>}
      </div>

      {data?.offices && data.offices.length === 0 && (
        <div className="mb-4">
          <Alert tone="warn">You have no offices assigned yet. Ask an administrator to add your office to your profile.</Alert>
        </div>
      )}

      {isLoading ? (
        <Spinner />
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Waiting for a cab" value={waiting} tone={waiting ? 'warn' : 'default'} onClick={() => navigate(bookingsUrl(waitingStatus))} />
            <StatCard
              label="Driver hasn't confirmed"
              value={unconfirmed}
              tone={unconfirmed ? 'danger' : 'default'}
              onClick={() => navigate(bookingsUrl('ASSIGNED'))}
            />
            <StatCard label="On the road" value={onTheRoad} onClick={() => navigate(bookingsUrl('ASSIGNED,DRIVER_EN_ROUTE,ARRIVED,IN_PROGRESS'))} />
            <StatCard label="Completed" value={b?.completed ?? 0} tone="good" onClick={() => navigate(bookingsUrl('COMPLETED'))} />
          </div>

          <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium text-slate-900">
                {waiting ? `${waiting} ${waiting === 1 ? 'request is' : 'requests are'} waiting for a cab` : 'Every request has a cab'}
              </p>
              <p className="text-sm text-slate-500">
                <Link to={`/ops/drivers${qs({ availability: 'AVAILABLE' })}`} className="hover:underline">
                  {data?.driversAvailable ?? 0} {data?.driversAvailable === 1 ? 'driver' : 'drivers'} available now
                </Link>
              </p>
            </div>
            {waiting > 0 ? (
              <Link to={bookingsUrl(waitingStatus)}>
                <Button size="lg" className="w-full sm:w-auto" icon={<ClipboardList className="h-5 w-5" />}>
                  Assign cabs
                </Button>
              </Link>
            ) : (
              <Link to={bookingsUrl('')}>
                <Button variant="secondary">View all cab requests</Button>
              </Link>
            )}
          </div>

        </div>
      )}
    </>
  );
}
