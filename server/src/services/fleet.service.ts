import { z } from 'zod';
import { withTransaction } from '../db.js';
import { DRIVER_EMPLOYMENT, VEHICLE_STATUSES, VEHICLE_TYPES } from '../domain.js';
import { CabAssignment } from '../models/booking.js';
import { Driver } from '../models/Driver.js';
import { DriverVehicleLink, DriverVerification } from '../models/fleetHistory.js';
import { User } from '../models/User.js';
import { Vehicle } from '../models/Vehicle.js';
import { AppError, badRequest, conflict, notFound } from '../utils/errors.js';
import { escapeRegex, paged, resolveSort, type Pagination } from '../utils/listing.js';
import { audit, type Actor } from './audit.service.js';
import { normalizeEmail } from './auth.service.js';
import { refreshDriverAvailability } from './availability.service.js';
import { PHONE_RE } from './employee.service.js';
import { alertOperations } from './alert.service.js';
import { phoneKey } from './driverAuth.service.js';
import { activeOfficeCodes } from './policy.service.js';
import { assertInScope, officeScope, scopeFilter } from './scope.service.js';

const dateStr = z.coerce.date();

// ===========================================================================
// Drivers
// ===========================================================================
export const driverSchema = z.object({
  driverCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,20}$/, 'Driver ID must be 2-20 letters/digits'),
  fullName: z.string().trim().min(2).max(100),
  phone: z.string().trim().refine((p) => PHONE_RE.test(p), 'Enter a valid phone number'),
  email: z.union([z.string().trim().email().transform(normalizeEmail), z.literal('')]).optional().default(''),
  licenseNumber: z.string().trim().toUpperCase().min(5).max(30),
  licenseExpiry: dateStr,
  officeLocation: z.string().trim().toUpperCase(),
});
export const driverUpdateSchema = driverSchema.omit({ driverCode: true }).partial();

async function assertOffice(code: string) {
  if (!(await activeOfficeCodes()).includes(code)) throw badRequest(`Unknown or inactive office ${code}`);
}

export async function createDriver(actor: Actor, input: z.infer<typeof driverSchema>) {
  const scope = await officeScope(actor);
  assertInScope(scope, input.officeLocation);
  await assertOffice(input.officeLocation);
  if (input.licenseExpiry < new Date()) throw badRequest('License is already expired');
  await assertPhoneFree(input.phone);
  return withTransaction(async ({ session }) => {
    if (await Driver.exists({ driverCode: input.driverCode }).session(session)) throw conflict(`Driver ID ${input.driverCode} already exists`);
    if (await Driver.exists({ licenseNumber: input.licenseNumber }).session(session)) throw conflict('A driver with this license number already exists');
    // The driver's account is created on their first mobile sign-in.
    const [driver] = await Driver.create(
      [{ ...input, email: input.email || undefined, verificationStatus: 'PENDING', availability: 'OFFLINE', createdBy: actor.id }],
      { session },
    );
    await audit(actor, 'DRIVER_CREATED', 'Driver', driver._id, `Driver ${driver.driverCode} (${driver.fullName}) created`, { officeLocation: input.officeLocation }, session);
    return driver;
  });
}

/** Mobile sign-in identifies a driver by number, so two active drivers can't share one. */
async function assertPhoneFree(phone: string, exceptDriverId?: unknown) {
  const taken = await Driver.exists({ phoneKey: phoneKey(phone), employmentStatus: { $ne: 'INACTIVE' }, ...(exceptDriverId ? { _id: { $ne: exceptDriverId } } : {}) });
  if (taken) throw conflict('Another driver is already registered with this mobile number', 'DUPLICATE_PHONE');
}

async function loadDriverInScope(actor: Actor, id: string) {
  const driver = await Driver.findById(id);
  if (!driver) throw notFound('Driver');
  assertInScope(await officeScope(actor), driver.officeLocation);
  return driver;
}

