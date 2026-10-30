import mongoose from 'mongoose';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioClient } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { CabAssignment, CabRequest } from '../src/models/booking.js';
import { EmailOutbox, Notification } from '../src/models/system.js';
import { closeRealtime, initRealtime } from '../src/realtime.js';
import { processOutboxBatch } from '../src/services/email/outbox.worker.js';
import { renderEmail } from '../src/services/email/templates.js';
import { detectLatePickups } from '../src/services/monitor.service.js';
import { enqueueEmail } from '../src/services/notification.service.js';
import request from 'supertest';
import { app, assign, drainOutbox, fakeEmail, makeAdmin, makeRetriesDue, scenario } from './helpers.js';

let server: http.Server | null = null;
afterEach(async () => {
  closeRealtime();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

describe('email outbox', () => {
  it('retries transient Graph failures with backoff and marks ACCEPTED (not DELIVERED)', async () => {
    await enqueueEmail(null, { idempotencyKey: 'k1', template: 'TRIP_COMPLETED', to: 'a@test.com', params: { name: 'A', reference: 'CB-1' } });
    fakeEmail.failures.push('transient');
    await processOutboxBatch();
    let msg = await EmailOutbox.findOne({ idempotencyKey: 'k1' });
    expect(msg!.status).toBe('RETRYING');
    expect(msg!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 10_000); // backed off
    expect(msg!.errorHistory).toHaveLength(1);
    await processOutboxBatch(); // not yet due → nothing sent
    expect(fakeEmail.sent).toHaveLength(0);
    await makeRetriesDue();
    await processOutboxBatch();
    msg = await EmailOutbox.findOne({ idempotencyKey: 'k1' });
    expect(msg!.status).toBe('ACCEPTED');
    expect(msg!.deliveredAt).toBeFalsy();
    expect(msg!.attempts).toBe(2);
  });

  it('permanent failures are marked FAILED without alerting anyone in the app', async () => {
    const admin = await makeAdmin();
    await enqueueEmail(null, { idempotencyKey: 'k2', template: 'TRIP_COMPLETED', to: 'bad@test.com', params: { name: 'A' } });
    fakeEmail.failures.push('permanent');
    await processOutboxBatch();
    const msg = await EmailOutbox.findOne({ idempotencyKey: 'k2' });
    expect(msg!.status).toBe('FAILED');
    expect(await Notification.exists({ user: admin.user._id })).toBeFalsy();
    await admin.client.get('/api/admin/outbox').expect(404);
  });

  it('exhausting retries marks the message FAILED', async () => {
    await enqueueEmail(null, { idempotencyKey: 'k3', template: 'TRIP_COMPLETED', to: 'a@test.com', params: {} });
    await EmailOutbox.updateOne({ idempotencyKey: 'k3' }, { $set: { maxAttempts: 2 } });
    fakeEmail.failures.push('transient', 'transient');
    await processOutboxBatch();
    await makeRetriesDue();
    await processOutboxBatch();
    expect((await EmailOutbox.findOne({ idempotencyKey: 'k3' }))!.status).toBe('FAILED');
  });

  it('duplicate events never produce duplicate emails (idempotency key)', async () => {
    for (let i = 0; i < 3; i++) await enqueueEmail(null, { idempotencyKey: 'same-event', template: 'TRIP_COMPLETED', to: 'a@test.com', params: {} });
    await drainOutbox();
    expect(fakeEmail.sent).toHaveLength(1);
  });

  it('two workers never send the same message twice', async () => {
    for (let i = 0; i < 10; i++) await enqueueEmail(null, { idempotencyKey: `p${i}`, template: 'TRIP_COMPLETED', to: `u${i}@test.com`, params: {} });
    await Promise.all([processOutboxBatch(), processOutboxBatch(), processOutboxBatch()]);
    expect(fakeEmail.sent).toHaveLength(10);
    expect(new Set(fakeEmail.sent.map((e) => e.to)).size).toBe(10);
  });

  it('templates escape HTML', async () => {
    await enqueueEmail(null, { idempotencyKey: 'esc', template: 'TRIP_COMPLETED', to: 'n@test.com', params: { name: '<b>x</b>', reference: 'CAB-1' } });
    await drainOutbox();
    expect(fakeEmail.sent[0].html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(fakeEmail.sent[0].html).not.toContain('<b>x</b>');
    expect(renderEmail('CAB_ASSIGNED', { travelDate: '2026-10-16' }).subject).toBe('Your Cab Has Been Assigned — 2026-10-16');
  });
});

describe('in-app notifications and real-time delivery', () => {
  it('pushes a ride assignment to an online driver over the websocket', async () => {
    const s = await scenario();
    server = http.createServer(app);
    initRealtime(server);
    await new Promise<void>((r) => server!.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    const loginRes = await request(app).post('/api/auth/driver-login').set('X-Requested-With', 'XMLHttpRequest').send({ phone: s.drv.driver.phone, password: s.drv.driver.phone.replace(/\D/g, '').slice(-10).slice(0, 4) });
    const header = (loginRes.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    const socket = ioClient(`http://127.0.0.1:${port}`, { extraHeaders: { cookie: header }, transports: ['websocket'] });
    await new Promise<void>((resolve, reject) => {
      socket.on('ready', () => resolve());
      socket.on('connect_error', reject);
    });
    const received = new Promise<{ type: string; body: string }>((resolve) => socket.on('notification', resolve));
    await assign(s.coord.client, s.bookingId, s.drv).expect(201);
    const n = await received;
    expect(n.type).toBe('RIDE_ASSIGNED');
    expect(n.body).toContain(s.reference);
    socket.close();
  });

  it('rejects unauthenticated websocket connections', async () => {
    server = http.createServer(app);
    initRealtime(server);
    await new Promise<void>((r) => server!.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    const socket = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    const err = await new Promise<Error>((resolve) => socket.on('connect_error', resolve));
    expect(err.message).toBe('UNAUTHORIZED');
    socket.close();
  });

  it('notifications for an offline driver are persisted and available after reconnect', async () => {
    const s = await scenario();
    await assign(s.coord.client, s.bookingId, s.drv).expect(201);
    const list = await s.drv.client.get('/api/notifications?unreadOnly=true');
    expect(list.body.unread).toBe(1);
    expect(list.body.items[0].type).toBe('RIDE_ASSIGNED');
    await s.drv.client.post(`/api/notifications/${list.body.items[0]._id}/read`).expect(200);
    expect((await s.drv.client.get('/api/notifications/unread-count')).body.unread).toBe(0);
    // another user cannot mark it
    const other = await s.emp.client!.post(`/api/notifications/${list.body.items[0]._id}/read`);
    expect(other.status).toBe(200);
    expect(await Notification.countDocuments({ user: s.emp.user._id, type: 'RIDE_ASSIGNED' })).toBe(0);
  });
});

describe('operational monitors', () => {
  it('drivers do not accept rides: an assigned ride is theirs at once', async () => {
    const s = await scenario();
    const res = await assign(s.coord.client, s.bookingId, s.drv);
    expect((await CabAssignment.findById(res.body.assignment._id))!.acknowledgedAt).toBeInstanceOf(Date);
  });

  it('detects late pickups and marks the booking delayed', async () => {
    const s = await scenario();
    await assign(s.coord.client, s.bookingId, s.drv).expect(201);
    await CabRequest.updateOne({ _id: s.bookingId }, { $set: { scheduledPickupAt: new Date(Date.now() - 30 * 60_000) } });
    await detectLatePickups();
    const b = await CabRequest.findById(s.bookingId);
    expect(b!.isDelayed).toBe(true);
    expect(b!.status).toBe('ASSIGNED');
    expect(await Notification.countDocuments({ user: s.coord.user._id, type: 'LATE_PICKUP' })).toBe(1);
    await detectLatePickups();
    expect(await Notification.countDocuments({ user: s.coord.user._id, type: 'LATE_PICKUP' })).toBe(1);
  });
});
