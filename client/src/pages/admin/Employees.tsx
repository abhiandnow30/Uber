import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Input,
  Modal,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  StatusBadge,
  useToast,
  type Column,
} from '../../components/ui';
import { errorMessage, get, patch, post } from '../../lib/api';
import { fieldErrors, useListState, usePaged } from '../../lib/hooks';
import { usePolicy } from '../../lib/policy';
import { useSsoConfig } from '../../lib/sso';
import { changed, useUnsavedChanges } from '../../lib/unsaved';
import { AddressPicker, sameSpot, type LatLng, type MapSpot } from '../../components/LocationPicker';

export type EmployeeRow = {
  _id: string;
  employeeId: string;
  fullName: string;
  email: string;
  phone?: string;
  officeLocation?: string;
  route?: string;
  homeAddress?: string;
  homeLocation?: LatLng | null;
  homeMapLink?: string;
  source?: string;
  status?: string;
  lastLoginAt?: string;
  invitedAt?: string;
  activatedAt?: string;
  createdAt: string;
};

const EMPTY = { employeeId: '', fullName: '', email: '', phone: '', officeLocation: '', route: '', homeAddress: '' };
type FormState = typeof EMPTY;

/** Add / edit employee modal. In edit mode the employee ID is read-only and only changed fields are sent. */
export function EmployeeFormModal({ open, onClose, employee, onSaved }: { open: boolean; onClose: () => void; employee?: EmployeeRow | null; onSaved?: (id: string) => void }) {
  const policy = usePolicy();
  const toast = useToast();
  const qc = useQueryClient();
  const editing = !!employee;
  const [form, setForm] = useState<FormState>(EMPTY);
  const [initial, setInitial] = useState<FormState>(EMPTY);
  // The exact spot (Google Maps link + coordinates), kept apart from the text fields; the field is
  // rebuilt each time the popup opens.
  const [spot, setSpot] = useState<MapSpot>({ link: '', pin: null });
  const [initialSpot, setInitialSpot] = useState<MapSpot>({ link: '', pin: null });
  const [mapKey, setMapKey] = useState(0);
  const [sendInvitation, setSendInvitation] = useState(true);
  const msOnly = !!useSsoConfig().data?.employeesMicrosoftOnly;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const routes = useQuery({ queryKey: ['admin-employees', 'routes'], queryFn: () => get<string[]>('/admin/employees/routes'), enabled: open });

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setError('');
    setSendInvitation(true);
    const start: FormState =
      employee
        ? {
            employeeId: employee.employeeId,
            fullName: employee.fullName ?? '',
            email: employee.email ?? '',
            phone: employee.phone ?? '',
            officeLocation: employee.officeLocation ?? '',
            route: employee.route ?? '',
            homeAddress: employee.homeAddress ?? '',
          }
        : { ...EMPTY, officeLocation: policy.data?.officeLocations.find((o) => o.active)?.code ?? '' };
    setForm(start);
    setInitial(start);
    const startSpot: MapSpot = { link: employee?.homeMapLink ?? '', pin: employee?.homeLocation ? { lat: employee.homeLocation.lat, lng: employee.homeLocation.lng } : null };
    setSpot(startSpot);
    setInitialSpot(startSpot);
    setMapKey((k) => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, employee]);

  const set = (k: keyof FormState) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const validate = () => {
    const e: Record<string, string> = {};
    if (!editing && !form.employeeId.trim()) e.employeeId = 'Employee ID is required';
    if (form.fullName.trim().length < 2) e.fullName = 'Full name is required';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.email.trim())) e.email = 'Enter a valid email address';
    if (!form.officeLocation) e.officeLocation = 'Office location is required';
    return e;
  };

  const save = async (): Promise<boolean> => {
    const v = validate();
    setErrors(v);
    setError('');
    if (Object.keys(v).length) return false;
    setBusy(true);
    try {
      let id: string;
      if (editing) {
        const { employeeId: _ignored, ...rest } = form;
        const diff: Record<string, unknown> = Object.fromEntries(
          Object.entries(rest).filter(([k, val]) => val.trim() !== String((employee as Record<string, unknown>)[k] ?? '')),
        );
        if (!sameSpot(spot, initialSpot)) {
          diff.homeLocation = spot.pin;
          diff.homeMapLink = spot.pin ? spot.link.trim() : '';
        }
        if (!Object.keys(diff).length) {
          onClose();
          return true;
        }
        await patch(`/admin/employees/${employee!._id}`, diff);
        id = employee!._id;
        toast.success('Employee updated');
      } else {
        const created = await post<{ _id: string }>('/admin/employees', { ...form, ...(spot.pin ? { homeLocation: spot.pin, homeMapLink: spot.link.trim() } : {}), sendInvitation });
        id = created._id;
        toast.success(
          'Employee added',
          msOnly ? `${form.email} can now sign in with Microsoft` : sendInvitation ? `An activation email has been queued for ${form.email}` : 'No invitation was sent',
        );
      }
      qc.invalidateQueries({ queryKey: ['admin-employees'] });
      qc.invalidateQueries({ queryKey: ['admin-employee'] });
      qc.invalidateQueries({ queryKey: ['admin-dashboard'] });
      guard.release();
      onClose();
      onSaved?.(id);
      return true;
    } catch (err) {
      const fe = fieldErrors(err);
      setErrors(fe);
      const msg = errorMessage(err);
      // 409 duplicates: attach to the matching field when obvious.
      if (/employee id/i.test(msg) && !fe.employeeId) setErrors((x) => ({ ...x, employeeId: msg }));
      else if (/email/i.test(msg) && !fe.email) setErrors((x) => ({ ...x, email: msg }));
      setError(msg);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    void save();
  };
  const guard = useUnsavedChanges(open && (changed(form, initial) || !sameSpot(spot, initialSpot)), save);
  const close = () => guard(onClose);

  const offices = policy.data?.officeLocations ?? [];
  return (
    <Modal
      open={open}
      onClose={close}
      title={editing ? `Edit ${employee!.fullName}` : 'Add employee'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="employee-form" loading={busy}>
            {editing ? 'Save changes' : 'Add employee'}
          </Button>
        </>
      }
    >
      <form id="employee-form" onSubmit={submit} noValidate className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Employee ID"
            value={form.employeeId}
            onChange={set('employeeId')}
            error={errors.employeeId}
            required={!editing}
            readOnly={editing}
            disabled={editing}
            hint={editing ? 'Employee ID cannot be changed' : '2-30 letters, digits, "-" or "_"'}
          />
          <Input label="Full name" value={form.fullName} onChange={set('fullName')} error={errors.fullName} required />
          <Input
            label="Official work email"
            type="email"
            value={form.email}
            onChange={set('email')}
            error={errors.email}
            required
            hint={editing ? 'Changing the email revokes outstanding invitation links' : undefined}
          />
          <Input label="Phone" type="tel" value={form.phone} onChange={set('phone')} error={errors.phone} />
          <Select label="Office location" value={form.officeLocation} onChange={set('officeLocation')} error={errors.officeLocation} required>
            <option value="">Select an office…</option>
            {offices.map((o) => (
              <option key={o.code} value={o.code} disabled={!o.active}>
                {o.name} ({o.code}){o.active ? '' : ' — inactive'}
              </option>
            ))}
          </Select>
          <Input
            label="Route (cab)"
            list="employee-routes"
            maxLength={120}
            value={form.route}
            onChange={set('route')}
            error={errors.route}
            placeholder="Unknown"
            hint={'Set by you from the employee\'s address. Pick an existing cab or type a new one, e.g. "LB Nagar Cab".'}
          />
          <datalist id="employee-routes">
            {(routes.data ?? []).map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
          <div className="sm:col-span-2">
            <AddressPicker
              key={mapKey}
              address={form.homeAddress}
              onAddress={(v) => setForm((f) => ({ ...f, homeAddress: v }))}
              spot={spot}
              onSpot={setSpot}
              saved={sameSpot(spot, initialSpot)}
              error={errors.homeAddress}
              hint="Optional. Employees can also add or change this themselves under Account."
            />
          </div>
        </div>
        {!editing && !msOnly && (
          <Checkbox
            label="Send activation invitation email now"
            checked={sendInvitation}
            onChange={(e) => setSendInvitation(e.target.checked)}
          />
        )}
        {error && <Alert tone="error">{error}</Alert>}
      </form>
    </Modal>
  );
}

/** Delete an employee who has left (e.g. resigned). Shared by the list and the detail page. */
export function DeleteEmployeeDialog({ employee, onClose, onDeleted }: { employee: { _id: string; fullName: string } | null; onClose: () => void; onDeleted?: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  return (
    <ConfirmDialog
      open={!!employee}
      onClose={onClose}
      title={employee ? `Delete ${employee.fullName}?` : ''}
      message="Their account and any upcoming rides will be removed. This can't be undone."
      confirmLabel="Delete"
      onConfirm={async () => {
        const r = await post<{ permanent: boolean; cancelledBookings: number }>(`/admin/employees/${employee!._id}/delete`, {});
        toast.success(
          `${employee!.fullName} deleted`,
          r.cancelledBookings ? `${r.cancelledBookings} upcoming ride${r.cancelledBookings === 1 ? ' was' : 's were'} cancelled.` : undefined,
        );
        qc.invalidateQueries({ queryKey: ['admin-employees'] });
        qc.invalidateQueries({ queryKey: ['admin-dashboard'] });
        onDeleted?.();
      }}
    />
  );
}

/** Route edited right in the table: pick an existing cab or type a new one; saved on Enter or when leaving the box. */
function RouteCell({ employee, routes }: { employee: EmployeeRow; routes: string[] }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [value, setValue] = useState(employee.route ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => setValue(employee.route ?? ''), [employee.route]);

  const save = async (): Promise<boolean> => {
    const route = value.trim();
    if (route === (employee.route ?? '')) return true;
    setBusy(true);
    try {
      await patch(`/admin/employees/${employee._id}`, { route });
      toast.success(route ? `${employee.fullName} → ${route}` : `Route cleared for ${employee.fullName}`);
      qc.invalidateQueries({ queryKey: ['admin-employees'] });
      return true;
    } catch (err) {
      toast.error('Could not save the route', errorMessage(err));
      setValue(employee.route ?? '');
      return false;
    } finally {
      setBusy(false);
    }
  };
  useUnsavedChanges(!busy && value.trim() !== (employee.route ?? ''), save);

  return (
    <div onClick={(ev) => ev.stopPropagation()}>
      <input
        aria-label={`Route for ${employee.fullName}`}
        list="employee-routes-inline"
        maxLength={120}
        value={value}
        placeholder="Unknown"
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setValue(employee.route ?? '');
            e.currentTarget.blur();
          }
        }}
        className="h-9 w-44 rounded-lg border border-transparent bg-transparent px-2 text-sm text-slate-900 placeholder:text-slate-400 hover:border-slate-300 focus:border-indigo-500 focus:bg-white focus:outline-none"
      />
      <datalist id="employee-routes-inline">
        {routes.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
    </div>
  );
}

