import { ChevronDown, ChevronRight } from 'lucide-react';
import { DateTime } from 'luxon';
import { Fragment, useState } from 'react';
import { Button, Card, EmptyState, ErrorState, Input, PageHeader, Pagination, SearchInput, Select, Spinner } from '../../components/ui';
import { fmtDateTime, humanize } from '../../lib/format';
import { useListState, usePaged } from '../../lib/hooks';

type AuditEntry = {
  _id: string;
  actor?: string;
  actorRole?: string;
  actorEmail?: string;
  action: string;
  entityType: string;
  entityId?: string;
  summary?: string;
  details?: unknown;
  ip?: string;
  userAgent?: string;
  createdAt: string;
};

const ENTITY_TYPES = ['AccessRequest', 'CabAssignment', 'CabRequest', 'Coordinator', 'Driver', 'DriverVehicleLink', 'EmailOutbox', 'Employee', 'ImportJob', 'Policy', 'Report', 'User', 'Vehicle'];
const ACTIONS = [
  'ACCESS_REQUEST_APPROVED', 'ACCESS_REQUEST_INFO_REQUESTED', 'ACCESS_REQUEST_REJECTED', 'ACCOUNT_STATUS_CHANGED', 'BOOKING_APPROVED', 'BOOKING_CREATED',
  'BOOKING_MARKED_DELAYED', 'BOOKING_REJECTED', 'COORDINATOR_CREATED', 'COORDINATOR_UPDATED', 'DRIVER_CREATED', 'DRIVER_UPDATED', 'DRIVER_VERIFICATION',
  'EMAIL_RETRY', 'EMPLOYEE_CREATED', 'EMPLOYEE_UPDATED', 'EMPLOYEES_EXPORTED', 'IMPORT_CANCELLED', 'IMPORT_COMMITTED', 'IMPORT_PREVIEWED', 'INVITATION_REVOKED',
  'INVITATION_SENT', 'PASSWORD_CHANGED', 'PIN_LOCKED', 'PIN_REGENERATED', 'POLICY_UPDATED', 'REPORT_EXPORTED', 'RIDE_ASSIGNED', 'RIDE_COMPLETED', 'RIDE_DECLINED',
  'RIDE_REASSIGNED', 'RIDE_STARTED', 'SUPPORT_OVERRIDE_START', 'VEHICLE_CREATED', 'VEHICLE_STATUS_CHANGED', 'VEHICLE_UPDATED',
];

/** datetime-local value (browser local time) → ISO instant for the API. */
const toIso = (v: string) => (v ? DateTime.fromISO(v).toUTC().toISO() ?? '' : '');

