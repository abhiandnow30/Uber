import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Pencil } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
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
  Input,
  Modal,
  PageHeader,
  Spinner,
  StatusBadge,
  type Column,
} from '../../components/ui';
import { errorMessage, get, patch, post } from '../../lib/api';
import { fmtDateTime, humanize } from '../../lib/format';
import { fieldErrors, useAction } from '../../lib/hooks';
import { DeleteCoordinatorDialog, PHONE_RE, ScopeFields, type CoordinatorRow } from './Coordinators';

type AuditEntry = { _id: string; action: string; entityType: string; entityId?: string; summary?: string; createdAt: string };
type Assignment = {
  _id: string;
  booking: string;
  bookingReference: string;
  officeLocation: string;
  status: string;
  scheduledPickupAt: string;
  createdAt: string;
  driver?: { _id: string; fullName: string; driverCode: string } | null;
  vehicle?: { _id: string; registrationNumber: string } | null;
};
type CoordinatorData = CoordinatorRow & { activity: AuditEntry[]; assignments: Assignment[] };

type ActionKey = 'activate' | 'deactivate' | 'suspend';
// Coordinators sign in with email + mobile number, so there are no invitations to send.
const ACTIONS_BY_STATUS: Record<string, ActionKey[]> = {
  INVITED: ['deactivate'],
  ACTIVE: ['suspend', 'deactivate'],
  SUSPENDED: ['activate', 'deactivate'],
  INACTIVE: ['activate'],
};

