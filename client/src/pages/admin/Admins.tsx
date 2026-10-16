import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import {
  Alert,
  Button,
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
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';
import { fieldErrors, useListState, usePaged } from '../../lib/hooks';
import { useSsoConfig } from '../../lib/sso';
import { PHONE_RE } from './Coordinators';

type AdminRow = {
  _id: string;
  name: string;
  email: string;
  phone?: string;
  status: string;
  statusReason?: string;
  lastLoginAt?: string;
  invitedAt?: string;
  hasCredentials: boolean;
};

type Action = { kind: 'suspend' | 'deactivate' | 'reactivate' | 'resend'; admin: AdminRow };

function AddAdminModal({ open, onClose, microsoft }: { open: boolean; onClose: () => void; microsoft: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({ fullName: '', email: '', phone: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm({ fullName: '', email: '', phone: '' });
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
    setErrors(v);
    setError('');
    if (Object.keys(v).length) return;
    setBusy(true);
    try {
      await post('/admin/admins', form);
      toast.success('Admin added', microsoft ? `${form.email} can now sign in with Microsoft` : `An activation email has been queued for ${form.email}`);
      qc.invalidateQueries({ queryKey: ['admin-admins'] });
      onClose();
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
      title="Add admin"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="admin-form" loading={busy}>
            {microsoft ? 'Add admin' : 'Add & invite'}
          </Button>
        </>
      }
    >
      <form id="admin-form" onSubmit={submit} noValidate className="space-y-4">
        <Input label="Full name" value={form.fullName} onChange={set('fullName')} error={errors.fullName} required />
        <Input label="Official work email" type="email" value={form.email} onChange={set('email')} error={errors.email} required />
        <Input label="Phone number" type="tel" value={form.phone} onChange={set('phone')} error={errors.phone} required />
        <Alert tone="info">
          {microsoft
            ? 'Use their official work email: they sign in with “Sign in with Microsoft” and their account becomes active on their first sign-in. '
            : 'The new admin starts as “Invited” and receives an email to set their password. '}
          Admins have full access to every office and setting, including adding and removing other admins.
        </Alert>
        {error && !Object.keys(errors).length && <Alert tone="error">{error}</Alert>}
      </form>
    </Modal>
  );
}

export default function Admins() {
  const { me } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const list = useListState({});
  const { data, isLoading, error, refetch } = usePaged<AdminRow>(['admin-admins'], '/admin/admins', list.query);
  const summary = (data as unknown as { summary?: { total: number; active: number; invited: number } } | undefined)?.summary;
  const [adding, setAdding] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const microsoft = !!useSsoConfig().data?.adminsMicrosoft;

  const onlyActive = (a: AdminRow) => a.status === 'ACTIVE' && summary?.active === 1;
  const actionsFor = (a: AdminRow): Action['kind'][] => {
    if (a._id === me?.user.id) return []; // nobody can suspend or deactivate themselves
    switch (a.status) {
      case 'ACTIVE':
        return onlyActive(a) ? [] : ['suspend', 'deactivate'];
      case 'SUSPENDED':
        return ['reactivate', 'deactivate'];
      case 'INACTIVE':
        return ['reactivate'];
      case 'INVITED':
        return microsoft ? ['deactivate'] : ['resend', 'deactivate'];
      default:
        return [];
    }
  };

  const run = async (reason: string) => {
    if (!action) return;
    const { kind, admin } = action;
    if (kind === 'resend') {
      await post(`/admin/admins/${admin._id}/invitation`);
      toast.success('Invitation email queued', admin.email);
    } else {
      // Inactive admins who never set a password are re-invited instead of reactivated directly.
      const status = kind === 'suspend' ? 'SUSPENDED' : kind === 'deactivate' ? 'INACTIVE' : admin.status === 'INACTIVE' && !admin.hasCredentials ? 'INVITED' : 'ACTIVE';
      // (with Microsoft sign-in, "INVITED" simply means "active again on their next Microsoft sign-in")
      await post(`/admin/admins/${admin._id}/status`, { status, reason: reason || undefined });
      toast.success(`${admin.name} is now ${status === 'INVITED' ? 'invited again' : status.toLowerCase()}`);
    }
    qc.invalidateQueries({ queryKey: ['admin-admins'] });
  };

  const LABELS: Record<Action['kind'], string> = { suspend: 'Suspend', deactivate: 'Deactivate', reactivate: 'Reactivate', resend: 'Resend invite' };

  const columns: Column<AdminRow>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (a) => (
        <div>
          <div className="font-medium text-slate-900">
            {a.name}
            {a._id === me?.user.id && <span className="ml-1.5 text-xs font-normal text-slate-500">(you)</span>}
          </div>
          <div className="text-xs text-slate-500">{a.email}</div>
        </div>
      ),
    },
    { key: 'phone', header: 'Phone', render: (a) => a.phone || '—' },
    {
      key: 'status',
      header: 'Status',
      render: (a) => (
        <span title={a.statusReason}>
          <StatusBadge status={a.status} />
        </span>
      ),
    },
    {
      key: 'login',
      header: 'Last sign-in',
      render: (a) => <span className="whitespace-nowrap">{a.lastLoginAt ? fmtDateTime(a.lastLoginAt) : a.status === 'INVITED' && microsoft ? 'Not yet (Microsoft)' : 'Never'}</span>,
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      render: (a) => (
        <div className="flex flex-wrap justify-end gap-1">
          {actionsFor(a).map((kind) => (
            <Button key={kind} size="sm" variant={kind === 'reactivate' || kind === 'resend' ? 'secondary' : 'ghost'} onClick={() => setAction({ kind, admin: a })}>
              {LABELS[kind]}
            </Button>
          ))}
          {onlyActive(a) && a._id !== me?.user.id && <span className="text-xs text-slate-400">Only active admin</span>}
        </div>
      ),
    },
  ];

  const needsReason = action?.kind === 'suspend' || action?.kind === 'deactivate';
  const messages: Record<Action['kind'], string> = {
    suspend: 'They are signed out everywhere and cannot sign in until reactivated.',
    deactivate: 'They are signed out everywhere and their access is removed. You can reactivate them later.',
    reactivate: microsoft ? 'They can sign in with Microsoft again.' : 'They can sign in again. If they never set a password, a new invitation email is sent instead.',
    resend: 'A new activation link is emailed. Earlier links stop working.',
  };

  return (
    <>
      <PageHeader
        title="Admins"
        subtitle={summary ? `${summary.total} ${summary.total === 1 ? 'admin' : 'admins'} · ${summary.active} active${summary.invited ? ` · ${summary.invited} invited` : ''}` : 'People with full access to the application.'}
        actions={
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
            Add admin
          </Button>
        }
      />
      <div className="mb-3 max-w-md">
        <SearchInput value={list.q} onChange={list.setSearch} placeholder="Search name, email or phone" />
      </div>
      <DataTable
        columns={columns}
        rows={data?.items}
        rowKey={(a) => a._id}
        loading={isLoading}
        error={error}
        onRetry={refetch}
        empty={<EmptyState title={list.q ? 'No admins match' : 'No admins'} />}
      />
      {data && <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onPage={list.setPage} />}
      <AddAdminModal open={adding} onClose={() => setAdding(false)} microsoft={microsoft} />
      <ConfirmDialog
        open={!!action}
        onClose={() => setAction(null)}
        onConfirm={run}
        title={action ? `${LABELS[action.kind]} ${action.admin.name}?` : ''}
        message={action ? messages[action.kind] : ''}
        confirmLabel={action ? LABELS[action.kind] : 'Confirm'}
        tone={needsReason ? 'danger' : 'primary'}
        reasonLabel={needsReason ? 'Reason' : undefined}
      />
    </>
  );
}
