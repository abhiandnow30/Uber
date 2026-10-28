import { describe, expect, it } from 'vitest';
import { CabRequest } from '../src/models/booking.js';
import { Employee } from '../src/models/Employee.js';
import { Policy } from '../src/models/Policy.js';
import { invalidatePolicyCache } from '../src/services/policy.service.js';
import { suggestStops } from '../src/services/trip.service.js';
import { bookingInput, employeePin, futureDate, makeCoordinator, makeDriver, makeEmployee } from './helpers.js';

describe('a shared cab is one trip for its driver', () => {
  it('lists every rider in stop order and runs the whole trip through each rider’s own ride', async () => {
    await Policy.updateOne({ key: 'global', 'officeLocations.code': 'HYD' }, { $set: { 'officeLocations.$.location': { lat: 17.4617, lng: 78.3511 } } });
    invalidatePolicyCache();
    const coord = await makeCoordinator(['HYD']);
    const drv = await makeDriver({ capacity: 4 });
    const travelDate = futureDate(2);
    const near = await makeEmployee();
    const far = await makeEmployee();
    await Employee.updateOne({ _id: near.employee._id }, { $set: { homeLocation: { lat: 17.465, lng: 78.355 } } }); // ~0.5 km from the office
    await Employee.updateOne({ _id: far.employee._id }, { $set: { homeLocation: { lat: 17.53, lng: 78.27 } } }); // ~11 km away
    const ids: string[] = [];
    for (const e of [near, far]) {
      const r = await e.client!.post('/api/me/bookings', bookingInput({ travelDate }));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      ids.push(r.body.booking._id);
    }
    const trip = await coord.client.post('/api/ops/trips', { bookingIds: ids, driverId: drv.driver._id, vehicleId: drv.vehicle._id, name: 'Kondapur & Gachibowli Cab' }).expect(201);

    // the driver's home shows the cab as one trip of 2 riders
    const home = (await drv.client.get('/api/driver/home').expect(200)).body;
    const listed = [...home.today, ...home.upcoming].filter((r: { tripId: string }) => r.tripId === trip.body.tripId);
    expect(listed).toHaveLength(2);
    expect(listed.every((r: { tripRiders: number }) => r.tripRiders === 2)).toBe(true);

    const url = `/api/driver/trips/${trip.body.tripId}`;
    const t = (await drv.client.get(url).expect(200)).body;
    expect(t).toMatchObject({ tripName: 'Kondapur & Gachibowli Cab' });
    const toOffice = t.direction === 'IN';
    // home → office: farthest pickup first so the cab ends at the office; office → home: nearest drop first
    const order = t.rides.map((r: { booking: { _id: string } }) => r.booking._id);
    expect(order).toEqual(toOffice ? [ids[1], ids[0]] : [ids[0], ids[1]]);

    // the driver can put the riders in their own order; it's kept, and only for their own cab
    const flipped = [...t.rides].reverse().map((r: { assignmentId: string }) => r.assignmentId);
    const reordered = (await drv.client.post(`${url}/order`, { assignmentIds: flipped }).expect(200)).body;
    expect(reordered.rides.map((r: { assignmentId: string }) => r.assignmentId)).toEqual(flipped);
    expect((await drv.client.get(url).expect(200)).body.rides.map((r: { assignmentId: string }) => r.assignmentId)).toEqual(flipped);
    expect((await drv.client.post(`${url}/order`, { assignmentIds: [flipped[0]] })).status).toBe(409); // must list every rider
    t.rides = reordered.rides;

    // each employee sees the cab is shared and their own place, in the driver's order, but not who else rides
    const placeOf = async (emp: typeof near, bookingId: string) => {
      const home = (await emp.client!.get('/api/me/home').expect(200)).body;
      const mine = home.upcoming.find((b: { _id: string }) => b._id === bookingId);
      expect(JSON.stringify(mine.sharedCab)).not.toMatch(/fullName|employee|email|homeLocation/);
      return mine.sharedCab;
    };
    const nearAssignment = reordered.rides.find((r: { booking: { _id: string } }) => r.booking._id === ids[0]).assignmentId;
    expect(await placeOf(near, ids[0])).toMatchObject({ name: 'Kondapur & Gachibowli Cab', riders: 2, stop: flipped.indexOf(nearAssignment) + 1, route: expect.arrayContaining(['17.4617,78.3511']) });

    // the whole trip, one step at a time, through each rider's own ride
    const ride = (i: number) => t.rides[i].assignmentId as string;
    for (const i of [0, 1]) await drv.client.post(`/api/driver/rides/${ride(i)}/en-route`).expect(200);
    for (const i of [0, 1]) {
      const bookingId = t.rides[i].booking._id as string;
      const emp = bookingId === ids[0] ? near : far;
      await drv.client.post(`/api/driver/rides/${ride(i)}/arrived`).expect(200);
      await drv.client.post(`/api/driver/rides/${ride(i)}/start`, { pin: await employeePin(emp.client!, bookingId) }).expect(200);
    }
    for (const i of [0, 1]) await drv.client.post(`/api/driver/rides/${ride(i)}/complete`).expect(200);
    expect((await CabRequest.find({ _id: { $in: ids } }).lean()).every((b) => b.status === 'COMPLETED')).toBe(true);
    const after = (await drv.client.get(url).expect(200)).body;
    expect(after.rides.every((r: { assignmentStatus: string }) => r.assignmentStatus === 'COMPLETED')).toBe(true);

    // another driver can't open it
    const other = await makeDriver();
    expect((await other.client.get(url)).status).toBe(404);
  });

  it('suggests stops without doubling back: each next stop is the nearest to the previous one', () => {
    const office = { lat: 17.46, lng: 78.35 };
    // A 2 km north, B 3 km south, C 3.5 km north of the office
    const homes = { A: { lat: 17.478, lng: 78.35 }, B: { lat: 17.433, lng: 78.35 }, C: { lat: 17.4915, lng: 78.35 } };
    const names = Object.keys(homes) as Array<keyof typeof homes>;
    // office → homes: A, then on north to C, then B (not A → B → C, which zig-zags)
    expect(suggestStops(names, (n) => homes[n], office, false)).toEqual(['A', 'C', 'B']);
    // homes → office: the same route backwards, ending at the office
    expect(suggestStops(names, (n) => homes[n], office, true)).toEqual(['B', 'C', 'A']);
    // homes without a pin go last; without an office pin the order is left as it is
    expect(suggestStops(['X', ...names], (n) => (n === 'X' ? null : homes[n as keyof typeof homes]), office, false)).toEqual(['A', 'C', 'B', 'X']);
    expect(suggestStops(names, (n) => homes[n], null, false)).toEqual(names);
  });
});
