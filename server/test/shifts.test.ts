import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { CabRequest } from '../src/models/booking.js';
import { Policy } from '../src/models/Policy.js';
import { syncIndexes } from '../src/scripts/indexes.js';
import { DEFAULT_OFFICES, DEFAULT_SHIFTS, invalidatePolicyCache } from '../src/services/policy.service.js';
import { bookingInput, futureDate, makeAdmin, makeEmployee } from './helpers.js';

/** Switch from the generic test rules to the company's shifts and 8 PM - 6 AM cab hours. */
async function useCompanyShifts() {
  await Policy.updateOne(
    { key: 'global' },
    { $set: { shifts: DEFAULT_SHIFTS, 'booking.cabWindowStart': '20:00', 'booking.cabWindowEnd': '06:00', 'booking.requireShift': true } },
  );
  invalidatePolicyCache();
}

const nextDay = (d: string) => DateTime.fromISO(d).plus({ days: 1 }).toFormat('yyyy-MM-dd');

describe('company shifts: one cab per shift, 8 PM - 6 AM', () => {
  it('the cab time comes from the shift; after midnight it is on the next day', async () => {
    await useCompanyShifts();
    const emp = await makeEmployee();
    const shiftDate = futureDate(2);

    // 4 PM - 1 AM: dropped home at 1:00 AM the next day; any time the client sends is ignored
    const late = await emp.client!.post('/api/me/bookings', bookingInput({ travelDate: shiftDate, pickupTime: '09:00', shift: '4PM-1AM' })).expect(201);
    const b = await CabRequest.findById(late.body.booking._id).lean();
    expect(b).toMatchObject({ shiftDate, travelDate: nextDay(shiftDate), pickupTime: '01:00', shift: '4PM-1AM' });
    expect(DateTime.fromJSDate(b!.scheduledPickupAt).setZone('Asia/Kolkata').toFormat('yyyy-MM-dd HH:mm')).toBe(`${nextDay(shiftDate)} 01:00`);

    // 1 PM - 10 PM: dropped home at 10:00 PM the same day
    const early = await emp.client!.post('/api/me/bookings', bookingInput({ travelDate: futureDate(3), shift: '1PM-10PM' })).expect(201);
    expect(await CabRequest.findById(early.body.booking._id).lean()).toMatchObject({ travelDate: futureDate(3), pickupTime: '22:00' });

    // 9 PM - 6 AM: the one cab is the 9:00 PM pickup to the office
    const night = await emp.client!.post('/api/me/bookings', bookingInput({ travelDate: futureDate(4), shift: '9PM-6AM' })).expect(201);
    expect(await CabRequest.findById(night.body.booking._id).lean()).toMatchObject({ travelDate: futureDate(4), pickupTime: '21:00' });
  });

  it('employees enter their shift times; the times decide IN (to office) or OUT (home)', async () => {
    await useCompanyShifts();
    const emp = await makeEmployee();
    await emp.employee.updateOne({ $set: { homeAddress: 'Flat 1, Kondapur, Hyderabad' } });
    const book = (d: number, o: Record<string, unknown>) => {
      const { pickupLocation: _p, dropLocation: _d, ...rest } = bookingInput({ travelDate: futureDate(d), ...o });
      return emp.client!.post('/api/me/bookings', rest);
    };

    // 9 PM - 6 AM moved to 10 PM - 7 AM: still IN — reach the office by 10 PM, pickup set later by the transport team
    const inRide = (await book(2, { shift: '9PM-6AM', shiftStart: '22:00', shiftEnd: '07:00' }).expect(201)).body.booking;
    expect(inRide).toMatchObject({ direction: 'IN', reportBy: '22:00', pickupTimeSet: false, shiftStart: '22:00', shiftEnd: '07:00', travelDate: futureDate(2) });
    expect(inRide.dropLocation).toMatch(/Hyderabad HQ/);

    // 7 PM - 4 AM moved to 8 PM - 5 AM: OUT — the cab leaves the office at 5 AM the next morning
    const outRide = (await book(3, { shift: '7PM-4AM', shiftStart: '20:00', shiftEnd: '05:00' }).expect(201)).body.booking;
    expect(outRide).toMatchObject({ direction: 'OUT', pickupTime: '05:00', pickupTimeSet: true, travelDate: nextDay(futureDate(3)) });
    expect(outRide.pickupLocation).toMatch(/Hyderabad HQ/);

    // 8 PM - 5 PM next day has no cab: too early to reach the office by 8 PM, and it ends after cab hours
    const none = await book(4, { shift: '9PM-6AM', shiftStart: '20:00', shiftEnd: '17:00' });
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe('NO_CAB_FOR_SHIFT');
  });

  it('IN rides: the coordinator sets the pickup time when assigning, before the reach-office time', async () => {
    await useCompanyShifts();
    const { makeCoordinator, makeDriver } = await import('./helpers.js');
    const coord = await makeCoordinator(['HYD']);
    const drv = await makeDriver({ capacity: 4 });
    const emp = await makeEmployee();
    await emp.employee.updateOne({ $set: { homeAddress: 'Flat 2, Gachibowli, Hyderabad' } });
    const { pickupLocation: _p, dropLocation: _d, ...input } = bookingInput({ travelDate: futureDate(2), shift: '9PM-6AM' });
    const ride = (await emp.client!.post('/api/me/bookings', input).expect(201)).body.booking;
    const trip = (time?: string) => coord.client.post('/api/ops/trips', { bookingIds: [ride._id], driverId: drv.driver._id, vehicleId: drv.vehicle._id, ...(time ? { pickupTime: time } : {}) });

    expect((await trip()).body.error.code).toBe('PICKUP_TIME_REQUIRED');
    expect((await trip('21:30')).body.error.code).toBe('PICKUP_TIME_INVALID'); // after 9 PM is too late
    expect((await trip('16:30')).body.error.code).toBe('PICKUP_TIME_INVALID'); // more than 4 hours early
    // before cab hours (8 PM) is fine: a long ride from home needs an earlier pickup
    await trip('19:15').expect(201);
    const saved = await CabRequest.findById(ride._id).lean();
    expect(saved).toMatchObject({ status: 'ASSIGNED', pickupTime: '19:15', pickupTimeSet: true, travelDate: futureDate(2), reportBy: '21:00' });
    expect(DateTime.fromJSDate(saved!.scheduledPickupAt).setZone('Asia/Kolkata').toFormat('yyyy-MM-dd HH:mm')).toBe(`${futureDate(2)} 19:15`);
  });

  it('one cab per shift day: an after-midnight cab counts for the day the shift started', async () => {
    await useCompanyShifts();
    const emp = await makeEmployee();
    const shiftDate = futureDate(2);

    // 7 PM - 4 AM shift on day D: the cab is at 4 AM on D+1, but it is D's cab
    await emp.client!.post('/api/me/bookings', bookingInput({ travelDate: shiftDate, shift: '7PM-4AM' })).expect(201);
    // no second cab for the same shift day, even on another shift
    const again = await emp.client!.post('/api/me/bookings', bookingInput({ travelDate: shiftDate, shift: '1PM-10PM' }));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('SHIFT_DAY_BOOKED');
    // the D+1 shift is a new day, although D's cab also runs on D+1
    await emp.client!.post('/api/me/bookings', bookingInput({ travelDate: nextDay(shiftDate), shift: '7PM-4AM' })).expect(201);
  });

  it('the route is not asked: it is the saved address and the office, in the shift direction', async () => {
    await useCompanyShifts();
    const emp = await makeEmployee();
    const noRoute = (o: Record<string, unknown>) => {
      const { pickupLocation: _p, dropLocation: _d, ...rest } = bookingInput(o);
      return rest;
    };
    const missing = await emp.client!.post('/api/me/bookings', noRoute({ travelDate: futureDate(2), shift: '7PM-4AM' }));
    expect(missing.body.error.code).toBe('HOME_ADDRESS_REQUIRED');

    await emp.employee.updateOne({ $set: { homeAddress: 'Flat 1, Kondapur, Hyderabad' } });
    const office = `${DEFAULT_OFFICES[0].name}, ${DEFAULT_OFFICES[0].address}`;
    const home = await emp.client!.post('/api/me/bookings', noRoute({ travelDate: futureDate(2), shift: '7PM-4AM' })).expect(201);
    expect(home.body.booking).toMatchObject({ pickupLocation: office, dropLocation: 'Flat 1, Kondapur, Hyderabad' });
    const toWork = await emp.client!.post('/api/me/bookings', noRoute({ travelDate: futureDate(3), shift: '9PM-6AM' })).expect(201);
    expect(toWork.body.booking).toMatchObject({ pickupLocation: 'Flat 1, Kondapur, Hyderabad', dropLocation: office });
  });

  it('without a shift, a cab before 6 AM counts for the previous work day', async () => {
    await useCompanyShifts();
    await Policy.updateOne({ key: 'global' }, { $set: { 'booking.requireShift': false } });
    invalidatePolicyCache();
    const emp = await makeEmployee();
    const day = futureDate(2);
    // 1 AM on D+1 is D's cab, so a 9 PM cab on D is a second cab for D
    await emp.client!.post('/api/me/bookings', bookingInput({ travelDate: nextDay(day), pickupTime: '01:00' })).expect(201);
    const second = await emp.client!.post('/api/me/bookings', bookingInput({ travelDate: day, pickupTime: '21:00' }));
    expect(second.body.error.code).toBe('SHIFT_DAY_BOOKED');
    // 9 PM on D+1 starts D+1's work day
    await emp.client!.post('/api/me/bookings', bookingInput({ travelDate: nextDay(day), pickupTime: '21:00' })).expect(201);
  });

  it('employees save a default shift on their account', async () => {
    await useCompanyShifts();
    const emp = await makeEmployee();
    await emp.client!.patch('/api/me/profile', { defaultShift: '7pm-4am' }).expect(200);
    expect((await emp.client!.get('/api/auth/me')).body.profile.defaultShift).toBe('7PM-4AM');
    expect((await emp.client!.patch('/api/me/profile', { defaultShift: 'NOPE' })).status).toBe(422);
    await emp.client!.patch('/api/me/profile', { defaultShift: '' }).expect(200);
    expect((await emp.client!.get('/api/auth/me')).body.profile.defaultShift).toBeUndefined();
  });

  it('employees must pick a shift, and cabs never run outside 8 PM - 6 AM', async () => {
    await useCompanyShifts();
    const emp = await makeEmployee();
    const noShift = await emp.client!.post('/api/me/bookings', bookingInput({ travelDate: futureDate(2), pickupTime: '23:00' }));
    expect(noShift.status).toBe(422);
    expect(noShift.body.error.details.fields.shift).toBe('Select your shift');

    // an old daytime shift still in the list can't be used to book a daytime cab
    await Policy.updateOne({ key: 'global' }, { $push: { shifts: { code: 'DAY', name: 'Day', direction: 'TO_OFFICE', defaultPickupTime: '09:00', active: true } } });
    invalidatePolicyCache();
    const day = await emp.client!.post('/api/me/bookings', bookingInput({ travelDate: futureDate(2), pickupTime: '09:00', shift: 'DAY' }));
    expect(day.status).toBe(422);
    expect(day.body.error.code).toBe('OUTSIDE_CAB_HOURS');
  });

  it('admins cannot save a shift whose cab time is outside the cab hours', async () => {
    await useCompanyShifts();
    const { client } = await makeAdmin();
    const bad = await client.put('/api/admin/policy', {
      shifts: [...DEFAULT_SHIFTS, { code: '9AM-6PM', name: '9 AM - 6 PM', startTime: '09:00', endTime: '18:00', direction: 'FROM_OFFICE', defaultPickupTime: '18:00', active: true }],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain('outside the cab hours');
    await client.put('/api/admin/policy', { shifts: DEFAULT_SHIFTS }).expect(200);
  });

  it('an existing database is switched to the company shifts once, keeping old shifts inactive', async () => {
    await Policy.deleteMany({});
    await Policy.create({
      key: 'global',
      officeLocations: DEFAULT_OFFICES,
      shifts: [{ code: 'MORNING', name: 'Morning shift (to office)', direction: 'TO_OFFICE', defaultPickupTime: '08:00', active: true }],
    });
    await syncIndexes();
    let p = await Policy.findOne({ key: 'global' }).lean();
    expect(p!.shifts.filter((s) => s.active).map((s) => s.code)).toEqual(DEFAULT_SHIFTS.map((s) => s.code));
    expect(p!.shifts.find((s) => s.code === 'MORNING')).toMatchObject({ active: false });
    expect(p!.booking).toMatchObject({ cabWindowStart: '20:00', cabWindowEnd: '06:00', requireShift: true });

    // later edits by an admin are never overwritten by the one-time update
    await Policy.updateOne({ key: 'global' }, { $set: { shifts: [DEFAULT_SHIFTS[0]] } });
    await syncIndexes();
    p = await Policy.findOne({ key: 'global' }).lean();
    expect(p!.shifts.map((s) => s.code)).toEqual(['1PM-10PM']);
  });
});
