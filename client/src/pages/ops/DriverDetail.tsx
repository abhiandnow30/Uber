import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
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
  Select,
  Spinner,
  StatusBadge,
  Tabs,
  Textarea,
  useToast,
  type Column,
} from '../../components/ui';
import { del, errorMessage, get, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fieldErrors } from '../../lib/hooks';
import { fmt12h, fmtDateTime, fmtRelative, fmtTravelDate, humanize } from '../../lib/format';
import { DriverFormModal, EMPLOYMENT, type DriverRow } from './Drivers';
import { ExpiryText } from './OpsDashboard';

type Person = { _id: string; name: string } | null | undefined;
type DriverDetailData = DriverRow & {
  verifiedAt?: string;
  lastSeenAt?: string;
  createdAt: string;
  currentVehicle?: { _id: string; registrationNumber: string; model: string; capacity: number; status: string; vehicleType?: string } | null;
  user?: { _id: string; status: string; statusReason?: string; lastLoginAt?: string; invitedAt?: string; activatedAt?: string; email?: string } | null;
  unavailablePeriods: Array<{ _id: string; from: string; to: string; reason: string; createdAt?: string }>;
  verifications: Array<{ _id: string; status: string; documentsChecked: string[]; notes?: string; reviewedBy?: Person; createdAt: string }>;
  links: Array<{ _id: string; vehicle?: { _id: string; registrationNumber: string; model: string } | null; startedAt: string; endedAt?: string | null; isCurrent: boolean; linkedBy?: Person; reason?: string; endReason?: string }>;
  assignments: Array<{
    _id: string;
    status: string;
    scheduledPickupAt: string;
    acknowledgedAt?: string;
    startMethod?: string;
    vehicle?: { _id: string; registrationNumber: string } | null;
    booking?: { _id: string; reference: string; status: string; pickupLocation: string; dropLocation: string; travelDate: string; pickupTime: string } | null;
  }>;
};


function EmploymentModal({ open, onClose, driver, onDone }: { open: boolean; onClose: () => void; driver: DriverDetailData; onDone: () => void }) {
  const [status, setStatus] = useState(driver.employmentStatus);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setStatus(driver.employmentStatus);
      setReason('');
      setErrors({});
      setError('');
    }
  }, [open, driver.employmentStatus]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < 3) {
      setErrors({ reason: 'Please enter at least 3 characters' });
      return;
    }
    setBusy(true);
    setError('');
    try {
      await post(`/ops/drivers/${driver._id}/employment`, { employmentStatus: status, reason: reason.trim() });
      onDone();
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
      title="Change employment status"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="employment-form" loading={busy} disabled={status === driver.employmentStatus}>
            Save
          </Button>
        </>
      }
    >
      <form id="employment-form" onSubmit={submit} className="space-y-4">
        <Select label="Employment status" value={status} onChange={(e) => setStatus(e.target.value)} error={errors.employmentStatus}>
          {EMPLOYMENT.map((s) => (
            <option key={s} value={s}>
              {humanize(s)}
            </option>
          ))}
        </Select>
        {status !== 'ACTIVE' && (driver.activeAssignments ?? driver.assignments.filter((a) => a.status === 'ACTIVE').length) > 0 && (
          <Alert tone="warn">This driver has active assignments. Coordinators will be notified so they can reassign them.</Alert>
        )}
        <Textarea label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} error={errors.reason} />
        {error && !Object.keys(errors).length && <Alert tone="error">{error}</Alert>}
      </form>
    </Modal>
  );
}

