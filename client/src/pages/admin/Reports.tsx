import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button, Card, DataTable, EmptyState, ErrorState, Input, PageHeader, Select, Spinner, StatCard, type Column } from '../../components/ui';
import { download, get, qs } from '../../lib/api';
import { addDaysISO, humanize, todayISO } from '../../lib/format';
import { usePolicy } from '../../lib/policy';

type Period = { _id: string; requests: number; assigned: number; completed: number; cancelled: number; rejected: number; noShow: number; delayed: number; passengers: number };
type Util = { id: string; name: string; assignments: number; completed: number; declined: number; noShow: number; reassigned: number; tripMinutes: number; lateArrivals: number };
type Report = {
  query: { from: string; to: string; granularity: string; officeLocation?: string };
  totals: Partial<Record<'requests' | 'assigned' | 'completed' | 'cancelled' | 'rejected' | 'noShow' | 'delayed' | 'passengers', number>>;
  periods: Period[];
  cancellations: Array<{ _id: { role?: string | null; reason?: string | null }; n: number }>;
  drivers: Util[];
  vehicles: Util[];
};
type Section = 'periods' | 'drivers' | 'vehicles' | 'cancellations';

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');

function utilColumns(label: string): Column<Util>[] {
  return [
    { key: 'name', header: label, render: (r) => <span className="whitespace-nowrap font-medium text-slate-900">{r.name}</span> },
    { key: 'assignments', header: 'Assignments', render: (r) => r.assignments },
    { key: 'completed', header: 'Completed', render: (r) => r.completed },
    { key: 'rate', header: 'Completion', render: (r) => pct(r.completed, r.assignments) },
    { key: 'declined', header: 'Declined', render: (r) => r.declined },
    { key: 'noShow', header: 'No-show', render: (r) => r.noShow },
    { key: 'reassigned', header: 'Reassigned', render: (r) => r.reassigned },
    { key: 'minutes', header: 'Trip hours', render: (r) => (r.tripMinutes / 60).toFixed(1) },
    { key: 'late', header: 'Late arrivals', render: (r) => r.lateArrivals },
  ];
}

