import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Button, Modal, Select, Textarea } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { useUnsavedChanges } from '../../lib/unsaved';

/** Minutes past the pickup time after which an assigned cab that hasn't arrived counts as late (as on the server). */
export const CAB_LATE_MINUTES = 15;

/** The cab is assigned but late: the employee may cancel it themselves. */
export const cabIsLate = (b: { status: string; isDelayed?: boolean; scheduledPickupAt?: string }) =>
  ['ASSIGNED', 'DRIVER_EN_ROUTE'].includes(b.status) && (!!b.isDelayed || (!!b.scheduledPickupAt && +new Date(b.scheduledPickupAt) < Date.now() - CAB_LATE_MINUTES * 60_000));

const LATE_REASONS = ['Cab is late', "I've arranged other transport", 'Other'] as const;

/**
 * Employee cancels a ride. Before a cab is assigned any reason will do; once the cab is late the
 * reason is picked from a list (with details for "Other"). The transport team is informed.
 */
export function CancelRideDialog({ open, late, summary, onClose, onConfirm }: { open: boolean; late: boolean; summary: ReactNode; onClose: () => void; onConfirm: (reason: string) => Promise<unknown> }) {
  const [choice, setChoice] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setChoice(late ? 'Cab is late' : '');
      setNote('');
      setError('');
    }
  }, [open, late]);

  // Saving here would mean cancelling the ride, so a typed reason can only be kept or discarded.
  const guard = useUnsavedChanges(open && !!note.trim());
  const close = () => guard(onClose);

  const submit = async () => {
    const reason = late ? (choice === 'Other' ? note.trim() : `${choice}${note.trim() ? ` — ${note.trim()}` : ''}`) : note.trim();
    if (reason.length < 3) return setError(late && choice === 'Other' ? 'Say why you are cancelling' : 'Please give a reason (at least 3 characters)');
    setBusy(true);
    setError('');
    try {
      await onConfirm(reason);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : close}
      title={late ? 'Your cab is late — cancel it?' : 'Cancel this ride?'}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            Keep ride
          </Button>
          <Button variant="danger" onClick={submit} loading={busy}>
            Cancel ride
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-slate-700">
        <div>{summary}</div>
        {late && (
          <Select label="Reason" required value={choice} onChange={(e) => setChoice(e.target.value)}>
            {LATE_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        )}
        <Textarea
          label={!late ? 'Reason for cancelling' : choice === 'Other' ? 'What happened?' : 'Details (optional)'}
          required={!late || choice === 'Other'}
          maxLength={300}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <p className="text-xs text-slate-500">This can&apos;t be undone. The transport team is informed, and you can request another cab for that day.</p>
        {error && <Alert tone="error">{error}</Alert>}
      </div>
    </Modal>
  );
}