export default function Audit() {
  const list = useListState({ action: '', entityType: '', from: '', to: '' }, '', 25);
  const [fromLocal, setFromLocal] = useState('');
  const [toLocal, setToLocal] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const { data, isLoading, error, refetch, isFetching } = usePaged<AuditEntry>(['admin-audit'], '/admin/audit', list.query);

  const hasFilters = list.q || Object.values(list.filters).some(Boolean);

  return (
    <>
      <PageHeader title="Audit log" subtitle="Append-only record of administrative and operational actions." />
      <Card className="mb-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <span className="mb-1 block text-sm font-medium text-slate-700">Search</span>
            <SearchInput value={list.q} onChange={list.setSearch} placeholder="Summary, actor email or action" />
          </div>
          <div>
            <Input label="Action" list="audit-actions" value={list.filters.action} onChange={(e) => list.setFilter('action', e.target.value.toUpperCase().trim())} placeholder="Any action" />
            <datalist id="audit-actions">
              {ACTIONS.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </div>
          <Select label="Entity type" value={list.filters.entityType} onChange={(e) => list.setFilter('entityType', e.target.value)}>
            <option value="">All entities</option>
            {ENTITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          <Input
            label="From"
            type="datetime-local"
            value={fromLocal}
            onChange={(e) => {
              setFromLocal(e.target.value);
              list.setFilter('from', toIso(e.target.value));
            }}
          />
          <Input
            label="To"
            type="datetime-local"
            value={toLocal}
            onChange={(e) => {
              setToLocal(e.target.value);
              list.setFilter('to', toIso(e.target.value));
            }}
          />
        </div>
        {hasFilters && (
          <div className="mt-3 flex justify-end">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                list.setFilters({ action: '', entityType: '', from: '', to: '' });
                list.setSearch('');
                setFromLocal('');
                setToLocal('');
              }}
            >
              Clear filters
            </Button>
          </div>
        )}
      </Card>

      {error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : (
        <>
        {/* Phones and tablets: one card per entry instead of a wide table. */}
        <div className="lg:hidden" aria-busy={isFetching}>
          {isLoading ? (
            <div className="rounded-xl border border-slate-200 bg-white">
              <Spinner />
            </div>
          ) : !data?.items.length ? (
            <div className="rounded-xl border border-slate-200 bg-white">
              <EmptyState title={hasFilters ? 'No entries match these filters' : 'No audit entries yet'} />
            </div>
          ) : (
            <ul className="space-y-3">
              {data.items.map((a) => {
                const expanded = !!open[a._id];
                return (
                  <li key={a._id} className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
                    <div className="flex items-start justify-between gap-3">
                      <span className="break-all font-mono text-xs font-medium text-slate-900">{a.action}</span>
                      <span className="whitespace-nowrap text-xs text-slate-500">{fmtDateTime(a.createdAt)}</span>
                    </div>
                    <p className="mt-1 text-slate-700">{a.summary ?? '—'}</p>
                    <p className="mt-2 break-words text-xs text-slate-500">
                      {a.actorEmail ?? 'system'}
                      {a.actorRole ? ` · ${humanize(a.actorRole)}` : ''} · {a.entityType}
                    </p>
                    <button
                      className="mt-2 inline-flex min-h-10 items-center gap-1 text-sm font-medium text-indigo-600"
                      aria-expanded={expanded}
                      onClick={() => setOpen((o) => ({ ...o, [a._id]: !expanded }))}
                    >
                      {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      {expanded ? 'Hide details' : 'Show details'}
                    </button>
                    {expanded && (
                      <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
                        {JSON.stringify({ details: a.details ?? null, entityId: a.entityId, ip: a.ip, userAgent: a.userAgent }, null, 2)}
                      </pre>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="hidden overflow-x-auto rounded-xl border border-slate-200 bg-white lg:block" aria-busy={isFetching}>
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50">
              <tr>
                {['', 'Time', 'Actor', 'Action', 'Entity', 'Summary'].map((h, i) => (
                  <th key={i} scope="col" className="whitespace-nowrap px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {h || <span className="sr-only">Details</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {isLoading ? (
                <tr>
                  <td colSpan={6}>
                    <Spinner />
                  </td>
                </tr>
              ) : !data?.items.length ? (
                <tr>
                  <td colSpan={6}>
                    <EmptyState title={hasFilters ? 'No entries match these filters' : 'No audit entries yet'} />
                  </td>
                </tr>
              ) : (
                data.items.map((a) => {
                  const expanded = !!open[a._id];
                  return (
                    <Fragment key={a._id}>
                      <tr className="align-top">
                        <td className="px-2 py-2">
                          <button
                            className="rounded-sm p-1 text-slate-500 hover:bg-slate-100"
                            aria-expanded={expanded}
                            aria-label={expanded ? 'Hide details' : 'Show details'}
                            onClick={() => setOpen((o) => ({ ...o, [a._id]: !expanded }))}
                          >
                            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </button>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-slate-700">{fmtDateTime(a.createdAt)}</td>
                        <td className="px-3 py-2">
                          <div className="text-slate-900">{a.actorEmail ?? 'system'}</div>
                          {a.actorRole && <div className="text-xs text-slate-500">{humanize(a.actorRole)}</div>}
                        </td>
                        <td className="px-3 py-2">
                          <span className="font-mono text-xs">{a.action}</span>
                        </td>
                        <td className="px-3 py-2">
                          <div>{a.entityType}</div>
                          {a.entityId && <div className="font-mono text-xs text-slate-400">{a.entityId}</div>}
                        </td>
                        <td className="px-3 py-2 text-slate-700">{a.summary ?? '—'}</td>
                      </tr>
                      {expanded && (
                        <tr className="bg-slate-50">
                          <td />
                          <td colSpan={5} className="px-3 py-2">
                            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
                              {JSON.stringify({ details: a.details ?? null, entityId: a.entityId, ip: a.ip, userAgent: a.userAgent }, null, 2)}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        </>
      )}
      {data && <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onPage={list.setPage} />}
    </>
  );
}
