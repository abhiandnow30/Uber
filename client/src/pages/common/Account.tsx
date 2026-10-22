import { useEffect, useState, type FormEvent } from 'react';
import { Clock, Home } from 'lucide-react';
import { Alert, Button, Card, DescriptionList, Input, PageHeader, Select, StatusBadge, Textarea, useToast } from '../../components/ui';
import { errorMessage, patch, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fieldErrors } from '../../lib/hooks';
import { fmtDateTime, humanize } from '../../lib/format';
import { fmt12h, usePolicy } from '../../lib/policy';
import { useSsoConfig } from '../../lib/sso';
import { PasswordFields, passwordOk } from '../public/Activate';

export default function Account() {
  const { me } = useAuth();
  const { data: sso } = useSsoConfig();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!me) return null;
  const profile = (me.profile ?? {}) as Record<string, string>;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await post('/auth/password/change', { currentPassword: current, newPassword: password });
      setMsg({ tone: 'success', text: 'Password changed.' });
      setCurrent('');
      setPassword('');
      setConfirm('');
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Account" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Profile">
          <DescriptionList
            items={[
              ['Name', me.user.name],
              ...(me.user.email && !me.user.email.endsWith('@phone-login.invalid') ? ([['Email', me.user.email]] as Array<[string, string]>) : []),
              ['Role', humanize(me.user.role)],
              ['Status', <StatusBadge key="s" status={me.user.status} />],
              ...(profile.employeeId ? ([['Employee ID', profile.employeeId], ['Office', profile.officeLocation]] as Array<[string, string]>) : []),
              ...(profile.driverCode ? ([['Driver ID', profile.driverCode], ['Office', profile.officeLocation]] as Array<[string, string]>) : []),
              ['Last sign-in', fmtDateTime(me.user.lastLoginAt)],
            ]}
          />
        </Card>
        {me.user.role === 'EMPLOYEE' && <ShiftCard />}
        {me.user.role === 'EMPLOYEE' && <HomeAddressCard />}
        {me.user.role !== 'DRIVER' && me.user.role !== 'COORDINATOR' && !(me.user.role === 'EMPLOYEE' && sso?.employeesMicrosoftOnly) && (
          <Card title="Change password">
            <form onSubmit={submit} className="space-y-4">
              <Input label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
              <PasswordFields password={password} confirm={confirm} setPassword={setPassword} setConfirm={setConfirm} />
              {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
              <Button type="submit" loading={busy} disabled={!current || !passwordOk(password, confirm)}>
                Update password
              </Button>
            </form>
          </Card>
        )}
      </div>
    </>
  );
}

/** Employees save the shift they usually work; it is pre-selected on the cab request form. */
function ShiftCard() {
  const { me, refresh } = useAuth();
  const toast = useToast();
  const { data: policy } = usePolicy();
  const saved = ((me?.profile ?? {}) as { defaultShift?: string }).defaultShift ?? '';
  const [shift, setShift] = useState(saved);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setShift(saved);
  }, [saved]);
  const shifts = policy?.shifts.filter((s) => s.active) ?? [];

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await patch('/me/profile', { defaultShift: shift });
      await refresh();
      toast.success('Shift saved', 'It will be selected automatically when you request a cab.');
    } catch (err) {
      setError(fieldErrors(err).defaultShift ?? errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Clock className="h-4 w-4" aria-hidden /> My shift
        </span>
      }
    >
      <form onSubmit={save} className="space-y-4">
        {!saved && <Alert tone="info">Save your shift so it is selected for you when you request a cab.</Alert>}
        <Select label="Shift" value={shift} onChange={(e) => setShift(e.target.value)} error={error}>
          <option value="">No default shift</option>
          {shifts.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
              {s.defaultPickupTime ? ` · cab ${fmt12h(s.defaultPickupTime)}` : ''}
            </option>
          ))}
        </Select>
        <p className="text-xs text-slate-500">You can still pick a different shift or cab time for a single ride on the request form.</p>
        <Button type="submit" loading={busy} disabled={shift === saved}>
          Save shift
        </Button>
      </form>
    </Card>
  );
}

/** Employees maintain their own home address; it pre-fills the cab request form. */
function HomeAddressCard() {
  const { me, refresh } = useAuth();
  const toast = useToast();
  const profile = (me?.profile ?? {}) as { homeAddress?: string };
  const [address, setAddress] = useState(profile.homeAddress ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setAddress(profile.homeAddress ?? '');
  }, [profile.homeAddress]);
  const dirty = address.trim() !== (profile.homeAddress ?? '');

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      await patch('/me/profile', { homeAddress: address.trim() });
      await refresh();
      toast.success('Present address saved', 'It will be filled in automatically when you request a cab.');
    } catch (err) {
      const f = fieldErrors(err);
      setErrors(Object.keys(f).length ? f : { homeAddress: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Home className="h-4 w-4" aria-hidden /> Present address
        </span>
      }
    >
      <form onSubmit={save} className="space-y-4">
        {!profile.homeAddress && <Alert tone="info">Add your present address so your cab requests are filled in for you.</Alert>}
        <Textarea
          label="Address"
          required
          maxLength={300}
          autoComplete="street-address"
          placeholder="Flat / house no., building, street, area, city, PIN code"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          error={errors.homeAddress}
        />
        <p className="text-xs text-slate-500">Only you and administrators can see your saved address. The transport team and your driver see only the pickup and drop-off points of your rides.</p>
        <Button type="submit" loading={busy} disabled={!dirty || address.trim().length < 5}>
          Save address
        </Button>
      </form>
    </Card>
  );
}
