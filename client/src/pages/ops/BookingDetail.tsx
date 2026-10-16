import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Circle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
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
  PageHeader,
  Spinner,
  StatusBadge,
  useToast,
  type Column,
} from '../../components/ui';
import { get, post } from '../../lib/api';
import { fmtDateTime, fmtRelative, fmtTravelDate, humanize } from '../../lib/format';
import { ASSIGNABLE, AssignModal, REASSIGNABLE, type AssignTarget } from './Bookings';

type Person = { _id: string; name: string } | null | undefined;
type Assignment = {
  _id: string;
  status: string;
  driver?: { _id: string; fullName: string; driverCode: string; phone: string } | null;
  vehicle?: { _id: string; registrationNumber: string; model: string; capacity: number } | null;
  assignedBy?: Person;
  acknowledgedAt?: string;
  declinedAt?: string;
  declineReason?: string;
  enRouteAt?: string;
  arrivedAt?: string;
  startedAt?: string;
  completedAt?: string;
  startMethod?: 'PIN' | 'OVERRIDE';
  overrideReason?: string;
  completionMethod?: 'DRIVER' | 'OVERRIDE';
  completionOverrideReason?: string;
  endedAt?: string;
  endReason?: string;
  createdAt: string;
};
type HistoryRow = { _id: string; from?: string; to: string; event: string; actor?: Person; actorRole?: string; reason?: string; createdAt: string };
type EmailRow = { _id: string; template: string; to: string; status: string; attempts: number; lastError?: string; acceptedAt?: string; createdAt: string };
type BookingDetailData = {
  _id: string;
  reference: string;
  status: string;
  officeLocation: string;
  pickupLocation: string;
  dropLocation: string;
  travelDate: string;
  pickupTime: string;
  timezone: string;
  scheduledPickupAt: string;
  passengers: number;
  tripType: string;
  leg?: string;
  tripGroupId?: string;
  shift?: string;
  notes?: string;
  approvalRequired?: boolean;
  approvedAt?: string;
  rejectionReason?: string;
  cancellationReason?: string;
  cancelledByRole?: string;
  cancelledAt?: string;
  completedAt?: string;
  isDelayed?: boolean;
  delayReason?: string;
  flaggedForReview?: boolean;
  flagReason?: string;
  cancellationRequest?: { status: 'PENDING' | 'APPROVED' | 'DECLINED'; reason?: string; requestedAt?: string; decidedAt?: string; note?: string } | null;
  currentAssignment?: string | null;
  createdAt: string;
  employee: { _id: string; fullName: string; employeeId: string; email: string; phone?: string; officeLocation?: string };
  assignments: Assignment[];
  history: HistoryRow[];
  emails: EmailRow[];
  pinState: { status: string; attempts: number; maxAttempts: number; expiresAt: string; usedAt?: string } | null;
};

const OPEN = ['REQUESTED', 'PENDING_APPROVAL', 'APPROVED', 'ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'];

type ActionKey = 'approve' | 'reject' | 'cancel' | 'delay' | 'clearFlag' | 'regenPin' | 'override' | 'supportComplete' | 'noShow' | 'approveCancel' | 'declineCancel';
type ActionDef = { title: string; message: ReactNode; confirmLabel: string; tone?: 'danger' | 'primary'; reasonLabel?: string; reasonMinLength?: number; path: string; success: string; withReason: boolean; bodyKey?: string };

function Step({ label, at, tz }: { label: string; at?: string; tz?: string }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      {at ? <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden /> : <Circle className="h-4 w-4 text-slate-300" aria-hidden />}
      <span className={at ? 'text-slate-900' : 'text-slate-400'}>{label}</span>
      <span className="ml-auto text-xs text-slate-500">{at ? fmtDateTime(at, tz) : '—'}</span>
    </li>
  );
}

