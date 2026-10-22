import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppLayout } from './components/Layout';
import { Spinner } from './components/ui';
import { homeFor, useAuth, type Role } from './lib/auth';

const p = <T,>(f: () => Promise<{ default: T }>) => lazy(f as never);

// Public
const Login = p(() => import('./pages/public/Login'));
const Activate = p(() => import('./pages/public/Activate'));
const ForgotPassword = p(() => import('./pages/public/ForgotPassword'));
const ResetPassword = p(() => import('./pages/public/ResetPassword'));
const Register = p(() => import('./pages/public/Register'));
const DriverLogin = p(() => import('./pages/public/DriverLogin'));
const CoordinatorLogin = p(() => import('./pages/public/CoordinatorLogin'));
// Common
const Notifications = p(() => import('./pages/common/Notifications'));
const Account = p(() => import('./pages/common/Account'));
// Admin
const AdminDashboard = p(() => import('./pages/admin/AdminDashboard'));
const Employees = p(() => import('./pages/admin/Employees'));
const EmployeeDetail = p(() => import('./pages/admin/EmployeeDetail'));
const Coordinators = p(() => import('./pages/admin/Coordinators'));
const CoordinatorDetail = p(() => import('./pages/admin/CoordinatorDetail'));
const Admins = p(() => import('./pages/admin/Admins'));
const PolicyPage = p(() => import('./pages/admin/Policy'));
const Reports = p(() => import('./pages/admin/Reports'));
const Audit = p(() => import('./pages/admin/Audit'));
const EmailDelivery = p(() => import('./pages/admin/EmailDelivery'));
// Operations (coordinator + admin)
const OpsDashboard = p(() => import('./pages/ops/OpsDashboard'));
const Bookings = p(() => import('./pages/ops/Bookings'));
const BookingDetail = p(() => import('./pages/ops/BookingDetail'));
const Drivers = p(() => import('./pages/ops/Drivers'));
const DriverDetail = p(() => import('./pages/ops/DriverDetail'));
const Vehicles = p(() => import('./pages/ops/Vehicles'));
const VehicleDetail = p(() => import('./pages/ops/VehicleDetail'));
// Employee
const EmployeeHome = p(() => import('./pages/employee/EmployeeHome'));
const RequestCab = p(() => import('./pages/employee/RequestCab'));
const MyBookings = p(() => import('./pages/employee/MyBookings'));
const MyBookingDetail = p(() => import('./pages/employee/MyBookingDetail'));
// Driver
const DriverHome = p(() => import('./pages/driver/DriverHome'));
const DriverRide = p(() => import('./pages/driver/DriverRide'));
const DriverHistory = p(() => import('./pages/driver/DriverHistory'));

/** Frontend guard for navigation only; the API enforces authorization on every request. */
function RequireRole({ roles, children }: { roles?: Role[]; children: ReactNode }) {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Spinner />;
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (roles && !roles.includes(me.user.role)) return <Navigate to={homeFor(me.user.role)} replace />;
  return <>{children}</>;
}

function PublicOnly({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) return <Spinner />;
  if (me) return <Navigate to={homeFor(me.user.role)} replace />;
  return <>{children}</>;
}

function Home() {
  const { me, loading } = useAuth();
  if (loading) return <Spinner />;
  return <Navigate to={me ? homeFor(me.user.role) : '/login'} replace />;
}

export default function App() {
  const ADMIN: Role[] = ['ADMIN'];
  const OPS: Role[] = ['ADMIN', 'COORDINATOR'];
  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<PublicOnly><Login /></PublicOnly>} />
        <Route path="/register" element={<PublicOnly><Register /></PublicOnly>} />
        <Route path="/driver-login" element={<PublicOnly><DriverLogin /></PublicOnly>} />
        <Route path="/coordinator-login" element={<PublicOnly><CoordinatorLogin /></PublicOnly>} />
        <Route path="/forgot-password" element={<PublicOnly><ForgotPassword /></PublicOnly>} />
        <Route path="/activate" element={<Activate />} />
        <Route path="/reset-password" element={<ResetPassword />} />

        <Route element={<RequireRole><AppLayout /></RequireRole>}>
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/account" element={<Account />} />

          <Route path="/admin" element={<RequireRole roles={ADMIN}><AdminDashboard /></RequireRole>} />
          <Route path="/admin/employees" element={<RequireRole roles={ADMIN}><Employees /></RequireRole>} />
          <Route path="/admin/employees/:id" element={<RequireRole roles={ADMIN}><EmployeeDetail /></RequireRole>} />
          <Route path="/admin/coordinators" element={<RequireRole roles={ADMIN}><Coordinators /></RequireRole>} />
          <Route path="/admin/coordinators/:id" element={<RequireRole roles={ADMIN}><CoordinatorDetail /></RequireRole>} />
          <Route path="/admin/admins" element={<RequireRole roles={ADMIN}><Admins /></RequireRole>} />
          <Route path="/admin/policy" element={<RequireRole roles={ADMIN}><PolicyPage /></RequireRole>} />
          <Route path="/admin/reports" element={<RequireRole roles={ADMIN}><Reports /></RequireRole>} />
          <Route path="/admin/audit" element={<RequireRole roles={ADMIN}><Audit /></RequireRole>} />
          <Route path="/admin/notifications" element={<RequireRole roles={ADMIN}><EmailDelivery /></RequireRole>} />

          <Route path="/ops" element={<RequireRole roles={OPS}><OpsDashboard /></RequireRole>} />
          <Route path="/ops/bookings" element={<RequireRole roles={OPS}><Bookings /></RequireRole>} />
          <Route path="/ops/bookings/:id" element={<RequireRole roles={OPS}><BookingDetail /></RequireRole>} />
          <Route path="/ops/drivers" element={<RequireRole roles={OPS}><Drivers /></RequireRole>} />
          <Route path="/ops/drivers/:id" element={<RequireRole roles={OPS}><DriverDetail /></RequireRole>} />
          <Route path="/ops/vehicles" element={<RequireRole roles={OPS}><Vehicles /></RequireRole>} />
          <Route path="/ops/vehicles/:id" element={<RequireRole roles={OPS}><VehicleDetail /></RequireRole>} />
          <Route path="/ops/links" element={<Navigate to="/ops/drivers" replace />} />

          <Route path="/employee" element={<RequireRole roles={['EMPLOYEE']}><EmployeeHome /></RequireRole>} />
          <Route path="/employee/request" element={<RequireRole roles={['EMPLOYEE']}><RequestCab /></RequireRole>} />
          <Route path="/employee/bookings" element={<RequireRole roles={['EMPLOYEE']}><MyBookings /></RequireRole>} />
          <Route path="/employee/bookings/:id" element={<RequireRole roles={['EMPLOYEE']}><MyBookingDetail /></RequireRole>} />

          <Route path="/driver" element={<RequireRole roles={['DRIVER']}><DriverHome /></RequireRole>} />
          <Route path="/driver/rides/:id" element={<RequireRole roles={['DRIVER']}><DriverRide /></RequireRole>} />
          <Route path="/driver/history" element={<RequireRole roles={['DRIVER']}><DriverHistory /></RequireRole>} />
        </Route>
        <Route path="*" element={<Home />} />
      </Routes>
    </Suspense>
  );
}
