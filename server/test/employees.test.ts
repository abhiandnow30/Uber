import { describe, expect, it } from 'vitest';
import { CabRequest } from '../src/models/booking.js';
import { AuditLog, Notification } from '../src/models/system.js';
import { User } from '../src/models/User.js';
import { Employee } from '../src/models/Employee.js';
import { anonymous, bookingInput, drainOutbox, fakeEmail, makeAdmin, makeCoordinator, makeEmployee } from './helpers.js';

const newEmployee = (o: Record<string, unknown> = {}) => ({
  employeeId: 'EMP2001',
  fullName: 'Kiran Patel',
  email: 'Kiran.Patel@Test.com',
  phone: '+91 98765 43210',
  officeLocation: 'HYD',
  ...o,
});

describe('employee management', () => {
  it('admin adds an employee manually: INVITED status, normalized email, no email (they sign in with Microsoft), audit', async () => {
    const admin = await makeAdmin();
    const res = await admin.client.post('/api/admin/employees', newEmployee());
    expect(res.status).toBe(201);
    const user = await User.findById(res.body.user);
    expect(user!.status).toBe('INVITED');
    expect(user!.email).toBe('kiran.patel@test.com');
    await drainOutbox();
    expect(fakeEmail.to('kiran.patel@test.com')).toHaveLength(0);
    expect(await AuditLog.exists({ action: 'EMPLOYEE_CREATED' })).toBeTruthy();
  });

  it('rejects duplicate employee IDs and emails (case-insensitive)', async () => {
    const admin = await makeAdmin();
    await admin.client.post('/api/admin/employees', newEmployee()).expect(201);
    const dupId = await admin.client.post('/api/admin/employees', newEmployee({ email: 'other@test.com' }));
    expect(dupId.status).toBe(409);
    expect(dupId.body.error.code).toBe('DUPLICATE_EMPLOYEE_ID');
    const dupEmail = await admin.client.post('/api/admin/employees', newEmployee({ employeeId: 'EMP2002', email: 'KIRAN.PATEL@test.com ' }));
    expect(dupEmail.status).toBe(409);
    expect(dupEmail.body.error.code).toBe('DUPLICATE_EMAIL');
    // email already used by a non-employee account
    const adminEmail = await admin.client.post('/api/admin/employees', newEmployee({ employeeId: 'EMP2003', email: 'admin@test.com' }));
    expect(adminEmail.status).toBe(409);
    expect(await Employee.countDocuments()).toBe(1);
  });

  it('validates fields and office location', async () => {
    const admin = await makeAdmin();
    const res = await admin.client.post('/api/admin/employees', newEmployee({ email: 'not-an-email', officeLocation: 'XYZ' }));
    expect(res.status).toBe(422);
    const res2 = await admin.client.post('/api/admin/employees', newEmployee({ officeLocation: 'XYZ' }));
    expect(res2.status).toBe(400);
  });

  it('there are no invitation links to resend or revoke', async () => {
    const admin = await makeAdmin();
    const created = await admin.client.post('/api/admin/employees', newEmployee()).expect(201);
    expect((await admin.client.post(`/api/admin/employees/${created.body._id}/invitation`)).status).toBe(404);
    expect((await admin.client.del(`/api/admin/employees/${created.body._id}/invitation`)).status).toBe(404);
  });

  it('unapproved / not-yet-activated users cannot book cabs', async () => {
    const admin = await makeAdmin();
    await admin.client.post('/api/admin/employees', newEmployee()).expect(201);
    await anonymous().post('/api/me/bookings', bookingInput()).expect(401);
  });

  it('deactivating an employee with open bookings flags them for review instead of deleting', async () => {
    const admin = await makeAdmin();
    const coord = await makeCoordinator(['HYD']);
    const emp = await makeEmployee();
    const b = await emp.client!.post('/api/me/bookings', bookingInput()).expect(201);
    await admin.client.post(`/api/admin/employees/${emp.employee._id}/status`, { status: 'INACTIVE' }).expect(400); // reason required
    await admin.client.post(`/api/admin/employees/${emp.employee._id}/status`, { status: 'INACTIVE', reason: 'Left company' }).expect(200);
    const booking = await CabRequest.findById(b.body.booking._id);
    expect(booking!.status).toBe('REQUESTED'); // unchanged
    expect(booking!.flaggedForReview).toBe(true);
    expect(await Notification.exists({ user: coord.user._id, type: 'EMPLOYEE_DEACTIVATED_WITH_BOOKINGS' })).toBeTruthy();
    expect(await Employee.exists({ _id: emp.employee._id })).toBeTruthy(); // record retained
  });

  it('enforces the account state machine on the backend', async () => {
    const admin = await makeAdmin();
    const created = await admin.client.post('/api/admin/employees', newEmployee()).expect(201);
    const res = await admin.client.post(`/api/admin/employees/${created.body._id}/status`, { status: 'ACTIVE' });
    expect(res.status).toBe(409); // INVITED → ACTIVE only via first Microsoft sign-in
    const res2 = await admin.client.post(`/api/admin/employees/${created.body._id}/status`, { status: 'SUSPENDED', reason: 'x test' });
    expect(res2.status).toBe(409);
  });

  it('lists employees with filters and search', async () => {
    const admin = await makeAdmin();
    await makeEmployee({ office: 'HYD' });
    await makeEmployee({ office: 'BLR' });
    const all = await admin.client.get('/api/admin/employees');
    expect(all.body.total).toBe(2);
    const blr = await admin.client.get('/api/admin/employees?officeLocation=BLR&status=ACTIVE');
    expect(blr.body.total).toBe(1);
    const csv = await admin.client.get('/api/admin/employees/export?format=csv');
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Employee ID');
  });
});

