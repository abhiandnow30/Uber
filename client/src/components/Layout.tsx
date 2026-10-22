import {
  BarChart3,
  Bell,
  CalendarPlus,
  Car,
  ClipboardList,
  History,
  Home,
  KeyRound,
  LogOut,
  Menu,
  Settings,
  ShieldCheck,
  UserCog,
  Users,
  X,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { get } from '../lib/api';
import { useAuth, type Role } from '../lib/auth';
import { useRealtime } from '../lib/realtime';
import { cn } from './ui';

/** `match`: extra path prefixes that keep this item highlighted (pages grouped under it). */
type NavItem = { to: string; label: string; icon: ReactNode; end?: boolean; match?: string[] };
const ic = 'h-4 w-4';

/** Tabs shown at the top of grouped pages, so the sidebar stays short. */
type Tab = { to: string; label: string };
const SECTION_TABS: Array<{ roles: Role[]; tabs: Tab[] }> = [
  {
    roles: ['ADMIN'],
    tabs: [
      { to: '/admin/employees', label: 'All employees' },
    ],
  },
  {
    roles: ['ADMIN', 'COORDINATOR'],
    tabs: [
      { to: '/ops/drivers', label: 'Drivers' },
      { to: '/ops/vehicles', label: 'Vehicles' },
    ],
  },
  {
    roles: ['ADMIN'],
    tabs: [
      { to: '/admin/policy', label: 'Booking policy' },
      { to: '/admin/notifications', label: 'Email delivery' },
      { to: '/admin/audit', label: 'Audit log' },
    ],
  },
];

const startsWithAny = (path: string, prefixes: string[]) => prefixes.some((p) => path === p || path.startsWith(`${p}/`));

const NAV: Record<Role, NavItem[]> = {
  ADMIN: [
    { to: '/admin', label: 'Dashboard', icon: <Home className={ic} />, end: true },
    { to: '/admin/employees', label: 'Employees', icon: <Users className={ic} /> },
    { to: '/admin/coordinators', label: 'Coordinators', icon: <UserCog className={ic} /> },
    { to: '/admin/admins', label: 'Admins', icon: <ShieldCheck className={ic} /> },
    { to: '/ops/bookings', label: 'Cab requests', icon: <ClipboardList className={ic} /> },
    { to: '/ops/drivers', label: 'Drivers & vehicles', icon: <Car className={ic} />, match: ['/ops/vehicles'] },
    { to: '/admin/reports', label: 'Reports', icon: <BarChart3 className={ic} /> },
    { to: '/admin/policy', label: 'Settings', icon: <Settings className={ic} />, match: ['/admin/notifications', '/admin/audit'] },
  ],
  COORDINATOR: [
    { to: '/ops', label: 'Dashboard', icon: <Home className={ic} />, end: true },
    { to: '/ops/bookings', label: 'Cab requests', icon: <ClipboardList className={ic} /> },
    { to: '/ops/drivers', label: 'Drivers & vehicles', icon: <Car className={ic} />, match: ['/ops/vehicles'] },
  ],
  EMPLOYEE: [
    { to: '/employee', label: 'Home', icon: <Home className={ic} />, end: true },
    { to: '/employee/request', label: 'Request a cab', icon: <CalendarPlus className={ic} /> },
    { to: '/employee/bookings', label: 'My bookings', icon: <History className={ic} /> },
  ],
  DRIVER: [
    { to: '/driver', label: 'My rides', icon: <Home className={ic} />, end: true },
    { to: '/driver/history', label: 'Trip history', icon: <History className={ic} /> },
  ],
};

/** Horizontal tabs for the section the current page belongs to (if any). */
function SectionTabs({ role, path }: { role: Role; path: string }) {
  const section = SECTION_TABS.find((sec) => sec.roles.includes(role) && sec.tabs.some((t) => startsWithAny(path, [t.to])));
  if (!section) return null;
  return (
    <nav aria-label="Section" className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-200">
      {section.tabs.map((t) => {
        const active = startsWithAny(path, [t.to]);
        return (
          <Link
            key={t.to}
            to={t.to}
            aria-current={active ? 'page' : undefined}
            className={cn('whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', active ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-700')}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

const ROLE_LABEL: Record<Role, string> = { ADMIN: 'Administrator', COORDINATOR: 'Transport coordinator', EMPLOYEE: 'Employee', DRIVER: 'Driver' };

export function NotificationBell() {
  const { data } = useQuery({ queryKey: ['notifications', 'count'], queryFn: () => get<{ unread: number }>('/notifications/unread-count'), refetchInterval: 60_000 });
  const unread = data?.unread ?? 0;
  return (
    <Link to="/notifications" className="relative rounded-lg p-2 text-slate-600 hover:bg-slate-100" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
      <Bell className="h-5 w-5" />
      {unread > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-[1.1rem] rounded-full bg-red-600 px-1 text-center text-[10px] font-semibold leading-[1.1rem] text-white">{unread > 99 ? '99+' : unread}</span>}
    </Link>
  );
}

export function AppLayout() {
  const { me, logout } = useAuth();
  const { connected } = useRealtime();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  if (!me) return null;
  const role = me.user.role;
  const items = NAV[role];
  const isDriver = role === 'DRIVER';

  const doLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const nav = (
    <nav className="flex flex-col gap-0.5 p-3" aria-label="Main">
      {items.map((it) => (
        <NavLink
          key={it.to}
          to={it.to}
          end={it.end}
          onClick={() => setOpen(false)}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium',
              isActive || startsWithAny(pathname, it.match ?? []) ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
            )
          }
        >
          {it.icon}
          {it.label}
        </NavLink>
      ))}
      <div className="my-2 border-t border-slate-200" />
      <NavLink to="/account" onClick={() => setOpen(false)} className={({ isActive }) => cn('flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium', isActive ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100')}>
        <KeyRound className={ic} /> Account
      </NavLink>
      <button onClick={doLogout} className="flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-600 hover:bg-slate-100">
        <LogOut className={ic} /> Sign out
      </button>
    </nav>
  );

  return (
    <div className="min-h-screen lg:flex">
      {/* Desktop sidebar (drivers get a mobile-first top bar only) */}
      {!isDriver && (
        <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-white lg:block">
          <div className="sticky top-0 flex h-screen flex-col">
            <Brand />
            <div className="flex-1 overflow-y-auto">{nav}</div>
            <UserFooter name={me.user.name} role={ROLE_LABEL[role]} connected={connected} />
          </div>
        </aside>
      )}

      <div className="min-w-0 flex-1">
        <header className={cn('sticky top-0 z-30 flex h-14 items-center justify-between border-b border-slate-200 bg-white/95 px-4 backdrop-blur-sm', !isDriver && 'lg:hidden')}>
          <div className="flex items-center gap-2">
            <button className="rounded-lg p-2 hover:bg-slate-100" onClick={() => setOpen(true)} aria-label="Open menu">
              <Menu className="h-5 w-5" />
            </button>
            <span className="font-semibold">{isDriver ? 'Driver' : 'Cab Booking'}</span>
            <span className={cn('h-2 w-2 rounded-full', connected ? 'bg-emerald-500' : 'bg-slate-300')} title={connected ? 'Live updates on' : 'Reconnecting…'} />
          </div>
          <NotificationBell />
        </header>
        {!isDriver && (
          <div className="sticky top-0 z-20 hidden h-14 items-center justify-end gap-2 border-b border-slate-200 bg-white/95 px-6 backdrop-blur-sm lg:flex">
            <span className={cn('flex items-center gap-1.5 text-xs', connected ? 'text-emerald-600' : 'text-slate-400')}>
              <span className={cn('h-2 w-2 rounded-full', connected ? 'bg-emerald-500' : 'bg-slate-300')} />
              {connected ? 'Live' : 'Reconnecting…'}
            </span>
            <NotificationBell />
          </div>
        )}
        <main className={cn('mx-auto w-full p-4 sm:p-6', isDriver ? 'max-w-xl' : 'max-w-7xl')}>
          {!isDriver && <SectionTabs role={role} path={pathname} />}
          <Outlet />
        </main>
      </div>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-72 flex-col bg-white shadow-xl">
            <div className="flex items-center justify-between pr-2">
              <Brand />
              <button onClick={() => setOpen(false)} className="rounded-lg p-2 hover:bg-slate-100" aria-label="Close menu">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">{nav}</div>
            <UserFooter name={me.user.name} role={ROLE_LABEL[role]} connected={connected} />
          </div>
        </div>
      )}
    </div>
  );
}

function Brand() {
  return (
    <div className="flex h-14 items-center gap-2 px-5">
      <img src="/favicon.svg" alt="" className="h-7 w-7" />
      <span className="font-semibold tracking-tight">Cab Booking</span>
    </div>
  );
}

function UserFooter({ name, role, connected }: { name: string; role: string; connected: boolean }) {
  return (
    <div className="border-t border-slate-200 p-4 text-sm">
      <p className="truncate font-medium text-slate-900">{name}</p>
      <p className="text-xs text-slate-500">
        {role} · {connected ? 'live' : 'offline'}
      </p>
    </div>
  );
}
