import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCheck } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, EmptyState, ErrorState, PageHeader, Pagination, Spinner, cn } from '../../components/ui';
import { get, post, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtRelative } from '../../lib/format';

type N = { _id: string; type: string; title: string; body: string; data: Record<string, string>; readAt: string | null; createdAt: string };

// One list, newest first; unread ones are highlighted.
export default function Notifications() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [marking, setMarking] = useState(false);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['notifications', 'all', page],
    queryFn: () => get<{ items: N[]; total: number; unread: number; pageSize: number }>(`/notifications${qs({ page })}`),
  });

  const open = async (n: N) => {
    if (!n.readAt) await post(`/notifications/${n._id}/read`);
    qc.invalidateQueries({ queryKey: ['notifications'] });
    const role = me?.user.role;
    if (n.data?.assignmentId && role === 'DRIVER') navigate(`/driver/rides/${n.data.assignmentId}`);
    else if (n.data?.bookingId && role === 'EMPLOYEE') navigate(`/employee/bookings/${n.data.bookingId}`);
    else if (n.data?.bookingId && (role === 'COORDINATOR' || role === 'ADMIN')) navigate(`/ops/bookings/${n.data.bookingId}`);
  };
  const readAll = async () => {
    setMarking(true);
    try {
      await post('/notifications/read-all');
      qc.invalidateQueries({ queryKey: ['notifications'] });
    } finally {
      setMarking(false);
    }
  };
  const unread = data?.unread ?? 0;

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle={unread ? `${unread} unread` : 'You are all caught up'}
        actions={
          <Button variant="secondary" onClick={readAll} loading={marking} disabled={!unread || marking} icon={<CheckCheck className="h-4 w-4" aria-hidden />}>
            Mark all as read
          </Button>
        }
      />
      <div>
        {isLoading ? (
          <Spinner />
        ) : error ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : !data?.items.length ? (
          <EmptyState title="No notifications yet" />
        ) : (
          <ul className="space-y-1">
            {data.items.map((n) => (
              <li key={n._id}>
                <button
                  onClick={() => open(n)}
                  className={cn(
                    'flex w-full gap-3 rounded-lg px-3 py-3 text-left',
                    n.readAt ? 'border border-slate-200 bg-white hover:bg-slate-50' : 'border-l-4 border-indigo-500 bg-indigo-50 hover:bg-indigo-100',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className={cn('block text-sm', n.readAt ? 'text-slate-700' : 'font-semibold text-slate-900')}>{n.title}</span>
                    <span className={cn('block text-sm', n.readAt ? 'text-slate-500' : 'text-slate-700')}>{n.body}</span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <span className="text-xs text-slate-400">{fmtRelative(n.createdAt)}</span>
                    {!n.readAt && <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-semibold uppercase text-white">New</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {data && <Pagination page={page} total={data.total} totalPages={Math.max(1, Math.ceil(data.total / data.pageSize))} onPage={setPage} />}
      </div>
    </>
  );
}