function UnavailableModal({ open, onClose, driverId, onDone }: { open: boolean; onClose: () => void; driverId: string; onDone: (affected: number) => void }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setFrom('');
      setTo('');
      setReason('');
      setErrors({});
      setError('');
    }
  }, [open]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!from) errs.from = 'Required';
    if (!to) errs.to = 'Required';
    if (from && to && new Date(to) <= new Date(from)) errs.to = '"To" must be after "from"';
    if (reason.trim().length < 3) errs.reason = 'Please enter at least 3 characters';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError('');
    try {
      const r = await post<{ affectedAssignments: number }>(`/ops/drivers/${driverId}/unavailability`, { from: new Date(from).toISOString(), to: new Date(to).toISOString(), reason: reason.trim() });
      onDone(r.affectedAssignments ?? 0);
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
      title="Flag driver unavailable"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="unavail-form" loading={busy}>
            Flag unavailable
          </Button>
        </>
      }
    >
      <form id="unavail-form" onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="From" type="datetime-local" required value={from} onChange={(e) => setFrom(e.target.value)} error={errors.from} />
          <Input label="To" type="datetime-local" required value={to} onChange={(e) => setTo(e.target.value)} error={errors.to} />
        </div>
        <Textarea label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} error={errors.reason} placeholder="e.g. Sick leave" />
        <p className="text-xs text-slate-500">Times are in your browser&apos;s local time. The driver cannot be assigned trips overlapping this period; coordinators are notified about existing overlapping rides so they can reassign them.</p>
        {error && !Object.keys(errors).length && <Alert tone="error">{error}</Alert>}
      </form>
    </Modal>
  );
}

type Dialog = null | 'suspend' | 'activate' | 'endLink' | { removePeriod: string };

