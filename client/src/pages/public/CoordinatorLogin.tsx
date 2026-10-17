import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, Input } from '../../components/ui';
import { ApiError, post } from '../../lib/api';
import { homeFor, useAuth } from '../../lib/auth';
import AuthShell from './AuthShell';

/** Coordinators sign in with the email and mobile number an admin registered for them. */
export default function CoordinatorLogin() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post('/auth/coordinator-login', { email, phone });
      const me = (await refresh()) as { data?: { user: { role: Parameters<typeof homeFor>[0] } } };
      navigate(me.data ? homeFor(me.data.user.role) : '/ops', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Coordinator sign in"
      subtitle="Use the email and mobile number your administrator registered for you."
      footer={<Link to="/login" className="text-indigo-600 hover:underline">Not a coordinator? Back to sign in</Link>}
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Input label="Email" type="email" autoComplete="email" placeholder="e.g. name@gmail.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <Input label="Mobile number" type="tel" inputMode="tel" autoComplete="tel" placeholder="e.g. 98765 43210" value={phone} onChange={(e) => setPhone(e.target.value)} required />
        {error && <Alert tone="error">{error}</Alert>}
        <Button type="submit" size="lg" className="w-full" loading={busy} disabled={!email.includes('@') || phone.replace(/\D/g, '').length < 10}>
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}
