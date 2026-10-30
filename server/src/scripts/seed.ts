/**
 * Development seed data. Refuses to run in production.
 * Creates one account per role (all ACTIVE), fleet, and a link.
 */
import { config } from '../config.js';
import { connectDatabase, disconnectDatabase } from '../db.js';
import { Coordinator } from '../models/Coordinator.js';
import { Driver } from '../models/Driver.js';
import { Employee } from '../models/Employee.js';
import { DriverVehicleLink } from '../models/fleetHistory.js';
import { User } from '../models/User.js';
import { Vehicle } from '../models/Vehicle.js';
import { getPolicy } from '../services/policy.service.js';
import { syncIndexes } from './indexes.js';

if (config.isProd) {
  console.error('Refusing to seed a production database.');
  process.exit(1);
}

async function upsertUser(email: string, name: string, role: string, phone = '') {
  return User.findOneAndUpdate(
    { email },
    { $setOnInsert: { email, name, role, phone, status: 'ACTIVE', activatedAt: new Date() } },
    { upsert: true, new: true },
  );
}

await connectDatabase();
await syncIndexes();
await getPolicy();

const admin = await upsertUser('admin@example.com', 'Aditi Admin', 'ADMIN');
const coordUser = await upsertUser('coordinator@example.com', 'Chetan Coordinator', 'COORDINATOR', '+91 90000 00001');
await Coordinator.updateOne(
  { user: coordUser!._id },
  { $setOnInsert: { user: coordUser!._id, fullName: coordUser!.name, email: coordUser!.email, phone: coordUser!.phone, officeLocations: ['HYD', 'BLR'], shifts: [] } },
  { upsert: true },
);

const employees = [
  ['EMP1001', 'Asha Rao', 'employee@example.com', '+91 90000 10001', 'HYD', 'Kondapur Cab'],
  ['EMP1002', 'Vikram Shah', 'vikram.shah@example.com', '+91 90000 10002', 'HYD', 'Madhapur Cab'],
  ['EMP1003', 'Meera Iyer', 'meera.iyer@example.com', '+91 90000 10003', 'BLR', ''],
] as const;
for (const [employeeId, fullName, email, phone, office, route] of employees) {
  const u = await upsertUser(email, fullName, 'EMPLOYEE', phone);
  await Employee.updateOne(
    { user: u!._id },
    {
      $setOnInsert: { user: u!._id, employeeId, fullName, email, phone, officeLocation: office, route, source: 'SEED' },
      ...(employeeId === 'EMP1001' ? { $set: { homeAddress: 'Flat 402, Lake View Apartments, Kondapur, Hyderabad 500084' } } : {}),
    },
    { upsert: true },
  );
}

const nextYear = new Date(Date.now() + 365 * 24 * 3600_000);
const driversSeed = [
  ['DRV001', 'Ramesh Kumar', 'driver@example.com', '+91 90000 20001', 'TS0920190012345', 'HYD'],
  ['DRV002', 'Suresh Reddy', 'driver2@example.com', '+91 90000 20002', 'TS0920180054321', 'HYD'],
] as const;
const vehiclesSeed = [
  ['TS09AB1234', 'Innova Crysta', 'MUV', 6, 'HYD'],
  ['TS09CD5678', 'Dzire', 'SEDAN', 4, 'HYD'],
] as const;
for (let i = 0; i < driversSeed.length; i++) {
  const [driverCode, fullName, email, phone, licenseNumber, office] = driversSeed[i];
  const u = await upsertUser(email, fullName, 'DRIVER', phone);
  const driver = await Driver.findOneAndUpdate(
    { driverCode },
    {
      $setOnInsert: {
        user: u!._id, driverCode, fullName, email, phone, licenseNumber, licenseExpiry: nextYear, officeLocation: office,
        verificationStatus: 'VERIFIED', verifiedAt: new Date(), verifiedBy: admin!._id, employmentStatus: 'ACTIVE', availability: 'AVAILABLE', onDuty: true,
      },
    },
    { upsert: true, new: true },
  );
  const [reg, model, type, capacity, vOffice] = vehiclesSeed[i];
  const vehicle = await Vehicle.findOneAndUpdate(
    { registrationNumber: reg },
    { $setOnInsert: { registrationNumber: reg, model, vehicleType: type, capacity, officeLocation: vOffice, status: 'ACTIVE', insuranceExpiry: nextYear, permitExpiry: nextYear } },
    { upsert: true, new: true },
  );
  if (!(await DriverVehicleLink.exists({ isCurrent: true, $or: [{ driver: driver!._id }, { vehicle: vehicle!._id }] }))) {
    await DriverVehicleLink.create({ driver: driver!._id, vehicle: vehicle!._id, linkedBy: admin!._id, reason: 'Seed' });
    await Driver.updateOne({ _id: driver!._id }, { $set: { currentVehicle: vehicle!._id } });
    await Vehicle.updateOne({ _id: vehicle!._id }, { $set: { currentDriver: driver!._id } });
  }
}

console.log(`
Seed complete.
  Admin        admin@example.com         (Sign in with Microsoft)
  Coordinator  coordinator@example.com   (email + mobile +91 90000 00001; offices HYD, BLR)
  Employee     employee@example.com      (EMP1001, HYD; Sign in with Microsoft)
  Driver       driver@example.com        (DRV001, TS09AB1234; mobile +91 90000 20001)
  Driver       driver2@example.com       (DRV002, TS09CD5678; mobile +91 90000 20002)
`);
await disconnectDatabase();