export default function Reports() {
  const policy = usePolicy();
  const today = todayISO();
  const [from, setFrom] = useState(addDaysISO(today, -6));
  const [to, setTo] = useState(today);
  const [granularity, setGranularity] = useState<'day' | 'week' | 'month'>('day');
  const [office, setOffice] = useState('');
  const invalidRange = !from || !to || from > to;
  const params = { from, to, granularity, officeLocation: office };
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['admin-reports', params],
    queryFn: ({ signal }) => get<Report>(`/admin/reports${qs(params)}`, signal),
    enabled: !invalidRange,
  });

  const exportButtons = (section: Section) => (
    <>
      <Button size="sm" variant="secondary" icon={<Download className="h-3.5 w-3.5" />} onClick={() => download('/admin/reports/export' + qs({ ...params, section, format: 'csv' }))}>
        CSV
      </Button>
      <Button size="sm" variant="secondary" icon={<Download className="h-3.5 w-3.5" />} onClick={() => download('/admin/reports/export' + qs({ ...params, section, format: 'xlsx' }))}>
        Excel
      </Button>
    </>
  );

  const periodColumns: Column<Period>[] = [
    { key: 'period', header: 'Period', render: (p) => <span className="whitespace-nowrap font-mono text-xs">{p._id}</span> },
    { key: 'requests', header: 'Requests', render: (p) => p.requests },
    { key: 'assigned', header: 'Assigned', render: (p) => p.assigned },
    { key: 'completed', header: 'Completed', render: (p) => p.completed },
    { key: 'cancelled', header: 'Cancelled', render: (p) => p.cancelled },
    { key: 'rejected', header: 'Rejected', render: (p) => p.rejected },
    { key: 'noShow', header: 'No-show', render: (p) => p.noShow },
    { key: 'delayed', header: 'Delayed', render: (p) => p.delayed },
    { key: 'passengers', header: 'Passengers', render: (p) => p.passengers },
  ];
  const cancelColumns: Column<Report['cancellations'][number]>[] = [
    { key: 'role', header: 'Cancelled by', render: (c) => humanize(c._id.role ?? 'UNKNOWN') },
    { key: 'reason', header: 'Reason', render: (c) => c._id.reason || <span className="text-slate-400">No reason given</span> },
    { key: 'n', header: 'Count', render: (c) => c.n },
  ];

  const t = data?.totals ?? {};
  const max = Math.max(1, ...(data?.periods.map((p) => p.requests) ?? [0]));

  const section = (title: string, s: Section, body: ReactNode) => (
    <Card title={title} actions={exportButtons(s)} className="mt-4">
      {body}
    </Card>
  );

  return (
    <>
      <PageHeader title="Reports" subtitle="Booking volume, fulfilment and fleet utilisation by travel date." />
      <Card className="mb-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Input label="From" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} error={invalidRange && from && to ? '“From” must be on or before “To”' : undefined} />
          <Input label="To" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          <Select label="Group by" value={granularity} onChange={(e) => setGranularity(e.target.value as 'day' | 'week' | 'month')}>
            <option value="day">Day</option>
            <option value="week">Week (ISO)</option>
            <option value="month">Month</option>
          </Select>
          <Select label="Office" value={office} onChange={(e) => setOffice(e.target.value)}>
            <option value="">All offices</option>
            {policy.data?.officeLocations.map((o) => (
              <option key={o.code} value={o.code}>
                {o.name} ({o.code})
              </option>
            ))}
          </Select>
        </div>
      </Card>

      {invalidRange ? (
        <EmptyState title="Choose a valid date range" />
      ) : isLoading ? (
        <Spinner />
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : !data ? null : (
        <div aria-busy={isFetching}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Requests" value={t.requests ?? 0} hint={`${t.passengers ?? 0} passengers`} />
            <StatCard label="Assigned" value={t.assigned ?? 0} hint={`${pct(t.assigned ?? 0, t.requests ?? 0)} of requests`} />
            <StatCard label="Completed" value={t.completed ?? 0} tone="good" hint={`${pct(t.completed ?? 0, t.requests ?? 0)} of requests`} />
            <StatCard label="Delayed" value={t.delayed ?? 0} tone={t.delayed ? 'warn' : 'default'} />
            <StatCard label="Cancelled" value={t.cancelled ?? 0} />
            <StatCard label="Rejected" value={t.rejected ?? 0} />
            <StatCard label="No-show" value={t.noShow ?? 0} tone={t.noShow ? 'warn' : 'default'} />
          </div>

          {section(
            'Requests by period',
            'periods',
            !data.periods.length ? (
              <EmptyState title="No bookings in this range" />
            ) : (
              <>
                <div className="mb-4 space-y-1.5" aria-label="Requests versus completed per period">
                  <div className="flex gap-4 text-xs text-slate-500">
                    <span className="inline-flex items-center gap-1">
                      <span className="h-2.5 w-2.5 rounded-xs bg-slate-300" aria-hidden /> Requests
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="h-2.5 w-2.5 rounded-xs bg-emerald-500" aria-hidden /> Completed
                    </span>
                  </div>
                  {data.periods.map((p) => (
                    <div key={p._id} className="flex items-center gap-2 text-xs">
                      <span className="w-20 shrink-0 font-mono text-slate-600">{p._id}</span>
                      <div className="relative h-4 flex-1 rounded-sm bg-slate-50" title={`${p.requests} requests, ${p.completed} completed`}>
                        <div className="absolute inset-y-0 left-0 rounded-sm bg-slate-300" style={{ width: `${(p.requests / max) * 100}%` }} />
                        <div className="absolute inset-y-0 left-0 rounded-sm bg-emerald-500" style={{ width: `${(p.completed / max) * 100}%` }} />
                      </div>
                      <span className="w-16 shrink-0 text-right text-slate-600">
                        {p.completed}/{p.requests}
                      </span>
                    </div>
                  ))}
                </div>
                <DataTable columns={periodColumns} rows={data.periods} rowKey={(p) => p._id} />
              </>
            ),
          )}
          {section('Driver utilisation', 'drivers', <DataTable columns={utilColumns('Driver')} rows={data.drivers} rowKey={(r) => r.id} empty={<EmptyState title="No driver assignments in this range" />} />)}
          {section('Vehicle utilisation', 'vehicles', <DataTable columns={utilColumns('Vehicle')} rows={data.vehicles} rowKey={(r) => r.id} empty={<EmptyState title="No vehicle assignments in this range" />} />)}
          <div className="grid grid-cols-1 gap-x-4 lg:grid-cols-2">
            {section(
              'Cancellations',
              'cancellations',
              <DataTable columns={cancelColumns} rows={data.cancellations} rowKey={(c) => `${c._id.role}|${c._id.reason}`} empty={<EmptyState title="No cancellations" />} />,
            )}
          </div>
        </div>
      )}
    </>
  );
}
