import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, Button, Spinner } from '../../components/ui';
import { errorMessage, get, post } from '../../lib/api';
import { PasswordFields, passwordOk } from './Activate';
import AuthShell from './AuthShell';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['reset', token],
    queryFn: () => get<{ valid: boolean }>(`/auth/password/reset/inspect?token=${encodeURIComponent(token)}`),
    enabled: !!token,
    retry: false,
  });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post('/auth/password/reset', { token, password });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  if (token && isLoading) return <Spinner />;
  if (done)
    return (
      <AuthShell title="Password updated">
        <Alert tone="success">Your password has been changed and all other sessions were signed out.</Alert>
        <Link to="/login" className="mt-4 block"><Button className="w-full" size="lg">Sign in</Button></Link>
      </AuthShell>
    );
  if (!token || !data?.valid)
    return (
      <AuthShell title="Link not valid">
        <Alert tone="error">This reset link is invalid, has expired or has already been used.</Alert>
        <Link to="/forgot-password" className="mt-4 block text-center text-sm text-indigo-600 hover:underline">Request a new link</Link>
      </AuthShell>
    );
  return (
    <AuthShell title="Choose a new password">
      <form onSubmit={submit} className="space-y-4">
        <PasswordFields password={password} confirm={confirm} setPassword={setPassword} setConfirm={setConfirm} />
        {error && <Alert tone="error">{error}</Alert>}
        <Button type="submit" size="lg" className="w-full" loading={busy} disabled={!passwordOk(password, confirm)}>
          Update password
        </Button>
      </form>
    </AuthShell>
  );
}
