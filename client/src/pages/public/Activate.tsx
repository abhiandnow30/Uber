import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, Button, Input, Spinner } from '../../components/ui';
import { errorMessage, get, post } from '../../lib/api';
import AuthShell from './AuthShell';

export function PasswordFields({ password, confirm, setPassword, setConfirm }: { password: string; confirm: string; setPassword: (v: string) => void; setConfirm: (v: string) => void }) {
  const weak = password.length > 0 && (password.length < 10 || !/[A-Za-z]/.test(password) || !/\d/.test(password));
  return (
    <>
      <Input
        label="New password"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        hint="At least 10 characters, with letters and numbers."
        error={weak ? 'At least 10 characters, with letters and numbers.' : undefined}
        required
      />
      <Input label="Confirm password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={confirm && confirm !== password ? 'Passwords do not match' : undefined} required />
    </>
  );
}

export const passwordOk = (p: string, c: string) => p.length >= 10 && /[A-Za-z]/.test(p) && /\d/.test(p) && p === c;

export default function Activate() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['activation', token],
    queryFn: () => get<{ valid: boolean; name?: string; email?: string }>(`/auth/activation/inspect?token=${encodeURIComponent(token)}`),
    enabled: !!token,
    retry: false,
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post('/auth/activate', { token, password });
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
      <AuthShell title="Account activated">
        <Alert tone="success">Your account is active. You can now sign in.</Alert>
        <Link to="/login" className="mt-4 block">
          <Button className="w-full" size="lg">Go to sign in</Button>
        </Link>
      </AuthShell>
    );
  if (!token || !data?.valid)
    return (
      <AuthShell title="Link not valid">
        <Alert tone="error">This activation link is invalid, has expired or has already been used. Ask your administrator to send a new invitation.</Alert>
        <Link to="/login" className="mt-4 block text-center text-sm text-indigo-600 hover:underline">Back to sign in</Link>
      </AuthShell>
    );
  return (
    <AuthShell title={`Welcome, ${data.name}`} subtitle={<>Set a password for <strong>{data.email}</strong> to activate your account.</>}>
      <form onSubmit={submit} className="space-y-4">
        <PasswordFields password={password} confirm={confirm} setPassword={setPassword} setConfirm={setConfirm} />
        {error && <Alert tone="error">{error}</Alert>}
        <Button type="submit" size="lg" className="w-full" loading={busy} disabled={!passwordOk(password, confirm)}>
          Activate account
        </Button>
      </form>
    </AuthShell>
  );
}
