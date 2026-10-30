import crypto from 'node:crypto';
import type { AuthenticationResult } from '@azure/msal-node';
import { DateTime } from 'luxon';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../src/app.js';
import { Coordinator } from '../src/models/Coordinator.js';
import { Driver } from '../src/models/Driver.js';
import { Employee } from '../src/models/Employee.js';
import { DriverVehicleLink } from '../src/models/fleetHistory.js';
import { User } from '../src/models/User.js';
import { Vehicle } from '../src/models/Vehicle.js';
import { EmailSendError, type EmailProvider, type OutgoingEmail } from '../src/services/email/providers.js';
import { processOutboxBatch } from '../src/services/email/outbox.worker.js';
import { EmailOutbox } from '../src/models/system.js';
import { normalizeEmail } from '../src/services/auth.service.js';
import { createSession, CSRF_COOKIE, SESSION_COOKIE } from '../src/services/session.service.js';
import { buildLoginUrl, completeLogin, setSsoClient } from '../src/services/sso.service.js';
import { config } from '../src/config.js';

export const app = createApp();

// ---------------------------------------------------------------------------
// Fake email provider (captures messages, can simulate failures)
// ---------------------------------------------------------------------------
class FakeEmailProvider implements EmailProvider {
  readonly name = 'fake';
  sent: OutgoingEmail[] = [];
  failures: Array<'transient' | 'permanent'> = [];
  reset() {
    this.sent = [];
    this.failures = [];
  }
  async send(email: OutgoingEmail) {
    const f = this.failures.shift();
    if (f === 'transient') throw new EmailSendError('Graph 503 Service Unavailable', true);
    if (f === 'permanent') throw new EmailSendError('Graph 400 invalid recipient', false);
    this.sent.push(email);
    return { providerMessageId: `fake-${this.sent.length}` };
  }
  to(address: string) {
    return this.sent.filter((e) => e.to === address.toLowerCase());
  }
}
export const fakeEmail = new FakeEmailProvider();

/** Send everything due in the outbox (makes retries due immediately). */
export async function drainOutbox() {
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const n = await processOutboxBatch(50);
    total += n;
    if (!n) break;
  }
  return total;
}

export async function makeRetriesDue() {
  await EmailOutbox.updateMany({ status: 'RETRYING' }, { $set: { nextAttemptAt: new Date(Date.now() - 1000) } });
}

// ---------------------------------------------------------------------------
// HTTP client with session cookie + CSRF headers
// ---------------------------------------------------------------------------
export type Client = {
  agent: TestAgent;
  csrf: string;
  get: (url: string) => request.Test;
  post: (url: string, body?: object) => request.Test;
  put: (url: string, body?: object) => request.Test;
  patch: (url: string, body?: object) => request.Test;
  del: (url: string) => request.Test;
};

function wrap(agent: TestAgent, csrf: string): Client {
  const h = (t: request.Test) => t.set('X-Requested-With', 'XMLHttpRequest').set('X-CSRF-Token', csrf);
  return {
    agent,
    csrf,
    get: (u) => agent.get(u),
    post: (u, b) => h(agent.post(u)).send(b ?? {}),
    put: (u, b) => h(agent.put(u)).send(b ?? {}),
    patch: (u, b) => h(agent.patch(u)).send(b ?? {}),
    del: (u) => h(agent.delete(u)),
  };
}

export function anonymous(): Client {
  return wrap(request.agent(app), '');
}

/**
 * Signs an admin or employee in the way "Sign in with Microsoft" ends: a real server session with
 * the same cookies the app sets (the Entra round trip itself can't run in tests).
 */
export async function login(email: string): Promise<Client> {
  const user = await User.findOne({ email: normalizeEmail(email) });
  if (!user || user.status !== 'ACTIVE') throw new Error(`Login failed for ${email}: ${user ? `account is ${user.status}` : 'no such user'}`);
  // Like a real Microsoft sign-in: link the Microsoft account (first time) and record the sign-in.
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date(), ...(user.entraOid ? {} : { entraOid: `test-oid-${user._id}` }) } });
  const session = await createSession(user, { method: 'SSO' });
  const agent = request.agent(app);
  agent.jar.setCookie(`${SESSION_COOKIE}=${session.token}; Path=/`);
  agent.jar.setCookie(`${CSRF_COOKIE}=${session.csrfToken}; Path=/`);
  return wrap(agent, session.csrfToken);
}

