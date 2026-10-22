import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { Policy } from '../src/models/Policy.js';
import { EmailOutbox } from '../src/models/system.js';
import { renderEmail } from '../src/services/email/templates.js';
import { sendDailyBookingReminders } from '../src/services/monitor.service.js';
import { invalidatePolicyCache } from '../src/services/policy.service.js';
import { bookingInput, futureDate, makeEmployee } from './helpers.js';

/** A moment `days` from today at the given Hyderabad time. */
const at = (days: number, hhmm: string) => DateTime.fromISO(`${futureDate(days)}T${hhmm}`, { zone: 'Asia/Kolkata' }).toJSDate();
const reminders = (to: string) => EmailOutbox.find({ template: 'DAILY_BOOKING_REMINDER', to }).lean();

describe('daily 6 PM booking reminder', () => {
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
});
