import { AlertTriangle, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Info, Inbox, Loader2, Search, X, XCircle } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { useUnsavedChanges } from '../lib/unsaved';
import { humanize } from '../lib/format';

export const cn = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  loading?: boolean;
  icon?: ReactNode;
};

export function Button({ variant = 'primary', size = 'md', loading, icon, className, children, disabled, ...rest }: ButtonProps) {
  const variants = {
    primary: 'bg-slate-900 text-white hover:bg-slate-800 disabled:bg-slate-400',
    secondary: 'bg-white text-slate-800 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400',
    danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300',
    success: 'bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-300',
    ghost: 'text-slate-700 hover:bg-slate-100 disabled:text-slate-400',
  };
  const sizes = { sm: 'h-8 px-3 text-sm pointer-coarse:h-10', md: 'h-10 px-4 text-sm', lg: 'h-12 px-5 text-base', xl: 'h-16 px-6 text-lg w-full' };
  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed',
        variants[variant],
        sizes[size],
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Form fields (labels + errors wired for accessibility)
// ---------------------------------------------------------------------------
type FieldProps = { label?: string; error?: string; hint?: string; required?: boolean; className?: string };

function FieldWrap({ id, label, error, hint, required, className, children }: FieldProps & { id: string; children: ReactNode }) {
  return (
    <div className={cn('space-y-1', className)}>
      {label && (
        <label htmlFor={id} className="block text-sm font-medium text-slate-700">
          {label}
          {required && (
            <span className="ml-0.5 text-red-600" aria-hidden>
              *
            </span>
          )}
        </label>
      )}
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

const inputBase = 'block w-full rounded-lg border bg-white px-3 text-sm shadow-xs placeholder:text-slate-400 disabled:bg-slate-100';
const inputState = (error?: string) => (error ? 'border-red-400 focus:border-red-500' : 'border-slate-300 focus:border-indigo-500');

export function Input({ label, error, hint, required, className, ...rest }: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <FieldWrap id={id} label={label} error={error} hint={hint} required={required} className={className}>
      <input
        id={id}
        className={cn(inputBase, 'h-10', inputState(error))}
        aria-invalid={!!error || undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        required={required}
        {...rest}
      />
    </FieldWrap>
  );
}

export function Select({ label, error, hint, required, className, children, ...rest }: FieldProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <FieldWrap id={id} label={label} error={error} hint={hint} required={required} className={className}>
      <select id={id} className={cn(inputBase, 'h-10 pr-8', inputState(error))} aria-invalid={!!error || undefined} required={required} {...rest}>
        {children}
      </select>
    </FieldWrap>
  );
}

export function Textarea({ label, error, hint, required, className, ...rest }: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <FieldWrap id={id} label={label} error={error} hint={hint} required={required} className={className}>
      <textarea id={id} rows={3} className={cn(inputBase, 'py-2', inputState(error))} aria-invalid={!!error || undefined} required={required} {...rest} />
    </FieldWrap>
  );
}

export function Checkbox({ label, className, ...rest }: { label: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className={cn('flex items-start gap-2', className)}>
      <input id={id} type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 rounded-sm border-slate-300 lg:h-4 lg:w-4" {...rest} />
      <label htmlFor={id} className="py-0.5 text-sm text-slate-700">
        {label}
      </label>
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search…', className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  useEffect(() => {
    const t = setTimeout(() => local !== value && onChange(local), 300);
    return () => clearTimeout(t);
  }, [local, value, onChange]);
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
      <input
        type="search"
        aria-label={placeholder}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        placeholder={placeholder}
        className={cn(inputBase, 'h-10 border-slate-300 pl-9')}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------
export function Card({ className, children, title, actions }: { className?: string; children: ReactNode; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={cn('rounded-xl border border-slate-200 bg-white shadow-xs', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          {title && <h2 className="text-sm font-semibold text-slate-800">{title}</h2>}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = 'default',
  icon,
  onClick,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'warn' | 'danger' | 'good';
  icon?: ReactNode;
  onClick?: () => void;
}) {
  const tones = { default: 'text-slate-900', warn: 'text-amber-600', danger: 'text-red-600', good: 'text-emerald-600' };
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag onClick={onClick} className={cn('rounded-xl border border-slate-200 bg-white p-4 text-left shadow-xs', onClick && 'hover:border-slate-300 hover:shadow-sm')}>
      <div className="flex items-center justify-between text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
        {icon}
      </div>
      <div className={cn('mt-2 text-2xl font-semibold', tones[tone])}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </Tag>
  );
}

/** Label/value pairs. Rows with no value are left out, so a page only shows what it knows. */
export function DescriptionList({ items, columns = 2 }: { items: Array<[string, ReactNode]>; columns?: 1 | 2 | 3 }) {
  const cols = { 1: 'sm:grid-cols-1', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3' };
  return (
    <dl className={cn('grid grid-cols-1 gap-x-6 gap-y-3', cols[columns])}>
      {items
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{k}</dt>
            <dd className="mt-0.5 wrap-break-word text-sm text-slate-900">{v}</dd>
          </div>
        ))}
    </dl>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ value: T; label: ReactNode }>; value: T; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="mb-4 flex flex-wrap gap-x-1 border-b border-slate-200">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={cn(
            'whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
            value === t.value ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-700',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status badges
// ---------------------------------------------------------------------------
const STATUS_TONES: Record<string, string> = {
  // accounts
  ACTIVE: 'bg-emerald-100 text-emerald-800',
  INVITED: 'bg-sky-100 text-sky-800',
  PENDING_ADMIN_REVIEW: 'bg-amber-100 text-amber-800',
  INFO_REQUESTED: 'bg-amber-100 text-amber-800',
  INACTIVE: 'bg-slate-200 text-slate-700',
  SUSPENDED: 'bg-red-100 text-red-800',
  REJECTED: 'bg-red-100 text-red-800',
  APPROVED: 'bg-teal-100 text-teal-800',
  // bookings
  REQUESTED: 'bg-amber-100 text-amber-800',
  PENDING_APPROVAL: 'bg-amber-100 text-amber-800',
  ASSIGNED: 'bg-indigo-100 text-indigo-800',
  DRIVER_EN_ROUTE: 'bg-blue-100 text-blue-800',
  ARRIVED: 'bg-violet-100 text-violet-800',
  IN_PROGRESS: 'bg-cyan-100 text-cyan-800',
  COMPLETED: 'bg-emerald-100 text-emerald-800',
  CANCELLED: 'bg-slate-200 text-slate-700',
  NO_SHOW: 'bg-orange-100 text-orange-800',
  DELAYED: 'bg-red-100 text-red-800',
  // fleet
  AVAILABLE: 'bg-emerald-100 text-emerald-800',
  ON_TRIP: 'bg-cyan-100 text-cyan-800',
  OFFLINE: 'bg-slate-200 text-slate-700',
  VERIFIED: 'bg-emerald-100 text-emerald-800',
  PENDING: 'bg-amber-100 text-amber-800',
  EXPIRED: 'bg-red-100 text-red-800',
  MAINTENANCE: 'bg-orange-100 text-orange-800',
  // email / exceptions / misc
  ACCEPTED: 'bg-emerald-100 text-emerald-800',
  DELIVERED: 'bg-emerald-200 text-emerald-900',
  SENDING: 'bg-sky-100 text-sky-800',
  RETRYING: 'bg-amber-100 text-amber-800',
  FAILED: 'bg-red-100 text-red-800',
  SKIPPED: 'bg-slate-200 text-slate-700',
  OPEN: 'bg-red-100 text-red-800',
  ACKNOWLEDGED: 'bg-amber-100 text-amber-800',
  RESOLVED: 'bg-emerald-100 text-emerald-800',
  CRITICAL: 'bg-red-600 text-white',
  WARNING: 'bg-amber-100 text-amber-800',
  INFO: 'bg-sky-100 text-sky-800',
  NEW: 'bg-emerald-100 text-emerald-800',
  UPDATE: 'bg-indigo-100 text-indigo-800',
  UNCHANGED: 'bg-slate-100 text-slate-600',
  DUPLICATE: 'bg-orange-100 text-orange-800',
  CONFLICT: 'bg-red-100 text-red-800',
  INVALID: 'bg-red-100 text-red-800',
  APPLIED: 'bg-emerald-100 text-emerald-800',
  PREVIEW: 'bg-sky-100 text-sky-800',
  COMMITTING: 'bg-amber-100 text-amber-800',
  COMPLETED_WITH_ERRORS: 'bg-orange-100 text-orange-800',
  LOCKED: 'bg-red-100 text-red-800',
  USED: 'bg-slate-200 text-slate-700',
  REVOKED: 'bg-slate-200 text-slate-700',
  REASSIGNED: 'bg-slate-200 text-slate-700',
  DECLINED: 'bg-red-100 text-red-800',
};

const STATUS_LABELS: Record<string, string> = {
  DRIVER_EN_ROUTE: 'Driver en route',
  IN_PROGRESS: 'In progress',
  NO_SHOW: 'No-show',
  PENDING_ADMIN_REVIEW: 'Pending review',
  ACCEPTED: 'Sent (accepted)',
};

export function StatusBadge({ status, className }: { status?: string | null; className?: string }) {
  if (!status) return <span className="text-slate-400">—</span>;
  return (
    <span
      className={cn('inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium', STATUS_TONES[status] ?? 'bg-slate-100 text-slate-700', className)}
    >
      {STATUS_LABELS[status] ?? humanize(status)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Feedback states
// ---------------------------------------------------------------------------
export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500" role="status">
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> {label}
    </div>
  );
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      <div className="text-slate-300">{icon ?? <Inbox className="h-10 w-10" aria-hidden />}</div>
      <p className="font-medium text-slate-700">{title}</p>
      {description && <p className="max-w-sm text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-6 text-center" role="alert">
      <XCircle className="h-6 w-6 text-red-500" aria-hidden />
      <p className="text-sm text-red-700">{message}</p>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Alert({ tone = 'info', title, children }: { tone?: 'info' | 'warn' | 'error' | 'success'; title?: string; children?: ReactNode }) {
  const tones = {
    info: ['border-sky-200 bg-sky-50 text-sky-900', <Info key="i" className="h-5 w-5 shrink-0 text-sky-600" aria-hidden />],
    warn: ['border-amber-200 bg-amber-50 text-amber-900', <AlertTriangle key="w" className="h-5 w-5 shrink-0 text-amber-600" aria-hidden />],
    error: ['border-red-200 bg-red-50 text-red-900', <XCircle key="e" className="h-5 w-5 shrink-0 text-red-600" aria-hidden />],
    success: ['border-emerald-200 bg-emerald-50 text-emerald-900', <CheckCircle2 key="s" className="h-5 w-5 shrink-0 text-emerald-600" aria-hidden />],
  } as const;
  const [cls, icon] = tones[tone];
  return (
    <div className={cn('flex gap-3 rounded-lg border p-3 text-sm', cls)} role={tone === 'error' ? 'alert' : 'status'}>
      {icon}
      <div>
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={title ? 'mt-0.5' : ''}>{children}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal + confirm dialog
// ---------------------------------------------------------------------------
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // The latest onClose, so the effect below runs only when the popup opens or closes (it moves focus
  // to the first field; re-running it on every render would steal focus while typing).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCloseRef.current();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    setTimeout(() => ref.current?.querySelector<HTMLElement>('input,select,textarea,button:not([data-close])')?.focus(), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      prev?.focus();
    };
  }, [open]);
  if (!open) return null;
  const sizes = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn('flex max-h-[92vh] w-full min-w-0 max-w-full flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-2xl', sizes[size])}
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <h2 id={titleId} className="min-w-0 break-words text-lg font-semibold">
            {title}
          </h2>
          <button data-close onClick={onClose} className="shrink-0 rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-w-0 overflow-y-auto overflow-x-hidden px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Confirmation for destructive / important actions. With `reasonLabel`, a
 * reason is required and passed to onConfirm.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirm',
  tone = 'danger',
  reasonLabel,
  reasonMinLength = 3,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<unknown> | void;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  tone?: 'danger' | 'primary';
  reasonLabel?: string;
  reasonMinLength?: number;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      setReason('');
      setError('');
    }
  }, [open]);
  const submit = async () => {
    if (reasonLabel && reason.trim().length < reasonMinLength) {
      setError(`Please enter at least ${reasonMinLength} characters`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };
  // A typed reason isn't thrown away without asking.
  const guard = useUnsavedChanges(open && reason.trim().length > 0);
  const close = () => guard(onClose);
  return (
    <Modal
      open={open}
      onClose={close}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant={tone} onClick={submit} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-slate-700">
        <div>{message}</div>
        {reasonLabel && <Textarea label={reasonLabel} value={reason} onChange={(e) => setReason(e.target.value)} required />}
        {error && <Alert tone="error">{error}</Alert>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Data table + pagination
// ---------------------------------------------------------------------------
export type Column<T> = {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  sortKey?: string;
  className?: string;
  /** Label in the phone/tablet card layout; defaults to the header when it is plain text. */
  cardLabel?: string;
  /** Leave this column out of the phone/tablet card layout. */
  hideInCard?: boolean;
  /** Give this column a full row in the card layout (long text such as addresses). */
  cardWide?: boolean;
};

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  error,
  onRetry,
  empty,
  sort,
  onSort,
  onRowClick,
  hideHeader,
}: {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty?: ReactNode;
  sort?: string;
  onSort?: (sort: string) => void;
  onRowClick?: (row: T) => void;
  /** Leave out the column header row (e.g. small grouped tables whose rows speak for themselves). */
  hideHeader?: boolean;
}) {
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  const sortField = sort?.replace(/^-/, '');
  const desc = sort?.startsWith('-');
  return (
    <>
      <CardList columns={columns} rows={rows} rowKey={rowKey} loading={loading} empty={empty} sort={sort} onSort={onSort} onRowClick={onRowClick} />
      <div className="hidden overflow-x-auto rounded-xl border border-slate-200 bg-white lg:block">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className={hideHeader ? 'sr-only' : 'bg-slate-50'}>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={cn('whitespace-nowrap px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500', c.className)}
                  aria-sort={c.sortKey && sortField === c.sortKey ? (desc ? 'descending' : 'ascending') : undefined}
                >
                  {c.sortKey && onSort ? (
                    <button
                      className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-slate-800"
                      onClick={() => onSort(sortField === c.sortKey && !desc ? `-${c.sortKey}` : c.sortKey!)}
                    >
                      {c.header}
                      {sortField === c.sortKey ? desc ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" /> : null}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr>
                <td colSpan={columns.length}>
                  <Spinner />
                </td>
              </tr>
            ) : !rows?.length ? (
              <tr>
                <td colSpan={columns.length}>{empty ?? <EmptyState title="Nothing here yet" />}</td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={rowKey(row)}
                  className={cn(onRowClick && 'cursor-pointer hover:bg-slate-50')}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={onRowClick ? (e) => e.key === 'Enter' && onRowClick(row) : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={cn('px-3 py-2.5 align-middle text-slate-700', c.className)}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * Phone / tablet layout of DataTable (below the lg breakpoint): one card per row, so wide
 * tables never need sideways scrolling. The first column is the card title; the others are
 * label/value pairs, and a column without a text header (e.g. actions) sits at the bottom.
 */
function CardList<T>({
  columns,
  rows,
  rowKey,
  loading,
  empty,
  sort,
  onSort,
  onRowClick,
}: {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  loading?: boolean;
  empty?: ReactNode;
  sort?: string;
  onSort?: (sort: string) => void;
  onRowClick?: (row: T) => void;
}) {
  const visible = columns.filter((c) => !c.hideInCard);
  const label = (c: Column<T>) => c.cardLabel ?? (typeof c.header === 'string' ? c.header : '');
  const [title, ...rest] = visible;
  const fields = rest.filter((c) => label(c));
  const footer = rest.filter((c) => !label(c));
  const sortable = onSort ? columns.filter((c) => c.sortKey) : [];
  return (
    <div className="lg:hidden">
      {sortable.length > 0 && (
        <label className="mb-3 flex items-center justify-end gap-2 text-sm text-slate-600">
          Sort by
          <select className="h-10 rounded-lg border border-slate-300 bg-white px-2 text-sm" value={sort ?? ''} onChange={(e) => onSort!(e.target.value)}>
            {sortable.flatMap((c) => [
              <option key={c.sortKey} value={c.sortKey}>
                {label(c) || c.sortKey} ↑
              </option>,
              <option key={`-${c.sortKey}`} value={`-${c.sortKey}`}>
                {label(c) || c.sortKey} ↓
              </option>,
            ])}
          </select>
        </label>
      )}
      {loading ? (
        <div className="rounded-xl border border-slate-200 bg-white">
          <Spinner />
        </div>
      ) : !rows?.length ? (
        <div className="rounded-xl border border-slate-200 bg-white">{empty ?? <EmptyState title="Nothing here yet" />}</div>
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => {
            // Action buttons for this row; a row with none gets no empty footer strip.
            const actions = footer.map((c) => [c.key, c.render(row)] as const).filter(([, node]) => node !== null && node !== undefined && node !== false);
            return (
              <li
                key={rowKey(row)}
                className={cn('rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700', onRowClick && 'cursor-pointer active:bg-slate-50')}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={onRowClick ? (e) => e.key === 'Enter' && onRowClick(row) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
              >
                {title && <div className="mb-2 font-medium text-slate-900">{title.render(row)}</div>}
                {fields.length > 0 && (
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
                    {fields.map((c) => (
                      <div key={c.key} className={cn('min-w-0', c.cardWide && 'col-span-2 sm:col-span-3')}>
                        <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label(c)}</dt>
                        <dd className="mt-0.5 break-words [&_*]:max-w-full">{c.render(row)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {actions.length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-3">
                    {actions.map(([key, node]) => (
                      <div key={key}>{node}</div>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function Pagination({ page, totalPages, total, onPage }: { page: number; totalPages: number; total: number; onPage: (p: number) => void }) {
  if (total === 0) return null;
  return (
    <nav className="mt-3 flex items-center justify-between text-sm text-slate-600" aria-label="Pagination">
      <span>
        {total} result{total === 1 ? '' : 's'} · page {page} of {totalPages}
      </span>
      <div className="flex gap-1">
        <Button size="sm" variant="secondary" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page" icon={<ChevronLeft className="h-4 w-4" />} />
        <Button size="sm" variant="secondary" onClick={() => onPage(page + 1)} disabled={page >= totalPages} aria-label="Next page" icon={<ChevronRight className="h-4 w-4" />} />
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
type Toast = { id: number; tone: 'success' | 'error' | 'info'; title: string; body?: string };
type ToastApi = { success: (t: string, b?: string) => void; error: (t: string, b?: string) => void; info: (t: string, b?: string) => void };
const ToastCtx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], title: string, body?: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, tone, title, body }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 4500);
  }, []);
  const apiRef = useRef<ToastApi>({
    success: (t, b) => push('success', t, b),
    error: (t, b) => push('error', t, b),
    info: (t, b) => push('info', t, b),
  });
  const icons = {
    success: <CheckCircle2 className="h-5 w-5 text-emerald-500" />,
    error: <XCircle className="h-5 w-5 text-red-500" />,
    info: <Info className="h-5 w-5 text-sky-500" />,
  };
  return (
    <ToastCtx.Provider value={apiRef.current}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-16 z-60 flex flex-col items-center gap-2 px-4 sm:top-auto sm:bottom-4 sm:items-end" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto flex w-full max-w-sm gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
            {icons[t.tone]}
            <div className="min-w-0 text-sm">
              <p className="font-medium text-slate-900">{t.title}</p>
              {t.body && <p className="mt-0.5 text-slate-600">{t.body}</p>}
            </div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast outside ToastProvider');
  return ctx;
}

// ---------------------------------------------------------------------------
// Number plate
// ---------------------------------------------------------------------------
/** "TS09CD5678" → "TS 09 CD 5678", the way plates are read; anything else is shown as written. */
export function formatPlate(reg: string) {
  const m = reg
    .replace(/\s+/g, '')
    .toUpperCase()
    .match(/^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$/);
  return m ? [m[1], m[2], m[3], m[4]].filter(Boolean).join(' ') : reg;
}

/**
 * The cab's registration number as a yellow commercial plate, the one thing people look for when
 * the cab arrives. `size`: sm in tables and lists, md on cards, lg where it's the headline.
 */
export function Plate({ reg, size = 'md', className }: { reg: string; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const sizes = { sm: 'px-1.5 py-0.5 text-xs border', md: 'px-2 py-0.5 text-sm border-2', lg: 'px-2.5 py-1 text-lg border-2' };
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-md border-slate-900 bg-amber-300 font-mono font-bold tracking-wider text-slate-900',
        sizes[size],
        className,
      )}
      aria-label={`Cab number ${reg}`}
    >
      {formatPlate(reg)}
    </span>
  );
}