export async function updateDriver(actor: Actor, id: string, input: z.infer<typeof driverUpdateSchema>) {
  const driver = await loadDriverInScope(actor, id);
  if (input.officeLocation) {
    assertInScope(await officeScope(actor), input.officeLocation);
    await assertOffice(input.officeLocation);
  }
  if (input.phone && phoneKey(input.phone) !== driver.phoneKey) await assertPhoneFree(input.phone, driver._id);
  const before = driver.toObject();
  const licenseChanged = (input.licenseNumber && input.licenseNumber !== driver.licenseNumber) || (input.licenseExpiry && +input.licenseExpiry !== +driver.licenseExpiry);
  driver.set({ ...input, email: input.email === '' ? undefined : (input.email ?? driver.email) });
  // License details changed: documents must be re-verified before new assignments.
  if (licenseChanged && driver.verificationStatus === 'VERIFIED') driver.verificationStatus = 'PENDING';
  try {
    await driver.save();
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw conflict('A driver with this license number already exists');
    throw err;
  }
  if (input.fullName || input.phone) await User.updateOne({ _id: driver.user }, { $set: { name: driver.fullName, phone: driver.phone } });
  await audit(actor, 'DRIVER_UPDATED', 'Driver', driver._id, `Driver ${driver.driverCode} updated`, {
    changes: Object.fromEntries(Object.keys(input).map((k) => [k, { from: (before as Record<string, unknown>)[k], to: (input as Record<string, unknown>)[k] }])),
    reverificationRequired: licenseChanged,
  });
  return driver;
}

export const verifyDriverSchema = z.object({
  status: z.enum(['VERIFIED', 'REJECTED', 'PENDING']),
  documentsChecked: z.array(z.string().trim().max(50)).max(20).default([]),
  notes: z.string().trim().max(1000).optional().default(''),
});

/** Admin-only document verification. Recorded as an immutable verification entry. */
export async function verifyDriver(actor: Actor, id: string, input: z.infer<typeof verifyDriverSchema>) {
  const driver = await Driver.findById(id);
  if (!driver) throw notFound('Driver');
  if (input.status === 'VERIFIED') {
    if (driver.licenseExpiry < new Date()) throw badRequest('Cannot verify: the driving license has expired');
    if (!input.documentsChecked.length) throw badRequest('List the documents that were checked');
  }
  return withTransaction(async ({ session }) => {
    await DriverVerification.create([{ driver: driver._id, status: input.status, documentsChecked: input.documentsChecked, notes: input.notes, reviewedBy: actor.id }], { session });
    await Driver.updateOne(
      { _id: driver._id },
      { $set: { verificationStatus: input.status, verifiedAt: input.status === 'VERIFIED' ? new Date() : undefined, verifiedBy: actor.id } },
      { session },
    );
    await audit(actor, 'DRIVER_VERIFICATION', 'Driver', driver._id, `Driver ${driver.driverCode} verification: ${input.status}`, input, session);
    return Driver.findById(driver._id).session(session);
  });
}

export const employmentSchema = z.object({ employmentStatus: z.enum(DRIVER_EMPLOYMENT), reason: z.string().trim().min(3).max(500) });

export async function setDriverEmployment(actor: Actor, id: string, input: z.infer<typeof employmentSchema>) {
  const driver = await loadDriverInScope(actor, id);
  return withTransaction(async (tx) => {
    await Driver.updateOne({ _id: driver._id }, { $set: { employmentStatus: input.employmentStatus } }, { session: tx.session });
    if (input.employmentStatus !== 'ACTIVE') {
      const active = await CabAssignment.find({ driver: driver._id, status: 'ACTIVE' }).session(tx.session);
      for (const a of active) {
        await alertOperations(
          {
            type: 'DRIVER_UNAVAILABLE_WITH_ASSIGNMENTS',
            message: `Driver ${driver.fullName} is now ${input.employmentStatus} but holds booking ${a.bookingReference}. Reassign it.`,
            officeLocation: a.officeLocation,
            bookingId: String(a.booking),
            dedupeKey: `DRIVER_EMPLOYMENT:${a._id}:${input.employmentStatus}`,
          },
          tx,
        );
      }
    }
    await refreshDriverAvailability(driver._id, tx.session);
    await audit(actor, 'DRIVER_EMPLOYMENT_CHANGED', 'Driver', driver._id, `Driver ${driver.driverCode}: ${driver.employmentStatus} → ${input.employmentStatus}`, input, tx.session);
    return Driver.findById(driver._id).session(tx.session);
  });
}

