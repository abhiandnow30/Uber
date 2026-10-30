import { describe, expect, it } from 'vitest';
import { CabAssignment, CabRequest } from '../src/models/booking.js';
import { bookingInput, futureDate, makeCoordinator, makeDriver, makeEmployee } from './helpers.js';

/** A ride on a route, at the given time two days ahead. */
async function ride(route: string, pickupTime = '09:00') {
  const e = await makeEmployee();
  await e.employee.updateOne({ $set: { route } });
  const res = await e.client!.post('/api/me/bookings', bookingInput({ travelDate: futureDate(2), pickupTime }));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.booking._id as string;
}

const live = (bookingId: string) => CabAssignment.findOne({ booking: bookingId, status: 'ACTIVE' }).lean();

describe('changing cabs', () => {
  it('a ride assigned on its own to a cab already going at that time joins its shared trip', async () => {
    const coord = await makeCoordinator(['HYD']);
    const drv = await makeDriver({ capacity: 4 });
    const a = await ride('Kondapur Cab');
    const b = await ride('Kondapur Cab');
    const trip = await coord.client.post('/api/ops/trips', { bookingIds: [a], driverId: drv.driver._id, vehicleId: drv.vehicle._id }).expect(201);
    await coord.client.post(`/api/ops/bookings/${b}/assign`, { driverId: drv.driver._id, vehicleId: drv.vehicle._id }).expect(201);
    expect((await live(b))!.tripId).toBe(trip.body.tripId);
    // the driver sees one trip of two riders
    const home = (await drv.client.get('/api/driver/home').expect(200)).body;
    const mine = [...home.today, ...home.upcoming].filter((r: { tripId: string }) => r.tripId === trip.body.tripId);
    expect(mine.map((r: { tripRiders: number }) => r.tripRiders)).toEqual([2, 2]);
  });

  it('a rider moves into another shared cab; the cab can no longer change once the driver starts', async () => {
    const coord = await makeCoordinator(['HYD']);
    const one = await makeDriver({ capacity: 4 });
    const two = await makeDriver({ capacity: 4 });
    const a = await ride('Kondapur Cab');
    const b = await ride('Gachibowli Cab');
    const c = await ride('Miyapur Cab');
    const first = await coord.client.post('/api/ops/trips', { bookingIds: [a, b], driverId: one.driver._id, vehicleId: one.vehicle._id }).expect(201);
    const second = await coord.client.post('/api/ops/trips', { bookingIds: [c], driverId: two.driver._id, vehicleId: two.vehicle._id }).expect(201);
    expect(first.body.tripName).toBe('Kondapur & Gachibowli Cab');

    // A moves to C's cab: A + C share it, B rides alone, and the automatic names follow
    const moved = await coord.client
      .post(`/api/ops/bookings/${a}/reassign`, { driverId: two.driver._id, vehicleId: two.vehicle._id, joinTripId: second.body.tripId, reason: 'Same way as Miyapur' })
      .expect(200);
    expect(moved.body).toMatchObject({ tripId: second.body.tripId, tripName: 'Miyapur & Kondapur Cab', joined: true });
    expect(await CabAssignment.countDocuments({ tripId: second.body.tripId, status: 'ACTIVE' })).toBe(2);
    expect(await CabAssignment.find({ tripId: first.body.tripId, status: 'ACTIVE' }).lean()).toMatchObject([{ tripName: 'Gachibowli Cab' }]);

    // the same cab twice is refused
    expect((await coord.client.post(`/api/ops/bookings/${a}/reassign`, { driverId: two.driver._id, vehicleId: two.vehicle._id, reason: 'again' })).body.error.code).toBe('SAME_CAB');

    // B to that cab too, without naming the trip: it joins (one cab, one trip), it doesn't clash
    await coord.client.post(`/api/ops/bookings/${b}/reassign`, { driverId: two.driver._id, vehicleId: two.vehicle._id, reason: 'Everyone in one cab' }).expect(200);
    expect((await live(b))!.tripId).toBe(second.body.tripId);

    // the driver starts the trip: nobody in that cab can be moved any more
    await two.client.post(`/api/driver/rides/${(await live(c))!._id}/en-route`).expect(200);
    const blocked = await coord.client.post(`/api/ops/bookings/${a}/reassign`, { driverId: one.driver._id, vehicleId: one.vehicle._id, reason: 'Back again' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('TRIP_STARTED');
    expect((await coord.client.get(`/api/ops/bookings/${a}`)).body.tripStarted).toBe(true);
  });

  it('a cab problem hands every rider not yet picked up back to the coordinator', async () => {
    const coord = await makeCoordinator(['HYD']);
    const drv = await makeDriver({ capacity: 4 });
    const a = await ride('Kondapur Cab');
    const b = await ride('Kondapur Cab');
    await coord.client.post('/api/ops/trips', { bookingIds: [a, b], driverId: drv.driver._id, vehicleId: drv.vehicle._id }).expect(201);
    const first = (await live(a))!;
    await drv.client.post(`/api/driver/rides/${first._id}/en-route`).expect(200);

    const bad = await drv.client.post(`/api/driver/rides/${first._id}/problem`, { reason: 'OTHER' });
    expect(bad.status).toBe(422); // "Other" needs to say what happened
    const res = await drv.client.post(`/api/driver/rides/${first._id}/problem`, { reason: 'BREAKDOWN', note: 'Flat tyre' }).expect(200);
    expect(res.body).toMatchObject({ released: 2, onBoard: 0 });
    const rides = await CabRequest.find({ _id: { $in: [a, b] } }).lean();
    expect(rides.map((r) => r.status)).toEqual(['REQUESTED', 'REQUESTED']);
    expect(rides.every((r) => !r.currentAssignment)).toBe(true);
    expect(await CabAssignment.countDocuments({ booking: { $in: [a, b] }, status: 'DECLINED' })).toBe(2);

    // and they can be given another cab straight away
    const other = await makeDriver({ capacity: 4 });
    await coord.client.post('/api/ops/trips', { bookingIds: [a, b], driverId: other.driver._id, vehicleId: other.vehicle._id }).expect(201);
  });

  it('a driver made inactive is signed out and their rides wait for another cab', async () => {
    const coord = await makeCoordinator(['HYD']);
    const drv = await makeDriver({ capacity: 4 });
    const a = await ride('Kondapur Cab');
    await coord.client.post(`/api/ops/bookings/${a}/assign`, { driverId: drv.driver._id, vehicleId: drv.vehicle._id }).expect(201);
    await drv.client.get('/api/driver/home').expect(200);
    await coord.client.post(`/api/ops/drivers/${drv.driver._id}/employment`, { employmentStatus: 'INACTIVE', reason: 'Left the company' }).expect(200);
    expect((await drv.client.get('/api/driver/home')).status).toBe(401);
    expect(await CabRequest.findById(a).lean()).toMatchObject({ status: 'REQUESTED' });
  });

  it("a cab's seats can't drop below a shared trip's riders", async () => {
    const coord = await makeCoordinator(['HYD']);
    const drv = await makeDriver({ capacity: 4 });
    const ids = [await ride('Kondapur Cab'), await ride('Kondapur Cab'), await ride('Kondapur Cab')];
    await coord.client.post('/api/ops/trips', { bookingIds: ids, driverId: drv.driver._id, vehicleId: drv.vehicle._id }).expect(201);
    const tooFew = await coord.client.patch(`/api/ops/vehicles/${drv.vehicle._id}`, { capacity: 2 });
    expect(tooFew.status).toBe(409);
    await coord.client.patch(`/api/ops/vehicles/${drv.vehicle._id}`, { capacity: 3 }).expect(200);
  });
});
