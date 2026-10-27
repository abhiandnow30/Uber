import { describe, expect, it } from 'vitest';
import { CabAssignment, CabRequest } from '../src/models/booking.js';
import { Notification } from '../src/models/system.js';
import { autoCancelStale } from '../src/services/monitor.service.js';
import { assign, scenario } from './helpers.js';

describe('cancellations', () => {
  it('rides nobody responds to are cancelled automatically 3 hours after the pickup time', async () => {
    const { coord, bookingId, drv, emp } = await scenario();
    const aid = (await assign(coord.client, bookingId, drv).expect(201)).body.assignment._id;
    const pickup = (await CabRequest.findById(bookingId))!.scheduledPickupAt;

    expect(await autoCancelStale(new Date(+pickup + 2 * 3600_000))).toBe(0); // 2 hours late: not yet
    expect(await autoCancelStale(new Date(+pickup + 3.5 * 3600_000))).toBe(1);
    const b = await CabRequest.findById(bookingId).lean();
    expect(b).toMatchObject({ status: 'CANCELLED' });
    expect(b!.cancellationReason).toMatch(/no response from the employee or driver within 3 hours/);
    expect((await CabAssignment.findById(aid))!.status).toBe('CANCELLED');
    expect(await Notification.exists({ user: emp.user._id, type: 'BOOKING_CANCELLED' })).toBeTruthy();
    expect(await Notification.exists({ user: coord.user._id, type: 'BOOKING_CANCELLED', title: 'Booking cancelled automatically' })).toBeTruthy();
  });

  it('drivers cancel only because of the employee: not coming, other, or a no-show at the pickup', async () => {
    const { coord, bookingId, drv } = await scenario();
    const aid = (await assign(coord.client, bookingId, drv).expect(201)).body.assignment._id;
    const cancel = (body: object) => drv.client.post(`/api/driver/rides/${aid}/cancel`, body);

    expect((await cancel({ reason: 'OTHER' })).status).toBe(422); // "other" needs a reason
    expect((await cancel({ reason: 'NO_SHOW' })).body.error.code).toBe('INVALID_TRANSITION'); // not at the pickup yet
    await drv.client.post(`/api/driver/rides/${aid}/en-route`).expect(200);
    await cancel({ reason: 'NOT_COMING', note: 'Called me, stuck at work' }).expect(200);
    const b = await CabRequest.findById(bookingId).lean();
    expect(b).toMatchObject({ status: 'CANCELLED', cancelledByRole: 'DRIVER' });
    expect(b!.cancellationReason).toBe("Cancelled by driver: Employee said they're not coming — Called me, stuck at work");
    expect(await Notification.exists({ user: coord.user._id, title: 'Booking cancelled by driver' })).toBeTruthy();
  });

  it('a no-show is recorded once the driver has arrived', async () => {
    const { coord, bookingId, drv } = await scenario();
    const aid = (await assign(coord.client, bookingId, drv).expect(201)).body.assignment._id;
    await drv.client.post(`/api/driver/rides/${aid}/en-route`).expect(200);
    await drv.client.post(`/api/driver/rides/${aid}/arrived`).expect(200);
    await drv.client.post(`/api/driver/rides/${aid}/cancel`, { reason: 'NO_SHOW' }).expect(200);
    expect((await CabRequest.findById(bookingId))!.status).toBe('NO_SHOW');
  });

  it('employees can cancel an assigned cab themselves only when it is late', async () => {
    const { coord, bookingId, drv, emp } = await scenario();
    await assign(coord.client, bookingId, drv).expect(201);
    const early = await emp.client!.post(`/api/me/bookings/${bookingId}/cancel`, { reason: 'Changed my mind' });
    expect(early.body.error.code).toBe('CANCELLATION_NOT_ALLOWED'); // on time: ask the admin instead
    expect((await emp.client!.get(`/api/me/bookings/${bookingId}`)).body).toMatchObject({ canCancel: false, cabLate: false });

    await CabRequest.updateOne({ _id: bookingId }, { $set: { isDelayed: true, delayReason: 'Traffic' } });
    expect((await emp.client!.get(`/api/me/bookings/${bookingId}`)).body).toMatchObject({ canCancel: true, cabLate: true });
    await emp.client!.post(`/api/me/bookings/${bookingId}/cancel`, { reason: "I've arranged other transport" }).expect(200);
    const b = await CabRequest.findById(bookingId).lean();
    expect(b).toMatchObject({ status: 'CANCELLED', cancelledByRole: 'EMPLOYEE' });
    expect(b!.cancellationReason).toBe("Cab late — I've arranged other transport");
    expect(await Notification.exists({ user: coord.user._id, title: 'Booking cancelled by employee' })).toBeTruthy();
  });
});
