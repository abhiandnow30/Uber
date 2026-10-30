import { describe, expect, it } from 'vitest';
import { CabAssignment, CabRequest, RideStartCredential } from '../src/models/booking.js';
import { EmailOutbox, Notification } from '../src/models/system.js';
import { Vehicle } from '../src/models/Vehicle.js';
import { assign, bookingInput, drainOutbox, driverLogin, employeePin, fakeEmail, futureDate, makeCoordinator, makeDriver, makeEmployee, makeRetriesDue, scenario } from './helpers.js';

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
    // A non-overlapping trip later the same day is fine (another employee: one cab per employee per day)
    const e3 = await makeEmployee();
    const b3 = await e3.client!.post('/api/me/bookings', bookingInput({ pickupTime: '18:00' }));
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

  it('a driver the coordinator just added can be assigned before signing in, and sees the ride after signing in', async () => {
    const { coord, bookingId } = await scenario();
    const v = await coord.client.post('/api/ops/vehicles', { registrationNumber: 'TS09NW0001', model: 'Dzire', vehicleType: 'SEDAN', capacity: 4, officeLocation: 'HYD' }).expect(201);
    const d = await coord.client.post('/api/ops/drivers', {
      fullName: 'New Driver', phone: '+91 97777 00001', licenseNumber: 'TSNEW000001', licenseExpiry: new Date(Date.now() + 365 * 86400_000).toISOString(), officeLocation: 'HYD',
    }).expect(201);
    await coord.client.post('/api/ops/links', { driverId: d.body._id, vehicleId: v.body._id }).expect(201);
    const eligible = await coord.client.get(`/api/ops/bookings/${bookingId}/eligible`);
    expect(eligible.body.drivers.find((x: { _id: string }) => x._id === d.body._id)).toMatchObject({ eligible: true, problems: [] });
    await coord.client.post(`/api/ops/bookings/${bookingId}/assign`, { driverId: d.body._id, vehicleId: v.body._id }).expect(201);

    const driver = await driverLogin('97777 00001');
    const home = await driver.get('/api/driver/home').expect(200);
    expect(JSON.stringify(home.body)).toContain(String(bookingId));
  });

  it('several rides share one cab as a named trip; a ride at another time still cannot double-book that cab', async () => {
    const coord = await makeCoordinator(['HYD']);
    const drv = await makeDriver({ capacity: 4 });
    const ride = async (route: string, pickupTime = '22:00') => {
      const e = await makeEmployee();
      await e.employee.updateOne({ $set: { route } });
      return (await e.client!.post('/api/me/bookings', bookingInput({ pickupTime })).expect(201)).body.booking._id as string;
    };
    const ids = [await ride('Kondapur Cab'), await ride('Madhapur Cab')];

    const elig = await coord.client.post('/api/ops/trips/eligible', { bookingIds: ids }).expect(200);
    expect(elig.body).toMatchObject({ seats: 2, suggestedName: 'Kondapur & Madhapur Cab' });
    expect(elig.body.drivers.find((d: { _id: string }) => d._id === String(drv.driver._id)).eligible).toBe(true);

    const trip = await coord.client.post('/api/ops/trips', { bookingIds: ids, driverId: drv.driver._id, vehicleId: drv.vehicle._id }).expect(201);
    expect(trip.body.tripName).toBe('Kondapur & Madhapur Cab');
    expect(await CabRequest.countDocuments({ _id: { $in: ids }, status: 'ASSIGNED' })).toBe(2);
    expect(await CabAssignment.countDocuments({ tripId: trip.body.tripId, status: 'ACTIVE' })).toBe(2);

    const list = await coord.client.get('/api/ops/bookings?status=ASSIGNED&pageSize=100');
    expect(list.body.items.filter((b: { assignment?: { tripName?: string } }) => b.assignment?.tripName === 'Kondapur & Madhapur Cab')).toHaveLength(2);

    await coord.client.patch(`/api/ops/trips/${trip.body.tripId}`, { name: 'Kondapur-Madhapur Night Cab' }).expect(200);
    expect(await CabAssignment.countDocuments({ tripId: trip.body.tripId, tripName: 'Kondapur-Madhapur Night Cab' })).toBe(2);

    // a ride at the same time assigned on its own to that cab shares it (one cab, one trip); the name the coordinator gave stays
    const same = await ride('Miyapur Cab');
    expect((await assign(coord.client, same, drv)).status).toBe(201);
    expect(await CabAssignment.countDocuments({ tripId: trip.body.tripId, status: 'ACTIVE', tripName: 'Kondapur-Madhapur Night Cab' })).toBe(3);

    // a ride at another time that overlaps the trip: the cab is taken
    const other = await ride('Miyapur Cab', '21:30');
    const clash = await assign(coord.client, other, drv);
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('SCHEDULE_CONFLICT');
  });

  it('more riders can join a shared cab already going at that time; a later trip can use the same cab', async () => {
    const coord = await makeCoordinator(['HYD']);
    const drv = await makeDriver({ capacity: 6 });
    const ride = async (route: string, pickupTime: string) => {
      const e = await makeEmployee();
      await e.employee.updateOne({ $set: { route } });
      // Two days ahead: "tomorrow 1 AM" is within the booking notice late in the evening.
      const res = await e.client!.post('/api/me/bookings', bookingInput({ pickupTime, travelDate: futureDate(2) }));
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.booking._id as string;
    };
    const kukatpally = [await ride('Kukatpally Cab', '01:00'), await ride('Kukatpally Cab', '01:00')];
    const first = await coord.client.post('/api/ops/trips', { bookingIds: kukatpally, driverId: drv.driver._id, vehicleId: drv.vehicle._id }).expect(201);

    // same time, other route: the cab is offered to join that trip, not as a clash
    const miyapur = await ride('Miyapur Cab', '01:00');
    const elig = await coord.client.post('/api/ops/trips/eligible', { bookingIds: [miyapur] }).expect(200);
    const cab = elig.body.vehicles.find((v: { _id: string }) => v._id === String(drv.vehicle._id));
    expect(cab.eligible).toBe(false);
    expect(cab.join).toMatchObject({ tripId: first.body.tripId, tripName: 'Kukatpally Cab', riders: 2, seatsUsed: 2 });

    const joined = await coord.client.post('/api/ops/trips', { bookingIds: [miyapur], driverId: drv.driver._id, vehicleId: drv.vehicle._id, joinTripId: first.body.tripId });
    expect(joined.status, JSON.stringify(joined.body)).toBe(201);
    expect(joined.body).toMatchObject({ tripId: first.body.tripId, tripName: 'Kukatpally & Miyapur Cab' });
    expect(await CabAssignment.countDocuments({ tripId: first.body.tripId, status: 'ACTIVE', tripName: 'Kukatpally & Miyapur Cab' })).toBe(3);

    // 30 minutes earlier overlaps that trip but isn't the same time: a clash, not a cab to join
    const earlier = await ride('Kukatpally Cab', '00:30');
    const elig3 = await coord.client.post('/api/ops/trips/eligible', { bookingIds: [earlier] }).expect(200);
    const cab3 = elig3.body.vehicles.find((v: { _id: string }) => v._id === String(drv.vehicle._id));
    expect(cab3).toMatchObject({ eligible: false, join: null });
    const forced = await coord.client.post('/api/ops/trips', { bookingIds: [earlier], driverId: drv.driver._id, vehicleId: drv.vehicle._id, joinTripId: first.body.tripId });
    expect(forced.body.error.code).toBe('NOT_SAME_TIME');
    // …but the coordinator may still choose that cab for it, knowing about the 1 AM trip
    expect(cab3.nearby.trips).toEqual([{ name: 'Kukatpally & Miyapur Cab', time: '1:00 AM' }]);
    const plain = await coord.client.post('/api/ops/trips', { bookingIds: [earlier], driverId: drv.driver._id, vehicleId: drv.vehicle._id });
    expect(plain.body.error.code).toBe('SCHEDULE_CONFLICT');
    await coord.client.post('/api/ops/trips', { bookingIds: [earlier], driverId: drv.driver._id, vehicleId: drv.vehicle._id, allowNearby: true }).expect(201);

    // two hours later the same cab is simply free
    const later = await ride('Manikonda Cab', '03:00');
    const elig2 = await coord.client.post('/api/ops/trips/eligible', { bookingIds: [later] }).expect(200);
    expect(elig2.body.vehicles.find((v: { _id: string }) => v._id === String(drv.vehicle._id)).eligible).toBe(true);
  });

  it('rides at different times cannot be put in one cab together', async () => {
    const coord = await makeCoordinator(['HYD']);
    const drv = await makeDriver({ capacity: 4 });
    const ids: string[] = [];
    for (const pickupTime of ['09:00', '11:00']) {
      const e = await makeEmployee();
      const res = await e.client!.post('/api/me/bookings', bookingInput({ travelDate: futureDate(2), pickupTime }));
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      ids.push(res.body.booking._id);
    }
    const res = await coord.client.post('/api/ops/trips', { bookingIds: ids, driverId: drv.driver._id, vehicleId: drv.vehicle._id });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NOT_SAME_TIME');
    expect(await CabAssignment.countDocuments({ booking: { $in: ids } })).toBe(0);
  });

  it('a shared cab needs a seat for every rider, and rides already assigned cannot be pooled again', async () => {
    const coord = await makeCoordinator(['HYD']);
    const small = await makeDriver({ capacity: 1 });
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const e = await makeEmployee();
      ids.push((await e.client!.post('/api/me/bookings', bookingInput({ pickupTime: '22:00' })).expect(201)).body.booking._id);
    }
    const full = await coord.client.post('/api/ops/trips', { bookingIds: ids, driverId: small.driver._id, vehicleId: small.vehicle._id });
    expect(full.status).toBe(422);
    expect(await CabRequest.countDocuments({ _id: { $in: ids }, status: 'ASSIGNED' })).toBe(0); // all or nothing

    const big = await makeDriver({ capacity: 4 });
    await coord.client.post('/api/ops/trips', { bookingIds: [ids[0]], driverId: big.driver._id, vehicleId: big.vehicle._id }).expect(201);
    const again = await coord.client.post('/api/ops/trips', { bookingIds: ids, driverId: big.driver._id, vehicleId: big.vehicle._id });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('rejects ineligible drivers and vehicles', async () => {
    const { coord, bookingId } = await scenario();
    const small = await makeDriver({ capacity: 1 });
    await CabRequest.updateOne({ _id: bookingId }, { $set: { passengers: 3 } });
    expect((await assign(coord.client, bookingId, small)).status).toBe(422);
    const maint = await makeDriver();
    await Vehicle.updateOne({ _id: maint.vehicle._id }, { $set: { status: 'MAINTENANCE' } });
    const r3 = await assign(coord.client, bookingId, maint);
    expect(r3.status).toBe(422);
    expect(r3.body.error.message).toMatch(/maintenance/);
  });

  it("drivers can't cancel or hand back a ride; the coordinator changes the cab and the employee is told", async () => {
    const { coord, bookingId, drv } = await scenario();
    const res = await assign(coord.client, bookingId, drv);
    const aid = res.body.assignment._id;
    const refused = await drv.client.post(`/api/driver/rides/${aid}/decline`, { reason: 'Vehicle breakdown' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('DRIVER_CANNOT_CANCEL');
    expect((await CabRequest.findById(bookingId))!.status).toBe('ASSIGNED');
    expect((await CabAssignment.findById(aid))!.status).toBe('ACTIVE');
    // the coordinator changes the cab instead → old PIN revoked, employee gets a "changed" email
    const drv2 = await makeDriver();
    await coord.client.post(`/api/ops/bookings/${bookingId}/reassign`, { driverId: drv2.driver._id, vehicleId: drv2.vehicle._id, reason: 'Driver reported a breakdown' }).expect(200);
    expect((await CabAssignment.findById(aid))!.status).toBe('REASSIGNED');
    expect((await RideStartCredential.findOne({ assignment: aid }))!.status).toBe('REVOKED');
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
