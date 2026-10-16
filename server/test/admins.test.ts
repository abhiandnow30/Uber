import { describe, expect, it } from 'vitest';
import { AuditLog, Session } from '../src/models/system.js';
import { User } from '../src/models/User.js';
import { CabAssignment } from '../src/models/booking.js';
import { Coordinator } from '../src/models/Coordinator.js';
import { assign, drainOutbox, fakeEmail, makeAdmin, makeCoordinator, makeUser, scenario } from './helpers.js';

describe('admin management', () => {
  it('admins see every admin with counts, can search, and add a new admin who is invited by email', async () => {
    const { client } = await makeAdmin('first.admin@test.com');
    await makeUser('ADMIN', 'second.admin@test.com', { name: 'Second Admin' });

    let list = await client.get('/api/admin/admins').expect(200);
    expect(list.body.summary).toMatchObject({ total: 2, active: 2 });
    expect(list.body.items[0]).not.toHaveProperty('passwordHash');

    // phone is required, and must look like a phone number
    expect((await client.post('/api/admin/admins', { fullName: 'New Admin', email: 'new.admin@test.com', phone: '' })).status).toBe(422);
    expect((await client.post('/api/admin/admins', { fullName: 'New Admin', email: 'new.admin@test.com', phone: 'call me' })).status).toBe(422);

    const created = await client.post('/api/admin/admins', { fullName: 'New Admin', email: 'New.Admin@test.com', phone: '+91 90000 30003' });
    expect(created.status).toBe(201);
    expect(await User.findOne({ email: 'new.admin@test.com' }).lean()).toMatchObject({ role: 'ADMIN', status: 'INVITED', phone: '+91 90000 30003' });
    await drainOutbox();
    expect(fakeEmail.to('new.admin@test.com')).toHaveLength(1);
    expect(await AuditLog.exists({ action: 'ADMIN_CREATED' })).toBeTruthy();
    expect((await client.post('/api/admin/admins', { fullName: 'Dup', email: 'new.admin@test.com', phone: '9000030004' })).status).toBe(409);

    list = await client.get('/api/admin/admins?q=second').expect(200);
    expect(list.body.items.map((a: { email: string }) => a.email)).toEqual(['second.admin@test.com']);
    list = await client.get('/api/admin/admins').expect(200);
    expect(list.body.summary).toMatchObject({ total: 3, active: 2, invited: 1 });
  });

  it('suspend, deactivate and reactivate other admins; never yourself or the last active admin', async () => {
    const me = await makeAdmin('me.admin@test.com');
    const other = await makeUser('ADMIN', 'other.admin@test.com');

    // not yourself
    expect((await me.client.post(`/api/admin/admins/${me.user._id}/status`, { status: 'INACTIVE', reason: 'Testing' })).status).toBe(400);

    // another admin: suspend (signed out) then reactivate
    await Session.create({ user: other._id, tokenHash: 'x'.repeat(64), csrfToken: 'c', expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() });
    await me.client.post(`/api/admin/admins/${other._id}/status`, { status: 'SUSPENDED', reason: 'Left the team' }).expect(200);
    expect((await User.findById(other._id))!.status).toBe('SUSPENDED');
    expect(await Session.exists({ user: other._id, revokedAt: null })).toBeNull();
    await me.client.post(`/api/admin/admins/${other._id}/status`, { status: 'ACTIVE' }).expect(200);

    // deactivating needs a reason
    expect((await me.client.post(`/api/admin/admins/${other._id}/status`, { status: 'INACTIVE' })).status).toBe(400);
    await me.client.post(`/api/admin/admins/${other._id}/status`, { status: 'INACTIVE', reason: 'Role changed' }).expect(200);
    expect(await AuditLog.countDocuments({ action: 'ACCOUNT_STATUS_CHANGED', entityId: other._id })).toBe(3);

    // now "me" is the only active admin: another admin can't remove them either
    const second = await makeAdmin('second.me@test.com');
    await me.client.post(`/api/admin/admins/${second.user._id}/status`, { status: 'INACTIVE', reason: 'Temporary account' }).expect(200);
    const last = await second.client.post(`/api/admin/admins/${me.user._id}/status`, { status: 'SUSPENDED', reason: 'x' });
    expect(last.status).toBe(401); // second was just deactivated and signed out
    await me.client.post(`/api/admin/admins/${second.user._id}/status`, { status: 'ACTIVE' }).expect(200);
    const third = await makeAdmin('third.me@test.com');
    await third.client.post(`/api/admin/admins/${second.user._id}/status`, { status: 'INACTIVE', reason: 'Done' }).expect(200);
    await third.client.post(`/api/admin/admins/${third.user._id}/status`, { status: 'INACTIVE', reason: 'x' }).expect(400); // self
  });

  it('the last active admin cannot be suspended or deactivated', async () => {
    const only = await makeAdmin('only.admin@test.com');
    const helper = await makeUser('ADMIN', 'helper.admin@test.com', { status: 'SUSPENDED' });
    // "only" acts on themselves is blocked as self; check the rule through a suspended peer becoming active then acting
    await only.client.post(`/api/admin/admins/${helper._id}/status`, { status: 'ACTIVE' }).expect(200);
    await only.client.post(`/api/admin/admins/${helper._id}/status`, { status: 'SUSPENDED', reason: 'Back to suspended' }).expect(200);
    // only one active admin left: the service refuses to take them out, whoever asks
    const { setAccountStatus } = await import('../src/services/account.service.js');
    await expect(setAccountStatus({ id: String(helper._id), role: 'ADMIN' }, String(only.user._id), 'INACTIVE', 'x')).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    expect((await User.findById(only.user._id))!.status).toBe('ACTIVE');
  });

  it('invited admins can be sent a new invitation; non-admins cannot manage admins', async () => {
    const { client } = await makeAdmin();
    const created = await client.post('/api/admin/admins', { fullName: 'Invitee', email: 'invitee@test.com', phone: '9000030005' }).expect(201);
    await client.post(`/api/admin/admins/${created.body._id}/invitation`).expect(200);
    await drainOutbox();
    expect(fakeEmail.to('invitee@test.com')).toHaveLength(2);

    const coord = await makeCoordinator(['HYD']);
    expect((await coord.client.get('/api/admin/admins')).status).toBe(403);
    expect((await coord.client.post('/api/admin/admins', { fullName: 'X', email: 'x@test.com', phone: '9000030006' })).status).toBe(403);
    // a coordinator's id is not an admin id
    expect((await client.post(`/api/admin/admins/${coord.user._id}/status`, { status: 'SUSPENDED', reason: 'x' })).status).toBe(404);
  });
});

