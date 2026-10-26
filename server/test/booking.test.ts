import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CabRequest } from '../src/models/booking.js';
import { Policy } from '../src/models/Policy.js';
import { findOfficeMismatches } from '../src/scripts/check-office-mismatch.js';
import { getPolicy, invalidatePolicyCache } from '../src/services/policy.service.js';
import { bookingInput, futureDate, makeAdmin, makeCoordinator, makeEmployee } from './helpers.js';

describe('employee cab requests', () => {
  it('creates a booking with a reference, REQUESTED status and UTC pickup time', async () => {
    const { client } = await makeEmployee();
    const res = await client!.post('/api/me/bookings', bookingInput({ pickupTime: '09:30' }));
    expect(res.status).toBe(201);
    expect(res.body.booking.reference).toMatch(/^CB-\d{6}-\d{4}$/);
    expect(res.body.booking.status).toBe('REQUESTED');
    // 09:30 IST = 04:00 UTC
    expect(new Date(res.body.booking.scheduledPickupAt).toISOString()).toMatch(/T04:00:00/);
  });

  it('is idempotent: re-sending the same submission does not create a second booking', async () => {
    const { client } = await makeEmployee();
    const input = bookingInput();
    const a = await client!.post('/api/me/bookings', input);
    const b = await client!.post('/api/me/bookings', input);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.duplicate).toBe(true);
    expect(b.body.booking._id).toBe(a.body.booking._id);
    // concurrent double-click
    const input2 = bookingInput({ travelDate: futureDate(2), pickupTime: '18:00' });
    const [c, d] = await Promise.all([client!.post('/api/me/bookings', input2), client!.post('/api/me/bookings', input2)]);
    expect([c.status, d.status].sort()).toEqual([200, 201]);
    expect(await CabRequest.countDocuments()).toBe(2);
  });

  it('allows one cab per day: a second request that day is rejected at any time', async () => {
    const { client } = await makeEmployee();
    await client!.post('/api/me/bookings', bookingInput()).expect(201);
    for (const pickupTime of ['09:00', '21:00']) {
      const dup = await client!.post('/api/me/bookings', bookingInput({ pickupTime }));
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('SHIFT_DAY_BOOKED');
    }
    // the next day is fine
    await client!.post('/api/me/bookings', bookingInput({ travelDate: futureDate(2) })).expect(201);
  });

  it('a completed ride still uses up the day; a rejected one frees it', async () => {
    const { client } = await makeEmployee();
    const coord = await makeCoordinator(['HYD']);
    const first = await client!.post('/api/me/bookings', bookingInput()).expect(201);
    await CabRequest.updateOne({ _id: first.body.booking._id }, { $set: { status: 'COMPLETED' }, $unset: { openSlotKey: 1 } });
    expect((await client!.post('/api/me/bookings', bookingInput({ pickupTime: '20:00' }))).body.error.code).toBe('SHIFT_DAY_BOOKED');

    const next = await client!.post('/api/me/bookings', bookingInput({ travelDate: futureDate(2) })).expect(201);
    await coord.client.post(`/api/ops/bookings/${next.body.booking._id}/reject`, { reason: 'No cab available' }).expect(200);
    await client!.post('/api/me/bookings', bookingInput({ travelDate: futureDate(2) })).expect(201);
  });

  it('the home page says whether the current work day already has a cab', async () => {
    const { client, user } = await makeEmployee();
    const res = await client!.post('/api/me/bookings', bookingInput()).expect(201);
    expect((await client!.get('/api/me/home')).body.bookedToday).toBe(false);
    // move that booking onto today's work day
    await CabRequest.updateOne({ _id: res.body.booking._id }, { $set: { shiftDayKey: `${user._id}:${futureDate(0)}:OUTBOUND` } });
    expect((await client!.get('/api/me/home')).body.bookedToday).toBe(true);
    await client!.post(`/api/me/bookings/${res.body.booking._id}/cancel`, { reason: 'Plans changed' }).expect(200);
    expect((await client!.get('/api/me/home')).body.bookedToday).toBe(false);
  });

  it('two different requests for the same day sent at once: only one is created', async () => {
    const { client } = await makeEmployee();
    const [a, b] = await Promise.all([
      client!.post('/api/me/bookings', bookingInput({ pickupTime: '08:00' })),
      client!.post('/api/me/bookings', bookingInput({ pickupTime: '19:00' })),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await CabRequest.countDocuments()).toBe(1);
  });

  it('rejects invalid dates, past times, cut-off violations and too-far bookings', async () => {
    const { client } = await makeEmployee();
    expect((await client!.post('/api/me/bookings', bookingInput({ travelDate: '2026-13-45' }))).status).toBe(422);
    expect((await client!.post('/api/me/bookings', bookingInput({ pickupTime: '25:00' }))).status).toBe(422);
    const past = await client!.post('/api/me/bookings', bookingInput({ travelDate: futureDate(-1) }));
    expect(past.status).toBe(422);
    expect(past.body.error.code).toBe('BOOKING_CUTOFF');
    const far = await client!.post('/api/me/bookings', bookingInput({ travelDate: futureDate(60) }));
    expect(far.body.error.code).toBe('BOOKING_WINDOW');
    const tooMany = await client!.post('/api/me/bookings', bookingInput({ passengers: 9 }));
    expect(tooMany.body.error.code).toBe('PASSENGER_LIMIT');
    expect(await CabRequest.countDocuments()).toBe(0);
  });

  it('applies the configurable daily cut-off time', async () => {
    const { client } = await makeEmployee();
    await getPolicy();
    await Policy.updateOne({ key: 'global' }, { $set: { 'booking.dailyCutoffTime': '00:00' } });
    invalidatePolicyCache();
    const res = await client!.post('/api/me/bookings', bookingInput({ travelDate: futureDate(1) }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BOOKING_CUTOFF');
  });

  it('employees cannot view or cancel other employees bookings (IDOR)', async () => {
    const a = await makeEmployee();
    const b = await makeEmployee();
    const res = await a.client!.post('/api/me/bookings', bookingInput()).expect(201);
    const id = res.body.booking._id;
    await b.client!.get(`/api/me/bookings/${id}`).expect(404);
    await b.client!.post(`/api/me/bookings/${id}/cancel`, { reason: 'not mine' }).expect(404);
    const list = await b.client!.get('/api/me/bookings');
    expect(list.body.total).toBe(0);
  });

  it('requires approval when the policy says so', async () => {
    const { client: admin } = await makeAdmin();
    await admin.put('/api/admin/policy', { booking: { approvalRequired: true } }).expect(200);
    const emp = await makeEmployee();
    const coord = await makeCoordinator(['HYD']);
    const res = await emp.client!.post('/api/me/bookings', bookingInput()).expect(201);
    expect(res.body.booking.status).toBe('PENDING_APPROVAL');
    await coord.client.post(`/api/ops/bookings/${res.body.booking._id}/approve`).expect(200);
    expect((await CabRequest.findById(res.body.booking._id))!.status).toBe('APPROVED');
  });

  it('employee can cancel before assignment; cancelled bookings cannot be cancelled again', async () => {
    const { client } = await makeEmployee();
    const res = await client!.post('/api/me/bookings', bookingInput()).expect(201);
    await client!.post(`/api/me/bookings/${res.body.booking._id}/cancel`, { reason: 'Plans changed' }).expect(200);
    const again = await client!.post(`/api/me/bookings/${res.body.booking._id}/cancel`, { reason: 'again' });
    expect(again.status).toBe(422);
    // the slot is free again
    await client!.post('/api/me/bookings', bookingInput()).expect(201);
  });
});

describe('coordinator booking view', () => {
  it('coordinator sees requests for their offices only', async () => {
    const hyd = await makeCoordinator(['HYD']);
    const blrCoord = await makeCoordinator(['BLR']);
    const emp = await makeEmployee({ office: 'HYD' });
    const res = await emp.client!.post('/api/me/bookings', bookingInput()).expect(201);
    const list = await hyd.client.get(`/api/ops/bookings?date=${res.body.booking.travelDate}`);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].employee.fullName).toBeTruthy();
    const other = await blrCoord.client.get('/api/ops/bookings');
    expect(other.body.total).toBe(0);
    await blrCoord.client.get(`/api/ops/bookings/${res.body.booking._id}`).expect(403);
    await blrCoord.client.get('/api/ops/bookings?officeLocation=HYD').expect(403);
  });

  it('an employee can only book for their own office, so other offices never handle them', async () => {
    const blrCoord = await makeCoordinator(['BLR']);
    const emp = await makeEmployee({ office: 'HYD' });
    const wrong = await emp.client!.post('/api/me/bookings', bookingInput({ officeLocation: 'BLR' }));
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('OFFICE_MISMATCH');
    const ok = await emp.client!.post('/api/me/bookings', bookingInput({ clientRequestId: crypto.randomUUID() })).expect(201);
    expect(ok.body.booking.officeLocation).toBe('HYD');
    expect((await blrCoord.client.get('/api/ops/bookings')).body.total).toBe(0);
    await blrCoord.client.post(`/api/ops/bookings/${ok.body.booking._id}/assign`, { driverId: ok.body.booking._id, vehicleId: ok.body.booking._id }).expect(403);
  });

  it('the pre-deploy check finds bookings whose office differs from the employee office', async () => {
    const emp = await makeEmployee({ office: 'HYD' });
    const res = await emp.client!.post('/api/me/bookings', bookingInput()).expect(201);
    expect(await findOfficeMismatches()).toHaveLength(0);
    await CabRequest.updateOne({ _id: res.body.booking._id }, { $set: { officeLocation: 'BLR' } });
    const rows = await findOfficeMismatches();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reference: res.body.booking.reference, bookingOffice: 'BLR', employeeOffice: 'HYD' });
  });

  it('supports filtering, search and pagination', async () => {
    const coord = await makeCoordinator(['HYD']);
    const emp = await makeEmployee();
    for (const d of [1, 2, 3]) await emp.client!.post('/api/me/bookings', bookingInput({ travelDate: futureDate(d) })).expect(201);
    const page = await coord.client.get('/api/ops/bookings?pageSize=2&page=2');
    expect(page.body.total).toBe(3);
    expect(page.body.items).toHaveLength(1);
    const filtered = await coord.client.get('/api/ops/bookings?status=REQUESTED&q=gachibowli');
    expect(filtered.body.total).toBe(3);
  });
});
