import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, Input, Select, Spinner, Textarea } from '../../components/ui';
import { errorMessage, get, post } from '../../lib/api';
import { homeFor, useAuth } from '../../lib/auth';
import { fieldErrors } from '../../lib/hooks';
import AuthShell from './AuthShell';

type Context = { email: string; fullName: string; offices: Array<{ code: string; name: string }> };

/** First Microsoft sign-in for someone not yet in the system: they complete their own profile. */
export default function Register() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const ctx = useQuery({ queryKey: ['sso-registration'], queryFn: () => get<Context>('/auth/sso/registration'), retry: false });
  // Only the address is asked for the cab; an admin assigns the employee's route (cab) afterwards.
  const [form, setForm] = useState({ employeeId: '', fullName: '', phone: '', officeLocation: '', homeAddress: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    if (!ctx.data) return;
    setForm((f) => ({ ...f, fullName: f.fullName || ctx.data.fullName, officeLocation: f.officeLocation || ctx.data.offices[0]?.code || '' }));
  }, [ctx.data]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setErrors({});
    try {
      await post('/auth/sso/register', form);
      const me = (await refresh()) as { data?: { user: { role: Parameters<typeof homeFor>[0] } } };
      navigate(me.data ? homeFor(me.data.user.role) : '/', { replace: true });
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const complete = Object.values(form).every((v) => v.trim());

  return (
    <AuthShell
      title="Complete your registration"
      subtitle="You're signed in with Microsoft but not yet registered for cab booking. Fill in your details to get started."
      footer={<Link to="/login" className="text-indigo-600 hover:underline">Back to sign in</Link>}
    >
      {ctx.isLoading ? (
        <Spinner />
      ) : ctx.error || !ctx.data ? (
        <Alert tone="error" title="Registration unavailable">
          {errorMessage(ctx.error)}{' '}
          <a href="/api/auth/sso/login" className="font-medium underline">
            Sign in with Microsoft again
          </a>
        </Alert>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Input label="Official work email" value={ctx.data.email} readOnly disabled hint="From your Microsoft account" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Employee ID" value={form.employeeId} onChange={set('employeeId')} error={errors.employeeId} required />
            <Input label="Full name" value={form.fullName} onChange={set('fullName')} error={errors.fullName} required />
            <Input label="Phone" type="tel" value={form.phone} onChange={set('phone')} error={errors.phone} required />
            <Select label="Office location" value={form.officeLocation} onChange={set('officeLocation')} error={errors.officeLocation} required>
              <option value="">Select an office…</option>
              {ctx.data.offices.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.name} ({o.code})
                </option>
              ))}
            </Select>
          </div>
          <Textarea
            label="Present address"
            autoComplete="street-address"
            placeholder="Flat / house no., building, street, area, city, PIN code"
            value={form.homeAddress}
            onChange={set('homeAddress')}
            error={errors.homeAddress}
            maxLength={300}
            required
            hint="The transport team assigns your cab route from this address."
          />
          {error && !Object.keys(errors).length && <Alert tone="error">{error}</Alert>}
          <Button type="submit" size="lg" className="w-full" loading={busy} disabled={!complete}>
            Register and continue
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
