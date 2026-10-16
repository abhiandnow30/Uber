import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, EmptyState, ErrorState, PageHeader, Pagination, Spinner, Tabs, cn } from '../../components/ui';
import { get, post, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtRelative } from '../../lib/format';

type N = { _id: string; type: string; title: string; body: string; data: Record<string, string>; readAt: string | null; createdAt: string };

export default function Notifications() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'all' | 'unread'>('unread');
  const [page, setPage] = useState(1);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['notifications', tab, page],
    queryFn: () => get<{ items: N[]; total: number; unread: number; pageSize: number }>(`/notifications${qs({ unreadOnly: tab === 'unread', page })}`),
  });

  const markRead = async (n: N) => {
    if (!n.readAt) await post(`/notifications/${n._id}/read`);
    qc.invalidateQueries({ queryKey: ['notifications'] });
    const role = me?.user.role;
    if (n.data?.assignmentId && role === 'DRIVER') navigate(`/driver/rides/${n.data.assignmentId}`);
    else if (n.data?.bookingId && role === 'EMPLOYEE') navigate(`/employee/bookings/${n.data.bookingId}`);
    else if (n.data?.bookingId && (role === 'COORDINATOR' || role === 'ADMIN')) navigate(`/ops/bookings/${n.data.bookingId}`);
  };
  const readAll = async () => {
    await post('/notifications/read-all');
    qc.invalidateQueries({ queryKey: ['notifications'] });
  };

  return (
    <>
      <PageHeader title="Notifications" actions={data?.unread ? <Button variant="secondary" onClick={readAll}>Mark all as read</Button> : null} />
      <Tabs tabs={[{ value: 'unread', label: `Unread${data?.unread ? ` (${data.unread})` : ''}` }, { value: 'all', label: 'All' }]} value={tab} onChange={(v) => { setTab(v); setPage(1); }} />
      <Card>
        {isLoading ? (
          <Spinner />
        ) : error ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : !data?.items.length ? (
          <EmptyState title={tab === 'unread' ? 'You are all caught up' : 'No notifications yet'} />
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.items.map((n) => (
              <li key={n._id}>
                <button onClick={() => markRead(n)} className={cn('flex w-full gap-3 px-1 py-3 text-left hover:bg-slate-50', !n.readAt && 'font-medium')}>
                  <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-indigo-500')} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-slate-900">{n.title}</span>
                    <span className="block text-sm font-normal text-slate-600">{n.body}</span>
                  </span>
                  <span className="shrink-0 text-xs font-normal text-slate-400">{fmtRelative(n.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {data && <Pagination page={page} total={data.total} totalPages={Math.max(1, Math.ceil(data.total / data.pageSize))} onPage={setPage} />}
      </Card>
    </>
  );
}