describe('coordinator phone number', () => {
  it('is required when adding or editing a coordinator', async () => {
    const { client } = await makeAdmin();
    const base = { fullName: 'Chetan Coordinator', email: 'chetan@test.com', officeLocations: ['HYD'] };
    expect((await client.post('/api/admin/coordinators', base)).status).toBe(422);
    expect((await client.post('/api/admin/coordinators', { ...base, phone: '' })).status).toBe(422);
    expect((await client.post('/api/admin/coordinators', { ...base, phone: 'abc' })).status).toBe(422);
    const c = await client.post('/api/admin/coordinators', { ...base, phone: '+91 90000 40004' }).expect(201);
    expect((await client.patch(`/api/admin/coordinators/${c.body._id}`, { phone: '' })).status).toBe(422);
    await client.patch(`/api/admin/coordinators/${c.body._id}`, { phone: '9000040005' }).expect(200);
  });
});

describe('deleting a coordinator', () => {
  it('a coordinator with no activity is removed completely', async () => {
    const { client } = await makeAdmin();
    const c = await client.post('/api/admin/coordinators', { fullName: 'Short Stay', email: 'short.stay@test.com', phone: '9000070007', officeLocations: ['HYD'] }).expect(201);
    const res = await client.post(`/api/admin/coordinators/${c.body._id}/delete`, {}).expect(200);
    expect(res.body).toEqual({ permanent: true });
    expect(await User.exists({ email: 'short.stay@test.com' })).toBeNull();
    const list = await client.get('/api/admin/coordinators').expect(200);
    expect(list.body.items.map((x: { email: string }) => x.email)).not.toContain('short.stay@test.com');
    expect(await AuditLog.exists({ action: 'COORDINATOR_DELETED' })).toBeTruthy();
  });

  it('a coordinator who assigned rides keeps their name on history but loses access and offices', async () => {
    const s = await scenario();
    await assign(s.coord.client, s.bookingId, s.drv).expect(201);
    const admin = await makeAdmin();
    const coordDoc = await Coordinator.findOne({ user: s.coord.user._id }).lean();
    const res = await admin.client.post(`/api/admin/coordinators/${coordDoc!._id}/delete`, {}).expect(200);
    expect(res.body).toEqual({ permanent: false });
    const after = await Coordinator.findById(coordDoc!._id).lean();
    expect(after!.deletedAt).toBeInstanceOf(Date);
    expect(after!.officeLocations).toEqual([]);
    expect(after).not.toHaveProperty('phone');
    expect((await User.findById(s.coord.user._id))!.status).toBe('INACTIVE');
    expect((await s.coord.client.get('/api/auth/me')).status).toBe(401); // signed out
    await admin.client.get(`/api/admin/coordinators/${coordDoc!._id}`).expect(404);
    await admin.client.post(`/api/admin/coordinators/${coordDoc!._id}/delete`, {}).expect(404);
    expect((await CabAssignment.findOne({ booking: s.bookingId }).lean())!.assignedBy.toString()).toBe(String(s.coord.user._id));
  });

  it('only admins can delete coordinators', async () => {
    const other = await makeCoordinator(['HYD']);
    const target = await makeCoordinator(['HYD']);
    const doc = await Coordinator.findOne({ user: target.user._id }).lean();
    expect((await other.client.post(`/api/admin/coordinators/${doc!._id}/delete`, {})).status).toBe(403);
  });
});
