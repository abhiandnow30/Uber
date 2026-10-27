import { describe, expect, it } from 'vitest';
import { CabAssignment, CabRequest } from '../src/models/booking.js';
import { Coordinator } from '../src/models/Coordinator.js';
import { Driver } from '../src/models/Driver.js';
import { AuditLog, Notification } from '../src/models/system.js';
import { User } from '../src/models/User.js';
import { Vehicle } from '../src/models/Vehicle.js';
import { createAdmin } from '../src/scripts/create-admin.js';
import { checkDocumentExpiry } from '../src/services/monitor.service.js';
import { anonymous, assign, bookingInput, drainOutbox, employeePin, fakeEmail, linkFrom, login, makeCoordinator, makeEmployee, scenario, toArrived } from './helpers.js';

describe('create-admin bootstrap', () => {
  it('creates an INVITED admin with an activation email, and can complete activation', async () => {
    const r = await createAdmin('IT.Admin@Company.com', 'IT Admin');
    expect(r.created).toBe(true);
    const u = await User.findOne({ email: 'it.admin@company.com' }).select('+passwordHash');
    expect(u!.role).toBe('ADMIN');
    expect(u!.status).toBe('INVITED');
    expect(u!.passwordHash).toBeFalsy();
    expect(await AuditLog.exists({ action: 'ADMIN_BOOTSTRAPPED' })).toBeTruthy();
    await drainOutbox();
    const token = linkFrom(fakeEmail.to('it.admin@company.com')[0], '/activate');
    await anonymous().post('/api/auth/activate', { token, password: 'AdminPass2026' }).expect(200);
    const admin = await login('it.admin@company.com', 'AdminPass2026');
    await admin.get('/api/admin/dashboard').expect(200);
  });

  it('re-issues the invitation for an invited admin but never alters other accounts', async () => {
    await createAdmin('a@company.com', 'Admin A');
    expect((await createAdmin('a@company.com', 'Admin A')).created).toBe(false);
    await makeEmployee({ email: 'emp@company.com' });
    await expect(createAdmin('emp@company.com', 'Someone')).rejects.toThrow(/existing employee account/);
    expect((await User.findOne({ email: 'emp@company.com' }))!.role).toBe('EMPLOYEE');
    await expect(createAdmin('not-an-email', 'Someone')).rejects.toThrow(/Invalid email/);
  });
});

describe('coordinator support actions for stuck trips', () => {
  it('only the driver can complete a trip; coordinators cannot complete it on their behalf', async () => {
    const s = await scenario();
    const a = await assign(s.coord.client, s.bookingId, s.drv);
    await toArrived(s.drv.client, a.body.assignment._id);
    await s.drv.client.post(`/api/driver/rides/${a.body.assignment._id}/start`, { pin: await employeePin(s.emp.client!, s.bookingId) }).expect(200);

    await s.coord.client.post(`/api/ops/bookings/${s.bookingId}/complete`, { reason: 'Driver phone battery died; employee confirmed drop-off' }).expect(403);
    expect((await CabRequest.findById(s.bookingId))!.status).toBe('IN_PROGRESS');
    await s.drv.client.post(`/api/driver/rides/${a.body.assignment._id}/complete`).expect(200);
    const asg = await CabAssignment.findById(a.body.assignment._id);
    expect(asg!.completionMethod).toBe('DRIVER');
    expect((await Driver.findById(s.drv.driver._id))!.availability).toBe('AVAILABLE');
    // cannot complete twice
    await s.drv.client.post(`/api/driver/rides/${a.body.assignment._id}/complete`).expect(409);
  });

  it('records a no-show reported to the transport team; only after arrival; drivers cannot call it', async () => {
    const s = await scenario();
    const a = await assign(s.coord.client, s.bookingId, s.drv);
    await s.coord.client.post(`/api/ops/bookings/${s.bookingId}/no-show`, { reason: 'Not at pickup' }).expect(409); // not arrived yet
    await toArrived(s.drv.client, a.body.assignment._id);
    await s.drv.client.post(`/api/ops/bookings/${s.bookingId}/no-show`, { reason: 'x driver' }).expect(403);
    await s.coord.client.post(`/api/ops/bookings/${s.bookingId}/no-show`, { reason: 'Driver called: waited 15 minutes, no answer' }).expect(200);
    expect((await CabRequest.findById(s.bookingId))!.status).toBe('NO_SHOW');
    expect((await CabAssignment.findById(a.body.assignment._id))!.status).toBe('NO_SHOW');
  });

  it('a coordinator from another office cannot use support actions', async () => {
    const s = await scenario();
    const other = await makeCoordinator(['BLR']);
    await assign(s.coord.client, s.bookingId, s.drv).expect(201);
    await other.client.post(`/api/ops/bookings/${s.bookingId}/no-show`, { reason: 'Not my office' }).expect(403);
  });
});

describe('vehicle document expiry monitoring', () => {
  it('warns ahead of insurance/permit expiry and flags expired documents once', async () => {
    const coord = await makeCoordinator(['HYD']);
    await Vehicle.create({ registrationNumber: 'TS09EXP1', model: 'B', vehicleType: 'SEDAN', capacity: 4, officeLocation: 'HYD', insuranceExpiry: new Date(Date.now() + 5 * 86400_000) });
    await Vehicle.create({ registrationNumber: 'TS09EXP2', model: 'B', vehicleType: 'SEDAN', capacity: 4, officeLocation: 'HYD', permitExpiry: new Date(Date.now() - 86400_000) });
    await Vehicle.create({ registrationNumber: 'TS09OK01', model: 'B', vehicleType: 'SEDAN', capacity: 4, officeLocation: 'HYD', insuranceExpiry: new Date(Date.now() + 200 * 86400_000) });
    await checkDocumentExpiry();
    await checkDocumentExpiry();
    const alerts = await Notification.find({ user: coord.user._id, type: 'DOCUMENT_EXPIRY' }).lean();
    expect(alerts).toHaveLength(2);
    expect(alerts.find((n) => n.body.includes('TS09EXP1'))!.body).toContain('insurance expires on');
    expect(alerts.find((n) => n.body.includes('TS09EXP2'))!.body).toContain('permit expired on');
  });
});
