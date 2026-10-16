import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Pencil } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
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
import { del, get, post } from '../../lib/api';
import { fmtDateTime, fmtTravelDate, humanize } from '../../lib/format';
import { useAction } from '../../lib/hooks';
import { useSsoConfig } from '../../lib/sso';
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
  pendingInvitation: { expiresAt: string; sentAt: string } | null;
  bookingCounts: Record<string, number>;
  bookings: Booking[];
  updatedAt?: string;
};

type ActionKey = 'activate' | 'deactivate' | 'suspend' | 'reinvite' | 'resend' | 'revoke';

/** Admin-available actions per account status (mirrors server ACCOUNT_TRANSITIONS; INVITED→ACTIVE only via activation). */
const ACTIONS_BY_STATUS: Record<string, ActionKey[]> = {
  PENDING_ADMIN_REVIEW: ['reinvite'],
  INVITED: ['resend', 'revoke', 'deactivate'],
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
  const msOnly = !!useSsoConfig().data?.employeesMicrosoftOnly;
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
  const resend = useAction(() => post<{ expiresAt: string }>(`/admin/employees/${id}/invitation`), {
    success: (r) => `Invitation sent. Link expires ${fmtDateTime(r.expiresAt)}`,
    invalidate,
    silentError: true,
  });
  const revoke = useAction(() => del<{ revoked: number }>(`/admin/employees/${id}/invitation`), {
    success: (r) => (r.revoked ? `Revoked ${r.revoked} invitation link(s)` : 'No outstanding invitation links'),
    invalidate,
    silentError: true,
  });

  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} onRetry={refetch} />;

  const status = data.status ?? '';
  // An INACTIVE account that never completed activation cannot be re-activated directly; it must be re-invited.
  const available = (ACTIONS_BY_STATUS[status] ?? [])
    .filter((a) => !(status === 'INACTIVE' && ((a === 'activate' && !data.hasCredentials) || (a === 'reinvite' && data.hasCredentials))))
    // Microsoft-only employees have no activation links to send or revoke.
    .filter((a) => !(msOnly && (a === 'resend' || a === 'revoke')));
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
          <p>{data.fullName} will be signed out everywhere and will no longer be able to sign in. Outstanding invitation links are revoked.</p>
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
      message: msOnly ? (
        <p>The account moves to “Invited” and becomes active the next time {data.fullName} signs in with Microsoft.</p>
      ) : (
        <p>The account moves to “Invited” and a new activation email is sent to {data.email}.</p>
      ),
      run: () => setStatus.mutateAsync({ status: 'INVITED' }),
    },
    resend: {
      label: 'Resend invitation',
      variant: 'secondary',
      title: 'Resend invitation',
      tone: 'primary',
      message: <p>A new activation link will be emailed to {data.email}. Earlier links stop working.</p>,
      run: () => resend.mutateAsync(undefined),
    },
    revoke: {
      label: 'Revoke invitation',
      variant: 'secondary',
      title: 'Revoke invitation',
      message: <p>All outstanding activation links for {data.email} will stop working. The account stays “Invited” until you resend or deactivate it.</p>,
      run: () => revoke.mutateAsync(undefined),
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
    { key: 'date', header: 'Travel date', render: (b) => <span className="whitespace-nowrap">{fmtTravelDate(b.travelDate)} {b.pickupTime}</span> },
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
              ['Phone', data.phone || '—'],
              ['Office', data.officeLocation || '—'],
              ['Route', data.route || '—'],
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
              [
                'Pending invitation',
                data.pendingInvitation ? (
                  <span>
                    Sent {fmtDateTime(data.pendingInvitation.sentAt)}
                    <br />
                    <span className="text-xs text-slate-500">Expires {fmtDateTime(data.pendingInvitation.expiresAt)}</span>
                  </span>
                ) : status === 'INVITED' && msOnly ? (
                  'Not needed: activates on first Microsoft sign-in'
                ) : status === 'INVITED' ? (
                  <span className="text-amber-700">No valid link outstanding — resend the invitation</span>
                ) : (
                  'None'
                ),
              ],
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
