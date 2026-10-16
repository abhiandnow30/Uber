import { describe, expect, it } from 'vitest';
import { CabAssignment, CabRequest, TripStatusHistory } from '../src/models/booking.js';
import { Driver } from '../src/models/Driver.js';
import { AuditLog, EmailOutbox, Notification } from '../src/models/system.js';
import { anonymous, drainOutbox, driverLogin, fakeEmail, futureDate, linkFrom, login, makeAdmin, makeCoordinator, type Client } from './helpers.js';
import crypto from 'node:crypto';

/** The complete scenario from the specification, through the public HTTP API only. */
describe('end-to-end workflow', () => {
  it('add employee → activate → fleet → book → assign → email → driver → PIN → complete → audit/reports', async () => {
    const admin = (await makeAdmin()).client;
    const coord = (await makeCoordinator(['HYD'])).client;

    // 1-3. Admin adds the employee; duplicates prevented; account INVITED
    const newEmp = { employeeId: 'EMP501', fullName: 'Nisha Verma', email: 'nisha.verma@test.com', phone: '9876500501', route: 'Kondapur Cab', officeLocation: 'HYD' };
    await admin.post('/api/admin/employees', newEmp).expect(201);
    expect((await admin.post('/api/admin/employees', newEmp)).status).toBe(409);

    // 4-5. Invitation email → activation → login
    await drainOutbox();
    const token = linkFrom(fakeEmail.to('nisha.verma@test.com')[0], '/activate');
    await anonymous().post('/api/auth/activate', { token, password: 'NishaPass2026' }).expect(200);
    const emp = await login('nisha.verma@test.com', 'NishaPass2026');

    // 6. Driver created and verified
    const d = await coord.post('/api/ops/drivers', {
      driverCode: 'DRV777', fullName: 'Mohan Singh', phone: '+91 94444 44444',
      licenseNumber: 'TS9988776655', licenseExpiry: new Date(Date.now() + 400 * 86400_000).toISOString(), officeLocation: 'HYD',
    });
    expect(d.status).toBe(201);
    await admin.post(`/api/ops/drivers/${d.body._id}/verify`, { status: 'VERIFIED', documentsChecked: ['Driving license', 'Background check'] }).expect(200);

    // 7. Coordinator adds a vehicle and links it; the driver signs in with mobile + vehicle number
    const v = await coord.post('/api/ops/vehicles', { registrationNumber: 'TS09EE7777', model: 'Innova', vehicleType: 'MUV', capacity: 6, officeLocation: 'HYD' });
    await coord.post('/api/ops/links', { driverId: d.body._id, vehicleId: v.body._id }).expect(201);
    const driver: Client = await driverLogin('94444 44444', 'TS09EE7777');
    await driver.post('/api/driver/duty', { onDuty: true }).expect(200);

    // 8-9. Employee requests a cab; it appears on the coordinator dashboard
    const travelDate = futureDate(2);
    const b = await emp.post('/api/me/bookings', { travelDate, pickupTime: '08:45', pickupLocation: 'Kondapur Main Road', dropLocation: 'HITEC City Campus', passengers: 2, shift: 'MORNING', clientRequestId: crypto.randomUUID() });
    expect(b.status).toBe(201);
    const bookingId = b.body.booking._id;
    const queue = await coord.get(`/api/ops/bookings?date=${travelDate}&status=REQUESTED`);
    expect(queue.body.items.map((i: { _id: string }) => i._id)).toContain(bookingId);

    // 10-11. Coordinator assigns; assignment committed with PIN
    const eligible = await coord.get(`/api/ops/bookings/${bookingId}/eligible`);
    expect(eligible.body.drivers.find((x: { _id: string }) => x._id === d.body._id).eligible).toBe(true);
    const a = await coord.post(`/api/ops/bookings/${bookingId}/assign`, { driverId: d.body._id, vehicleId: v.body._id });
    expect(a.status).toBe(201);
    const assignmentId = a.body.assignment._id;

    // 12. Outlook email to employee
    await drainOutbox();
    const assignedMail = fakeEmail.to('nisha.verma@test.com').find((m) => m.subject === `Your Cab Has Been Assigned — ${travelDate}`);
    expect(assignedMail?.text).toContain('Vehicle Number: TS09EE7777');
    expect(assignedMail?.text).toContain('Driver Name: Mohan Singh');
    const coordView = await coord.get(`/api/ops/bookings?date=${travelDate}`);
    expect(coordView.body.items[0].notification.status).toBe('ACCEPTED');

    // 13-14. Driver sees in-app notification and acknowledges
    const notes = await driver.get('/api/notifications?unreadOnly=true');
    expect(notes.body.items.some((n: { type: string }) => n.type === 'RIDE_ASSIGNED')).toBe(true);
    await driver.post(`/api/driver/rides/${assignmentId}/acknowledge`).expect(200);

    // 15. En route + arrival
    await driver.post(`/api/driver/rides/${assignmentId}/en-route`).expect(200);
    await driver.post(`/api/driver/rides/${assignmentId}/arrived`).expect(200);

    // 16-18. Employee shares PIN; driver enters it; backend authorises start
    const details = await emp.get(`/api/me/bookings/${bookingId}`);
    expect(details.body.assignment.vehicle.registrationNumber).toBe('TS09EE7777');
    const pin = details.body.pin.code;
    await driver.post(`/api/driver/rides/${assignmentId}/start`, { pin }).expect(200);

    // 19. Employee and coordinator see the update
    expect((await emp.get(`/api/me/bookings/${bookingId}`)).body.status).toBe('IN_PROGRESS');
    expect((await coord.get(`/api/ops/bookings/${bookingId}`)).body.status).toBe('IN_PROGRESS');
    expect(await Notification.exists({ type: 'TRIP_STARTED' })).toBeTruthy();

    // 20-22. Completion, history, availability, completion email
    await driver.post(`/api/driver/rides/${assignmentId}/complete`).expect(200);
    expect((await CabRequest.findById(bookingId))!.status).toBe('COMPLETED');
    expect((await CabAssignment.findById(assignmentId))!.completedAt).toBeInstanceOf(Date);
    expect((await Driver.findById(d.body._id))!.availability).toBe('AVAILABLE');
    await drainOutbox();
    expect(fakeEmail.to('nisha.verma@test.com').some((m) => m.subject.startsWith('Trip Completed'))).toBe(true);
    expect(await TripStatusHistory.countDocuments({ booking: bookingId })).toBeGreaterThanOrEqual(7);

    // 23. Admin audit trail and reports
    const actions = (await AuditLog.find().lean()).map((l) => l.action);
    for (const act of ['EMPLOYEE_CREATED', 'ACCOUNT_ACTIVATED', 'DRIVER_VERIFICATION', 'DRIVER_VEHICLE_LINKED', 'BOOKING_CREATED', 'RIDE_ASSIGNED', 'RIDE_ACKNOWLEDGED', 'RIDE_STARTED', 'RIDE_COMPLETED']) {
      expect(actions).toContain(act);
    }
    const report = await admin.get(`/api/admin/reports?from=${travelDate}&to=${travelDate}`);
    expect(report.body.totals.completed).toBe(1);
    expect(report.body.drivers[0].completed).toBe(1);
    const dash = await admin.get(`/api/admin/dashboard?date=${travelDate}`);
    expect(dash.body.bookings.completed).toBe(1);
    expect(dash.body.employees.active).toBe(1);
    const exported = await admin.get(`/api/admin/reports/export?from=${travelDate}&to=${travelDate}&section=drivers&format=csv`);
    expect(exported.text).toContain('Mohan Singh');
    expect(await EmailOutbox.countDocuments({ status: 'FAILED' })).toBe(0);
  });
});
