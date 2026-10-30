import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { Session } from '../src/models/system.js';
import { User } from '../src/models/User.js';
import { anonymous, app, makeAdmin, makeCoordinator, makeDriver, makeEmployee, makeUser } from './helpers.js';

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

  it('has no email + password sign-in, activation or password reset endpoints', async () => {
    await makeUser('ADMIN', 'pw.admin@test.com');
    const anon = anonymous();
    expect((await anon.post('/api/auth/login', { email: 'pw.admin@test.com', password: 'Password123!' })).status).toBe(404);
    expect((await anon.post('/api/auth/password/forgot', { email: 'pw.admin@test.com' })).status).toBe(404);
    expect((await anon.post('/api/auth/password/reset', { token: 'x'.repeat(20), password: 'Password123!' })).status).toBe(404);
    expect((await anon.post('/api/auth/activate', { token: 'x'.repeat(20), password: 'Password123!' })).status).toBe(404);
    expect((await anon.get('/api/auth/activation/inspect?token=abc')).status).toBe(404);
    const { client } = await makeEmployee();
    expect((await client!.post('/api/auth/password/change', { currentPassword: 'a', newPassword: 'b' })).status).toBe(404);
    expect(await Session.countDocuments({ user: (await User.findOne({ email: 'pw.admin@test.com' }))!._id })).toBe(0);
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
