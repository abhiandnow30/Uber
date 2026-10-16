import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, ConfirmDialog, DataTable, EmptyState, Modal, PageHeader, Pagination, Select, StatusBadge, Tabs, Textarea, useToast, type Column } from '../../components/ui';
import { errorMessage, get, post, qs, type Paged } from '../../lib/api';
import { fieldErrors, usePaged } from '../../lib/hooks';
import { fmtDateTime } from '../../lib/format';
import type { DriverRow } from './Drivers';
import type { VehicleRow } from './Vehicles';

type LinkRow = {
  _id: string;
  driver?: { _id: string; fullName: string; driverCode: string; verificationStatus: string; employmentStatus: string; availability: string; officeLocation: string } | null;
  vehicle?: { _id: string; registrationNumber: string; model: string; capacity: number; status: string } | null;
  startedAt: string;
  endedAt?: string | null;
  isCurrent: boolean;
  linkedBy?: { _id: string; name: string } | null;
  unlinkedBy?: { _id: string; name: string } | null;
  reason?: string;
  endReason?: string;
};

function LinkModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [driverId, setDriverId] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setDriverId('');
      setVehicleId('');
      setReason('');
      setErrors({});
      setError('');
    }
  }, [open]);
  const drivers = useQuery({
    queryKey: ['ops', 'drivers', 'link-options'],
    queryFn: () => get<Paged<DriverRow>>('/ops/drivers?pageSize=100&sort=fullName'),
    enabled: open,
  });
  const vehicles = useQuery({
    queryKey: ['ops', 'vehicles', 'link-options'],
    queryFn: () => get<Paged<VehicleRow>>('/ops/vehicles?pageSize=100'),
    enabled: open,
  });
  const driver = drivers.data?.items.find((d) => d._id === driverId);
  const vehicle = vehicles.data?.items.find((v) => v._id === vehicleId);
  const vehicleChoices = (vehicles.data?.items ?? []).filter((v) => v.status !== 'INACTIVE' && (!driver || v.officeLocation === driver.officeLocation));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!driverId) errs.driverId = 'Select a driver';
    if (!vehicleId) errs.vehicleId = 'Select a vehicle';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError('');
    try {
      await post('/ops/links', { driverId, vehicleId, reason: reason.trim() });
      toast.success('Driver linked to vehicle', `${driver?.fullName ?? ''} → ${vehicle?.registrationNumber ?? ''}`);
      qc.invalidateQueries({ queryKey: ['ops'] });
      onClose();
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Link driver to vehicle"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="link-form" loading={busy}>
            Link
          </Button>
        </>
      }
    >
      <form id="link-form" onSubmit={submit} className="space-y-4">
        {(drivers.error || vehicles.error) && <Alert tone="error">{errorMessage(drivers.error ?? vehicles.error)}</Alert>}
        <Select
          label="Driver"
          required
          value={driverId}
          onChange={(e) => {
            setDriverId(e.target.value);
            setVehicleId('');
          }}
          error={errors.driverId}
          disabled={drivers.isLoading}
        >
          <option value="">{drivers.isLoading ? 'Loading drivers…' : 'Select driver…'}</option>
          {drivers.data?.items
            .filter((d) => d.employmentStatus === 'ACTIVE')
            .map((d) => (
              <option key={d._id} value={d._id}>
                {d.fullName} ({d.driverCode}) · {d.officeLocation}
                {d.currentVehicle ? ` · now ${d.currentVehicle.registrationNumber}` : ''}
                {d.verificationStatus !== 'VERIFIED' ? ` · ${d.verificationStatus.toLowerCase()}` : ''}
              </option>
            ))}
        </Select>
        <Select label="Vehicle" required value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} error={errors.vehicleId} disabled={vehicles.isLoading}>
          <option value="">{vehicles.isLoading ? 'Loading vehicles…' : driver ? `Select vehicle in ${driver.officeLocation}…` : 'Select vehicle…'}</option>
          {vehicleChoices.map((v) => (
            <option key={v._id} value={v._id}>
              {v.registrationNumber} · {v.model} · {v.capacity} seats
              {v.currentDriver ? ` · now ${v.currentDriver.fullName}` : ''}
              {v.status !== 'ACTIVE' ? ` · ${v.status.toLowerCase()}` : ''}
            </option>
          ))}
        </Select>
        {(driver?.currentVehicle || vehicle?.currentDriver) && (
          <Alert tone="warn">
            {driver?.currentVehicle && <p>{driver.fullName} is currently linked to {driver.currentVehicle.registrationNumber}; that link will end.</p>}
            {vehicle?.currentDriver && <p>{vehicle.registrationNumber} is currently linked to {vehicle.currentDriver.fullName}; that link will end.</p>}
          </Alert>
        )}
        <Textarea label="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} error={errors.reason} />
        <Alert tone="info">
          Linking ends any previous links of both the driver and the vehicle. The link only sets the driver&apos;s default vehicle — it does not make the driver available for
          every trip. Availability, verification and schedule are still checked for each assignment.
        </Alert>
        {error && !Object.keys(errors).length && <Alert tone="error">{error}</Alert>}
      </form>
    </Modal>
  );
}

