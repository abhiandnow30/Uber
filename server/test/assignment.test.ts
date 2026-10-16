import { describe, expect, it } from 'vitest';
import { CabAssignment, CabRequest, RideStartCredential } from '../src/models/booking.js';
import { EmailOutbox, Notification } from '../src/models/system.js';
import { Vehicle } from '../src/models/Vehicle.js';
import { assign, bookingInput, drainOutbox, employeePin, fakeEmail, makeCoordinator, makeDriver, makeEmployee, makeRetriesDue, scenario } from './helpers.js';

describe('cab assignment', () => {
  it('assigns an eligible driver + vehicle, creates a PIN, emails the employee and notifies the driver', async () => {
    const { coord, emp, drv, bookingId, reference } = await scenario();
    const res = await assign(coord.client, bookingId, drv);
    expect(res.status).toBe(201);

    const booking = await CabRequest.findById(bookingId);
    expect(booking!.status).toBe('ASSIGNED');
    const cred = await RideStartCredential.findOne({ booking: bookingId }).select('+pinHash +pinCipher').lean();
    expect(cred!.status).toBe('ACTIVE');
    expect(cred!.pinHash).toMatch(/^[a-f0-9]{64}$/);

    // Employee sees PIN in authenticated booking details
    const pin = await employeePin(emp.client!, bookingId);
    expect(pin).toMatch(/^\d{4}$/);
    expect(JSON.stringify(cred)).not.toContain(`"${pin}"`); // never stored in plaintext

    // Outlook email via outbox with the specified content, and no PIN
    await drainOutbox();
    const mail = fakeEmail.sent.find((m) => m.subject.startsWith('Your Cab Has Been Assigned'));
    expect(mail).toBeTruthy();
    expect(mail!.to).toBe(emp.user.email);
    expect(mail!.text).toContain(`Booking Reference: ${reference}`);
    expect(mail!.text).toContain(`Vehicle Number: ${drv.vehicle.registrationNumber}`);
    expect(mail!.text).toContain('Driver Contact:');
    expect(mail!.text).toContain('Transport Coordination Team');
    expect(mail!.text).not.toContain(pin);
    expect((await EmailOutbox.findOne({ template: 'CAB_ASSIGNED' }))!.status).toBe('ACCEPTED');

    // Driver in-app notification without the PIN
    const n = await Notification.findOne({ user: drv.user._id, type: 'RIDE_ASSIGNED' }).lean();
    expect(n).toBeTruthy();
    expect(JSON.stringify(n)).not.toContain(pin);
    const driverView = await drv.client.get('/api/driver/home');
    expect(JSON.stringify(driverView.body)).not.toContain(pin);
    expect(driverView.body.today.length + driverView.body.upcoming.length).toBe(1);
  });

  it('prevents double-booking the same driver or vehicle for overlapping trips', async () => {
    const coord = await makeCoordinator(['HYD']);
    const drv = await makeDriver();
    const e1 = await makeEmployee();
    const e2 = await makeEmployee();
    const b1 = await e1.client!.post('/api/me/bookings', bookingInput({ pickupTime: '09:00' }));
    const b2 = await e2.client!.post('/api/me/bookings', bookingInput({ pickupTime: '09:30' }));
    await assign(coord.client, b1.body.booking._id, drv).expect(201);
    const clash = await assign(coord.client, b2.body.booking._id, drv);
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('SCHEDULE_CONFLICT');
    // Same vehicle with a different driver also conflicts
    const drv2 = await makeDriver();
    const clash2 = await assign(coord.client, b2.body.booking._id, { driver: drv2.driver, vehicle: drv.vehicle });
    expect(clash2.status).toBe(409);
    // A non-overlapping trip later the same day is fine
    const b3 = await e2.client!.post('/api/me/bookings', bookingInput({ pickupTime: '18:00' }));
    await assign(coord.client, b3.body.booking._id, drv).expect(201);
  });

  it('simultaneous assignments cannot reserve the same driver for conflicting trips', async () => {
    const coord = await makeCoordinator(['HYD']);
    const coord2 = await makeCoordinator(['HYD']);
    const drv = await makeDriver();
    const bookings = [];
    for (let i = 0; i < 4; i++) {
      const e = await makeEmployee();
      const r = await e.client!.post('/api/me/bookings', bookingInput({ pickupTime: `09:${10 + i}` }));
      bookings.push(r.body.booking._id);
    }
    const results = await Promise.all(bookings.map((id, i) => assign(i % 2 ? coord.client : coord2.client, id, drv)));
    const ok = results.filter((r) => r.status === 201);
    expect(ok).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect(await CabAssignment.countDocuments({ driver: drv.driver._id, status: 'ACTIVE' })).toBe(1);
  });

  it('two coordinators assigning the same booking at once produce a single assignment', async () => {
    const { coord, bookingId, drv } = await scenario();
    const drv2 = await makeDriver();
    const [a, b] = await Promise.all([assign(coord.client, bookingId, drv), assign(coord.client, bookingId, drv2)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await CabAssignment.countDocuments({ booking: bookingId })).toBe(1);
  });

  it('is idempotent with an Idempotency-Key header', async () => {
    const { coord, bookingId, drv } = await scenario();
    const body = { driverId: String(drv.driver._id), vehicleId: String(drv.vehicle._id) };
    const a = await coord.client.post(`/api/ops/bookings/${bookingId}/assign`, body).set('Idempotency-Key', 'k-123');
    const b = await coord.client.post(`/api/ops/bookings/${bookingId}/assign`, body).set('Idempotency-Key', 'k-123');
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.duplicate).toBe(true);
    expect(await CabAssignment.countDocuments()).toBe(1);
  });

  it('rejects ineligible drivers and vehicles', async () => {
    const { coord, bookingId } = await scenario();
    const unverified = await makeDriver({ verified: false });
    const r1 = await assign(coord.client, bookingId, unverified);
    expect(r1.status).toBe(422);
    expect(r1.body.error.message).toMatch(/not verified/);
    const small = await makeDriver({ capacity: 1 });
    await CabRequest.updateOne({ _id: bookingId }, { $set: { passengers: 3 } });
    expect((await assign(coord.client, bookingId, small)).status).toBe(422);
    const maint = await makeDriver();
    await Vehicle.updateOne({ _id: maint.vehicle._id }, { $set: { status: 'MAINTENANCE' } });
    const r3 = await assign(coord.client, bookingId, maint);
    expect(r3.status).toBe(422);
    expect(r3.body.error.message).toMatch(/maintenance/);
    const eligible = await coord.client.get(`/api/ops/bookings/${bookingId}/eligible`);
    expect(eligible.body.drivers.find((d: { _id: string }) => d._id === String(unverified.driver._id)).eligible).toBe(false);
  });

  it('driver decline returns the ride to the queue, raises an exception and notifies coordinators', async () => {
    const { coord, bookingId, drv } = await scenario();
    const res = await assign(coord.client, bookingId, drv);
    const aid = res.body.assignment._id;
    await drv.client.post(`/api/driver/rides/${aid}/decline`, {}).expect(422);
    await drv.client.post(`/api/driver/rides/${aid}/decline`, { reason: 'Vehicle breakdown' }).expect(200);
    const b = await CabRequest.findById(bookingId);
    expect(b!.status).toBe('REQUESTED');
    expect(b!.currentAssignment).toBeFalsy();
    expect((await CabAssignment.findById(aid))!.status).toBe('DECLINED');
    expect((await RideStartCredential.findOne({ assignment: aid }))!.status).toBe('REVOKED');
    expect(await Notification.exists({ type: 'DRIVER_DECLINED' })).toBeTruthy();
    expect(await Notification.exists({ user: coord.user._id, type: 'DRIVER_DECLINED' })).toBeTruthy();
    // coordinator reassigns to another eligible driver → employee gets a "changed" email
    const drv2 = await makeDriver();
    await assign(coord.client, bookingId, drv2).expect(201);
    await drainOutbox();
    expect(fakeEmail.sent.some((m) => m.subject.startsWith('Your Cab Assignment Has Changed'))).toBe(true);
  });

  it('reassignment invalidates the previous PIN and issues a new one', async () => {
    const { coord, emp, bookingId, drv } = await scenario();
    const first = await assign(coord.client, bookingId, drv);
    const oldPin = await employeePin(emp.client!, bookingId);
    const drv2 = await makeDriver();
    const re = await coord.client.post(`/api/ops/bookings/${bookingId}/reassign`, { driverId: String(drv2.driver._id), vehicleId: String(drv2.vehicle._id), reason: 'Driver unwell' });
    expect(re.status).toBe(200);
    expect((await CabAssignment.findById(first.body.assignment._id))!.status).toBe('REASSIGNED');
    expect((await RideStartCredential.findOne({ assignment: first.body.assignment._id }))!.status).toBe('REVOKED');
    expect(await RideStartCredential.countDocuments({ booking: bookingId, status: 'ACTIVE' })).toBe(1);
    const newPin = await employeePin(emp.client!, bookingId);
    expect(newPin).toMatch(/^\d{4}$/);
    // old driver can no longer act on the ride
    await drv.client.post(`/api/driver/rides/${first.body.assignment._id}/acknowledge`).expect(409);
    expect(await Notification.exists({ user: drv.user._id, type: 'RIDE_REASSIGNED' })).toBeTruthy();
    void oldPin;
  });

  it('email failures never duplicate or roll back the assignment; transient failures are retried', async () => {
    const { coord, bookingId, drv } = await scenario();
    fakeEmail.failures.push('transient', 'transient');
    await assign(coord.client, bookingId, drv).expect(201);
    await drainOutbox(); // first attempts fail → RETRYING
    let msg = await EmailOutbox.findOne({ template: 'CAB_ASSIGNED' });
    expect(['RETRYING', 'ACCEPTED']).toContain(msg!.status);
    for (let i = 0; i < 3; i++) {
      await makeRetriesDue();
      await drainOutbox();
    }
    msg = await EmailOutbox.findOne({ template: 'CAB_ASSIGNED' });
    expect(msg!.status).toBe('ACCEPTED');
    expect(msg!.deliveredAt).toBeFalsy(); // accepted ≠ delivered
    expect(await CabAssignment.countDocuments({ booking: bookingId })).toBe(1);
    expect(fakeEmail.sent.filter((m) => m.subject.startsWith('Your Cab Has Been Assigned'))).toHaveLength(1);
  });
});
