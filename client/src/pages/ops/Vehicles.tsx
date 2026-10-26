import { Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, DataTable, EmptyState, Input, Modal, PageHeader, Pagination, SearchInput, Select, StatusBadge, type Column } from '../../components/ui';
import { errorMessage, patch, post } from '../../lib/api';
import { fieldErrors, useAction, useListState, usePaged } from '../../lib/hooks';
import { humanize } from '../../lib/format';
import { DriverPicker } from './Drivers';
import { OfficeSelect, useOpsOffices } from './OpsDashboard';

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

// A cab is identified by its registration number; seats is the only other thing needed to assign it.
// The office decides which coordinators see it and is only asked when there is more than one.
type VehicleForm = { registrationNumber: string; capacity: string; officeLocation: string };

/** Create (no `vehicle`) or edit an existing vehicle. */
export function VehicleFormModal({ open, onClose, vehicle, onSaved }: { open: boolean; onClose: () => void; vehicle?: VehicleRow | null; onSaved?: (id: string) => void }) {
  const { offices } = useOpsOffices();
  const editing = !!vehicle;
  const [f, setF] = useState<VehicleForm>({ registrationNumber: '', capacity: '4', officeLocation: '' });
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
            capacity: String(vehicle.capacity),
            officeLocation: vehicle.officeLocation,
          }
        : { registrationNumber: '', capacity: '4', officeLocation: offices.length === 1 ? offices[0].code : '' },
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
    const body: Record<string, unknown> = { capacity: Number(f.capacity), officeLocation: f.officeLocation };
    if (!editing) body.registrationNumber = f.registrationNumber;
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
            <Input
              label="Registration number"
              required
              autoComplete="off"
              value={f.registrationNumber}
              onChange={(e) => set('registrationNumber')(e.target.value.toUpperCase())}
              error={errors.registrationNumber}
              hint="As on the number plate, e.g. KA 01 CE 1234"
            />
          )}
          <Input label="Seats (passengers)" required type="number" min={1} max={60} value={f.capacity} onChange={(e) => set('capacity')(e.target.value)} error={errors.capacity} />
          {offices.length > 1 && (
            <Select label="Office" required value={f.officeLocation} onChange={(e) => set('officeLocation')(e.target.value)} error={errors.officeLocation}>
              <option value="">Select office…</option>
              {offices.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.name} ({o.code})
                </option>
              ))}
            </Select>
          )}
        </div>
        {!editing && <p className="text-xs text-slate-500">The registration number identifies the cab and can&apos;t be changed later.</p>}
        {formError && <Alert tone="error">{formError}</Alert>}
      </form>
    </Modal>
  );
}

export default function Vehicles() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [adding, setAdding] = useState(false);
  const list = useListState({ officeLocation: params.get('office') ?? '', status: params.get('status') ?? '' }, 'registrationNumber');
  const { data, isLoading, error, refetch } = usePaged<VehicleRow>(['ops', 'vehicles'], '/ops/vehicles', list.query);

  const columns: Column<VehicleRow>[] = [
    { key: 'reg', header: 'Reg. number', sortKey: 'registrationNumber', render: (v) => <Link to={`/ops/vehicles/${v._id}`} onClick={(e) => e.stopPropagation()} className="whitespace-nowrap font-medium text-indigo-600 hover:underline">{v.registrationNumber}</Link> },
    { key: 'cap', header: 'Seats', sortKey: 'capacity', render: (v) => v.capacity, className: 'text-center' },
    { key: 'status', header: 'Status', sortKey: 'status', render: (v) => <StatusBadge status={v.status} /> },
    { key: 'driver', header: 'Driver', render: (v) => <DriverPicker vehicle={v} className="min-w-[12rem]" /> },
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
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <span className="block text-sm font-medium text-slate-700">Search</span>
            <SearchInput value={list.q} onChange={list.setSearch} placeholder="Registration number…" />
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
