import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pencil } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CallButton, Alert, Button, Card, DataTable, DescriptionList, EmptyState, ErrorState, Input, Modal, PageHeader, Select, Spinner, StatusBadge, Tabs, Textarea, useToast, type Column } from '../../components/ui';
import { errorMessage, get, post } from '../../lib/api';
import { fieldErrors } from '../../lib/hooks';
import { useUnsavedChanges } from '../../lib/unsaved';
import { fmt12h, fmtDate, fmtDateTime, fmtTravelDate, humanize } from '../../lib/format';
import { DriverPicker } from './Drivers';
import { VEHICLE_STATUSES, VehicleFormModal, type VehicleRow } from './Vehicles';

type Person = { _id: string; name: string } | null | undefined;
type VehicleDetailData = VehicleRow & {
  createdAt: string;
  links: Array<{ _id: string; driver?: { _id: string; fullName: string; driverCode: string } | null; startedAt: string; endedAt?: string | null; isCurrent: boolean; linkedBy?: Person; reason?: string; endReason?: string }>;
  assignments: Array<{
    _id: string;
    status: string;
    scheduledPickupAt: string;
    startMethod?: string;
    driver?: { _id: string; fullName: string; driverCode: string } | null;
    booking?: { _id: string; reference: string; status: string; travelDate: string; pickupTime: string } | null;
  }>;
};

function StatusModal({ open, onClose, vehicle, onDone }: { open: boolean; onClose: () => void; vehicle: VehicleDetailData; onDone: () => void }) {
  const [status, setStatus] = useState(vehicle.status);
  const [reason, setReason] = useState('');
  const [due, setDue] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setStatus(vehicle.status);
      setReason('');
      setDue('');
      setErrors({});
      setError('');
    }
  }, [open, vehicle.status]);
  const active = vehicle.assignments.filter((a) => a.status === 'ACTIVE').length;
  const save = async (): Promise<boolean> => {
    if (reason.trim().length < 3) {
      setErrors({ reason: 'Please enter at least 3 characters' });
      return false;
    }
    setBusy(true);
    setError('');
    try {
      await post(`/ops/vehicles/${vehicle._id}/status`, { status, reason: reason.trim(), ...(status === 'MAINTENANCE' && due ? { maintenanceDueAt: due } : {}) });
      onDone();
      onClose();
      return true;
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save();
  };
  const guard = useUnsavedChanges(open && (status !== vehicle.status || !!reason.trim() || !!due), save);
  const close = () => guard(onClose);
  return (
    <Modal
      open={open}
      onClose={close}
      title="Change vehicle status"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="vstatus-form" loading={busy} disabled={status === vehicle.status}>
            Save
          </Button>
        </>
      }
    >
      <form id="vstatus-form" onSubmit={submit} className="space-y-4">
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} error={errors.status}>
          {VEHICLE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {humanize(s)}
            </option>
          ))}
        </Select>
        {status !== 'ACTIVE' && active > 0 && <Alert tone="warn">This vehicle has {active} active assignment(s). Coordinators will be notified so they can reassign them.</Alert>}
        <Textarea label={status === 'MAINTENANCE' ? 'Maintenance details / reason' : 'Reason'} required value={reason} onChange={(e) => setReason(e.target.value)} error={errors.reason} />
        {status === 'MAINTENANCE' && <Input label="Maintenance due / expected back" type="date" value={due} onChange={(e) => setDue(e.target.value)} error={errors.maintenanceDueAt} />}
        {error && !Object.keys(errors).length && <Alert tone="error">{error}</Alert>}
      </form>
    </Modal>
  );
}