/**
 * The real "Sign in with Microsoft" completion (sso.service) with a fake Entra client: activates an
 * INVITED account on first sign-in, exactly as in production. Throws if the sign-in is refused.
 */
export async function microsoftSignIn(email: string, oid = `oid-${email}`): Promise<Client> {
  const saved = { ...config };
  Object.assign(config, { ssoEnabled: true, ENTRA_TENANT_ID: 'tenant-test', ENTRA_CLIENT_ID: 'app-test', ENTRA_CLIENT_SECRET: 's', ENTRA_REDIRECT_URI: 'http://localhost/api/auth/sso/callback' });
  setSsoClient({
    getAuthCodeUrl: async () => 'https://login.microsoftonline.com/tenant-test/oauth2/v2.0/authorize',
    acquireTokenByCode: async () => ({ idTokenClaims: { oid, tid: 'tenant-test', preferred_username: email } }) as unknown as AuthenticationResult,
  });
  try {
    const { cookieValue } = await buildLoginUrl();
    const r = await completeLogin({ code: 'auth-code', state: JSON.parse(cookieValue).state, cookie: cookieValue });
    if (!r.ok) throw new Error(`Microsoft sign-in refused for ${email}: ${r.reason}`);
    const agent = request.agent(app);
    agent.jar.setCookie(`${SESSION_COOKIE}=${r.token}; Path=/`);
    agent.jar.setCookie(`${CSRF_COOKIE}=${r.csrfToken}; Path=/`);
    return wrap(agent, r.csrfToken);
  } finally {
    setSsoClient(null);
    Object.assign(config, saved);
  }
}

// ---------------------------------------------------------------------------
// Factories (direct DB) for test preconditions
// ---------------------------------------------------------------------------
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

export async function makeUser(role: string, email: string, opts: { status?: string; name?: string } = {}) {
  return User.create({
    email,
    name: opts.name ?? email.split('@')[0],
    role,
    status: opts.status ?? 'ACTIVE',
  });
}

export async function makeAdmin(email = 'admin@test.com') {
  const user = await makeUser('ADMIN', email);
  return { user, client: await login(email) };
}

