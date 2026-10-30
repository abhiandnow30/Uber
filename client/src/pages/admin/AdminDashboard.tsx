import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, ClipboardList, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Card, EmptyState, ErrorState, PageHeader, Spinner, StatCard } from '../../components/ui';
import { get, qs } from '../../lib/api';
import { fmtDateTime, fmtRelative, fmtTravelDate, humanize } from '../../lib/format';
import { usePolicy } from '../../lib/policy';

type Dashboard = {
  date: string;
  officeLocation: string | null;
  employees: { total: number; active: number; invited: number; inactive: number };
  activeCoordinators: number;
  activeVerifiedDrivers: number;
  vehicles: { total: number; available: number };
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
  cancellationRequests: number;
  recentActivity: Array<{ _id: string; action: string; summary?: string; actorEmail?: string; actorRole?: string; createdAt: string }>;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export default function AdminDashboard() {
  const navigate = useNavigate();
  const policy = usePolicy();
  const [date, setDate] = useState('');
  const [office, setOffice] = useState('');
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-dashboard', date, office],
    queryFn: ({ signal }) => get<Dashboard>(`/admin/dashboard${qs({ date, officeLocation: office })}`, signal),
    refetchInterval: 60_000,
  });

  const day = data?.date ?? date;
  const bookingsUrl = (status?: string) => `/ops/bookings${qs({ date: day, office, status: status || 'ALL' })}`;
  const officeName = office ? policy.data?.officeLocations.find((o) => o.code === office)?.name ?? office : '';

  const attention: Array<{ key: string; text: string; action: string; to: string }> = [];
  if (data) {
    const b = data.bookings;
    if (b.pendingAssignment > 0)
      attention.push({ key: 'assign', text: `${plural(b.pendingAssignment, 'cab request is', 'cab requests are')} waiting for a cab`, action: 'Assign cabs', to: bookingsUrl('REQUESTED,APPROVED') });
    if (b.pendingApproval > 0)
      attention.push({ key: 'approval', text: `${plural(b.pendingApproval, 'cab request needs', 'cab requests need')} approval`, action: 'Review', to: bookingsUrl('PENDING_APPROVAL') });
    if (data.cancellationRequests > 0)
      attention.push({
        key: 'cancel-requests',
        text: `${plural(data.cancellationRequests, 'employee has', 'employees have')} asked to cancel an assigned ride`,
        action: 'Review',
        to: `/ops/bookings${qs({ date: 'all', status: 'ALL', cancellationRequested: 'true' })}`,
      });
    if (data.employees.invited > 0)
      attention.push({ key: 'invited', text: `${plural(data.employees.invited, 'invited employee has', 'invited employees have')} not activated their account yet`, action: 'View', to: '/admin/employees?status=INVITED' });
  }

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={data ? `Today at a glance · ${fmtTravelDate(data.date)} · ${officeName || 'all offices'}` : 'Today at a glance'}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              aria-label="Date"
              value={date || data?.date || ''}
              onChange={(e) => setDate(e.target.value)}
              className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm shadow-xs focus:border-indigo-500"
            />
            <select
              aria-label="Office"
              value={office}
              onChange={(e) => setOffice(e.target.value)}
              className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm shadow-xs focus:border-indigo-500"
            >
              <option value="">All offices</option>
              {policy.data?.officeLocations.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.name}
                </option>
              ))}
            </select>
            {(date || office) && (
              <Button size="sm" variant="ghost" onClick={() => { setDate(''); setOffice(''); }}>
                Reset
              </Button>
            )}
          </div>
        }
      />

      {isLoading ? (
        <Spinner />
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : !data ? (
        <EmptyState title="Nothing to show yet" />
      ) : (
        <div className="space-y-6">
          <Card title="Needs your attention">
            {!attention.length ? (
              <div className="flex items-center gap-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900" role="status">
                <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
                All good — nothing needs your attention.
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {attention.map((a) => (
                  <li key={a.key} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <span className="text-sm text-slate-900">{a.text}</span>
                    <Link to={a.to}>
                      <Button size="sm" variant="secondary">
                        {a.action}
                      </Button>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <section aria-labelledby="today-heading">
            <h2 id="today-heading" className="mb-2 text-base font-semibold text-slate-800">
              Today
            </h2>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard label="Cab requests" value={data.bookings.total} onClick={() => navigate(bookingsUrl())} />
              <StatCard
                label="Waiting for a cab"
                value={data.bookings.pendingAssignment + data.bookings.pendingApproval}
                tone={data.bookings.pendingAssignment + data.bookings.pendingApproval ? 'warn' : 'default'}
                onClick={() => navigate(bookingsUrl(data.bookings.pendingApproval ? 'REQUESTED,APPROVED,PENDING_APPROVAL' : 'REQUESTED,APPROVED'))}
              />
              <StatCard
                label="On the road"
                value={data.bookings.assigned + data.bookings.activeTrips}
                onClick={() => navigate(bookingsUrl('ASSIGNED,DRIVER_EN_ROUTE,ARRIVED,IN_PROGRESS'))}
              />
              <StatCard label="Completed" value={data.bookings.completed} tone="good" onClick={() => navigate(bookingsUrl('COMPLETED'))} />
            </div>
          </section>

          <Card title="Quick actions">
            <div className="flex flex-wrap gap-2">
              <Link to="/admin/employees">
                <Button icon={<UserPlus className="h-4 w-4" />}>Add employee</Button>
              </Link>
              <Link to="/ops/bookings">
                <Button variant="secondary" icon={<ClipboardList className="h-4 w-4" />}>
                  View cab requests
                </Button>
              </Link>
            </div>
          </Card>

          <Card
            title="Recent activity"
            actions={
              <Link to="/admin/audit" className="inline-flex items-center gap-1 text-sm font-medium text-indigo-600 hover:underline">
                View all <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            }
          >
            {!data.recentActivity.length ? (
              <EmptyState title="No activity yet" />
            ) : (
              <ul className="divide-y divide-slate-100">
                {data.recentActivity.slice(0, 5).map((a) => (
                  <li key={a._id} className="flex items-start justify-between gap-3 py-2">
                    <p className="min-w-0 text-sm text-slate-900" title={a.actorEmail ? `By ${a.actorEmail}` : undefined}>
                      {a.summary || humanize(a.action)}
                    </p>
                    <span className="shrink-0 text-xs text-slate-400" title={fmtDateTime(a.createdAt)}>
                      {fmtRelative(a.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