export const unavailabilitySchema = z
  .object({ from: dateStr, to: dateStr, reason: z.string().trim().min(3).max(300) })
  .refine((v) => v.to > v.from, { message: '"to" must be after "from"', path: ['to'] });

/** Coordinator flags a driver unavailable for a period; the team is alerted about overlapping assignments. */
export async function flagDriverUnavailable(actor: Actor, id: string, input: z.infer<typeof unavailabilitySchema>) {
  const driver = await loadDriverInScope(actor, id);
  return withTransaction(async (tx) => {
    await Driver.updateOne({ _id: driver._id }, { $push: { unavailablePeriods: { ...input, createdBy: actor.id } } }, { session: tx.session });
    const overlapping = await CabAssignment.find({
      driver: driver._id,
      status: 'ACTIVE',
      windowStart: { $lt: input.to },
      windowEnd: { $gt: input.from },
    }).session(tx.session);
    for (const a of overlapping) {
      await alertOperations(
        {
          type: 'DRIVER_UNAVAILABLE_WITH_ASSIGNMENTS',
          message: `Driver ${driver.fullName} was flagged unavailable (${input.reason}) but is assigned to booking ${a.bookingReference}. Reassign it.`,
          officeLocation: a.officeLocation,
          bookingId: String(a.booking),
          dedupeKey: `DRIVER_UNAVAILABLE:${a._id}:${input.from.toISOString()}`,
        },
        tx,
      );
    }
    await audit(actor, 'DRIVER_FLAGGED_UNAVAILABLE', 'Driver', driver._id, `Driver ${driver.driverCode} unavailable: ${input.reason}`, input, tx.session);
    return { driver: await Driver.findById(driver._id).session(tx.session), affectedAssignments: overlapping.length };
  });
}

export async function removeUnavailability(actor: Actor, id: string, periodId: string) {
  const driver = await loadDriverInScope(actor, id);
  await Driver.updateOne({ _id: driver._id }, { $pull: { unavailablePeriods: { _id: periodId } } });
  await audit(actor, 'DRIVER_UNAVAILABILITY_REMOVED', 'Driver', driver._id, `Unavailability period removed for ${driver.driverCode}`, { periodId });
}

export const driverListSchema = z.object({
  officeLocation: z.string().trim().toUpperCase().optional(),
  verificationStatus: z.string().optional(),
  employmentStatus: z.string().optional(),
  availability: z.string().optional(),
});

export async function listDrivers(actor: Actor, p: Pagination, f: z.infer<typeof driverListSchema>) {
  const scope = await officeScope(actor);
  const filter: Record<string, unknown> = { ...scopeFilter(scope) };
  if (f.officeLocation) {
    assertInScope(scope, f.officeLocation);
    filter.officeLocation = f.officeLocation;
  }
  for (const k of ['verificationStatus', 'employmentStatus', 'availability'] as const) if (f[k]) filter[k] = f[k];
  if (p.q) {
    const rx = new RegExp(escapeRegex(p.q), 'i');
    filter.$or = [{ fullName: rx }, { driverCode: rx }, { phone: rx }, { licenseNumber: rx }];
  }
  const sort = resolveSort(p.sort, ['fullName', 'driverCode', 'licenseExpiry', 'availability', 'createdAt'], { fullName: 1, _id: 1 });
  const [items, total] = await Promise.all([
    Driver.find(filter).sort(sort).skip((p.page - 1) * p.pageSize).limit(p.pageSize).populate('currentVehicle', 'registrationNumber model capacity status').populate('user', 'status lastLoginAt').lean(),
    Driver.countDocuments(filter),
  ]);
  const now = new Date();
  const active = await CabAssignment.aggregate([
    { $match: { driver: { $in: items.map((d) => d._id) }, status: 'ACTIVE', windowEnd: { $gt: now } } },
    { $group: { _id: '$driver', n: { $sum: 1 } } },
  ]);
  const counts = new Map(active.map((a) => [String(a._id), a.n]));
  return paged(items.map((d) => ({ ...d, activeAssignments: counts.get(String(d._id)) ?? 0 })), total, p);
}

