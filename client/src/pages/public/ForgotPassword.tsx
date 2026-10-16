import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Input } from '../../components/ui';
import { errorMessage, post } from '../../lib/api';
import AuthShell from './AuthShell';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await post<{ message: string }>('/auth/password/forgot', { email });
      setMessage(r.message);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell title="Reset your password" subtitle="We will email a single-use reset link to your work address." footer={<Link to="/login" className="text-indigo-600 hover:underline">Back to sign in</Link>}>
      {message ? (
        <Alert tone="success">{message}</Alert>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Input label="Work email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
          {error && <Alert tone="error">{error}</Alert>}
          <Button type="submit" size="lg" className="w-full" loading={busy} disabled={!email}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
