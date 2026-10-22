import mongoose from 'mongoose';
import { logger } from '../logger.js';
import { DEFAULT_SHIFTS, invalidatePolicyCache } from '../services/policy.service.js';
import '../models/User.js';
import '../models/Employee.js';
import '../models/Coordinator.js';
import '../models/Driver.js';
import '../models/Vehicle.js';
import '../models/fleetHistory.js';
import '../models/booking.js';
import '../models/system.js';
import '../models/Policy.js';
import '../models/Counter.js';

/**
 * Creates collections and indexes for every model (idempotent). Collections must
 * exist before multi-document transactions write to them. This acts as the schema
 * "migration" step for MongoDB; it is safe to run on every start.
 */
/** Collections of features that were removed; dropped so their data doesn't linger. */
const RETIRED_COLLECTIONS = ['importjobs', 'importrows', 'operationalexceptions', 'accessrequests'];

export async function syncIndexes() {
  const existing = new Set((await mongoose.connection.db!.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const name of RETIRED_COLLECTIONS) {
    if (existing.has(name)) {
      await mongoose.connection.db!.dropCollection(name);
      logger.info({ collection: name }, 'Dropped retired collection');
    }
  }
  for (const name of mongoose.modelNames()) {
    const model = mongoose.model(name);
    await model.createCollection().catch(() => undefined);
    await model.syncIndexes();
  }
  // One-time: replace the original sample shifts with the company's shifts and cab hours.
  // Old shifts stay (inactive) so existing bookings still show their shift name.
  const policies = mongoose.model('Policy');
  const MIGRATION = 'company-shifts-2026-10';
  const p = await policies.findOne({ key: 'global', migrations: { $ne: MIGRATION } }).lean<{ _id: unknown; shifts?: Array<{ code: string }> } | null>();
  if (p) {
    const newCodes = DEFAULT_SHIFTS.map((s) => s.code);
    const kept = (p.shifts ?? []).filter((s) => !newCodes.includes(s.code)).map((s) => ({ ...s, active: false }));
    await policies.updateOne(
      { _id: p._id },
      {
        $set: { shifts: [...DEFAULT_SHIFTS, ...kept], 'booking.cabWindowStart': '20:00', 'booking.cabWindowEnd': '06:00', 'booking.requireShift': true },
        $addToSet: { migrations: MIGRATION },
      },
    );
    invalidatePolicyCache();
    logger.info('Policy updated to company shifts and cab hours');
  }

  // Preferences added later default to on in existing policies (so admins can also switch them off).
  const added = await policies.updateOne({ key: 'global', 'notifications.dailyBookingReminder': { $exists: false } }, { $set: { 'notifications.dailyBookingReminder': true } });
  if (added.modifiedCount) invalidatePolicyCache();

  // Coordinators are no longer limited by shift.
  await mongoose.connection.db!.collection('coordinators').updateMany({ shifts: { $exists: true } }, { $unset: { shifts: '' } });

  // Drivers saved before mobile sign-in existed have no phoneKey yet.
  const drivers = mongoose.model('Driver');
  for (const d of await drivers.find({ phoneKey: { $exists: false } }, { phone: 1 }).lean<Array<{ _id: unknown; phone?: string }>>()) {
    if (d.phone) await drivers.updateOne({ _id: d._id }, { $set: { phoneKey: d.phone.replace(/\D/g, '').slice(-10) } });
  }
  logger.info({ models: mongoose.modelNames().length }, 'Indexes synchronised');
}