export default function BookingDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [action, setAction] = useState<ActionKey | null>(null);
  const [assignMode, setAssignMode] = useState<'assign' | 'reassign' | null>(null);
  const { data: b, isLoading, error, refetch } = useQuery({
    queryKey: ['ops', 'booking', id],
    queryFn: ({ signal }) => get<BookingDetailData>(`/ops/bookings/${id}`, signal),
  });

  if (isLoading) return <Spinner />;
  if (error || !b)
    return (
      <>
        <BackLink />
        <ErrorState error={error ?? new Error('Booking not found')} onRetry={refetch} />
      </>
    );

  const tz = b.timezone;
  const current = b.assignments.find((a) => a._id === b.currentAssignment) ?? null;
  const isOpen = OPEN.includes(b.status);
  const rideNotStarted = ['ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED'].includes(b.status);
  const pinNeedsRegen = !!b.pinState && ['LOCKED', 'EXPIRED'].includes(b.pinState.status) && rideNotStarted;

  const actions: Record<ActionKey, ActionDef> = {
    approve: {
      title: 'Approve request',
      message: `Approve ${b.reference}? The employee is notified and the request moves to "Needs assignment".`,
      confirmLabel: 'Approve',
      tone: 'primary',
      path: 'approve',
      success: 'Request approved',
      withReason: false,
    },
    reject: {
      title: 'Reject request',
      message: 'The employee will be emailed the reason you enter below.',
      confirmLabel: 'Reject request',
      reasonLabel: 'Reason for rejection',
      path: 'reject',
      success: 'Request rejected',
      withReason: true,
    },
    cancel:
      b.status === 'IN_PROGRESS'
        ? {
            title: 'End interrupted trip',
            message: (
              <Alert tone="error" title="This trip is in progress">
                Only use this when the ride was genuinely interrupted (breakdown, accident, emergency). The trip is closed as cancelled, the driver is released, and the transport team
                is notified. This cannot be undone.
              </Alert>
            ),
            confirmLabel: 'End interrupted trip',
            reasonLabel: 'What happened?',
            reasonMinLength: 10,
            path: 'cancel',
            success: 'Trip ended as interrupted',
            withReason: true,
          }
        : {
            title: 'Cancel booking',
            message: current
              ? `Cancel ${b.reference}? The assigned driver is released, the PIN revoked, and the employee notified.`
              : `Cancel ${b.reference}? The employee will be notified.`,
            confirmLabel: 'Cancel booking',
            reasonLabel: 'Cancellation reason',
            path: 'cancel',
            success: 'Booking cancelled',
            withReason: true,
          },
    approveCancel: {
      title: 'Approve cancellation',
      message: `Cancel ${b.reference} as the employee asked? The driver is released, the PIN revoked, and the employee notified.`,
      confirmLabel: 'Approve and cancel ride',
      path: 'cancellation-request/approve',
      success: 'Ride cancelled at the employee’s request',
      withReason: false,
    },
    declineCancel: {
      title: 'Decline cancellation request',
      message: 'The ride stays booked. Your note is shown to the employee.',
      confirmLabel: 'Decline request',
      tone: 'primary',
      reasonLabel: 'Note to the employee',
      path: 'cancellation-request/decline',
      success: 'Request declined; the employee has been notified',
      withReason: true,
    },
    delay: {
      title: 'Mark as delayed',
      message: 'The employee is notified that their cab is delayed, with the reason below.',
      confirmLabel: 'Mark delayed',
      tone: 'primary',
      reasonLabel: 'Delay reason (shared with the employee)',
      path: 'delay',
      success: 'Booking marked delayed',
      withReason: true,
    },
    clearFlag: {
      title: 'Clear review flag',
      message: b.flagReason ? `Flag reason: ${b.flagReason}` : 'Mark this booking as reviewed.',
      confirmLabel: 'Clear flag',
      tone: 'primary',
      reasonLabel: 'Review note',
      path: 'clear-flag',
      success: 'Review flag cleared',
      withReason: true,
    },
    regenPin: {
      title: 'Regenerate ride-start PIN',
      message: 'The current PIN is revoked and a new one is issued. Only the employee can see the new PIN in their booking; ask them to check it.',
      confirmLabel: 'Regenerate PIN',
      tone: 'primary',
      reasonLabel: 'Reason',
      path: 'regenerate-pin',
      success: 'New PIN issued to the employee',
      withReason: true,
    },
    override: {
      title: 'Support override: start trip',
      message: (
        <div className="space-y-2">
          <Alert tone="error" title="This bypasses PIN verification">
            Starting the trip without the employee&apos;s PIN skips the identity check that protects employees. Use it only after confirming by phone that the right employee is in the
            right vehicle. The action is audited with your name and reason.
          </Alert>
        </div>
      ),
      confirmLabel: 'Start trip without PIN',
      reasonLabel: 'Why could the PIN not be used? (min. 10 characters)',
      reasonMinLength: 10,
      path: 'override-start',
      success: 'Trip started by support override',
      withReason: true,
    },
    supportComplete: {
      title: 'Complete trip on the driver’s behalf',
      message: (
        <Alert tone="warn" title="Use only when the driver cannot complete the trip">
          For example when the driver&apos;s phone has died. Confirm with the employee or driver that the trip actually ended. The action is audited with your name and reason, and the driver is notified.
        </Alert>
      ),
      confirmLabel: 'Mark trip completed',
      reasonLabel: 'What happened? (min. 10 characters)',
      reasonMinLength: 10,
      path: 'complete',
      success: 'Trip marked completed',
      withReason: true,
    },
    noShow: {
      title: 'Record employee no-show',
      message: <p>Use this when the driver reports by phone that the employee did not come to the pickup point. The ride is closed and the ride-start PIN is revoked.</p>,
      confirmLabel: 'Record no-show',
      reasonLabel: 'Details (e.g. waited 15 minutes, no answer on phone)',
      path: 'no-show',
      success: 'No-show recorded',
      withReason: true,
    },
  };

  const run = async (key: ActionKey, reason: string) => {
    const def = actions[key];
    await post(`/ops/bookings/${b._id}/${def.path}`, def.withReason ? { reason } : {});
    toast.success(def.success);
    qc.invalidateQueries({ queryKey: ['ops'] });
  };

  const assignTarget: AssignTarget = {
    _id: b._id,
    reference: b.reference,
    status: b.status,
    travelDate: b.travelDate,
    pickupTime: b.pickupTime,
    timezone: b.timezone,
    pickupLocation: b.pickupLocation,
    dropLocation: b.dropLocation,
    passengers: b.passengers,
    employee: b.employee,
    currentDriver: current?.driver ? `${current.driver.fullName} (${current.driver.driverCode})` : undefined,
    currentVehicle: current?.vehicle?.registrationNumber,
  };

  const assignmentCols: Column<Assignment>[] = [
    { key: 'when', header: 'Assigned', render: (a) => <span className="whitespace-nowrap">{fmtDateTime(a.createdAt, tz)}</span> },
    { key: 'driver', header: 'Driver', render: (a) => (a.driver ? <Link className="text-indigo-600 hover:underline" to={`/ops/drivers/${a.driver._id}`}>{a.driver.fullName} ({a.driver.driverCode})</Link> : '—') },
    { key: 'vehicle', header: 'Vehicle', render: (a) => (a.vehicle ? <Link className="text-indigo-600 hover:underline" to={`/ops/vehicles/${a.vehicle._id}`}>{a.vehicle.registrationNumber}</Link> : '—') },
    { key: 'by', header: 'By', render: (a) => a.assignedBy?.name ?? '—' },
    { key: 'status', header: 'Status', render: (a) => <StatusBadge status={a.status} /> },
    { key: 'end', header: 'Ended / reason', render: (a) => (a.endedAt || a.declinedAt ? <span className="text-xs">{fmtDateTime(a.endedAt ?? a.declinedAt, tz)} — {a.endReason ?? a.declineReason ?? ''}</span> : '—') },
  ];
  const emailCols: Column<EmailRow>[] = [
    { key: 'when', header: 'Queued', render: (e) => <span className="whitespace-nowrap">{fmtDateTime(e.createdAt, tz)}</span> },
    { key: 'tpl', header: 'Template', render: (e) => humanize(e.template) },
    { key: 'to', header: 'To', render: (e) => <span className="whitespace-nowrap">{e.to}</span> },
    { key: 'status', header: 'Status', render: (e) => <StatusBadge status={e.status} /> },
    { key: 'att', header: 'Attempts', render: (e) => e.attempts, className: 'text-center' },
    { key: 'err', header: 'Last error', render: (e) => (e.lastError ? <span className="text-xs text-red-700">{e.lastError}</span> : '—') },
  ];

  const def = action ? actions[action] : null;

  return (
    <>
      <BackLink />
      <PageHeader
        title={`Booking ${b.reference}`}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            <StatusBadge status={b.status} />
            {b.isDelayed && <StatusBadge status="DELAYED" />}
            {b.flaggedForReview && <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-800">Needs review</span>}
            {b.cancellationRequest?.status === 'PENDING' && <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">Cancellation requested</span>}
            <span>
              {fmtTravelDate(b.travelDate)} · pickup {b.pickupTime} ({tz})
            </span>
          </span>
        }
        actions={
          <>
            {b.cancellationRequest?.status === 'PENDING' && isOpen && (
              <>
                <Button variant="danger" onClick={() => setAction('approveCancel')}>
                  Approve cancellation
                </Button>
                <Button variant="secondary" onClick={() => setAction('declineCancel')}>
                  Decline request
                </Button>
              </>
            )}
            {b.status === 'PENDING_APPROVAL' && (
              <>
                <Button variant="success" onClick={() => setAction('approve')}>
                  Approve
                </Button>
                <Button variant="danger" onClick={() => setAction('reject')}>
                  Reject
                </Button>
              </>
            )}
            {ASSIGNABLE.includes(b.status) && <Button onClick={() => setAssignMode('assign')}>Assign cab</Button>}
            {REASSIGNABLE.includes(b.status) && (
              <Button variant="secondary" onClick={() => setAssignMode('reassign')}>
                Reassign
              </Button>
            )}
            {b.status === 'ARRIVED' && (
              <>
                <Button variant="secondary" onClick={() => setAction('override')}>
                  Support override start
                </Button>
                <Button variant="secondary" onClick={() => setAction('noShow')}>
                  Record no-show
                </Button>
              </>
            )}
            {b.status === 'IN_PROGRESS' && (
              <Button variant="secondary" onClick={() => setAction('supportComplete')}>
                Complete on driver&apos;s behalf
              </Button>
            )}
            {pinNeedsRegen && (
              <Button variant="secondary" onClick={() => setAction('regenPin')}>
                Regenerate PIN
              </Button>
            )}
            {isOpen && (
              <Button variant="secondary" onClick={() => setAction('delay')}>
                Mark delayed
              </Button>
            )}
            {b.flaggedForReview && (
              <Button variant="secondary" onClick={() => setAction('clearFlag')}>
                Clear review flag
              </Button>
            )}
            {isOpen && (
              <Button variant="danger" onClick={() => setAction('cancel')}>
                {b.status === 'IN_PROGRESS' ? 'End interrupted trip' : 'Cancel'}
              </Button>
            )}
          </>
        }
      />

      <div className="space-y-4">
        {b.cancellationRequest?.status === 'PENDING' && isOpen && (
          <Alert tone="error" title="The employee has asked to cancel this ride">
            “{b.cancellationRequest.reason}”{b.cancellationRequest.requestedAt ? ` · ${fmtDateTime(b.cancellationRequest.requestedAt, tz)}` : ''}. Approve to cancel the ride and release the driver, or decline to keep it booked.
          </Alert>
        )}
        {b.flaggedForReview && (
          <Alert tone="warn" title="Flagged for review">
            {b.flagReason ?? 'This booking needs a coordinator review.'}
          </Alert>
        )}
        {b.isDelayed && (
          <Alert tone="warn" title="Marked delayed">
            {b.delayReason ?? '—'}
          </Alert>
        )}
        {b.status === 'REJECTED' && b.rejectionReason && <Alert tone="error" title="Rejected">{b.rejectionReason}</Alert>}
        {b.status === 'CANCELLED' && (
          <Alert tone="info" title={`Cancelled${b.cancelledByRole ? ` by ${humanize(b.cancelledByRole)}` : ''}${b.cancelledAt ? ` · ${fmtDateTime(b.cancelledAt, tz)}` : ''}`}>
            {b.cancellationReason ?? '—'}
          </Alert>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          <Card title="Trip" className="lg:col-span-2">
            <DescriptionList
              items={[
                ['Pickup', b.pickupLocation],
                ['Destination', b.dropLocation],
                ['Travel date', fmtTravelDate(b.travelDate)],
                ['Scheduled pickup', `${fmtDateTime(b.scheduledPickupAt, tz)} (${tz})`],
                ['Passengers', b.passengers],
                ['Trip type', `${humanize(b.tripType)}${b.tripType === 'ROUND_TRIP' && b.leg ? ` · ${humanize(b.leg)} leg` : ''}`],
                ['Shift', b.shift || '—'],
                ['Office', b.officeLocation],
                ['Approval', b.approvalRequired ? (b.approvedAt ? `Approved ${fmtDateTime(b.approvedAt, tz)}` : 'Required') : 'Not required'],
                ['Requested', fmtDateTime(b.createdAt, tz)],
                ['Notes', b.notes || '—'],
              ]}
            />
          </Card>
          <Card title="Employee">
            <DescriptionList
              columns={1}
              items={[
                ['Name', b.employee?.fullName],
                ['Employee ID', b.employee?.employeeId],
                ['Email', b.employee?.email],
                ['Phone', b.employee?.phone || '—'],
              ]}
            />
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card title="Current assignment" className="lg:col-span-2">
            {!current ? (
              <EmptyState
                title="No cab assigned"
                description={ASSIGNABLE.includes(b.status) ? 'Select an available driver and vehicle to assign this trip.' : undefined}
                action={ASSIGNABLE.includes(b.status) ? <Button onClick={() => setAssignMode('assign')}>Assign cab</Button> : undefined}
              />
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                <DescriptionList
                  columns={1}
                  items={[
                    ['Driver', current.driver ? <Link className="text-indigo-600 hover:underline" to={`/ops/drivers/${current.driver._id}`}>{current.driver.fullName} ({current.driver.driverCode})</Link> : '—'],
                    ['Driver phone', current.driver?.phone ?? '—'],
                    ['Vehicle', current.vehicle ? <Link className="text-indigo-600 hover:underline" to={`/ops/vehicles/${current.vehicle._id}`}>{current.vehicle.registrationNumber} · {current.vehicle.model} ({current.vehicle.capacity} seats)</Link> : '—'],
                    ['Assigned by', `${current.assignedBy?.name ?? '—'} · ${fmtDateTime(current.createdAt, tz)}`],
                    ['Start method', current.startMethod ? (current.startMethod === 'OVERRIDE' ? `Support override — ${current.overrideReason ?? ''}` : 'Employee PIN') : '—'],
                    ['Completed by', current.completionMethod ? (current.completionMethod === 'OVERRIDE' ? `Support override — ${current.completionOverrideReason ?? ''}` : 'Driver') : '—'],
                  ]}
                />
                <ol className="space-y-2" aria-label="Trip progress">
                  <Step label="Acknowledged by driver" at={current.acknowledgedAt} tz={tz} />
                  <Step label="En route" at={current.enRouteAt} tz={tz} />
                  <Step label="Arrived at pickup" at={current.arrivedAt} tz={tz} />
                  <Step label="Trip started" at={current.startedAt} tz={tz} />
                  <Step label="Completed" at={current.completedAt} tz={tz} />
                </ol>
              </div>
            )}
          </Card>
          <Card title="Ride-start PIN">
            {!b.pinState ? (
              <p className="text-sm text-slate-500">No PIN issued (a PIN is created when a cab is assigned).</p>
            ) : (
              <>
                <DescriptionList
                  columns={1}
                  items={[
                    ['Status', <StatusBadge key="s" status={b.pinState.status} />],
                    ['Failed attempts', `${b.pinState.attempts} / ${b.pinState.maxAttempts}`],
                    ['Expires', fmtDateTime(b.pinState.expiresAt, tz)],
                    ...(b.pinState.usedAt ? ([['Used', fmtDateTime(b.pinState.usedAt, tz)]] as Array<[string, string]>) : []),
                  ]}
                />
                <p className="mt-3 text-xs text-slate-500">Coordinators never see the PIN. Only the employee can view it in their booking.</p>
                {pinNeedsRegen && (
                  <Button className="mt-3" size="sm" variant="secondary" onClick={() => setAction('regenPin')}>
                    Regenerate PIN
                  </Button>
                )}
              </>
            )}
          </Card>
        </div>

        <Card title="Assignment history">
          <DataTable columns={assignmentCols} rows={b.assignments} rowKey={(a) => a._id} empty={<EmptyState title="No assignments yet" />} />
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Status history">
            {!b.history.length ? (
              <EmptyState title="No events yet" />
            ) : (
              <ol className="relative space-y-4 border-l border-slate-200 pl-5">
                {b.history.map((h) => (
                  <li key={h._id} className="relative">
                    <span className="absolute left-[-1.6rem] top-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-indigo-500" aria-hidden />
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium text-slate-900">{humanize(h.event)}</span>
                      {h.from && h.from !== h.to ? (
                        <span className="inline-flex items-center gap-1">
                          <StatusBadge status={h.from} /> → <StatusBadge status={h.to} />
                        </span>
                      ) : (
                        <StatusBadge status={h.to} />
                      )}
                    </div>
                    <p className="text-xs text-slate-500">
                      {fmtDateTime(h.createdAt, tz)} ({fmtRelative(h.createdAt)}) · {h.actor?.name ?? 'System'}
                      {h.actorRole ? ` (${humanize(h.actorRole)})` : ''}
                    </p>
                    {h.reason && <p className="mt-0.5 text-sm text-slate-700">“{h.reason}”</p>}
                  </li>
                ))}
              </ol>
            )}
          </Card>
          <Card title="Email notifications">
            <p className="mb-3 text-xs text-slate-500">“Sent (accepted)” means the mail provider accepted the message; it is not proof of delivery.</p>
            <DataTable columns={emailCols} rows={b.emails} rowKey={(e) => e._id} empty={<EmptyState title="No emails for this booking" />} />
          </Card>
        </div>
      </div>

      {def && (
        <ConfirmDialog
          open={!!action}
          onClose={() => setAction(null)}
          onConfirm={(reason) => run(action!, reason)}
          title={def.title}
          message={def.message}
          confirmLabel={def.confirmLabel}
          tone={def.tone ?? 'danger'}
          reasonLabel={def.reasonLabel}
          reasonMinLength={def.reasonMinLength}
        />
      )}
      <AssignModal open={!!assignMode} mode={assignMode ?? 'assign'} booking={assignTarget} onClose={() => setAssignMode(null)} />
    </>
  );
}

function BackLink() {
  return (
    <Link to="/ops/bookings" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900">
      <ArrowLeft className="h-4 w-4" /> Cab requests
    </Link>
  );
}
