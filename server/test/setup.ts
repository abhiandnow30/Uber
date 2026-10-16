import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, inject, vi } from 'vitest';
import { syncIndexes } from '../src/scripts/indexes.js';
import { setEmailProvider } from '../src/services/email/providers.js';
import { Policy } from '../src/models/Policy.js';
import { DEFAULT_OFFICES, invalidatePolicyCache } from '../src/services/policy.service.js';
import { fakeEmail } from './helpers.js';

beforeAll(async () => {
  const base = inject('mongoUri');
  const dbName = `test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  await mongoose.connect(url.toString());
  await syncIndexes();
});

beforeEach(async () => {
  // No test may reach the network (Graph, Entra...). Tests that need fetch stub it explicitly.
  vi.stubGlobal('fetch', () => Promise.reject(new Error('Network access is disabled in tests')));
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
  // Most suites book at arbitrary times; give them the generic rules they were written for.
  // Shift-specific tests switch to the real shifts with useCompanyShifts().
  await Policy.create({
    key: 'global',
    officeLocations: DEFAULT_OFFICES,
    shifts: [
      { code: 'MORNING', name: 'Morning shift (to office)', direction: 'TO_OFFICE', defaultPickupTime: '08:00', active: true },
      { code: 'EVENING', name: 'Evening shift (from office)', direction: 'FROM_OFFICE', defaultPickupTime: '18:30', active: true },
      { code: 'NIGHT', name: 'Night shift', direction: 'ANY', defaultPickupTime: '21:00', active: true },
    ],
    booking: { cabWindowStart: '', cabWindowEnd: '', requireShift: false },
    migrations: ['company-shifts-2026-10'],
  });
  invalidatePolicyCache();
  fakeEmail.reset();
  setEmailProvider(fakeEmail);
});

afterAll(async () => {
  await mongoose.connection.db?.dropDatabase();
  await mongoose.disconnect();
});
