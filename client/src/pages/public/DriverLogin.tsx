import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, Input } from '../../components/ui';
import { ApiError, post } from '../../lib/api';
import { homeFor, useAuth } from '../../lib/auth';
import AuthShell from './AuthShell';

/** Drivers sign in with the mobile number the coordinator registered and their vehicle number. */
export default function DriverLogin() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [phone, setPhone] = useState('');
  const [last4, setLast4] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post('/auth/driver-login', { phone, vehicleLast4: last4 });
      const me = (await refresh()) as { data?: { user: { role: Parameters<typeof homeFor>[0] } } };
      navigate(me.data ? homeFor(me.data.user.role) : '/driver', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Driver sign in"
      subtitle="Use the mobile number registered with your transport coordinator."
      footer={<Link to="/login" className="text-indigo-600 hover:underline">Not a driver? Back to sign in</Link>}
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Input label="Mobile number" type="tel" inputMode="tel" autoComplete="tel" placeholder="e.g. 98765 43210" value={phone} onChange={(e) => setPhone(e.target.value)} required />
        <Input
          label="Last 4 characters of your vehicle number"
          inputMode="text"
          autoComplete="off"
          placeholder="e.g. 1234"
          maxLength={4}
          value={last4}
          onChange={(e) => setLast4(e.target.value.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 4))}
          hint="For TS09AB1234, enter 1234"
          required
        />
        {error && <Alert tone="error">{error}</Alert>}
        <Button type="submit" size="lg" className="w-full" loading={busy} disabled={phone.replace(/\D/g, '').length < 10 || last4.length !== 4}>
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}