export default function Employees() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const policy = usePolicy();
  const list = useListState({ officeLocation: '', status: params.get('status') ?? '' }, '-createdAt');
  const { data, isLoading, error, refetch, isFetching } = usePaged<EmployeeRow>(['admin-employees'], '/admin/employees', list.query);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<EmployeeRow | null>(null);
  const [deleting, setDeleting] = useState<EmployeeRow | null>(null);
  const toast = useToast();
  const routes = useQuery({ queryKey: ['admin-employees', 'routes'], queryFn: () => get<string[]>('/admin/employees/routes') });

  const columns: Column<EmployeeRow>[] = [
    { key: 'employeeId', header: 'Employee ID', sortKey: 'employeeId', render: (e) => <span className="font-mono text-xs">{e.employeeId}</span> },
    {
      key: 'fullName',
      header: 'Name',
      sortKey: 'fullName',
      render: (e) => (
        <Link to={`/admin/employees/${e._id}`} className="font-medium text-slate-900 hover:underline" onClick={(ev) => ev.stopPropagation()}>
          {e.fullName}
        </Link>
      ),
    },
    { key: 'email', header: 'Email', sortKey: 'email', render: (e) => e.email },
    { key: 'office', header: 'Office', sortKey: 'officeLocation', render: (e) => e.officeLocation || '—' },
    { key: 'route', header: 'Route', sortKey: 'route', render: (e) => <RouteCell employee={e} routes={routes.data ?? []} /> },
    { key: 'status', header: 'Status', render: (e) => <StatusBadge status={e.status} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      render: (e) => (
        <div className="flex justify-end gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={async (ev) => {
              ev.stopPropagation();
              // The list only carries table columns; load the full record (home address etc.) for the form.
              try {
                setEditing(await get<EmployeeRow>(`/admin/employees/${e._id}`));
              } catch (err) {
                toast.error('Could not open employee', errorMessage(err));
              }
            }}
          >
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-red-700 hover:bg-red-50"
            onClick={(ev) => {
              ev.stopPropagation();
              setDeleting(e);
            }}
          >
            Delete
          </Button>
        </div>
      ),
    },
  ];

  const hasFilters = Object.values(list.filters).some(Boolean) || list.q;

  return (
    <>
      <PageHeader
        title="Employees"
        subtitle="Employees who can book cabs. New accounts show as Invited until the employee first signs in with Microsoft."
        actions={
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
            Add employee
          </Button>
        }
      />

      <Card className="mb-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <span className="mb-1 block text-sm font-medium text-slate-700">Search</span>
            <SearchInput value={list.q} onChange={list.setSearch} placeholder="Name, email, employee ID or route" />
          </div>
          <Select label="Office" value={list.filters.officeLocation} onChange={(e) => list.setFilter('officeLocation', e.target.value)}>
            <option value="">All offices</option>
            {policy.data?.officeLocations.map((o) => (
              <option key={o.code} value={o.code}>
                {o.name} ({o.code})
              </option>
            ))}
          </Select>
        </div>
        {hasFilters && (
          <div className="mt-3 flex justify-end">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                list.setFilters({ officeLocation: '', status: '' });
                list.setSearch('');
              }}
            >
              Clear filters
            </Button>
          </div>
        )}
      </Card>

      <div aria-busy={isFetching}>
        <DataTable
          columns={columns}
          rows={data?.items}
          rowKey={(e) => e._id}
          loading={isLoading}
          error={error}
          onRetry={refetch}
          sort={list.sort}
          onSort={list.setSort}
          onRowClick={(e) => navigate(`/admin/employees/${e._id}`)}
          empty={
            <EmptyState
              title={hasFilters ? 'No employees match these filters' : 'No employees yet'}
              description={hasFilters ? 'Try clearing the filters.' : 'Add a new hire manually, or new employees can register themselves by signing in with Microsoft.'}
              action={!hasFilters ? <Button onClick={() => setAdding(true)}>Add employee</Button> : undefined}
            />
          }
        />
      </div>
      {data && <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onPage={list.setPage} />}

      <EmployeeFormModal open={adding} onClose={() => setAdding(false)} onSaved={(id) => navigate(`/admin/employees/${id}`)} />
      <EmployeeFormModal open={!!editing} onClose={() => setEditing(null)} employee={editing} />
      <DeleteEmployeeDialog employee={deleting} onClose={() => setDeleting(null)} />
    </>
  );
}