export async function getDriver(actor: Actor, id: string) {
  const driver = await loadDriverInScope(actor, id);
  const [full, verifications, links, assignments] = await Promise.all([
    Driver.findById(driver._id).populate('currentVehicle').populate('user', 'status statusReason lastLoginAt invitedAt activatedAt email').lean(),
    DriverVerification.find({ driver: driver._id }).sort({ createdAt: -1 }).populate('reviewedBy', 'name').lean(),
    DriverVehicleLink.find({ driver: driver._id }).sort({ startedAt: -1 }).limit(50).populate('vehicle', 'registrationNumber model').populate('linkedBy', 'name').lean(),
    CabAssignment.find({ driver: driver._id }).sort({ scheduledPickupAt: -1 }).limit(100).populate('vehicle', 'registrationNumber').populate('booking', 'reference status pickupLocation dropLocation travelDate pickupTime').lean(),
  ]);
  return { ...full, verifications, links, assignments };
}

// ===========================================================================
// Vehicles
// ===========================================================================
export const vehicleSchema = z.object({
  registrationNumber: z.string().trim().toUpperCase().transform((s) => s.replace(/\s+/g, '')).pipe(z.string().regex(/^[A-Z0-9-]{4,15}$/, 'Invalid registration number')),
  // Not asked for on the vehicle form any more; kept for older vehicles and integrations.
  model: z.string().trim().max(50).optional(),
  vehicleType: z.enum(VEHICLE_TYPES).optional(),
  capacity: z.coerce.number().int().min(1).max(60),
  officeLocation: z.string().trim().toUpperCase(),
  // '' clears the date (null), omitted leaves it unchanged
  insuranceExpiry: z.union([dateStr, z.literal('').transform(() => null)]).optional(),
  permitExpiry: z.union([dateStr, z.literal('').transform(() => null)]).optional(),
  maintenanceNotes: z.string().trim().max(1000).optional(),
});
export const vehicleUpdateSchema = vehicleSchema.omit({ registrationNumber: true }).partial();
export const vehicleStatusSchema = z.object({
  status: z.enum(VEHICLE_STATUSES),
  reason: z.string().trim().min(3).max(500),
  maintenanceDueAt: z.union([dateStr, z.literal('').transform(() => undefined)]).optional(),
});

export async function createVehicle(actor: Actor, input: z.infer<typeof vehicleSchema>) {
  assertInScope(await officeScope(actor), input.officeLocation);
  await assertOffice(input.officeLocation);
  if (await Vehicle.exists({ registrationNumber: input.registrationNumber })) throw conflict(`Vehicle ${input.registrationNumber} already exists`);
  const vehicle = await Vehicle.create({ ...input, status: 'ACTIVE', createdBy: actor.id });
  await audit(actor, 'VEHICLE_CREATED', 'Vehicle', vehicle._id, `Vehicle ${vehicle.registrationNumber} added`, { officeLocation: input.officeLocation });
  return vehicle;
}

async function loadVehicleInScope(actor: Actor, id: string) {
  const vehicle = await Vehicle.findById(id);
  if (!vehicle) throw notFound('Vehicle');
  assertInScope(await officeScope(actor), vehicle.officeLocation);
  return vehicle;
}

export async function updateVehicle(actor: Actor, id: string, input: z.infer<typeof vehicleUpdateSchema>) {
  const vehicle = await loadVehicleInScope(actor, id);
  if (input.officeLocation) {
    assertInScope(await officeScope(actor), input.officeLocation);
    await assertOffice(input.officeLocation);
  }
  if (input.capacity !== undefined && input.capacity < vehicle.capacity) {
    const tooBig = await CabAssignment.find({ vehicle: vehicle._id, status: 'ACTIVE' }).populate('booking', 'passengers').lean();
    if (tooBig.some((a) => ((a.booking as unknown as { passengers: number })?.passengers ?? 0) > input.capacity!)) {
      throw conflict('Capacity cannot be reduced below passenger counts of upcoming assignments');
    }
  }
  vehicle.set(input);
  await vehicle.save();
  await audit(actor, 'VEHICLE_UPDATED', 'Vehicle', vehicle._id, `Vehicle ${vehicle.registrationNumber} updated`, { changes: input });
  return vehicle;
}

