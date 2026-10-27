import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { Policy } from '../src/models/Policy.js';
import { EmailOutbox } from '../src/models/system.js';
import { renderEmail } from '../src/services/email/templates.js';
import { sendDailyBookingReminders } from '../src/services/monitor.service.js';
import { invalidatePolicyCache } from '../src/services/policy.service.js';
import { bookingInput, futureDate, makeAdmin, makeEmployee } from './helpers.js';

/** A moment `days` from today at the given Hyderabad time. */
const at = (days: number, hhmm: string) => DateTime.fromISO(`${futureDate(days)}T${hhmm}`, { zone: 'Asia/Kolkata' }).toJSDate();
const reminders = (to: string) => EmailOutbox.find({ template: 'DAILY_BOOKING_REMINDER', to }).lean();

describe('daily booking reminder (6 PM unless the admin picks another time)', () => {
  it('emails signed-in employees without a cab for tomorrow, once per day', async () => {
    const free = await makeEmployee();
    const booked = await makeEmployee();
    const invited = await makeEmployee({ status: 'INVITED' });
    await booked.client!.post('/api/me/bookings', bookingInput({ travelDate: futureDate(2) })).expect(201);

    // nothing before 6 PM
    expect(await sendDailyBookingReminders(at(1, '17:30'))).toBe(0);

    await sendDailyBookingReminders(at(1, '18:01'));
    await sendDailyBookingReminders(at(1, '18:02')); // later runs the same evening add nothing
    expect(await reminders(free.employee.email)).toHaveLength(1);
    expect(await reminders(booked.employee.email)).toHaveLength(0); // already has tomorrow's cab
    expect(await reminders(invited.employee.email)).toHaveLength(0); // never signed in

    const [mail] = await reminders(free.employee.email);
    const rendered = renderEmail('DAILY_BOOKING_REMINDER', mail.params as Record<string, unknown>);
    expect(rendered.subject).toContain('Need a cab for');
    expect(rendered.html).toContain('/employee/request');
  });

  it('is never sent late at night, and admins can switch it off', async () => {
    const emp = await makeEmployee();
    expect(await sendDailyBookingReminders(at(3, '23:00'))).toBe(0);

    await Policy.updateOne({ key: 'global' }, { $set: { 'notifications.dailyBookingReminder': false } });
    invalidatePolicyCache();
    expect(await sendDailyBookingReminders(at(4, '18:05'))).toBe(0);
    expect(await reminders(emp.employee.email)).toHaveLength(0);
  });

  it('goes out at the time the admin chose, including just before midnight', async () => {
    const admin = (await makeAdmin()).client;
    const emp = await makeEmployee();
    expect((await admin.put('/api/admin/policy', { reminders: { dailyTime: '25:00' } })).status).toBe(422);
    await admin.put('/api/admin/policy', { reminders: { dailyTime: '20:30' } }).expect(200);

    expect(await sendDailyBookingReminders(at(5, '18:05'))).toBe(0); // the old 6 PM time no longer counts
    expect(await sendDailyBookingReminders(at(5, '20:31'))).toBe(1);
    expect(await reminders(emp.employee.email)).toHaveLength(1);

    // 11:45 PM: a run just after midnight still belongs to the evening before (one email, for the right day)
    await admin.put('/api/admin/policy', { reminders: { dailyTime: '23:45' } }).expect(200);
    expect(await sendDailyBookingReminders(at(7, '00:10'))).toBe(1);
    const latest = (await reminders(emp.employee.email)).at(-1)!;
    expect(latest.params).toMatchObject({ shiftDate: DateTime.fromISO(futureDate(7)).toFormat('ccc, d LLL yyyy') });
  });
});
