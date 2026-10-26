import { ArrowLeft, Users } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, EmptyState, ErrorState, Pagination, Spinner, StatusBadge } from '../../components/ui';
import { qs } from '../../lib/api';
import { fmt12h, fmtDateTime, fmtTravelDate } from '../../lib/format';
import { usePaged } from '../../lib/hooks';

type HistoryRide = {
  assignmentId: string;
  assignmentStatus: string;
  completedAt?: string | null;
  endReason?: string | null;
  scheduledPickupAt: string;
  vehicle?: { registrationNumber?: string } | null;
  booking: {
    _id: string;
    reference: string;
    status: string;
    travelDate: string;
    pickupTime: string;
    pickupLocation: string;
    dropLocation: string;
    passengers: number;
  } | null;
};

export default function DriverHistory() {
  const [page, setPage] = useState(1);
  const { data, isLoading, error, refetch } = usePaged<HistoryRide>(['driver', 'history'], '/driver/rides/history', qs({ page, pageSize: 20 }));

  return (
    <div className="space-y-4">
      <Link to="/driver" className="inline-flex items-center gap-1 text-sm font-medium text-slate-600 hover:text-slate-900">
        <ArrowLeft className="h-4 w-4" aria-hidden /> My rides
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Ride history</h1>

      {isLoading ? (
        <Spinner />
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : !data?.items.length ? (
        <Card>
          <EmptyState title="No past rides yet" description="Completed, cancelled and reassigned rides will appear here." />
        </Card>
      ) : (
        <ul className="space-y-3">
          {data.items.map((r) => {
            const b = r.booking;
            return (
              <li key={r.assignmentId}>
                <Link to={`/driver/rides/${r.assignmentId}`} className="block rounded-xl border border-slate-200 bg-white p-4 shadow-xs hover:border-slate-300">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium text-slate-900">
                        {b ? `${fmtTravelDate(b.travelDate)} · ${fmt12h(b.pickupTime)}` : fmtDateTime(r.scheduledPickupAt)}
                      </p>
                      <p className="font-mono text-xs text-slate-500">{b?.reference ?? '—'}</p>
                    </div>
                    <StatusBadge status={r.assignmentStatus} />
                  </div>
                  {b && (
                    <p className="mt-2 text-sm text-slate-700">
                      {b.pickupLocation} → {b.dropLocation}
                    </p>
                  )}
                  <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate-500">
                    {b && (
                      <span className="inline-flex items-center gap-1">
                        <Users className="h-3.5 w-3.5" aria-hidden /> {b.passengers}
                      </span>
                    )}
                    {r.vehicle?.registrationNumber && <span>{r.vehicle.registrationNumber}</span>}
                    {r.completedAt && <span>Completed {fmtDateTime(r.completedAt)}</span>}
                  </p>
                  {r.endReason && r.assignmentStatus !== 'COMPLETED' && <p className="mt-1 text-xs text-slate-600">Reason: {r.endReason}</p>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {data && <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onPage={setPage} />}
    </div>
  );
}
