import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Card, EmptyState, ErrorState, PageHeader, Pagination, Spinner, StatusBadge, Tabs, type Column, DataTable } from '../../components/ui';
import { qs } from '../../lib/api';
import { fmtTravelDate } from '../../lib/format';
import { usePaged } from '../../lib/hooks';

type Scope = 'upcoming' | 'past' | 'all';

type MyBooking = {
  _id: string;
  reference: string;
  status: string;
  travelDate: string;
  pickupTime: string;
  pickupLocation: string;
  dropLocation: string;
  passengers: number;
  tripType?: string;
  leg?: string;
  isDelayed?: boolean;
  currentAssignment?: {
    driver?: { fullName?: string; phone?: string } | null;
    vehicle?: { registrationNumber?: string; model?: string } | null;
  } | null;
};

const PAGE_SIZE = 10;

function Status({ b }: { b: MyBooking }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      <StatusBadge status={b.status} />
      {b.isDelayed && <StatusBadge status="DELAYED" />}
    </span>
  );
}

function Cab({ b }: { b: MyBooking }) {
  const a = b.currentAssignment;
  if (!a?.driver && !a?.vehicle) return <span className="text-slate-400">Not assigned yet</span>;
  return (
    <span>
      {a.driver?.fullName ?? '—'}
      {a.vehicle?.registrationNumber ? <span className="text-slate-500"> · {a.vehicle.registrationNumber}</span> : null}
    </span>
  );
}

export default function MyBookings() {
  const navigate = useNavigate();
  const [scope, setScope] = useState<Scope>('upcoming');
  const [page, setPage] = useState(1);
  const query = qs({ scope: scope === 'all' ? undefined : scope, page, pageSize: PAGE_SIZE });
  const { data, isLoading, error, refetch, isFetching } = usePaged<MyBooking>(['my-bookings', 'list'], '/me/bookings', query);

  const columns: Column<MyBooking>[] = [
    { key: 'ref', header: 'Reference', render: (b) => <span className="font-mono text-xs">{b.reference}</span> },
    { key: 'date', header: 'Date', render: (b) => <span className="whitespace-nowrap">{fmtTravelDate(b.travelDate)}</span> },
    { key: 'time', header: 'Pickup', render: (b) => b.pickupTime },
    {
      key: 'route',
      header: 'Route',
      render: (b) => (
        <span className="block max-w-xs truncate" title={`${b.pickupLocation} → ${b.dropLocation}`}>
          {b.pickupLocation} → {b.dropLocation}
        </span>
      ),
    },
    { key: 'status', header: 'Status', render: (b) => <Status b={b} /> },
    { key: 'cab', header: 'Driver / vehicle', render: (b) => <Cab b={b} /> },
  ];

  const empty = (
    <EmptyState
      title={scope === 'upcoming' ? 'No upcoming bookings' : scope === 'past' ? 'No past bookings' : 'No bookings yet'}
      action={scope !== 'past' ? <Button onClick={() => navigate('/employee/request')}>Request a cab</Button> : undefined}
    />
  );

  return (
    <>
      <PageHeader
        title="My bookings"
        actions={
          <Button icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => navigate('/employee/request')}>
            Request a cab
          </Button>
        }
      />
      <Tabs<Scope>
        tabs={[
          { value: 'upcoming', label: 'Upcoming' },
          { value: 'past', label: 'Past' },
          { value: 'all', label: 'All' },
        ]}
        value={scope}
        onChange={(v) => {
          setScope(v);
          setPage(1);
        }}
      />

      {/* Mobile: cards */}
      <div className="sm:hidden">
        {isLoading ? (
          <Spinner />
        ) : error ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : !data?.items.length ? (
          <Card>{empty}</Card>
        ) : (
          <ul className="space-y-3" aria-busy={isFetching || undefined}>
            {data.items.map((b) => (
              <li key={b._id}>
                <Link to={`/employee/bookings/${b._id}`} className="block rounded-xl border border-slate-200 bg-white p-4 shadow-xs hover:border-slate-300">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium text-slate-900">
                        {fmtTravelDate(b.travelDate)} · {b.pickupTime}
                      </p>
                      <p className="font-mono text-xs text-slate-500">{b.reference}</p>
                    </div>
                    <Status b={b} />
                  </div>
                  <p className="mt-2 text-sm text-slate-700">
                    {b.pickupLocation} → {b.dropLocation}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    <Cab b={b} />
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Desktop: table */}
      <div className="hidden sm:block">
        <DataTable columns={columns} rows={data?.items} rowKey={(b) => b._id} loading={isLoading} error={error} onRetry={refetch} empty={empty} onRowClick={(b) => navigate(`/employee/bookings/${b._id}`)} />
      </div>

      {data && <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onPage={setPage} />}
    </>
  );
}
