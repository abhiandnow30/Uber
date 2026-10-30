import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, Input } from '../../components/ui';
import { ApiError, post } from '../../lib/api';
import { homeFor, useAuth } from '../../lib/auth';
import AuthShell from './AuthShell';

/** Drivers sign in with the mobile number the coordinator registered; the password is its first 4 digits. */
export default function DriverLogin() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post('/auth/driver-login', { phone, password });
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
        <Input label="Mobile number" type="tel" inputMode="tel" autoComplete="username" placeholder="e.g. 98765 43210" value={phone} onChange={(e) => setPhone(e.target.value)} required />
        <Input
          label="Password"
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          maxLength={4}
          value={password}
          onChange={(e) => setPassword(e.target.value.replace(/\D/g, '').slice(0, 4))}
          required
        />
        {error && <Alert tone="error">{error}</Alert>}
        <Button type="submit" size="lg" className="w-full" loading={busy} disabled={phone.replace(/\D/g, '').length < 10 || password.length !== 4}>
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}
