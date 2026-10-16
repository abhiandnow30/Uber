import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AuditLog, Session } from '../src/models/system.js';
import { User } from '../src/models/User.js';
import { anonymous, app, drainOutbox, fakeEmail, linkFrom, login, makeAdmin, makeCoordinator, makeDriver, makeEmployee, makeUser, PASSWORD } from './helpers.js';

describe('authentication', () => {
  it('logs in, returns profile and logs out (session revoked server-side)', async () => {
    const { client } = await makeEmployee({ email: 'asha@test.com' });
    const me = await client!.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.role).toBe('EMPLOYEE');
    expect(me.body.profile.employeeId).toBeTruthy();

    await client!.post('/api/auth/logout').expect(200);
    expect(await Session.countDocuments({ revokedAt: null })).toBe(0);
    await client!.get('/api/auth/me').expect(401);
  });

  it('uses one generic message for unknown emails and wrong passwords (no enumeration)', async () => {
    await makeUser('EMPLOYEE', 'known@test.com');
    const anon = anonymous();
    const a = await anon.post('/api/auth/login', { email: 'nobody@test.com', password: 'whatever123' });
    const b = await anon.post('/api/auth/login', { email: 'known@test.com', password: 'wrong-password1' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
    expect(a.body.error.message).toMatch(/contact your administrator/i);
  });

  it('locks the account after repeated failed attempts', async () => {
    await makeUser('EMPLOYEE', 'lock@test.com');
    const anon = anonymous();
    for (let i = 0; i < 5; i++) await anon.post('/api/auth/login', { email: 'lock@test.com', password: 'bad-password-1' });
    const res = await anon.post('/api/auth/login', { email: 'lock@test.com', password: PASSWORD });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(await AuditLog.exists({ action: 'LOGIN_LOCKOUT' })).toBeTruthy();
  });

  it('rejects INVITED / SUSPENDED / INACTIVE accounts even with the right password', async () => {
    for (const status of ['INVITED', 'SUSPENDED', 'INACTIVE']) {
      await makeUser('EMPLOYEE', `${status.toLowerCase()}@test.com`, { status });
      const res = await anonymous().post('/api/auth/login', { email: `${status.toLowerCase()}@test.com`, password: PASSWORD });
      expect(res.status).toBe(403);
    }
  });

  it('requires CSRF headers on state-changing requests', async () => {
    const { client } = await makeEmployee();
    // Missing X-Requested-With
    const raw = await client!.agent.post('/api/notifications/read-all').set('X-CSRF-Token', client!.csrf);
    expect(raw.status).toBe(403);
    // Wrong CSRF token
    const bad = await client!.agent.post('/api/notifications/read-all').set('X-Requested-With', 'XMLHttpRequest').set('X-CSRF-Token', 'nope');
    expect(bad.status).toBe(403);
    expect(bad.body.error.code).toBe('CSRF_REJECTED');
    await client!.post('/api/notifications/read-all').expect(200);
  });

  it('password reset link is single-use and revokes existing sessions', async () => {
    const { client } = await makeEmployee({ email: 'reset@test.com' });
    await anonymous().post('/api/auth/password/forgot', { email: 'reset@test.com' }).expect(200);
    // same response for unknown email
    const unknown = await anonymous().post('/api/auth/password/forgot', { email: 'ghost@test.com' });
    expect(unknown.status).toBe(200);
    await drainOutbox();
    const mail = fakeEmail.to('reset@test.com')[0];
    const token = linkFrom(mail, '/reset-password');
    await anonymous().post('/api/auth/password/reset', { token, password: 'NewPassword456' }).expect(200);
    const again = await anonymous().post('/api/auth/password/reset', { token, password: 'AnotherPass789' });
    expect(again.status).toBe(400);
    await client!.get('/api/auth/me').expect(401); // old session revoked
    await login('reset@test.com', 'NewPassword456');
  });

  it('suspending a user revokes their sessions immediately', async () => {
    const admin = await makeAdmin();
    const { client, employee } = await makeEmployee();
    const res = await admin.client.post(`/api/admin/employees/${employee._id}/status`, { status: 'SUSPENDED', reason: 'Policy violation' });
    expect(res.status).toBe(200);
    await client!.get('/api/auth/me').expect(401);
  });
});

describe('role-based and resource-level authorization', () => {
  it('blocks employees and drivers from admin and operations APIs', async () => {
    const { client: emp } = await makeEmployee();
    const { client: drv } = await makeDriver();
    for (const c of [emp!, drv]) {
      await c.get('/api/admin/employees').expect(403);
      await c.get('/api/ops/bookings').expect(403);
    }
    await emp!.get('/api/driver/home').expect(403);
    await drv.get('/api/me/bookings').expect(403);
  });

  it('coordinators cannot use admin-only APIs', async () => {
    const { client } = await makeCoordinator();
    await client.get('/api/admin/employees').expect(403);
    await client.put('/api/admin/policy', { booking: { maxDaysAhead: 30 } }).expect(403);
    await client.get('/api/admin/audit').expect(403);
  });

  it('unauthenticated requests are rejected', async () => {
    await request(app).get('/api/me/bookings').expect(401);
    await request(app).get('/api/admin/dashboard').expect(401);
  });

  it('a client-supplied role is ignored', async () => {
    const { client, user } = await makeEmployee();
    await client!.patch('/api/admin/employees/' + user._id, { role: 'ADMIN' }).expect(403);
    expect((await User.findById(user._id))!.role).toBe('EMPLOYEE');
  });
});
