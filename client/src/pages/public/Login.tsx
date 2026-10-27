import { useState, type FormEvent } from 'react';
import { Car, UserCog } from 'lucide-react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Input } from '../../components/ui';
import { ApiError } from '../../lib/api';
import { homeFor, useAuth } from '../../lib/auth';
import { useSsoConfig } from '../../lib/sso';
import AuthShell from './AuthShell';

const SSO_ERRORS: Record<string, string> = {
  inactive: 'Your account is not active. Please contact your administrator.',
  invalid: 'Microsoft sign-in could not be verified. Please try again.',
  sso_failed: 'Microsoft sign-in failed. Please try again.',
  sso_disabled: 'Microsoft sign-in is not configured for this portal.',
  driver_mobile_only: 'Drivers sign in with their mobile number. Use the "Driver" button below.',
  coordinator_own_sign_in: 'Coordinators sign in with their email and mobile number. Use the "Coordinator" button below.',
};

export default function Login() {
  const { login, refresh } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<{
    message: string;
    notRegistered?: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: sso } = useSsoConfig();

  const ssoError = params.get('error');
  const ssoMessage = ssoError === 'not_registered' ? sso?.notRegisteredMessage : ssoError ? SSO_ERRORS[ssoError] : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      const me = (await refresh()) as {
        data?: { user: { role: Parameters<typeof homeFor>[0] } };
      };
      const from = (location.state as { from?: string } | null)?.from;
      // Only same-app paths: reject protocol-relative ("//", "/\") and absolute targets (open-redirect hardening).
      const safeFrom = from && /^\/(?![/\\])[\w\-/]*$/.test(from) && from !== '/login' ? from : null;
      navigate(safeFrom ?? (me.data ? homeFor(me.data.user.role) : '/'), {
        replace: true,
      });
    } catch (err) {
      if (err instanceof ApiError)
        setError({
          message: err.message,
          notRegistered: err.code === 'INVALID_CREDENTIALS',
        });
      else
        setError({
          message: 'Unable to sign in. Check your connection and try again.',
        });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Sign in" subtitle="Use your official work account.">
      {ssoMessage && (
        <div className="mb-4">
          <Alert tone={ssoError === 'not_registered' ? 'warn' : 'error'}>{ssoMessage}</Alert>
        </div>
      )}
      {sso?.enabled && (
        <>
          <a
            href="/api/auth/sso/login"
            className="flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white text-sm font-medium hover:bg-slate-50"
          >
            <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden>
              <rect x="1" y="1" width="9" height="9" fill="#f25022" />
              <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
              <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
              <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
            </svg>
            Sign in with Microsoft
          </a>
          <p className="mt-2 text-center text-xs text-slate-500">Employees and admins sign in with Microsoft.</p>
          <div className="my-5 flex items-center gap-3 text-xs uppercase text-slate-400">
            <span className="h-px flex-1 bg-slate-200" />
            or
            <span className="h-px flex-1 bg-slate-200" />
          </div>
        </>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Link
          to="/coordinator-login"
          className="flex flex-col items-center gap-1 rounded-xl border border-slate-300 bg-white px-3 py-4 text-center hover:border-indigo-400 hover:bg-indigo-50"
        >
          <UserCog className="h-6 w-6 text-indigo-600" aria-hidden />
          <span className="text-sm font-semibold text-slate-900">Coordinator</span>
          <span className="text-xs text-slate-500">Email &amp; mobile number</span>
        </Link>
        <Link
          to="/driver-login"
          className="flex flex-col items-center gap-1 rounded-xl border border-slate-300 bg-white px-3 py-4 text-center hover:border-indigo-400 hover:bg-indigo-50"
        >
          <Car className="h-6 w-6 text-indigo-600" aria-hidden />
          <span className="text-sm font-semibold text-slate-900">Driver</span>
          <span className="text-xs text-slate-500">Mobile number</span>
        </Link>
      </div>
      {/* Email + password is only the fallback for when Microsoft sign-in isn't configured. */}
      {!sso?.enabled && (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Input label="Work email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <Input label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          {error && <Alert tone="error">{error.message}</Alert>}
          <Button type="submit" className="w-full" size="lg" loading={busy} disabled={!email || !password}>
            Sign in
          </Button>
          <div className="text-center">
            <Link to="/forgot-password" className="text-sm text-slate-600 hover:underline">
              Forgot password?
            </Link>
          </div>
        </form>
      )}
    </AuthShell>
  );
}
