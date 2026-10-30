import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Pencil } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CallButton,
  Alert,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  DescriptionList,
  EmptyState,
  ErrorState,
  PageHeader,
  Spinner,
  StatusBadge,
  type Column,
} from '../../components/ui';
import { get, post } from '../../lib/api';
import { fmt12h, fmtDateTime, fmtTravelDate, humanize } from '../../lib/format';
import { useAction } from '../../lib/hooks';
import { DeleteEmployeeDialog, EmployeeFormModal, type EmployeeRow } from './Employees';

type Booking = {
  _id: string;
  reference: string;
  travelDate: string;
  pickupTime: string;
  pickupLocation: string;
  dropLocation: string;
  tripType?: string;
  status: string;
  officeLocation?: string;
  isDelayed?: boolean;
};

type EmployeeDetailData = EmployeeRow & {
  user: string;
  statusReason?: string;
  hasCredentials?: boolean;
  bookingCounts: Record<string, number>;
  bookings: Booking[];
  updatedAt?: string;
};

type ActionKey = 'activate' | 'deactivate' | 'suspend' | 'reinvite';

/** Admin-available actions per account status (mirrors server ACCOUNT_TRANSITIONS; INVITED→ACTIVE only via first Microsoft sign-in). */
const ACTIONS_BY_STATUS: Record<string, ActionKey[]> = {
  PENDING_ADMIN_REVIEW: ['reinvite'],
  INVITED: ['deactivate'],
  ACTIVE: ['suspend', 'deactivate'],
  SUSPENDED: ['activate', 'deactivate'],
  INACTIVE: ['activate', 'reinvite'],
  REJECTED: ['reinvite'],
};

