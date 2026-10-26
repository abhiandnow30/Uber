import { describe, expect, it } from 'vitest';
import { Driver } from '../src/models/Driver.js';
import { DriverVehicleLink } from '../src/models/fleetHistory.js';
import { Notification } from '../src/models/system.js';
import { User } from '../src/models/User.js';
import { Vehicle } from '../src/models/Vehicle.js';
import { anonymous, assign, makeAdmin, makeCoordinator, makeDriver, PASSWORD, scenario } from './helpers.js';

const nextYear = () => new Date(Date.now() + 365 * 86400_000).toISOString();

describe('fleet management', () => {
  it('Driver IDs are generated in order and skip IDs already in use', async () => {
    const coord = await makeCoordinator(['HYD']);
    await makeDriver(); // a driver created another way
    await Driver.updateOne({}, { $set: { driverCode: 'DRV002' } });
    const add = (n: number) =>
      coord.client.post('/api/ops/drivers', {
        driverCode: 'IGNORED', fullName: `Driver ${n}`, phone: `+91 9333${n}${n} 0000${n}`,
        licenseNumber: `TS00000000${n}`, licenseExpiry: nextYear(), officeLocation: 'HYD',
      });
    const codes = [];
    for (const n of [1, 2, 3]) codes.push((await add(n).expect(201)).body.driverCode);
    expect(codes).toEqual(['DRV001', 'DRV003', 'DRV004']);
  });

  it('coordinator adds a driver (ready to assign, no account until first sign-in) and a vehicle', async () => {
    const coord = await makeCoordinator(['HYD']);
    const d = await coord.client.post('/api/ops/drivers', {
      fullName: 'Raj Driver', phone: '+91 95555 55555',
      licenseNumber: 'TS1234567890', licenseExpiry: nextYear(), officeLocation: 'HYD',
    });
    expect(d.status).toBe(201);
    expect(d.body.verificationStatus).toBe('VERIFIED'); // no separate verification step
    expect(d.body.driverCode).toMatch(/^DRV\d{3,}$/);
    expect(d.body.email).toBeUndefined();
    expect(await User.exists({ role: 'DRIVER' })).toBeNull(); // no account until the first mobile sign-in

    const v = await coord.client.post('/api/ops/vehicles', { registrationNumber: 'ts 09 zz 0001', model: 'Etios', vehicleType: 'SEDAN', capacity: 4, officeLocation: 'HYD' });
    expect(v.status).toBe(201);
    expect(v.body.registrationNumber).toBe('TS09ZZ0001');
    const dup = await coord.client.post('/api/ops/vehicles', { registrationNumber: 'TS09ZZ0001', model: 'Y', vehicleType: 'SEDAN', capacity: 4, officeLocation: 'HYD' });
    expect(dup.status).toBe(409);

    // model, type and permit are optional: registration, seats and office are enough
    const plain = await coord.client.post('/api/ops/vehicles', { registrationNumber: 'TS09ZZ0003', capacity: 6, officeLocation: 'HYD' });
    expect(plain.status).toBe(201);
    expect(plain.body).toMatchObject({ registrationNumber: 'TS09ZZ0003', capacity: 6, model: '', vehicleType: 'SEDAN' });
  });

  it('coordinators are restricted to their offices', async () => {
    const coord = await makeCoordinator(['BLR']);
    const res = await coord.client.post('/api/ops/vehicles', { registrationNumber: 'TS09ZZ0002', model: 'Etios', vehicleType: 'SEDAN', capacity: 4, officeLocation: 'HYD' });
    expect(res.status).toBe(403);
  });

  it('links drivers to vehicles, replacing previous links and keeping history', async () => {
    const s = await scenario();
    const v2 = await Vehicle.create({ registrationNumber: 'TS09NEW1', model: 'Carens', vehicleType: 'MUV', capacity: 6, officeLocation: 'HYD' });
    await s.coord.client.post('/api/ops/links', { driverId: String(s.drv.driver._id), vehicleId: String(v2._id), reason: 'Bigger car' }).expect(201);
    expect(await DriverVehicleLink.countDocuments({ driver: s.drv.driver._id })).toBe(2);
    expect(await DriverVehicleLink.countDocuments({ driver: s.drv.driver._id, isCurrent: true })).toBe(1);
    expect(String((await Driver.findById(s.drv.driver._id))!.currentVehicle)).toBe(String(v2._id));
    expect((await Vehicle.findById(s.drv.vehicle._id))!.currentDriver).toBeFalsy();
    // ineligible: inactive vehicle
    await Vehicle.updateOne({ _id: s.drv.vehicle._id }, { $set: { status: 'INACTIVE' } });
    const r = await s.coord.client.post('/api/ops/links', { driverId: String(s.drv.driver._id), vehicleId: String(s.drv.vehicle._id) });
    expect(r.status).toBe(422);
  });

  it('a link does not imply availability: flagged-unavailable drivers cannot be assigned', async () => {
    const s = await scenario();
    const from = new Date(Date.now()).toISOString();
    const to = new Date(Date.now() + 3 * 86400_000).toISOString();
    await s.coord.client.post(`/api/ops/drivers/${s.drv.driver._id}/unavailability`, { from, to, reason: 'Medical leave' }).expect(200);
    const res = await assign(s.coord.client, s.bookingId, s.drv);
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/unavailable/);
  });

  it('putting a vehicle into maintenance with upcoming rides alerts the coordinator rather than dropping rides', async () => {
    const s = await scenario();
    await assign(s.coord.client, s.bookingId, s.drv).expect(201);
    await s.coord.client.post(`/api/ops/vehicles/${s.drv.vehicle._id}/status`, { status: 'MAINTENANCE', reason: 'Brake service' }).expect(200);
    expect(await Notification.exists({ user: s.coord.user._id, type: 'VEHICLE_UNAVAILABLE_WITH_ASSIGNMENTS' })).toBeTruthy();
  });
});