export default function Links() {
  const [tab, setTab] = useState<'current' | 'history'>('current');
  const [page, setPage] = useState(1);
  const [linking, setLinking] = useState(false);
  const [ending, setEnding] = useState<LinkRow | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error, refetch } = usePaged<LinkRow>(['ops', 'links'], '/ops/links', qs({ current: tab === 'current' ? 'true' : 'false', page, pageSize: 25 }));

  const columns: Column<LinkRow>[] = [
    {
      key: 'driver',
      header: 'Driver',
      render: (l) =>
        l.driver ? (
          <div>
            <Link to={`/ops/drivers/${l.driver._id}`} className="font-medium text-indigo-600 hover:underline">
              {l.driver.fullName}
            </Link>
            <p className="text-xs text-slate-500">
              {l.driver.driverCode} · {l.driver.officeLocation}
            </p>
          </div>
        ) : (
          '—'
        ),
    },
    {
      key: 'dstatus',
      header: 'Driver status',
      render: (l) =>
        l.driver ? (
          <div className="flex flex-wrap gap-1">
            <StatusBadge status={l.driver.availability} />
            {l.driver.verificationStatus !== 'VERIFIED' && <StatusBadge status={l.driver.verificationStatus} />}
            {l.driver.employmentStatus !== 'ACTIVE' && <StatusBadge status={l.driver.employmentStatus} />}
          </div>
        ) : null,
    },
    {
      key: 'vehicle',
      header: 'Vehicle',
      render: (l) =>
        l.vehicle ? (
          <div>
            <Link to={`/ops/vehicles/${l.vehicle._id}`} className="font-medium text-indigo-600 hover:underline">
              {l.vehicle.registrationNumber}
            </Link>
            <p className="text-xs text-slate-500">
              {l.vehicle.model} · {l.vehicle.capacity} seats
            </p>
          </div>
        ) : (
          '—'
        ),
    },
    { key: 'vstatus', header: 'Vehicle status', render: (l) => <StatusBadge status={l.vehicle?.status} /> },
    { key: 'since', header: 'Linked', render: (l) => <span className="whitespace-nowrap">{fmtDateTime(l.startedAt)}</span> },
    { key: 'by', header: 'Linked by', render: (l) => l.linkedBy?.name ?? '—' },
    ...(tab === 'history'
      ? ([
          { key: 'ended', header: 'Ended', render: (l) => (l.isCurrent ? <StatusBadge status="ACTIVE" /> : <span className="whitespace-nowrap">{fmtDateTime(l.endedAt)}</span>) },
          { key: 'endedBy', header: 'Ended by', render: (l) => l.unlinkedBy?.name ?? '—' },
        ] as Column<LinkRow>[])
      : []),
    { key: 'reason', header: 'Reason', render: (l) => <span className="text-xs">{[l.reason, l.endReason && `Ended: ${l.endReason}`].filter(Boolean).join(' · ') || '—'}</span> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      render: (l) =>
        l.isCurrent ? (
          <Button size="sm" variant="secondary" onClick={() => setEnding(l)}>
            End link
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Driver–vehicle links"
        subtitle="Each driver's default vehicle. Assignments still pick a driver and vehicle per trip."
        actions={
          <Button icon={<Link2 className="h-4 w-4" />} onClick={() => setLinking(true)}>
            Link driver to vehicle
          </Button>
        }
      />
      <Tabs
        tabs={[
          { value: 'current', label: 'Current links' },
          { value: 'history', label: 'Full history' },
        ]}
        value={tab}
        onChange={(v) => {
          setTab(v);
          setPage(1);
        }}
      />
      <DataTable
        columns={columns}
        rows={data?.items}
        rowKey={(l) => l._id}
        loading={isLoading}
        error={error}
        onRetry={refetch}
        empty={<EmptyState title={tab === 'current' ? 'No drivers are linked to vehicles' : 'No link history'} action={tab === 'current' ? <Button onClick={() => setLinking(true)}>Link driver to vehicle</Button> : undefined} />}
      />
      {data && <Pagination page={data.page} total={data.total} totalPages={data.totalPages} onPage={setPage} />}

      <LinkModal open={linking} onClose={() => setLinking(false)} />
      <ConfirmDialog
        open={!!ending}
        onClose={() => setEnding(null)}
        title="End link"
        message={`${ending?.driver?.fullName ?? 'The driver'} will no longer have ${ending?.vehicle?.registrationNumber ?? 'this vehicle'} as their default vehicle. Existing assignments are not changed.`}
        confirmLabel="End link"
        reasonLabel="Reason"
        onConfirm={async (reason) => {
          await post(`/ops/links/${ending!._id}/end`, { reason });
          toast.success('Link ended');
          qc.invalidateQueries({ queryKey: ['ops'] });
        }}
      />
    </>
  );
}
