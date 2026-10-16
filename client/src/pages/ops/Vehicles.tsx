import { Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, DataTable, EmptyState, Input, Modal, PageHeader, Pagination, SearchInput, Select, StatusBadge, Textarea, type Column } from '../../components/ui';
import { errorMessage, patch, post } from '../../lib/api';
import { fieldErrors, useAction, useListState, usePaged } from '../../lib/hooks';
import { humanize } from '../../lib/format';
import { VEHICLE_TYPES } from '../../lib/policy';
import { ExpiryText, OfficeSelect, toDateInput, useOpsOffices } from './OpsDashboard';

export type VehicleRow = {
  _id: string;
  registrationNumber: string;
  model: string;
  vehicleType: string;
  capacity: number;
  status: string;
  maintenanceNotes?: string;
  maintenanceDueAt?: string;
  insuranceExpiry?: string;
  permitExpiry?: string;
  officeLocation: string;
  currentDriver?: { _id: string; fullName: string; driverCode: string; phone?: string } | null;
};

export const VEHICLE_STATUSES = ['ACTIVE', 'INACTIVE', 'MAINTENANCE'];

type VehicleForm = { registrationNumber: string; model: string; vehicleType: string; capacity: string; officeLocation: string; insuranceExpiry: string; permitExpiry: string; maintenanceNotes: string };

