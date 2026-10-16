import { describe, expect, it } from 'vitest';
import { Employee } from '../src/models/Employee.js';
import { AuditLog } from '../src/models/system.js';
import { makeAdmin, makeCoordinator, makeDriver, makeEmployee } from './helpers.js';

const HOME = 'Flat 402, Lake View Apartments, Kondapur, Hyderabad 500084';

describe('employee home address', () => {
  it('employees save their own home address and see it on their profile', async () => {
    const emp = await makeEmployee();
    const res = await emp.client!.patch('/api/me/profile', { homeAddress: HOME });
    expect(res.status).toBe(200);
    const me = await emp.client!.get('/api/auth/me');
    expect(me.body.profile.homeAddress).toBe(HOME);
    expect((await Employee.findById(emp.employee._id))!.homeAddressUpdatedAt).toBeInstanceOf(Date);
  });

  it('employees cannot change admin-managed fields through self-service', async () => {
    const emp = await makeEmployee({ office: 'HYD' });
    const res = await emp.client!.patch('/api/me/profile', { homeAddress: HOME, officeLocation: 'BLR', employeeId: 'HACK1' });
    expect(res.status).toBe(422);
    const e = await Employee.findById(emp.employee._id);
    expect(e!.officeLocation).toBe('HYD');
    expect(e!.homeAddress).toBeFalsy();
    expect((await emp.client!.patch('/api/me/profile', { homeAddress: 'x' })).status).toBe(422); // too short
  });

  it('only employees can use the self-service profile endpoint', async () => {
    const drv = await makeDriver();
    const coord = await makeCoordinator();
    await drv.client.patch('/api/me/profile', { homeAddress: HOME }).expect(403);
    await coord.client.get('/api/me/profile').expect(403);
  });

  it('admins can view and edit it; it is not in list views; audit never stores the address', async () => {
    const admin = await makeAdmin();
    const emp = await makeEmployee();
    await emp.client!.patch('/api/me/profile', { homeAddress: HOME }).expect(200);
    const detail = await admin.client.get(`/api/admin/employees/${emp.employee._id}`);
    expect(detail.body.homeAddress).toBe(HOME);
    const list = await admin.client.get('/api/admin/employees');
    expect(JSON.stringify(list.body)).not.toContain('Lake View');
    await admin.client.patch(`/api/admin/employees/${emp.employee._id}`, { homeAddress: 'Plot 7, Madhapur, Hyderabad' }).expect(200);
    expect((await Employee.findById(emp.employee._id))!.homeAddress).toBe('Plot 7, Madhapur, Hyderabad');
    const logs = JSON.stringify(await AuditLog.find().lean());
    expect(logs).not.toContain('Lake View');
    expect(logs).not.toContain('Madhapur');
    expect(logs).toContain('EMPLOYEE_PROFILE_SELF_UPDATED');
  });
});