describe('driver sign-in with mobile number and vehicle number', () => {
  async function setup() {
    const coord = await makeCoordinator(['HYD']);
    const d = await coord.client.post('/api/ops/drivers', {
      fullName: 'Mobile Driver', phone: '+91 98765 43210',
      licenseNumber: 'TSMOBILE001', licenseExpiry: nextYear(), officeLocation: 'HYD',
    }).expect(201);
    const v = await coord.client.post('/api/ops/vehicles', { registrationNumber: 'TS09AB1234', model: 'Dzire', vehicleType: 'SEDAN', capacity: 4, officeLocation: 'HYD' }).expect(201);
    await coord.client.post('/api/ops/links', { driverId: d.body._id, vehicleId: v.body._id }).expect(201);
    return { coord, driverId: d.body._id as string, vehicleId: v.body._id as string };
  }
  const signIn = (phone: string, password: string, client = anonymous()) => client.post('/api/auth/driver-login', { phone, password });

  it('a driver added without email signs in with the mobile number + its first 4 digits', async () => {
    const { driverId } = await setup();
    expect((await Driver.findById(driverId))!.user).toBeFalsy(); // no account until first sign-in
    const client = anonymous();
    const res = await signIn('98765 43210', '9876', client);
    expect(res.status).toBe(200);
    const me = await client.get('/api/auth/me').expect(200);
    expect(me.body.user.role).toBe('DRIVER');
    const driver = await Driver.findById(driverId);
    expect((await User.findById(driver!.user))!.status).toBe('ACTIVE');
    // with the country code too, same account
    expect((await signIn('+919876543210', '9876')).status).toBe(200);
    expect(await User.countDocuments({ role: 'DRIVER', name: 'Mobile Driver' })).toBe(1);
  });

  it('wrong passwords and unknown numbers get the same refusal; repeated failures lock the number', async () => {
    const { driverId } = await setup();
    const wrong = await signIn('9876543210', '1234');
    const unknown = await signIn('9000000000', '9000');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
    for (let i = 0; i < 4; i++) await signIn('9876543210', '0000');
    const locked = await signIn('9876543210', '9876'); // right details, but locked now
    expect(locked.status).toBe(429);
    await Driver.updateOne({ _id: driverId }, { $unset: { phoneLoginLockedUntil: 1 } });
    expect((await signIn('9876543210', '9876')).status).toBe(200);

    // a driver without a cab can still sign in; deactivating the driver stops sign-in
    await Driver.updateOne({ _id: driverId }, { $set: { employmentStatus: 'INACTIVE' } });
    expect((await signIn('9876543210', '9876')).status).toBe(401);
  });

  it('drivers cannot sign in with email and password, even if they once had one', async () => {
    await setup();
    const drv = await makeDriver();
    const res = await anonymous().post('/api/auth/login', { email: drv.user.email, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toContain('mobile number');
  });

  it('two active drivers cannot be registered with the same mobile number', async () => {
    const { coord } = await setup();
    const dup = await coord.client.post('/api/ops/drivers', {
      fullName: 'Second Driver', phone: '9876543210',
      licenseNumber: 'TSMOBILE002', licenseExpiry: nextYear(), officeLocation: 'HYD',
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_PHONE');
  });
});
