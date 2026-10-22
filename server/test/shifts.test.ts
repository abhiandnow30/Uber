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

  it('employees can change the cab time; it stays on the day closest to the shift cab', async () => {
    await useCompanyShifts();
    const emp = await makeEmployee();
    const shiftDate = futureDate(2);

    // 7 PM - 4 AM, staying late: 5:00 AM the morning after
    const late = await emp.client!.post('/api/me/bookings', bookingInput({ travelDate: shiftDate, shift: '7PM-4AM', changedPickupTime: '05:00' })).expect(201);
    expect(await CabRequest.findById(late.body.booking._id).lean()).toMatchObject({ shiftDate, travelDate: nextDay(shiftDate), pickupTime: '05:00' });

    // 1 PM - 10 PM, leaving at 11:30 PM: still the same evening
    const evening = await emp.client!.post('/api/me/bookings', bookingInput({ travelDate: futureDate(3), shift: '1PM-10PM', changedPickupTime: '23:30' })).expect(201);
    expect(await CabRequest.findById(evening.body.booking._id).lean()).toMatchObject({ travelDate: futureDate(3), pickupTime: '23:30' });

    // still only inside the cab hours
    const day = await emp.client!.post('/api/me/bookings', bookingInput({ travelDate: futureDate(4), shift: '7PM-4AM', changedPickupTime: '07:00' }));
    expect(day.status).toBe(422);
    expect(day.body.error.code).toBe('OUTSIDE_CAB_HOURS');
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