export default function VehicleDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<'trips' | 'links'>('trips');
  const [editing, setEditing] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);
  const { data: v, isLoading, error, refetch } = useQuery({
    queryKey: ['ops', 'vehicle', id],
    queryFn: ({ signal }) => get<VehicleDetailData>(`/ops/vehicles/${id}`, signal),
  });

  if (isLoading) return <Spinner />;
  if (error || !v)
    return (
      <>
        <BackLink />
        <ErrorState error={error ?? new Error('Vehicle not found')} onRetry={refetch} />
      </>
    );

  const tripCols: Column<VehicleDetailData['assignments'][number]>[] = [
    { key: 'ref', header: 'Booking', render: (a) => (a.booking ? <Link className="font-medium text-indigo-600 hover:underline" to={`/ops/bookings/${a.booking._id}`}>{a.booking.reference}</Link> : '—') },
    { key: 'when', header: 'Pickup', render: (a) => <span className="whitespace-nowrap">{a.booking ? `${fmtTravelDate(a.booking.travelDate)} ${fmt12h(a.booking.pickupTime)}` : fmtDateTime(a.scheduledPickupAt)}</span> },
    { key: 'driver', header: 'Driver', render: (a) => (a.driver ? <Link className="text-indigo-600 hover:underline" to={`/ops/drivers/${a.driver._id}`}>{a.driver.fullName} ({a.driver.driverCode})</Link> : '—') },
    { key: 'asg', header: 'Assignment', render: (a) => <StatusBadge status={a.status} /> },
    { key: 'bst', header: 'Booking status', render: (a) => <StatusBadge status={a.booking?.status} /> },
    { key: 'start', header: 'Start', render: (a) => (a.startMethod ? humanize(a.startMethod) : '—') },
  ];
  const linkCols: Column<VehicleDetailData['links'][number]>[] = [
    { key: 'driver', header: 'Driver', render: (l) => (l.driver ? <Link className="text-indigo-600 hover:underline" to={`/ops/drivers/${l.driver._id}`}>{l.driver.fullName} ({l.driver.driverCode})</Link> : '—') },
    { key: 'from', header: 'Linked', render: (l) => fmtDateTime(l.startedAt) },
    { key: 'to', header: 'Ended', render: (l) => (l.isCurrent ? <StatusBadge status="ACTIVE" /> : fmtDateTime(l.endedAt)) },
    { key: 'by', header: 'Linked by', render: (l) => l.linkedBy?.name ?? '—' },
    { key: 'reason', header: 'Reason', render: (l) => <span className="text-xs">{[l.reason, l.endReason && `Ended: ${l.endReason}`].filter(Boolean).join(' · ') || '—'}</span> },
  ];

  return (
    <>
      <BackLink />
      <PageHeader
        title={v.registrationNumber}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            {v.model ? `${v.model} · ` : ''}{v.capacity} seats · {v.officeLocation}
            <StatusBadge status={v.status} />
          </span>
        }
        actions={
          <>
            <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button variant="secondary" onClick={() => setChangingStatus(true)}>
              Change status
            </Button>
          </>
        }
      />
      <div className="space-y-4">
        {v.status === 'MAINTENANCE' && (
          <Alert tone="warn" title="In maintenance">
            {v.maintenanceNotes || '—'}
            {v.maintenanceDueAt ? ` · expected back ${fmtDate(v.maintenanceDueAt)}` : ''}
          </Alert>
        )}
        <div className="grid gap-4 lg:grid-cols-3 max-lg:[&>*]:min-w-0">
          <Card title="Vehicle" className="lg:col-span-2">
            <DescriptionList
              items={[
                ['Registration', v.registrationNumber],
                ['Capacity', `${v.capacity} passengers`],
                ['Office', v.officeLocation],
                ['Status', <StatusBadge key="s" status={v.status} />],
                ['Added', fmtDateTime(v.createdAt)],
              ]}
            />
          </Card>
          <Card title="Driver">
            {v.currentDriver ? (
              <p className="mb-3 text-sm">
                <Link className="font-medium text-indigo-600 hover:underline" to={`/ops/drivers/${v.currentDriver._id}`}>
                  {v.currentDriver.fullName}
                </Link>{' '}
                ({v.currentDriver.driverCode}) <CallButton phone={v.currentDriver.phone} name={v.currentDriver.fullName} className="ml-1 align-middle" />
              </p>
            ) : (
              <p className="mb-3 text-sm text-slate-500">No driver assigned to this cab.</p>
            )}
            <DriverPicker vehicle={v} />
          </Card>
        </div>
        <Card>
          <Tabs
            tabs={[
              { value: 'trips', label: `Assignment history (${v.assignments.length})` },
              { value: 'links', label: `Driver links (${v.links.length})` },
            ]}
            value={tab}
            onChange={setTab}
          />
          {tab === 'trips' ? (
            <DataTable columns={tripCols} rows={v.assignments} rowKey={(a) => a._id} empty={<EmptyState title="No trips yet" />} />
          ) : (
            <DataTable columns={linkCols} rows={v.links} rowKey={(l) => l._id} empty={<EmptyState title="Never linked to a driver" />} />
          )}
        </Card>
      </div>
      <VehicleFormModal open={editing} onClose={() => setEditing(false)} vehicle={v} />
      <StatusModal
        open={changingStatus}
        onClose={() => setChangingStatus(false)}
        vehicle={v}
        onDone={() => {
          toast.success('Vehicle status updated');
          qc.invalidateQueries({ queryKey: ['ops'] });
        }}
      />
    </>
  );
}

function BackLink() {
  return (
    <Link to="/ops/vehicles" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900">
      <ArrowLeft className="h-4 w-4" /> Vehicles
    </Link>
  );
}
