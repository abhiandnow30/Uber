import { z } from 'zod';
import { withTransaction } from '../db.js';
import { CabAssignment } from '../models/booking.js';
import { Coordinator } from '../models/Coordinator.js';
import { AuditLog, AuthToken, Notification, Session } from '../models/system.js';
import { User } from '../models/User.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';
import { escapeRegex, paged, type Pagination } from '../utils/listing.js';
import { audit, type Actor } from './audit.service.js';
import { normalizeEmail } from './auth.service.js';
import { emailDomainAllowed, PHONE_RE } from './employee.service.js';
import { getPolicy } from './policy.service.js';
import { disconnectUserSockets } from '../realtime.js';
import { revokeAllSessions } from './session.service.js';

export const coordinatorSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  email: z.string().trim().email().transform(normalizeEmail).refine(emailDomainAllowed, 'Email must use an official company domain'),
  phone: z.string().trim().min(1, 'Phone number is required').max(25).refine((p) => PHONE_RE.test(p), 'Enter a valid phone number'),
  officeLocations: z.array(z.string().trim().toUpperCase()).min(1, 'Assign at least one office'),
});

async function validateScope(offices: string[]) {
  const policy = await getPolicy();
  const validOffices = policy.officeLocations.map((o) => o.code);
  const badOffice = offices.find((o) => !validOffices.includes(o));
  if (badOffice) throw badRequest(`Unknown office ${badOffice}`);
}

export async function createCoordinator(actor: Actor, input: z.infer<typeof coordinatorSchema>) {
  await validateScope(input.officeLocations);
  return withTransaction(async ({ session }) => {
    if (await User.exists({ email: input.email }).session(session)) throw conflict(`Email ${input.email} is already registered`, 'DUPLICATE_EMAIL');
    const [user] = await User.create(
      [{ email: input.email, name: input.fullName, phone: input.phone, role: 'COORDINATOR', status: 'INVITED', createdBy: actor.id }],
      { session },
    );
    const [coord] = await Coordinator.create([{ ...input, user: user._id }], { session });
    // No email: they activate on their first sign-in with this email and phone number.
    await audit(actor, 'COORDINATOR_CREATED', 'Coordinator', coord._id, `Coordinator ${input.email} created`, { offices: input.officeLocations }, session);
    return coord;
  });
}

export async function updateCoordinator(actor: Actor, id: string, input: Partial<z.infer<typeof coordinatorSchema>>) {
  const coord = await Coordinator.findOne({ _id: id, deletedAt: null });
  if (!coord) throw notFound('Coordinator');
  await validateScope(input.officeLocations ?? coord.officeLocations);
  if (input.email && input.email !== coord.email) throw badRequest('Coordinator email cannot be changed; create a new account instead');
  const before = { officeLocations: coord.officeLocations, fullName: coord.fullName, phone: coord.phone };
  if (input.fullName) coord.fullName = input.fullName;
  if (input.phone !== undefined) coord.phone = input.phone;
  if (input.officeLocations) coord.officeLocations = input.officeLocations;
  await coord.save();
  await User.updateOne({ _id: coord.user }, { $set: { name: coord.fullName, phone: coord.phone } });
  await audit(actor, 'COORDINATOR_UPDATED', 'Coordinator', coord._id, `Coordinator ${coord.email} updated`, { before, after: input });
  // Their live connection follows the offices they handle: it reconnects and joins the new ones.
  if (input.officeLocations && [...before.officeLocations].sort().join() !== [...input.officeLocations].sort().join() && coord.user) {
    await disconnectUserSockets(String(coord.user));
  }
  return coord;
}

export async function listCoordinators(p: Pagination) {
  const filter: Record<string, unknown> = { deletedAt: null };
  if (p.q) {
    const rx = new RegExp(escapeRegex(p.q), 'i');
    filter.$or = [{ fullName: rx }, { email: rx }];
  }
  const [items, total] = await Promise.all([
    Coordinator.find(filter).sort({ fullName: 1 }).skip((p.page - 1) * p.pageSize).limit(p.pageSize).populate('user', 'status lastLoginAt').lean(),
    Coordinator.countDocuments(filter),
  ]);
  return paged(items, total, p);
}

export async function getCoordinator(id: string) {
  const coord = await Coordinator.findOne({ _id: id, deletedAt: null }).populate('user', 'status statusReason lastLoginAt invitedAt activatedAt').lean();
  if (!coord) throw notFound('Coordinator');
  const userId = (coord.user as unknown as { _id: unknown })._id;
  const [activity, assignments] = await Promise.all([
    AuditLog.find({ actor: userId }).sort({ createdAt: -1 }).limit(50).lean(),
    CabAssignment.find({ assignedBy: userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('driver', 'fullName driverCode')
      .populate('vehicle', 'registrationNumber')
      .lean(),
  ]);
  return { ...coord, activity, assignments };
}

/**
 * Removes a coordinator. Someone who never did anything in the app is deleted outright; someone
 * with history (rides assigned, audited actions) keeps only their name on that history: phone and
 * offices are cleared and the account can never sign in again.
 */
export async function deleteCoordinator(actor: Actor, id: string) {
  const coord = await Coordinator.findOne({ _id: id, deletedAt: null }).lean();
  if (!coord) throw notFound('Coordinator');
  const hasHistory = !!(
    (await CabAssignment.exists({ assignedBy: coord.user })) ||
    (await AuditLog.exists({ actor: coord.user, action: { $nin: ['LOGIN', 'LOGOUT', 'ACCOUNT_ACTIVATED'] } }))
  );
  await withTransaction(async ({ session }) => {
    if (!hasHistory) {
      await Coordinator.deleteOne({ _id: coord._id }, { session });
      await User.deleteOne({ _id: coord.user }, { session });
      await AuthToken.deleteMany({ user: coord.user }, { session });
      await Notification.deleteMany({ user: coord.user }, { session });
    } else {
      const now = new Date();
      await Coordinator.updateOne({ _id: coord._id }, { $set: { deletedAt: now, deletedBy: actor.id, officeLocations: [] }, $unset: { phone: 1, shifts: 1 } }, { session });
      await User.updateOne({ _id: coord.user }, { $set: { status: 'INACTIVE', statusReason: 'Deleted', statusChangedAt: now }, $unset: { phone: 1 } }, { session });
      await AuthToken.updateMany({ user: coord.user, usedAt: null, revokedAt: null }, { $set: { revokedAt: now } }, { session });
    }
    await audit(actor, 'COORDINATOR_DELETED', 'Coordinator', coord._id, `Coordinator ${coord.fullName} (${coord.email}) deleted`, { permanent: !hasHistory }, session);
  });
  await revokeAllSessions(coord.user, 'COORDINATOR_DELETED');
  if (!hasHistory) await Session.deleteMany({ user: coord.user });
  return { permanent: !hasHistory };
}