/** Create (no `vehicle`) or edit an existing vehicle. */
export function VehicleFormModal({ open, onClose, vehicle, onSaved }: { open: boolean; onClose: () => void; vehicle?: VehicleRow | null; onSaved?: (id: string) => void }) {
  const { offices } = useOpsOffices();
  const editing = !!vehicle;
  const [f, setF] = useState<VehicleForm>({ registrationNumber: '', model: '', vehicleType: 'SEDAN', capacity: '4', officeLocation: '', insuranceExpiry: '', permitExpiry: '', maintenanceNotes: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  useEffect(() => {
    if (!open) return;
    setErrors({});
    setFormError('');
    setF(
      vehicle
        ? {
            registrationNumber: vehicle.registrationNumber,
            model: vehicle.model,
            vehicleType: vehicle.vehicleType,
            capacity: String(vehicle.capacity),
            officeLocation: vehicle.officeLocation,
            insuranceExpiry: toDateInput(vehicle.insuranceExpiry),
            permitExpiry: toDateInput(vehicle.permitExpiry),
            maintenanceNotes: vehicle.maintenanceNotes ?? '',
          }
        : { registrationNumber: '', model: '', vehicleType: 'SEDAN', capacity: '4', officeLocation: offices.length === 1 ? offices[0].code : '', insuranceExpiry: '', permitExpiry: '', maintenanceNotes: '' },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, vehicle]);

  const save = useAction(
    (body: Record<string, unknown>) => (editing ? patch<{ _id: string }>(`/ops/vehicles/${vehicle!._id}`, body) : post<{ _id: string }>('/ops/vehicles', body)),
    { success: editing ? 'Vehicle updated' : 'Vehicle added', invalidate: [['ops']], silentError: true },
  );
  const set = (k: keyof VehicleForm) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErrors({});
    setFormError('');
    const { registrationNumber, maintenanceNotes, capacity, ...rest } = f;
    const body: Record<string, unknown> = { ...rest, capacity: Number(capacity) };
    if (editing) body.maintenanceNotes = maintenanceNotes;
    else body.registrationNumber = registrationNumber;
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
      title={editing ? `Edit ${vehicle!.registrationNumber}` : 'Add vehicle'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="vehicle-form" loading={save.isPending}>
            {editing ? 'Save changes' : 'Add vehicle'}
          </Button>
        </>
      }
    >
      <form id="vehicle-form" onSubmit={submit} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          {!editing && (
            <Input label="Registration number" required value={f.registrationNumber} onChange={(e) => set('registrationNumber')(e.target.value.toUpperCase())} error={errors.registrationNumber} hint="e.g. KA01AB1234" />
          )}
          <Input label="Model" required value={f.model} onChange={(e) => set('model')(e.target.value)} error={errors.model} hint="e.g. Innova Crysta, Dzire" />
          <Select label="Vehicle type" required value={f.vehicleType} onChange={(e) => set('vehicleType')(e.target.value)} error={errors.vehicleType}>
            {VEHICLE_TYPES.map((t) => (
              <option key={t} value={t}>
                {humanize(t)}
              </option>
            ))}
          </Select>
          <Input label="Passenger capacity" required type="number" min={1} max={60} value={f.capacity} onChange={(e) => set('capacity')(e.target.value)} error={errors.capacity} />
          <Select label="Office" required value={f.officeLocation} onChange={(e) => set('officeLocation')(e.target.value)} error={errors.officeLocation}>
            <option value="">Select office…</option>
            {offices.map((o) => (
              <option key={o.code} value={o.code}>
                {o.name} ({o.code})
              </option>
            ))}
          </Select>
          <Input label="Insurance expiry" type="date" value={f.insuranceExpiry} onChange={(e) => set('insuranceExpiry')(e.target.value)} error={errors.insuranceExpiry} />
          <Input label="Permit expiry" type="date" value={f.permitExpiry} onChange={(e) => set('permitExpiry')(e.target.value)} error={errors.permitExpiry} />
        </div>
        {editing && <Textarea label="Maintenance notes" value={f.maintenanceNotes} onChange={(e) => set('maintenanceNotes')(e.target.value)} error={errors.maintenanceNotes} />}
        <p className="text-xs text-slate-500">A vehicle with expired insurance or permit, or with fewer seats than the passengers, is never offered for assignment.</p>
        {formError && <Alert tone="error">{formError}</Alert>}
      </form>
    </Modal>
  );
}

export default function Vehicles() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [adding, setAdding] = useState(false);
  const list = useListState({ officeLocation: params.get('office') ?? '', status: params.get('status') ?? '', vehicleType: params.get('vehicleType') ?? '' }, 'registrationNumber');
  const { data, isLoading, error, refetch } = usePaged<VehicleRow>(['ops', 'vehicles'], '/ops/vehicles', list.query);

  const columns: Column<VehicleRow>[] = [
    { key: 'reg', header: 'Reg. number', sortKey: 'registrationNumber', render: (v) => <Link to={`/ops/vehicles/${v._id}`} onClick={(e) => e.stopPropagation()} className="whitespace-nowrap font-medium text-indigo-600 hover:underline">{v.registrationNumber}</Link> },
    { key: 'mm', header: 'Model', render: (v) => <span className="whitespace-nowrap">{v.model}</span> },
    { key: 'type', header: 'Type', render: (v) => humanize(v.vehicleType) },
    { key: 'cap', header: 'Seats', sortKey: 'capacity', render: (v) => v.capacity, className: 'text-center' },
    { key: 'status', header: 'Status', sortKey: 'status', render: (v) => <StatusBadge status={v.status} /> },
    { key: 'notes', header: 'Maintenance', render: (v) => (v.maintenanceNotes ? <span className="line-clamp-2 max-w-56 text-xs" title={v.maintenanceNotes}>{v.maintenanceNotes}</span> : <span className="text-slate-400">—</span>) },
    { key: 'ins', header: 'Insurance expiry', render: (v) => <ExpiryText iso={v.insuranceExpiry} /> },
    { key: 'permit', header: 'Permit expiry', render: (v) => <ExpiryText iso={v.permitExpiry} /> },
    { key: 'driver', header: 'Linked driver', render: (v) => (v.currentDriver ? <span className="whitespace-nowrap">{v.currentDriver.fullName} <span className="text-xs text-slate-500">({v.currentDriver.driverCode})</span></span> : <span className="text-slate-400">—</span>) },
    { key: 'office', header: 'Office', render: (v) => v.officeLocation },
  ];

  return (
    <>
      <PageHeader
        title="Vehicles"
        subtitle="Fleet, status and document expiry"
        actions={
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
            Add vehicle
          </Button>
        }
      />
      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <span className="block text-sm font-medium text-slate-700">Search</span>
            <SearchInput value={list.q} onChange={list.setSearch} placeholder="Registration or model…" />
          </div>
          <OfficeSelect value={list.filters.officeLocation} onChange={(v) => list.setFilter('officeLocation', v)} />
          <Select label="Status" value={list.filters.status} onChange={(e) => list.setFilter('status', e.target.value)}>
            <option value="">Any</option>
            {VEHICLE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </Select>
          <Select label="Type" value={list.filters.vehicleType} onChange={(e) => list.setFilter('vehicleType', e.target.value)}>
            <option value="">Any</option>
            {VEHICLE_TYPES.map((t) => (
              <option key={t} value={t}>
                {humanize(t)}
              </option>
            ))}
          </Select>
        </div>
      </Card>
      <DataTable
        columns={columns}
        rows={data?.items}
        rowKey={(v) => v._id}
        loading={isLoading}
        error={error}
        onRetry={refetch}
        sort={list.sort}
        onSort={list.setSort}
        onRowClick={(v) => navigate(`/ops/vehicles/${v._id}`)}
        empty={<EmptyState title="No vehicles found" description="Add a vehicle or change the filters." action={<Button onClick={() => setAdding(true)}>Add vehicle</Button>} />}
      />
      {data && <Pagination page={data.page} total={data.total} totalPages={data.totalPages} onPage={list.setPage} />}
      <VehicleFormModal open={adding} onClose={() => setAdding(false)} onSaved={(id) => navigate(`/ops/vehicles/${id}`)} />
    </>
  );
}
