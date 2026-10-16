import crypto from 'node:crypto';
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
import { hashPassword } from '../src/utils/crypto.js';
import { employeesUseMicrosoftOnly } from '../src/services/auth.service.js';

export const PASSWORD = 'Password123!';
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

export function linkFrom(email: OutgoingEmail, path: string) {
  const m = email.text.match(new RegExp(`https?://[^\\s]+${path}\\?token=([A-Za-z0-9_\\-%]+)`));
  if (!m) throw new Error(`No ${path} link in email: ${email.subject}`);
  return decodeURIComponent(m[1]);
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

export async function login(email: string, password = PASSWORD): Promise<Client> {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').set('X-Requested-With', 'XMLHttpRequest').send({ email, password });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return wrap(agent, res.body.csrfToken);
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
    passwordHash: await hashPassword(PASSWORD),
  });
}

export async function makeAdmin(email = 'admin@test.com') {
  const user = await makeUser('ADMIN', email);
  return { user, client: await login(email) };
}

export async function makeCoordinator(offices = ['HYD'], email = `coord-${uniq()}@test.com`) {
  const user = await makeUser('COORDINATOR', email);
  await Coordinator.create({ user: user._id, fullName: 'Coord', email, officeLocations: offices });
  return { user, client: await login(email) };
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
  // With Microsoft-only sign-in employees can't use passwords, so there's no client to hand back.
  const canLogin = (!opts.status || opts.status === 'ACTIVE') && !employeesUseMicrosoftOnly();
  return { user, employee, client: canLogin ? await login(email) : null };
}

let phoneSeq = 0;

/** Drivers sign in with their mobile number and the last 4 characters of their linked vehicle. */
export async function driverLogin(phone: string, vehicleNumber: string): Promise<Client> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/driver-login')
    .set('X-Requested-With', 'XMLHttpRequest')
    .send({ phone, vehicleLast4: vehicleNumber.replace(/[^a-z0-9]/gi, '').slice(-4) });
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
  return { user, driver, vehicle, client: await driverLogin(phone, vehicle.registrationNumber) };
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