function EditModal({ open, onClose, coord }: { open: boolean; onClose: () => void; coord: CoordinatorData }) {
  const [form, setForm] = useState({ fullName: '', phone: '' });
  const [offices, setOffices] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const save = useAction((b: Record<string, unknown>) => patch(`/admin/coordinators/${coord._id}`, b), {
    success: 'Coordinator updated',
    invalidate: [['admin-coordinator', coord._id], ['admin-coordinators']],
    silentError: true,
  });

  useEffect(() => {
    if (!open) return;
    setForm({ fullName: coord.fullName, phone: coord.phone ?? '' });
    setOffices(coord.officeLocations);
    setErrors({});
    setError('');
  }, [open, coord]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v: Record<string, string> = {};
    if (form.fullName.trim().length < 2) v.fullName = 'Full name is required';
    if (!form.phone.trim()) v.phone = 'Phone number is required';
    else if (!PHONE_RE.test(form.phone.trim())) v.phone = 'Enter a valid phone number';
    if (!offices.length) v.officeLocations = 'Assign at least one office';
    setErrors(v);
    setError('');
    if (Object.keys(v).length) return;
    try {
      await save.mutateAsync({ fullName: form.fullName, phone: form.phone, officeLocations: offices });
      onClose();
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Edit ${coord.fullName}`}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="coord-edit" loading={save.isPending}>
            Save changes
          </Button>
        </>
      }
    >
      <form id="coord-edit" onSubmit={submit} noValidate className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Full name" value={form.fullName} onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))} error={errors.fullName} required />
          <Input label="Phone number" type="tel" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} error={errors.phone} required />
          <Input label="Email" value={coord.email} disabled readOnly hint="Email cannot be changed; create a new coordinator instead" />
        </div>
        <ScopeFields offices={offices} onOffices={setOffices} errors={errors} />
        {error && <Alert tone="error">{error}</Alert>}
      </form>
    </Modal>
  );
}

export default function CoordinatorDetail() {
  const { id = '' } = useParams();
  const [action, setAction] = useState<ActionKey | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-coordinator', id],
    queryFn: ({ signal }) => get<CoordinatorData>(`/admin/coordinators/${id}`, signal),
  });
  const invalidate = [['admin-coordinator', id], ['admin-coordinators'], ['admin-dashboard']];
  const setStatus = useAction((b: { status: string; reason?: string }) => post<{ status: string }>(`/admin/coordinators/${id}/status`, b), {
    success: (r) => `Account is now ${humanize(r.status)}`,
    invalidate,
    silentError: true,
  });
  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} onRetry={refetch} />;
  const status = data.user?.status ?? '';

  const defs: Record<ActionKey, { label: string; variant: 'primary' | 'secondary' | 'danger' | 'success'; title: string; message: ReactNode; reasonLabel?: string; tone: 'danger' | 'primary'; run: (r: string) => Promise<unknown> }> = {
    activate: {
      label: 'Activate',
      variant: 'success',
      title: 'Activate coordinator',
      tone: 'primary',
      message: <p>{data.fullName} will be able to sign in again. If the account was never activated, use “Re-invite”.</p>,
      run: () => setStatus.mutateAsync({ status: 'ACTIVE' }),
    },
    deactivate: {
      label: 'Deactivate',
      variant: 'danger',
      title: 'Deactivate coordinator',
      tone: 'danger',
      message: <p>{data.fullName} is signed out everywhere and can no longer sign in. Existing assignments they made are not changed.</p>,
      reasonLabel: 'Reason (recorded in the audit log)',
      run: (reason) => setStatus.mutateAsync({ status: 'INACTIVE', reason }),
    },
    suspend: {
      label: 'Suspend',
      variant: 'danger',
      title: 'Suspend coordinator',
      tone: 'danger',
      message: <p>{data.fullName} is signed out and blocked until reactivated.</p>,
      reasonLabel: 'Reason for suspension',
      run: (reason) => setStatus.mutateAsync({ status: 'SUSPENDED', reason }),
    },
  };
  const current = action ? defs[action] : null;

  const activityColumns: Column<AuditEntry>[] = [
    { key: 'time', header: 'Time', render: (a) => <span className="whitespace-nowrap">{fmtDateTime(a.createdAt)}</span> },
    { key: 'action', header: 'Action', render: (a) => <span className="font-mono text-xs">{a.action}</span> },
    { key: 'entity', header: 'Entity', render: (a) => a.entityType },
    { key: 'summary', header: 'Summary', render: (a) => a.summary ?? '—' },
  ];
  const assignmentColumns: Column<Assignment>[] = [
    {
      key: 'ref',
      header: 'Booking',
      render: (a) => (
        <Link to={`/ops/bookings/${a.booking}`} className="font-mono text-xs text-indigo-600 hover:underline">
          {a.bookingReference}
        </Link>
      ),
    },
    { key: 'pickup', header: 'Pickup', render: (a) => <span className="whitespace-nowrap">{fmtDateTime(a.scheduledPickupAt)}</span> },
    { key: 'driver', header: 'Driver', render: (a) => (a.driver ? `${a.driver.fullName} (${a.driver.driverCode})` : '—') },
    { key: 'vehicle', header: 'Vehicle', render: (a) => a.vehicle?.registrationNumber ?? '—' },
    { key: 'office', header: 'Office', render: (a) => a.officeLocation },
    { key: 'status', header: 'Status', render: (a) => <StatusBadge status={a.status} /> },
    { key: 'created', header: 'Assigned at', render: (a) => <span className="whitespace-nowrap">{fmtDateTime(a.createdAt)}</span> },
  ];

  return (
    <>
      <Link to="/admin/coordinators" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Coordinators
      </Link>
      <PageHeader
        title={data.fullName}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            {data.email} <StatusBadge status={status} />
          </span>
        }
        actions={
          <>
            <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>
              Edit scope
            </Button>
            {(ACTIONS_BY_STATUS[status] ?? []).map((k) => (
              <Button key={k} variant={defs[k].variant} onClick={() => setAction(k)}>
                {defs[k].label}
              </Button>
            ))}
            <Button variant="danger" onClick={() => setDeleting(true)}>
              Delete
            </Button>
          </>
        }
      />
      {data.user?.statusReason && (status === 'INACTIVE' || status === 'SUSPENDED') && (
        <div className="mb-4">
          <Alert tone="warn">Reason: {data.user.statusReason}</Alert>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Profile & scope" className="lg:col-span-2">
          <DescriptionList
            items={[
              ['Full name', data.fullName],
              ['Email', data.email],
              ['Phone', data.phone || '—'],
              ['Created', fmtDateTime(data.createdAt)],
              ['Offices', data.officeLocations.join(', ') || '—'],
            ]}
          />
        </Card>
        <Card title="Account">
          <DescriptionList
            columns={1}
            items={[
              ['Status', <StatusBadge status={status} />],
              ['Last login', fmtDateTime(data.user?.lastLoginAt)],
              ['Invited', fmtDateTime(data.user?.invitedAt)],
              ['Activated', fmtDateTime(data.user?.activatedAt)],
            ]}
          />
        </Card>
      </div>

      <Card title="Recent activity" className="mt-4">
        <DataTable columns={activityColumns} rows={data.activity} rowKey={(a) => a._id} empty={<EmptyState title="No activity recorded" />} />
      </Card>
      <Card title="Assignment history" className="mt-4">
        <DataTable columns={assignmentColumns} rows={data.assignments} rowKey={(a) => a._id} empty={<EmptyState title="No assignments made yet" />} />
      </Card>

      {current && (
        <ConfirmDialog
          open={!!action}
          onClose={() => setAction(null)}
          title={current.title}
          message={current.message}
          confirmLabel={current.label}
          tone={current.tone}
          reasonLabel={current.reasonLabel}
          onConfirm={current.run}
        />
      )}
      <EditModal open={editing} onClose={() => setEditing(false)} coord={data} />
      <DeleteCoordinatorDialog coordinator={deleting ? data : null} onClose={() => setDeleting(false)} onDeleted={() => navigate('/admin/coordinators')} />
    </>
  );
}