/** Coordinators sign in with their email and the mobile number an admin registered. */
export async function coordinatorLogin(email: string, phone: string): Promise<Client> {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/coordinator-login').set('X-Requested-With', 'XMLHttpRequest').send({ email, phone });
  if (res.status !== 200) throw new Error(`Coordinator sign-in failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return wrap(agent, res.body.csrfToken);
}

let coordPhoneSeq = 0;
export async function makeCoordinator(offices = ['HYD'], email = `coord-${uniq()}@test.com`) {
  const user = await makeUser('COORDINATOR', email);
  const phone = `8${String(process.pid % 10000).padStart(4, '0')}${String(++coordPhoneSeq).padStart(5, '0')}`;
  await Coordinator.create({ user: user._id, fullName: 'Coord', email, phone, officeLocations: offices });
  return { user, phone, client: await coordinatorLogin(email, phone) };
}

export async function makeEmployee(opts: { office?: string; email?: string; employeeId?: string; status?: string } = {}) {
  const email = opts.email ?? `emp-${uniq()}@test.com`;
  const user = await makeUser('EMPLOYEE', email, { status: opts.status });
  const employee = await Employee.create({
    user: user._id,
    employeeId: opts.employeeId ?? `E${uniq()}`.toUpperCase().slice(0, 20),
    fullName: `Employee ${email.split('@')[0]}`,
    email,
    phone: '+91 90000 00000',
    officeLocation: opts.office ?? 'HYD',
  });
  // Only active accounts can sign in.
  const canLogin = !opts.status || opts.status === 'ACTIVE';
  return { user, employee, client: canLogin ? await login(email) : null };
}

let phoneSeq = 0;

/** Drivers sign in with their mobile number; the password is its first 4 digits (of the 10-digit number). */
export const driverPassword = (phone: string) => phone.replace(/\D/g, '').slice(-10).slice(0, 4);

export async function driverLogin(phone: string): Promise<Client> {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/driver-login').set('X-Requested-With', 'XMLHttpRequest').send({ phone, password: driverPassword(phone) });
  if (res.status !== 200) throw new Error(`Driver sign-in failed for ${phone}: ${res.status} ${JSON.stringify(res.body)}`);
  return wrap(agent, res.body.csrfToken);
}

export async function makeDriver(opts: { office?: string; capacity?: number; verified?: boolean; email?: string } = {}) {
  const email = opts.email ?? `drv-${uniq()}@test.com`;
  const user = await makeUser('DRIVER', email);
  const code = `D${uniq()}`.toUpperCase().slice(0, 18);
  const phone = `9${String(process.pid % 10000).padStart(4, '0')}${String(++phoneSeq).padStart(5, '0')}`;
  const vehicle = await Vehicle.create({
    registrationNumber: `TS${uniq()}`.toUpperCase().slice(0, 14),
    model: 'Innova',
    vehicleType: 'MUV',
    capacity: opts.capacity ?? 4,
    officeLocation: opts.office ?? 'HYD',
    status: 'ACTIVE',
  });
  const driver = await Driver.create({
    user: user._id,
    driverCode: code,
    fullName: `Driver ${code}`,
    phone,
    email,
    licenseNumber: `LIC${uniq()}`.toUpperCase(),
    licenseExpiry: new Date(Date.now() + 365 * 86400_000),
    verificationStatus: opts.verified === false ? 'PENDING' : 'VERIFIED',
    employmentStatus: 'ACTIVE',
    officeLocation: opts.office ?? 'HYD',
    onDuty: true,
    availability: 'AVAILABLE',
    currentVehicle: vehicle._id,
  });
  await DriverVehicleLink.create({ driver: driver._id, vehicle: vehicle._id, linkedBy: user._id });
  return { user, driver, vehicle, client: await driverLogin(phone) };
}

export function futureDate(days = 1, tz = 'Asia/Kolkata') {
  return DateTime.now().setZone(tz).plus({ days }).toFormat('yyyy-MM-dd');
}

export function bookingInput(overrides: Record<string, unknown> = {}) {
  return {
    travelDate: futureDate(1),
    pickupTime: '09:00',
    pickupLocation: 'Gachibowli Metro Station',
    dropLocation: 'HITEC City Campus',
    passengers: 1,
    clientRequestId: crypto.randomUUID(),
    ...overrides,
  };
}

/** Full setup: coordinator, employee with a booking, driver with vehicle. */
export async function scenario() {
  const coord = await makeCoordinator(['HYD']);
  const emp = await makeEmployee();
  const drv = await makeDriver();
  const res = await emp.client!.post('/api/me/bookings', bookingInput());
  if (res.status !== 201) throw new Error(`booking failed ${res.status} ${JSON.stringify(res.body)}`);
  return { coord, emp, drv, bookingId: res.body.booking._id as string, reference: res.body.booking.reference as string };
}

export function assign(coord: Client, bookingId: string, drv: { driver: { _id: unknown }; vehicle: { _id: unknown } }) {
  return coord.post(`/api/ops/bookings/${bookingId}/assign`, { driverId: String(drv.driver._id), vehicleId: String(drv.vehicle._id) });
}

/** Employee reads their own PIN from the authenticated booking details. */
export async function employeePin(emp: Client, bookingId: string): Promise<string> {
  const res = await emp.get(`/api/me/bookings/${bookingId}`);
  if (!res.body.pin) throw new Error(`No PIN visible: ${JSON.stringify(res.body.pinStatus)}`);
  return res.body.pin.code;
}

/** Drives an assigned ride to ARRIVED. Returns the assignment id. */
export async function toArrived(drv: Client, assignmentId: string) {
  for (const step of ['acknowledge', 'en-route', 'arrived']) {
    const r = await drv.post(`/api/driver/rides/${assignmentId}/${step}`);
    if (r.status >= 300) throw new Error(`${step} failed ${r.status} ${JSON.stringify(r.body)}`);
  }
}
