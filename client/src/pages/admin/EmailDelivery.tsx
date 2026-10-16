import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, Button, ConfirmDialog, DataTable, EmptyState, PageHeader, Pagination, SearchInput, StatusBadge, Tabs, type Column } from '../../components/ui';
import { post, type Paged } from '../../lib/api';
import { fmtDateTime, fmtRelative, humanize } from '../../lib/format';
import { useAction, useListState, usePaged } from '../../lib/hooks';

type OutboxItem = {
  _id: string;
  template: string;
  to: string;
  subject?: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt?: string;
  lastError?: string | null;
  provider?: string;
  acceptedAt?: string;
  deliveredAt?: string;
  relatedBooking?: { _id: string; reference: string } | null;
  createdAt: string;
};
type OutboxPage = Paged<OutboxItem> & { counts: Record<string, number> };

const TABS = ['', 'FAILED', 'RETRYING', 'PENDING', 'SENDING', 'ACCEPTED', 'DELIVERED', 'SKIPPED'] as const;
type TabValue = (typeof TABS)[number];

export default function EmailDelivery() {
  const [params, setParams] = useSearchParams();
  const initial = (TABS as readonly string[]).includes(params.get('status') ?? '') ? (params.get('status') as TabValue) : '';
  const list = useListState({ status: initial as string }, '', 25);
  const { data: raw, isLoading, error, refetch } = usePaged<OutboxItem>(['admin-outbox'], '/admin/outbox', list.query);
  const data = raw as OutboxPage | undefined;
  const [retrying, setRetrying] = useState<OutboxItem | null>(null);
  const retry = useAction((id: string) => post(`/admin/outbox/${id}/retry`), {
    success: 'Message queued for another attempt',
    invalidate: [['admin-outbox'], ['admin-dashboard']],
    silentError: true,
  });

  const counts = data?.counts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const setTab = (v: TabValue) => {
    list.setFilter('status', v);
    const next = new URLSearchParams(params);
    if (v) next.set('status', v);
    else next.delete('status');
    setParams(next, { replace: true });
  };

  const columns: Column<OutboxItem>[] = [
    { key: 'created', header: 'Created', render: (m) => <span className="whitespace-nowrap">{fmtDateTime(m.createdAt)}</span> },
    {
      key: 'template',
      header: 'Template',
      render: (m) => (
        <div>
          <div className="whitespace-nowrap">{humanize(m.template)}</div>
          {m.subject && <div className="max-w-xs truncate text-xs text-slate-500">{m.subject}</div>}
        </div>
      ),
    },
    { key: 'to', header: 'To', render: (m) => <span className="break-all">{m.to}</span> },
    { key: 'status', header: 'Status', render: (m) => <StatusBadge status={m.status} /> },
    {
      key: 'attempts',
      header: 'Attempts',
      render: (m) => (
        <div className="whitespace-nowrap">
          {m.attempts}/{m.maxAttempts}
          {m.status === 'RETRYING' && m.nextAttemptAt && <div className="text-xs text-slate-500">next {fmtRelative(m.nextAttemptAt)}</div>}
        </div>
      ),
    },
    { key: 'error', header: 'Last error', render: (m) => (m.lastError ? <span className="block max-w-xs wrap-break-word text-xs text-red-700">{m.lastError}</span> : <span className="text-slate-400">—</span>) },
    {
      key: 'booking',
      header: 'Booking',
      render: (m) =>
        m.relatedBooking ? (
          <Link to={`/ops/bookings/${m.relatedBooking._id}`} className="font-mono text-xs text-indigo-600 hover:underline">
            {m.relatedBooking.reference}
          </Link>
        ) : (
          <span className="text-slate-400">—</span>
        ),
    },
    { key: 'accepted', header: 'Accepted at', render: (m) => <span className="whitespace-nowrap">{fmtDateTime(m.acceptedAt)}</span> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      render: (m) =>
        m.status === 'FAILED' ? (
          <Button size="sm" variant="secondary" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => setRetrying(m)}>
            Retry
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader title="Email delivery" subtitle="Transactional emails queued by the system and their sending status." />
      <div className="mb-4">
        <Alert tone="info">
          “Accepted” means Microsoft Graph accepted the message for delivery; it is not proof of delivery. Failed messages exhausted their retries or hit a permanent error and
          can be retried manually.
        </Alert>
      </div>
      <Tabs
        tabs={TABS.map((s) => ({
          value: s,
          label: s ? `${humanize(s)} (${counts[s] ?? 0})` : `All (${total})`,
        }))}
        value={list.filters.status as TabValue}
        onChange={setTab}
      />
      <div className="mb-3 max-w-md">
        <SearchInput value={list.q} onChange={list.setSearch} placeholder="Search recipient email" />
      </div>
      <DataTable
        columns={columns}
        rows={data?.items}
        rowKey={(m) => m._id}
        loading={isLoading}
        error={error}
        onRetry={refetch}
        empty={<EmptyState title={list.filters.status === 'FAILED' ? 'No failed emails' : 'No messages'} description={list.q ? 'Try a different recipient.' : undefined} />}
      />
      {data && <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onPage={list.setPage} />}

      <ConfirmDialog
        open={!!retrying}
        onClose={() => setRetrying(null)}
        title="Retry sending this email?"
        tone="primary"
        confirmLabel="Retry"
        message={
          <p>
            The “{humanize(retrying?.template)}” email to <strong>{retrying?.to}</strong> is queued again with a fresh set of attempts. Make sure the underlying problem (e.g. an invalid
            address or mail configuration) has been fixed first.
          </p>
        }
        onConfirm={() => retry.mutateAsync(retrying!._id)}
      />
    </>
  );
}