export default function EmployeeDetail() {
  const { id = '' } = useParams();
  const [action, setAction] = useState<ActionKey | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-employee', id],
    queryFn: ({ signal }) => get<EmployeeDetailData>(`/admin/employees/${id}`, signal),
  });

  const invalidate = [['admin-employee', id], ['admin-employees'], ['admin-dashboard']];
  const setStatus = useAction((b: { status: string; reason?: string }) => post(`/admin/employees/${id}/status`, b), {
    success: (r) => `Account is now ${humanize((r as { status: string }).status)}`,
    invalidate,
    silentError: true,
  });

  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} onRetry={refetch} />;

  const status = data.status ?? '';
  // An INACTIVE account that never signed in goes back to "Invited" (active on first Microsoft sign-in).
  const available = (ACTIONS_BY_STATUS[status] ?? [])
    .filter((a) => !(status === 'INACTIVE' && ((a === 'activate' && !data.hasCredentials) || (a === 'reinvite' && data.hasCredentials))));
  const totalBookings = Object.values(data.bookingCounts).reduce((a, b) => a + b, 0);

  const actionDefs: Record<ActionKey, { label: string; variant: 'primary' | 'secondary' | 'danger' | 'success'; title: string; message: ReactNode; reasonLabel?: string; run: (reason: string) => Promise<unknown>; tone?: 'danger' | 'primary' }> = {
    activate: {
      label: 'Activate',
      variant: 'success',
      title: 'Activate account',
      tone: 'primary',
      message: (
        <>
          <p>{data.fullName} will be able to sign in and book cabs again.</p>
        </>
      ),
      run: () => setStatus.mutateAsync({ status: 'ACTIVE' }),
    },
    deactivate: {
      label: 'Deactivate',
      variant: 'danger',
      title: 'Deactivate account',
      message: (
        <>
          <p>{data.fullName} will be signed out everywhere and will no longer be able to sign in.</p>
          <p className="mt-2">Open or upcoming bookings are not cancelled automatically; they are flagged for review by operations.</p>
        </>
      ),
      reasonLabel: 'Reason (recorded in the audit log)',
      run: (reason) => setStatus.mutateAsync({ status: 'INACTIVE', reason }),
    },
    suspend: {
      label: 'Suspend',
      variant: 'danger',
      title: 'Suspend account',
      message: <p>{data.fullName} will be signed out and blocked from signing in until reactivated. Upcoming bookings are flagged for review.</p>,
      reasonLabel: 'Reason for suspension',
      run: (reason) => setStatus.mutateAsync({ status: 'SUSPENDED', reason }),
    },
    reinvite: {
      label: 'Re-invite',
      variant: 'primary',
      title: 'Re-invite employee',
      tone: 'primary',
      message: <p>The account moves to “Invited” and becomes active the next time {data.fullName} signs in with Microsoft.</p>,
      run: () => setStatus.mutateAsync({ status: 'INVITED' }),
    },
  };
  const current = action ? actionDefs[action] : null;

  const bookingColumns: Column<Booking>[] = [
    {
      key: 'ref',
      header: 'Reference',
      render: (b) => (
        <Link to={`/ops/bookings/${b._id}`} className="font-mono text-xs text-indigo-600 hover:underline">
          {b.reference}
        </Link>
      ),
    },
    { key: 'date', header: 'Travel date', render: (b) => <span className="whitespace-nowrap">{fmtTravelDate(b.travelDate)} {fmt12h(b.pickupTime)}</span> },
    { key: 'route', header: 'Route', render: (b) => <span className="text-xs">{b.pickupLocation} → {b.dropLocation}</span> },
    { key: 'type', header: 'Trip', render: (b) => humanize(b.tripType) },
    {
      key: 'status',
      header: 'Status',
      render: (b) => (
        <span className="flex flex-wrap gap-1">
          <StatusBadge status={b.status} />
          {b.isDelayed && <StatusBadge status="DELAYED" />}
        </span>
      ),
    },
  ];

  return (
    <>
      <Link to="/admin/employees" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Employees
      </Link>
      <PageHeader
        title={data.fullName}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{data.employeeId}</span> · {data.email} <StatusBadge status={status} />
          </span>
        }
        actions={
          <>
            <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>
              Edit
            </Button>
            {available.map((k) => (
              <Button key={k} variant={actionDefs[k].variant} onClick={() => setAction(k)}>
                {actionDefs[k].label}
              </Button>
            ))}
            <Button variant="danger" onClick={() => setDeleting(true)}>
              Delete
            </Button>
          </>
        }
      />

      {data.statusReason && (status === 'INACTIVE' || status === 'SUSPENDED' || status === 'REJECTED') && (
        <div className="mb-4">
          <Alert tone="warn" title={`Account ${humanize(status).toLowerCase()}`}>
            Reason: {data.statusReason}
          </Alert>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Profile" className="lg:col-span-2">
          <DescriptionList
            items={[
              ['Employee ID', <span className="font-mono">{data.employeeId}</span>],
              ['Full name', data.fullName],
              ['Email', data.email],
              ['Phone', data.phone ? <CallButton key="call" phone={data.phone} name={data.fullName} /> : '—'],
              ['Office', data.officeLocation || '—'],
              ['Route (cab)', data.route || 'Unknown'],
              ['Present address', data.homeAddress || 'Not provided yet'],
              ['Source', humanize(data.source)],
              ['Created', fmtDateTime(data.createdAt)],
            ]}
          />
        </Card>
        <Card title="Account">
          <DescriptionList
            columns={1}
            items={[
              ['Status', <StatusBadge status={status} />],
              ['Last login', fmtDateTime(data.lastLoginAt)],
              ['Invited', fmtDateTime(data.invitedAt)],
              ['Activated', fmtDateTime(data.activatedAt)],
              ['Sign-in', status === 'INVITED' ? 'Microsoft (activates on first sign-in)' : 'Microsoft'],
            ]}
          />
        </Card>
      </div>

      <Card title={`Bookings & trips (${totalBookings})`} className="mt-4">
        {totalBookings > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {Object.entries(data.bookingCounts).map(([s, n]) => (
              <span key={s} className="inline-flex items-center gap-1 text-xs">
                <StatusBadge status={s} /> <span className="font-medium text-slate-700">{n}</span>
              </span>
            ))}
          </div>
        )}
        <DataTable
          columns={bookingColumns}
          rows={data.bookings}
          rowKey={(b) => b._id}
          empty={<EmptyState title="No bookings yet" />}
        />
        {data.bookings.length >= 50 && <p className="mt-2 text-xs text-slate-500">Showing the 50 most recent bookings.</p>}
      </Card>

      {current && (
        <ConfirmDialog
          open={!!action}
          onClose={() => setAction(null)}
          title={current.title}
          message={current.message}
          confirmLabel={current.label}
          tone={current.tone ?? (current.variant === 'danger' ? 'danger' : 'primary')}
          reasonLabel={current.reasonLabel}
          onConfirm={current.run}
        />
      )}
      <EmployeeFormModal open={editing} onClose={() => setEditing(false)} employee={data} />
      <DeleteEmployeeDialog employee={deleting ? data : null} onClose={() => setDeleting(false)} onDeleted={() => navigate('/admin/employees')} />
    </>
  );
}
