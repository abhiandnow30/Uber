import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, DataTable, EmptyState, Input, Modal, PageHeader, Pagination, SearchInput, Select, StatusBadge, useToast, type Column } from '../../components/ui';
import { errorMessage, get, patch, post, type Paged } from '../../lib/api';
import { fieldErrors, useAction, useListState, usePaged } from '../../lib/hooks';
import { ExpiryText, OfficeSelect, toDateInput, useOpsOffices } from './OpsDashboard';
import type { VehicleRow } from './Vehicles';

export type DriverRow = {
  _id: string;
  driverCode: string;
  fullName: string;
  phone: string;
  email?: string;
  licenseNumber: string;
  licenseExpiry: string;
  verificationStatus: string;
  employmentStatus: string;
  availability: string;
  onDuty: boolean;
  officeLocation: string;
  currentVehicle?: { _id: string; registrationNumber: string; model?: string; capacity?: number; status?: string } | null;
  user?: { _id: string; status: string; lastLoginAt?: string } | null;
  activeAssignments?: number;
};

/**
 * The driver's vehicle as a dropdown of their current vehicle plus every free, active vehicle in
 * their office. Choosing one links it straight away (the server ends both previous links).
 */
export function VehiclePicker({ driver, className }: { driver: Pick<DriverRow, '_id' | 'fullName' | 'officeLocation' | 'currentVehicle'>; className?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // Shared cache key: every picker on the page reuses one request.
  const vehicles = useQuery({ queryKey: ['ops', 'vehicles', 'link-options'], queryFn: () => get<Paged<VehicleRow>>('/ops/vehicles?pageSize=100') });
  const current = driver.currentVehicle;
  const choices = (vehicles.data?.items ?? []).filter((v) => v.status === 'ACTIVE' && v.officeLocation === driver.officeLocation && v._id !== current?._id);
  const free = choices.filter((v) => !v.currentDriver);
  const taken = choices.filter((v) => v.currentDriver);

  const link = async (vehicleId: string) => {
    if (!vehicleId || vehicleId === current?._id) return;
    const v = choices.find((x) => x._id === vehicleId);
    if (v?.currentDriver && !window.confirm(`${v.registrationNumber} is linked to ${v.currentDriver.fullName}. Move it to ${driver.fullName}? ${v.currentDriver.fullName} will be left without a vehicle.`)) return;
    setBusy(true);
    try {
      await post('/ops/links', { driverId: driver._id, vehicleId });
      toast.success('Vehicle linked', `${driver.fullName} → ${v?.registrationNumber ?? ''}`);
      qc.invalidateQueries({ queryKey: ['ops'] });
    } catch (err) {
      toast.error('Could not link vehicle', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={className} onClick={(e) => e.stopPropagation()}>
      <Select aria-label={`Vehicle for ${driver.fullName}`} value={current?._id ?? ''} onChange={(e) => link(e.target.value)} disabled={busy || vehicles.isLoading}>
        {current ? <option value={current._id}>{current.registrationNumber}</option> : <option value="">{vehicles.isLoading ? 'Loading…' : choices.length ? 'Select a cab…' : 'No cabs in this office'}</option>}
        {free.length > 0 && (
          <optgroup label="Available cabs">
            {free.map((v) => (
              <option key={v._id} value={v._id}>
                {v.registrationNumber}{v.model ? ` · ${v.model}` : ''} · {v.capacity} seats
              </option>
            ))}
          </optgroup>
        )}
        {taken.length > 0 && (
          <optgroup label="Linked to another driver">
            {taken.map((v) => (
              <option key={v._id} value={v._id}>
                {v.registrationNumber} · now {v.currentDriver!.fullName}
              </option>
            ))}
          </optgroup>
        )}
      </Select>
    </div>
  );
}

export const VERIFICATION = ['PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED'];
export const EMPLOYMENT = ['ACTIVE', 'INACTIVE', 'SUSPENDED'];
export const AVAILABILITY = ['AVAILABLE', 'ASSIGNED', 'ON_TRIP', 'OFFLINE', 'SUSPENDED'];

type DriverForm = { driverCode: string; fullName: string; phone: string; email: string; licenseNumber: string; licenseExpiry: string; officeLocation: string };

/** Create (no `driver`) or edit an existing driver. */
export function DriverFormModal({ open, onClose, driver, onSaved }: { open: boolean; onClose: () => void; driver?: (DriverRow & { user?: { status: string } | null }) | null; onSaved?: (id: string) => void }) {
  const { offices } = useOpsOffices();
  const editing = !!driver;
  const blank: DriverForm = { driverCode: '', fullName: '', phone: '', email: '', licenseNumber: '', licenseExpiry: '', officeLocation: offices.length === 1 ? offices[0].code : '' };
  const [f, setF] = useState<DriverForm>(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  useEffect(() => {
    if (!open) return;
    setErrors({});
    setFormError('');
    setF(
      driver
        ? {
            driverCode: driver.driverCode,
            fullName: driver.fullName,
            phone: driver.phone,
            email: driver.email ?? '',
            licenseNumber: driver.licenseNumber,
            licenseExpiry: toDateInput(driver.licenseExpiry),
            officeLocation: driver.officeLocation,
          }
        : blank,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, driver]);

  const save = useAction(
    (body: Record<string, unknown>) => (editing ? patch<{ _id: string }>(`/ops/drivers/${driver!._id}`, body) : post<{ _id: string }>('/ops/drivers', body)),
    { success: editing ? 'Driver updated' : 'Driver added', invalidate: [['ops']], silentError: true },
  );

  const set = (k: keyof DriverForm) => (v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const licenseChanged = editing && (f.licenseNumber.trim().toUpperCase() !== driver!.licenseNumber || f.licenseExpiry !== toDateInput(driver!.licenseExpiry));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErrors({});
    setFormError('');
    const { fullName, phone, email, licenseNumber, licenseExpiry, officeLocation } = f;
    const body: Record<string, unknown> = editing ? { fullName, phone, email, licenseNumber, licenseExpiry, officeLocation } : { ...f };
    try {
      const r = await save.mutateAsync(body);
      onClose();
      onSaved?.(r._id);
    } catch (err) {
      setErrors(fieldErrors(err));
      setFormError(errorMessage(err));
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `Edit driver ${driver!.driverCode}` : 'Add driver'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="driver-form" loading={save.isPending}>
            {editing ? 'Save changes' : 'Add driver'}
          </Button>
        </>
      }
    >
      <form id="driver-form" onSubmit={submit} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          {!editing && <Input label="Driver ID" required value={f.driverCode} onChange={(e) => set('driverCode')(e.target.value.toUpperCase())} error={errors.driverCode} hint="2–20 letters/digits, e.g. DRV-014" />}
          <Input label="Full name" required value={f.fullName} onChange={(e) => set('fullName')(e.target.value)} error={errors.fullName} autoComplete="off" />
          <Input label="Mobile number" required type="tel" value={f.phone} onChange={(e) => set('phone')(e.target.value)} error={errors.phone} hint="The driver signs in with this number" />
          <Input
            label="Email (optional)"
            type="email"
            value={f.email}
            onChange={(e) => set('email')(e.target.value)}
            error={errors.email}
            hint="Contact only; drivers don't sign in with email"
          />
          <Input label="License number" required value={f.licenseNumber} onChange={(e) => set('licenseNumber')(e.target.value.toUpperCase())} error={errors.licenseNumber} />
          <Input label="License expiry" required type="date" value={f.licenseExpiry} onChange={(e) => set('licenseExpiry')(e.target.value)} error={errors.licenseExpiry} />
          <Select label="Office" required value={f.officeLocation} onChange={(e) => set('officeLocation')(e.target.value)} error={errors.officeLocation}>
            <option value="">Select office…</option>
            {offices.map((o) => (
              <option key={o.code} value={o.code}>
                {o.name} ({o.code})
              </option>
            ))}
          </Select>
        </div>
        {!editing && (
          <>
            <Alert tone="info">
              The driver signs in on their phone with this <strong>mobile number</strong> and the <strong>last 4 characters of their vehicle number</strong>, once you link them to a vehicle. They can be
              assigned rides after their first sign-in. New drivers start with <strong>pending verification</strong>: an administrator must verify their documents before they can be assigned trips.
            </Alert>
          </>
        )}
        {licenseChanged && driver?.verificationStatus === 'VERIFIED' && (
          <Alert tone="warn" title="Re-verification required">
            Changing license details resets document verification to pending. The driver cannot receive new assignments until an administrator verifies them again.
          </Alert>
        )}
        {formError && <Alert tone="error">{formError}</Alert>}
      </form>
    </Modal>
  );
}

export default function Drivers() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [adding, setAdding] = useState(false);
  const list = useListState(
    {
      officeLocation: params.get('office') ?? '',
      availability: params.get('availability') ?? '',
    },
    'fullName',
  );
  const { data, isLoading, error, refetch } = usePaged<DriverRow>(['ops', 'drivers'], '/ops/drivers', list.query);

  const columns: Column<DriverRow>[] = [
    { key: 'code', header: 'Driver ID', sortKey: 'driverCode', render: (d) => <Link to={`/ops/drivers/${d._id}`} onClick={(e) => e.stopPropagation()} className="font-medium text-indigo-600 hover:underline">{d.driverCode}</Link> },
    { key: 'name', header: 'Name', sortKey: 'fullName', render: (d) => <span className="whitespace-nowrap font-medium text-slate-900">{d.fullName}</span> },
    { key: 'phone', header: 'Phone', render: (d) => <span className="whitespace-nowrap">{d.phone}</span> },
    { key: 'license', header: 'License expiry', sortKey: 'licenseExpiry', render: (d) => <ExpiryText iso={d.licenseExpiry} /> },
    { key: 'avail', header: 'Availability', sortKey: 'availability', render: (d) => <StatusBadge status={d.availability} /> },
    { key: 'duty', header: 'On duty', className: 'hidden 2xl:table-cell', render: (d) => (d.onDuty ? <span className="text-emerald-700">Yes</span> : <span className="text-slate-400">No</span>) },
    { key: 'vehicle', header: 'Current vehicle', render: (d) => <VehiclePicker driver={d} className="min-w-[11rem]" /> },
    { key: 'active', header: 'Active rides', render: (d) => d.activeAssignments ?? 0, className: 'hidden text-center 2xl:table-cell' },
    { key: 'login', header: 'Login', render: (d) => (d.user ? <StatusBadge status={d.user.status} /> : <span className="text-xs text-slate-400">No login</span>) },
  ];

  return (
    <>
      <PageHeader
        title="Drivers"
        subtitle="Driver profiles and availability"
        actions={
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
            Add driver
          </Button>
        }
      />
      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1 lg:col-span-1">
            <span className="block text-sm font-medium text-slate-700">Search</span>
            <SearchInput value={list.q} onChange={list.setSearch} placeholder="Name, ID, phone, license…" />
          </div>
          <OfficeSelect value={list.filters.officeLocation} onChange={(v) => list.setFilter('officeLocation', v)} />
          <Select label="Availability" value={list.filters.availability} onChange={(e) => list.setFilter('availability', e.target.value)}>
            <option value="">Any</option>
            {AVAILABILITY.map((s) => (
              <option key={s} value={s}>
                {s.replace('_', ' ').charAt(0) + s.replace('_', ' ').slice(1).toLowerCase()}
              </option>
            ))}
          </Select>
        </div>
      </Card>
      <DataTable
        columns={columns}
        rows={data?.items}
        rowKey={(d) => d._id}
        loading={isLoading}
        error={error}
        onRetry={refetch}
        sort={list.sort}
        onSort={list.setSort}
        onRowClick={(d) => navigate(`/ops/drivers/${d._id}`)}
        empty={<EmptyState title="No drivers found" description="Add a driver or change the filters." action={<Button onClick={() => setAdding(true)}>Add driver</Button>} />}
      />
      {data && <Pagination page={data.page} total={data.total} totalPages={data.totalPages} onPage={list.setPage} />}
      <DriverFormModal open={adding} onClose={() => setAdding(false)} onSaved={(id) => navigate(`/ops/drivers/${id}`)} />
    </>
  );
}
