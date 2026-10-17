import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Button,
  Checkbox,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Input,
  Modal,
  PageHeader,
  Pagination,
  SearchInput,
  StatusBadge,
  useToast,
  type Column,
} from '../../components/ui';
import { errorMessage, post } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { fieldErrors, useListState, usePaged } from '../../lib/hooks';
import { usePolicy } from '../../lib/policy';

export const PHONE_RE = /^\+?[0-9][0-9 ()-]{6,19}$/;

export type CoordinatorRow = {
  _id: string;
  fullName: string;
  email: string;
  phone?: string;
  officeLocations: string[];
  user: { _id: string; status: string; statusReason?: string; lastLoginAt?: string; invitedAt?: string; activatedAt?: string } | null;
  createdAt: string;
};

/** Office checkboxes for a coordinator's scope. */
export function ScopeFields({ offices, onOffices, errors }: { offices: string[]; onOffices: (v: string[]) => void; errors?: Record<string, string> }) {
  const policy = usePolicy();
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <fieldset>
      <legend className="mb-1 text-sm font-medium text-slate-700">
        Office locations<span className="ml-0.5 text-red-600" aria-hidden>*</span>
      </legend>
      <div className="space-y-1.5">
        {policy.data?.officeLocations.map((o) => (
          <Checkbox
            key={o.code}
            label={`${o.name} (${o.code})${o.active ? '' : ' — inactive'}`}
            checked={offices.includes(o.code)}
            onChange={() => onOffices(toggle(offices, o.code))}
          />
        ))}
      </div>
      {errors?.officeLocations && (
        <p className="mt-1 text-sm text-red-600" role="alert">
          {errors.officeLocations}
        </p>
      )}
    </fieldset>
  );
}

function CreateCoordinatorModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState({ fullName: '', email: '', phone: '' });
  const [offices, setOffices] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm({ fullName: '', email: '', phone: '' });
    setOffices([]);
    setErrors({});
    setError('');
  }, [open]);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v: Record<string, string> = {};
    if (form.fullName.trim().length < 2) v.fullName = 'Full name is required';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.email.trim())) v.email = 'Enter a valid email address';
    if (!form.phone.trim()) v.phone = 'Phone number is required';
    else if (!PHONE_RE.test(form.phone.trim())) v.phone = 'Enter a valid phone number';
    if (!offices.length) v.officeLocations = 'Assign at least one office';
    setErrors(v);
    setError('');
    if (Object.keys(v).length) return;
    setBusy(true);
    try {
      const c = await post<{ _id: string }>('/admin/coordinators', { ...form, officeLocations: offices });
      toast.success('Coordinator added', `They can now sign in with ${form.email} and their mobile number`);
      qc.invalidateQueries({ queryKey: ['admin-coordinators'] });
      qc.invalidateQueries({ queryKey: ['admin-dashboard'] });
      onClose();
      navigate(`/admin/coordinators/${c._id}`);
    } catch (err) {
      const fe = fieldErrors(err);
      const msg = errorMessage(err);
      if (/email/i.test(msg) && !fe.email) fe.email = msg;
      setErrors(fe);
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add coordinator"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="coord-form" loading={busy}>
            Add coordinator
          </Button>
        </>
      }
    >
      <form id="coord-form" onSubmit={submit} noValidate className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Full name" value={form.fullName} onChange={set('fullName')} error={errors.fullName} required />
          <Input label="Official work email" type="email" value={form.email} onChange={set('email')} error={errors.email} required />
          <Input label="Phone number" type="tel" value={form.phone} onChange={set('phone')} error={errors.phone} required />
        </div>
        <ScopeFields offices={offices} onOffices={setOffices} errors={errors} />
        <Alert tone="info">They sign in with this email and mobile number (“Coordinator? Sign in with email and mobile number”). They only see bookings, drivers and vehicles of the offices ticked here.</Alert>
        {error && !Object.keys(errors).length && <Alert tone="error">{error}</Alert>}
      </form>
    </Modal>
  );
}

/** Delete a coordinator who has left. Shared by the list and the detail page. */
export function DeleteCoordinatorDialog({ coordinator, onClose, onDeleted }: { coordinator: { _id: string; fullName: string } | null; onClose: () => void; onDeleted?: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  return (
    <ConfirmDialog
      open={!!coordinator}
      onClose={onClose}
      title={coordinator ? `Delete ${coordinator.fullName}?` : ''}
      message="Their account will be removed. This can't be undone."
      confirmLabel="Delete"
      onConfirm={async () => {
        await post(`/admin/coordinators/${coordinator!._id}/delete`, {});
        toast.success(`${coordinator!.fullName} deleted`);
        qc.invalidateQueries({ queryKey: ['admin-coordinators'] });
        qc.invalidateQueries({ queryKey: ['admin-dashboard'] });
        onDeleted?.();
      }}
    />
  );
}

export default function Coordinators() {
  const navigate = useNavigate();
  const list = useListState({});
  const { data, isLoading, error, refetch } = usePaged<CoordinatorRow>(['admin-coordinators'], '/admin/coordinators', list.query);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<CoordinatorRow | null>(null);

  const columns: Column<CoordinatorRow>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (c) => (
        <div>
          <div className="font-medium text-slate-900">{c.fullName}</div>
          <div className="text-xs text-slate-500">{c.email}</div>
        </div>
      ),
    },
    { key: 'phone', header: 'Phone', render: (c) => c.phone || '—' },
    { key: 'offices', header: 'Offices', render: (c) => c.officeLocations.join(', ') || '—' },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.user?.status} /> },
    { key: 'login', header: 'Last login', render: (c) => <span className="whitespace-nowrap">{fmtDateTime(c.user?.lastLoginAt)}</span> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      render: (c) => (
        <Button
          size="sm"
          variant="ghost"
          className="text-red-700 hover:bg-red-50"
          onClick={(ev) => {
            ev.stopPropagation();
            setDeleting(c);
          }}
        >
          Delete
        </Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Coordinators"
        subtitle="Transport coordinators manage bookings, drivers and vehicles for their assigned offices."
        actions={
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
            Add coordinator
          </Button>
        }
      />
      <div className="mb-3 max-w-md">
        <SearchInput value={list.q} onChange={list.setSearch} placeholder="Search name or email" />
      </div>
      <DataTable
        columns={columns}
        rows={data?.items}
        rowKey={(c) => c._id}
        loading={isLoading}
        error={error}
        onRetry={refetch}
        onRowClick={(c) => navigate(`/admin/coordinators/${c._id}`)}
        empty={<EmptyState title={list.q ? 'No coordinators match' : 'No coordinators yet'} action={!list.q ? <Button onClick={() => setCreating(true)}>Add coordinator</Button> : undefined} />}
      />
      {data && <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onPage={list.setPage} />}
      <CreateCoordinatorModal open={creating} onClose={() => setCreating(false)} />
      <DeleteCoordinatorDialog coordinator={deleting} onClose={() => setDeleting(null)} />
    </>
  );
}