export default function DriverDetail() {
  const { id = '' } = useParams();
  const { me } = useAuth();
  const isAdmin = me?.user.role === 'ADMIN';
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<'trips' | 'links'>('trips');
  const [editing, setEditing] = useState(false);
  const [employment, setEmployment] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);

  const { data: d, isLoading, error, refetch } = useQuery({
    queryKey: ['ops', 'driver', id],
    queryFn: ({ signal }) => get<DriverDetailData>(`/ops/drivers/${id}`, signal),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['ops'] });

  if (isLoading) return <Spinner />;
  if (error || !d)
    return (
      <>
        <BackLink />
        <ErrorState error={error ?? new Error('Driver not found')} onRetry={refetch} />
      </>
    );

  const currentLink = d.links.find((l) => l.isCurrent);
  const now = Date.now();
  const periods = [...(d.unavailablePeriods ?? [])].sort((a, b) => +new Date(b.from) - +new Date(a.from));
  const activeCount = d.assignments.filter((a) => a.status === 'ACTIVE').length;

  const tripCols: Column<DriverDetailData['assignments'][number]>[] = [
    { key: 'ref', header: 'Booking', render: (a) => (a.booking ? <Link className="font-medium text-indigo-600 hover:underline" to={`/ops/bookings/${a.booking._id}`}>{a.booking.reference}</Link> : '—') },
    { key: 'when', header: 'Pickup', render: (a) => <span className="whitespace-nowrap">{a.booking ? `${fmtTravelDate(a.booking.travelDate)} ${fmt12h(a.booking.pickupTime)}` : fmtDateTime(a.scheduledPickupAt)}</span> },
    { key: 'route', header: 'Route', render: (a) => (a.booking ? <span className="text-xs">{a.booking.pickupLocation} → {a.booking.dropLocation}</span> : '—') },
    { key: 'veh', header: 'Vehicle', render: (a) => a.vehicle?.registrationNumber ?? '—' },
    { key: 'asg', header: 'Assignment', render: (a) => <StatusBadge status={a.status} /> },
    { key: 'bst', header: 'Booking status', render: (a) => <StatusBadge status={a.booking?.status} /> },
    { key: 'ack', header: 'Ack', render: (a) => (a.acknowledgedAt ? fmtDateTime(a.acknowledgedAt) : '—') },
    { key: 'start', header: 'Start', render: (a) => (a.startMethod ? humanize(a.startMethod) : '—') },
  ];
  const linkCols: Column<DriverDetailData['links'][number]>[] = [
    { key: 'veh', header: 'Vehicle', render: (l) => (l.vehicle ? <Link className="text-indigo-600 hover:underline" to={`/ops/vehicles/${l.vehicle._id}`}>{l.vehicle.registrationNumber}{l.vehicle.model ? ` · ${l.vehicle.model}` : ''}</Link> : '—') },
    { key: 'from', header: 'Linked', render: (l) => fmtDateTime(l.startedAt) },
    { key: 'to', header: 'Ended', render: (l) => (l.isCurrent ? <StatusBadge status="ACTIVE" /> : fmtDateTime(l.endedAt)) },
    { key: 'by', header: 'Linked by', render: (l) => l.linkedBy?.name ?? '—' },
    { key: 'reason', header: 'Reason', render: (l) => <span className="text-xs">{[l.reason, l.endReason && `Ended: ${l.endReason}`].filter(Boolean).join(' · ') || '—'}</span> },
  ];

  const loginStatus = d.user?.status;

  return (
    <>
      <BackLink />
      <PageHeader
        title={d.fullName}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            {d.driverCode} · {d.officeLocation}
            <StatusBadge status={d.availability} />
            {d.onDuty ? <span className="text-emerald-700">On duty</span> : <span>Off duty</span>}
          </span>
        }
        actions={
          <>
            <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button variant="secondary" onClick={() => setEmployment(true)}>
              Employment status
            </Button>
            <Button variant="secondary" onClick={() => setUnavailable(true)}>
              Flag unavailable
            </Button>
          </>
        }
      />

      <div className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title="Profile" className="lg:col-span-2">
            <DescriptionList
              items={[
                ['Driver ID', d.driverCode],
                ['Phone', d.phone],
                ['Office', d.officeLocation],
                ['License number', d.licenseNumber],
                ['License expiry', <ExpiryText key="l" iso={d.licenseExpiry} />],
                ['Employment', <StatusBadge key="e" status={d.employmentStatus} />],
                ['Availability', <StatusBadge key="a" status={d.availability} />],
                ['Active assignments', activeCount],
                ['Last seen', d.lastSeenAt ? fmtRelative(d.lastSeenAt) : '—'],
                ['Added', fmtDateTime(d.createdAt)],
              ]}
            />
          </Card>
          <div className="space-y-4">
            <Card title="Sign-in">
              <p className="mb-3 text-sm text-slate-600">
                Signs in with mobile number <strong>{d.phone}</strong>; the password is its first 4 digits.
              </p>
              {!d.user ? (
                <p className="text-sm text-slate-500">Hasn&apos;t signed in yet. You can already assign rides; the driver sees them after signing in.</p>
              ) : (
                <>
                  <DescriptionList
                    columns={1}
                    items={[
                      ['Status', <StatusBadge key="s" status={loginStatus} />],
                      ...(d.user.statusReason ? ([['Reason', d.user.statusReason]] as Array<[string, string]>) : []),
                      ['Activated', fmtDateTime(d.user.activatedAt)],
                      ['Last sign-in', fmtDateTime(d.user.lastLoginAt)],
                    ]}
                  />
                  {isAdmin && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {loginStatus === 'ACTIVE' && (
                        <Button size="sm" variant="danger" onClick={() => setDialog('suspend')}>
                          Suspend login
                        </Button>
                      )}
                      {(loginStatus === 'SUSPENDED' || loginStatus === 'INACTIVE') && (
                        <Button size="sm" variant="success" onClick={() => setDialog('activate')}>
                          Activate login
                        </Button>
                      )}
                    </div>
                  )}
                </>
              )}
            </Card>
            <Card title="Cab">
              {!d.currentVehicle ? (
                <p className="text-sm text-slate-500">
                  Not assigned to a cab yet. Open a cab under{' '}
                  <Link className="font-medium text-indigo-600 hover:underline" to="/ops/vehicles">
                    Vehicles
                  </Link>{' '}
                  and choose this driver.
                </p>
              ) : (
                <>
                  <p className="text-sm">
                    <Link className="font-mono font-medium text-indigo-600 hover:underline" to={`/ops/vehicles/${d.currentVehicle._id}`}>
                      {d.currentVehicle.registrationNumber}
                    </Link>{' '}
                    · {d.currentVehicle.capacity} seats <StatusBadge status={d.currentVehicle.status} />
                  </p>
                  {currentLink && <p className="mt-1 text-xs text-slate-500">Assigned {fmtDateTime(currentLink.startedAt)} by {currentLink.linkedBy?.name ?? '—'}</p>}
                  <p className="mt-2 text-xs text-slate-500">To change it, pick a different driver on the cab&apos;s page.</p>
                  {currentLink && (
                    <Button className="mt-3" size="sm" variant="secondary" onClick={() => setDialog('endLink')}>
                      Remove from cab
                    </Button>
                  )}
                </>
              )}
            </Card>
          </div>
        </div>

        <Card
          title="Unavailability periods"
          actions={
            <Button size="sm" variant="secondary" onClick={() => setUnavailable(true)}>
              Add period
            </Button>
          }
        >
          {!periods.length ? (
            <p className="text-sm text-slate-500">No unavailability recorded.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {periods.map((p) => {
                const state = new Date(p.to).getTime() < now ? 'Past' : new Date(p.from).getTime() <= now ? 'Now' : 'Upcoming';
                return (
                  <li key={p._id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                    <span className={state === 'Now' ? 'rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800' : 'rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600'}>{state}</span>
                    <span className="whitespace-nowrap">
                      {fmtDateTime(p.from)} → {fmtDateTime(p.to)}
                    </span>
                    <span className="min-w-0 flex-1 text-slate-600">{p.reason}</span>
                    <Button size="sm" variant="ghost" aria-label="Remove period" icon={<Trash2 className="h-4 w-4" />} onClick={() => setDialog({ removePeriod: p._id })} />
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card>
          <Tabs
            tabs={[
              { value: 'trips', label: `Trip history (${d.assignments.length})` },
              { value: 'links', label: `Vehicle links (${d.links.length})` },
            ]}
            value={tab}
            onChange={setTab}
          />
          {tab === 'trips' && <DataTable columns={tripCols} rows={d.assignments} rowKey={(a) => a._id} empty={<EmptyState title="No trips yet" />} />}
          {tab === 'links' && <DataTable columns={linkCols} rows={d.links} rowKey={(l) => l._id} empty={<EmptyState title="Never linked to a vehicle" />} />}
        </Card>
      </div>

      <DriverFormModal open={editing} onClose={() => setEditing(false)} driver={d} />
      <EmploymentModal open={employment} onClose={() => setEmployment(false)} driver={d} onDone={() => { toast.success('Employment status updated'); refresh(); }} />
      <UnavailableModal
        open={unavailable}
        onClose={() => setUnavailable(false)}
        driverId={d._id}
        onDone={(n) => {
          if (n) toast.error('Driver flagged unavailable', `${n} overlapping ride${n === 1 ? '' : 's'} must be reassigned — see Cab requests.`);
          else toast.success('Driver flagged unavailable');
          refresh();
        }}
      />

      <ConfirmDialog
        open={dialog === 'suspend'}
        onClose={() => setDialog(null)}
        title="Suspend driver login"
        message="The driver is signed out and cannot use the driver dashboard. Their active rides become ineligible and must be reassigned."
        confirmLabel="Suspend"
        reasonLabel="Reason"
        onConfirm={async (reason) => {
          await post(`/admin/drivers/${d._id}/account-status`, { status: 'SUSPENDED', reason });
          toast.success('Login suspended');
          refresh();
        }}
      />
      <ConfirmDialog
        open={dialog === 'activate'}
        onClose={() => setDialog(null)}
        title="Activate driver login"
        message="The driver will be able to sign in to the driver dashboard again."
        confirmLabel="Activate"
        tone="primary"
        reasonLabel="Reason"
        onConfirm={async (reason) => {
          await post(`/admin/drivers/${d._id}/account-status`, { status: 'ACTIVE', reason });
          toast.success('Login activated');
          refresh();
        }}
      />
      <ConfirmDialog
        open={dialog === 'endLink'}
        onClose={() => setDialog(null)}
        title="End driver–vehicle link"
        message={`${d.fullName} will no longer have ${d.currentVehicle?.registrationNumber ?? 'this vehicle'} as their default vehicle. Existing assignments are not changed.`}
        confirmLabel="End link"
        reasonLabel="Reason"
        onConfirm={async (reason) => {
          await post(`/ops/links/${currentLink!._id}/end`, { reason });
          toast.success('Link ended');
          refresh();
        }}
      />
      <ConfirmDialog
        open={!!dialog && typeof dialog === 'object'}
        onClose={() => setDialog(null)}
        title="Remove unavailability period"
        message="The driver becomes assignable again during this period (if otherwise eligible)."
        confirmLabel="Remove"
        onConfirm={async () => {
          if (dialog && typeof dialog === 'object') await del(`/ops/drivers/${d._id}/unavailability/${dialog.removePeriod}`);
          toast.success('Period removed');
          refresh();
        }}
      />
    </>
  );
}

function BackLink() {
  return (
    <Link to="/ops/drivers" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900">
      <ArrowLeft className="h-4 w-4" /> Drivers
    </Link>
  );
}