export async function setVehicleStatus(actor: Actor, id: string, input: z.infer<typeof vehicleStatusSchema>) {
  const vehicle = await loadVehicleInScope(actor, id);
  return withTransaction(async (tx) => {
    await Vehicle.updateOne(
      { _id: vehicle._id },
      { $set: { status: input.status, maintenanceNotes: input.status === 'MAINTENANCE' ? input.reason : vehicle.maintenanceNotes, maintenanceDueAt: input.maintenanceDueAt } },
      { session: tx.session },
    );
    if (input.status !== 'ACTIVE') {
      const active = await CabAssignment.find({ vehicle: vehicle._id, status: 'ACTIVE' }).session(tx.session);
      for (const a of active) {
        await alertOperations(
          {
            type: 'VEHICLE_UNAVAILABLE_WITH_ASSIGNMENTS',
            message: `Vehicle ${vehicle.registrationNumber} is now ${input.status} but is assigned to booking ${a.bookingReference}. Reassign it.`,
            officeLocation: a.officeLocation,
            bookingId: String(a.booking),
            dedupeKey: `VEHICLE_STATUS:${a._id}:${input.status}`,
          },
          tx,
        );
      }
    }
    await audit(actor, 'VEHICLE_STATUS_CHANGED', 'Vehicle', vehicle._id, `Vehicle ${vehicle.registrationNumber}: ${vehicle.status} → ${input.status}`, input, tx.session);
    return Vehicle.findById(vehicle._id).session(tx.session);
  });
}

export const vehicleListSchema = z.object({
  officeLocation: z.string().trim().toUpperCase().optional(),
  status: z.string().optional(),
  vehicleType: z.string().optional(),
});

export async function listVehicles(actor: Actor, p: Pagination, f: z.infer<typeof vehicleListSchema>) {
  const scope = await officeScope(actor);
  const filter: Record<string, unknown> = { ...scopeFilter(scope) };
  if (f.officeLocation) {
    assertInScope(scope, f.officeLocation);
    filter.officeLocation = f.officeLocation;
  }
  if (f.status) filter.status = f.status;
  if (f.vehicleType) filter.vehicleType = f.vehicleType;
  if (p.q) {
    const rx = new RegExp(escapeRegex(p.q), 'i');
    filter.$or = [{ registrationNumber: rx }, { model: rx }];
  }
  const sort = resolveSort(p.sort, ['registrationNumber', 'capacity', 'status', 'createdAt'], { registrationNumber: 1, _id: 1 });
  const [items, total] = await Promise.all([
    Vehicle.find(filter).sort(sort).skip((p.page - 1) * p.pageSize).limit(p.pageSize).populate('currentDriver', 'fullName driverCode phone').lean(),
    Vehicle.countDocuments(filter),
  ]);
  return paged(items, total, p);
}

export async function getVehicle(actor: Actor, id: string) {
  const vehicle = await loadVehicleInScope(actor, id);
  const [full, links, assignments] = await Promise.all([
    Vehicle.findById(vehicle._id).populate('currentDriver', 'fullName driverCode phone').lean(),
    DriverVehicleLink.find({ vehicle: vehicle._id }).sort({ startedAt: -1 }).limit(50).populate('driver', 'fullName driverCode').populate('linkedBy', 'name').lean(),
    CabAssignment.find({ vehicle: vehicle._id }).sort({ scheduledPickupAt: -1 }).limit(100).populate('driver', 'fullName driverCode').populate('booking', 'reference status travelDate pickupTime').lean(),
  ]);
  return { ...full, links, assignments };
}

// ===========================================================================
// Driver <-> vehicle links
// ===========================================================================
export const linkSchema = z.object({ driverId: z.string(), vehicleId: z.string(), reason: z.string().trim().max(300).optional().default('') });

/**
 * Link a driver to a vehicle (ending any existing links of both). A link is the
 * driver's default vehicle only; availability is still validated for every ride.
 */