describe('deleting an employee who has left', () => {
  it('someone who never booked a ride is removed completely', async () => {
    const admin = await makeAdmin();
    const emp = await makeEmployee({ employeeId: 'GONE1' });
    const res = await admin.client.post(`/api/admin/employees/${emp.employee._id}/delete`, {}).expect(200); // no reason needed
    expect(res.body).toMatchObject({ permanent: true, cancelledBookings: 0 });
    expect(await Employee.exists({ _id: emp.employee._id })).toBeNull();
    expect(await User.exists({ _id: emp.user._id })).toBeNull();
    expect(await AuditLog.exists({ action: 'EMPLOYEE_DELETED' })).toBeTruthy();
    expect((await emp.client!.get('/api/auth/me')).status).toBe(401); // signed out
  });

  it('someone with rides: upcoming rides are cancelled, personal details erased, past rides keep their name', async () => {
    const admin = await makeAdmin();
    const coord = await makeCoordinator(['HYD']);
    const emp = await makeEmployee({ employeeId: 'GONE2' });
    await Employee.updateOne({ _id: emp.employee._id }, { $set: { phone: '9000060006', homeAddress: 'Flat 1, Kondapur', route: 'Kondapur Cab' } });
    const b = await emp.client!.post('/api/me/bookings', bookingInput()).expect(201);

    const res = await admin.client.post(`/api/admin/employees/${emp.employee._id}/delete`, { reason: 'Resigned' }).expect(200);
    expect(res.body).toMatchObject({ permanent: false, cancelledBookings: 1 });

    const booking = await CabRequest.findById(b.body.booking._id).lean();
    expect(booking!.status).toBe('CANCELLED');
    expect(booking!.cancellationReason).toContain('Employee left the company');
    expect(await Notification.exists({ user: coord.user._id })).toBeTruthy();

    const e = await Employee.findById(emp.employee._id).lean();
    expect(e).toMatchObject({ fullName: emp.employee.fullName, deletedReason: 'Resigned' });
    expect(e!.deletedAt).toBeInstanceOf(Date);
    expect(e).not.toHaveProperty('phone');
    expect(e).not.toHaveProperty('homeAddress');
    expect(e).not.toHaveProperty('route');
    expect((await User.findById(emp.user._id))!.status).toBe('INACTIVE');
    expect((await emp.client!.get('/api/auth/me')).status).toBe(401);

    // gone from the list, the detail page and further actions
    const list = await admin.client.get('/api/admin/employees?q=GONE2').expect(200);
    expect(list.body.items).toHaveLength(0);
    await admin.client.get(`/api/admin/employees/${emp.employee._id}`).expect(404);
    await admin.client.post(`/api/admin/employees/${emp.employee._id}/delete`, { reason: 'Again' }).expect(404);
    await admin.client.post(`/api/admin/employees/${emp.employee._id}/status`, { status: 'ACTIVE' }).expect(404);
  });

  it('cannot delete someone who is on a trip right now; only admins can delete', async () => {
    const admin = await makeAdmin();
    const coord = await makeCoordinator(['HYD']);
    const emp = await makeEmployee();
    const b = await emp.client!.post('/api/me/bookings', bookingInput()).expect(201);
    await CabRequest.updateOne({ _id: b.body.booking._id }, { $set: { status: 'IN_PROGRESS' } });
    const res = await admin.client.post(`/api/admin/employees/${emp.employee._id}/delete`, { reason: 'Resigned' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TRIP_IN_PROGRESS');
    expect((await coord.client.post(`/api/admin/employees/${emp.employee._id}/delete`, { reason: 'Resigned' })).status).toBe(403);
  });
});