export async function linkDriverVehicle(actor: Actor, input: z.infer<typeof linkSchema>) {
  const scope = await officeScope(actor);
  return withTransaction(async ({ session }) => {
    const [driver, vehicle] = await Promise.all([Driver.findById(input.driverId).session(session), Vehicle.findById(input.vehicleId).session(session)]);
    if (!driver) throw notFound('Driver');
    if (!vehicle) throw notFound('Vehicle');
    assertInScope(scope, driver.officeLocation);
    assertInScope(scope, vehicle.officeLocation);
    const problems: string[] = [];
    if (driver.employmentStatus !== 'ACTIVE') problems.push(`driver is ${driver.employmentStatus}`);
    if (driver.verificationStatus === 'REJECTED') problems.push('driver verification was rejected');
    if (driver.licenseExpiry < new Date()) problems.push('driver license has expired');
    if (vehicle.status === 'INACTIVE') problems.push('vehicle is inactive');
    if (driver.officeLocation !== vehicle.officeLocation) problems.push('driver and vehicle belong to different offices');
    if (problems.length) throw new AppError(422, 'NOT_ELIGIBLE', `Cannot link: ${problems.join('; ')}`);

    const current = await DriverVehicleLink.findOne({ driver: driver._id, vehicle: vehicle._id, isCurrent: true }).session(session);
    if (current) return current;

    const now = new Date();
    const ending = await DriverVehicleLink.find({ isCurrent: true, $or: [{ driver: driver._id }, { vehicle: vehicle._id }] }).session(session);
    for (const l of ending) {
      await DriverVehicleLink.updateOne({ _id: l._id }, { $set: { isCurrent: false, endedAt: now, unlinkedBy: actor.id, endReason: 'Replaced by new link' } }, { session });
      await Driver.updateOne({ _id: l.driver }, { $unset: { currentVehicle: 1 } }, { session });
      await Vehicle.updateOne({ _id: l.vehicle }, { $unset: { currentDriver: 1 } }, { session });
    }
    const [link] = await DriverVehicleLink.create([{ driver: driver._id, vehicle: vehicle._id, startedAt: now, linkedBy: actor.id, reason: input.reason }], { session });
    await Driver.updateOne({ _id: driver._id }, { $set: { currentVehicle: vehicle._id } }, { session });
    await Vehicle.updateOne({ _id: vehicle._id }, { $set: { currentDriver: driver._id } }, { session });
    await audit(actor, 'DRIVER_VEHICLE_LINKED', 'DriverVehicleLink', link._id, `${driver.driverCode} linked to ${vehicle.registrationNumber}`, { replaced: ending.map((l) => String(l._id)), reason: input.reason }, session);
    return link;
  });
}

export async function unlinkDriverVehicle(actor: Actor, linkId: string, reason: string) {
  const scope = await officeScope(actor);
  return withTransaction(async ({ session }) => {
    const link = await DriverVehicleLink.findOne({ _id: linkId, isCurrent: true }).populate('driver', 'officeLocation driverCode').session(session);
    if (!link) throw notFound('Active link');
    assertInScope(scope, (link.driver as unknown as { officeLocation: string }).officeLocation);
    await DriverVehicleLink.updateOne({ _id: link._id }, { $set: { isCurrent: false, endedAt: new Date(), unlinkedBy: actor.id, endReason: reason } }, { session });
    await Driver.updateOne({ _id: (link.driver as unknown as { _id: unknown })._id }, { $unset: { currentVehicle: 1 } }, { session });
    await Vehicle.updateOne({ _id: link.vehicle }, { $unset: { currentDriver: 1 } }, { session });
    await audit(actor, 'DRIVER_VEHICLE_UNLINKED', 'DriverVehicleLink', link._id, 'Driver-vehicle link ended', { reason }, session);
  });
}

export async function listLinks(actor: Actor, p: Pagination, currentOnly: boolean) {
  const scope = await officeScope(actor);
  const filter: Record<string, unknown> = currentOnly ? { isCurrent: true } : {};
  if (scope !== null) {
    const drivers = await Driver.find(scopeFilter(scope), { _id: 1 }).lean();
    filter.driver = { $in: drivers.map((d) => d._id) };
  }
  const [items, total] = await Promise.all([
    DriverVehicleLink.find(filter)
      .sort({ startedAt: -1 })
      .skip((p.page - 1) * p.pageSize)
      .limit(p.pageSize)
      .populate('driver', 'fullName driverCode verificationStatus employmentStatus availability officeLocation')
      .populate('vehicle', 'registrationNumber model capacity status')
      .populate('linkedBy', 'name')
      .populate('unlinkedBy', 'name')
      .lean(),
    DriverVehicleLink.countDocuments(filter),
  ]);
  return paged(items, total, p);
}
