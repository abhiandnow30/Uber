import { z } from 'zod';
import { withTransaction } from '../db.js';
import { Notification, Session } from '../models/system.js';
import { User } from '../models/User.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';
import { escapeRegex, paged, type Pagination } from '../utils/listing.js';
import { audit, type Actor } from './audit.service.js';
import { normalizeEmail } from './auth.service.js';
import { emailDomainAllowed, PHONE_RE } from './employee.service.js';
import { revokeAllSessions } from './session.service.js';

export const adminSchema = z.object({
  fullName: z.string().trim().min(2, 'Full name is required').max(100),
  email: z.string().trim().email('Enter a valid email address').transform(normalizeEmail).refine(emailDomainAllowed, 'Email must use an official company domain'),
  phone: z.string().trim().min(1, 'Phone number is required').max(25).refine((p) => PHONE_RE.test(p), 'Enter a valid phone number'),
});

/** Admin accounts plus counts, so the page can show how many admins there are. */
export async function listAdmins(p: Pagination) {
  const filter: Record<string, unknown> = { role: 'ADMIN' };
  if (p.q) {
    const rx = new RegExp(escapeRegex(p.q), 'i');
    filter.$or = [{ name: rx }, { email: rx }, { phone: rx }];
  }
  const [items, total, counts] = await Promise.all([
    User.find(filter)
      .sort({ name: 1 })
      .skip((p.page - 1) * p.pageSize)
      .limit(p.pageSize)
      .select('name email phone status statusReason lastLoginAt invitedAt activatedAt createdAt entraOid')
      .lean(),
    User.countDocuments(filter),
    User.aggregate([{ $match: { role: 'ADMIN' } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  const byStatus = Object.fromEntries(counts.map((c) => [c._id, c.n])) as Record<string, number>;
  return {
    ...paged(
      // The page only needs to know whether the admin has signed in with Microsoft before.
      items.map(({ entraOid, ...u }) => ({ ...u, hasCredentials: !!entraOid })),
      total,
      p,
    ),
    summary: { total: Object.values(byStatus).reduce((a, b) => a + b, 0), active: byStatus.ACTIVE ?? 0, invited: byStatus.INVITED ?? 0 },
  };
}

/**
 * Creates an admin in "Invited" status. They activate on their first Microsoft sign-in.
 */
export async function createAdmin(actor: Actor, input: z.infer<typeof adminSchema>) {
  return withTransaction(async ({ session }) => {
    if (await User.exists({ email: input.email }).session(session)) throw conflict(`Email ${input.email} is already registered`, 'DUPLICATE_EMAIL');
    const [user] = await User.create(
      [{ email: input.email, name: input.fullName, phone: input.phone, role: 'ADMIN', status: 'INVITED', statusChangedAt: new Date(), createdBy: actor.id }],
      { session },
    );
    await audit(actor, 'ADMIN_CREATED', 'User', user._id, `Admin ${input.email} created`, undefined, session);
    return { _id: user._id, name: user.name, email: user.email, phone: user.phone, status: user.status };
  });
}

/**
 * Permanently removes an admin account. Audit entries keep the actor's email, so history stays readable.
 * Nobody can delete themselves, and the last active admin can never be removed.
 */
export async function deleteAdmin(actor: Actor, id: string) {
  const admin = await User.findOne({ _id: id, role: 'ADMIN' }).lean();
  if (!admin) throw notFound('Admin');
  if (String(admin._id) === String(actor.id)) throw badRequest('You cannot delete your own account');
  if (admin.status === 'ACTIVE' && (await User.countDocuments({ role: 'ADMIN', status: 'ACTIVE' })) <= 1) {
    throw badRequest('The only active admin cannot be deleted');
  }
  await withTransaction(async ({ session }) => {
    await User.deleteOne({ _id: admin._id }, { session });
    await Notification.deleteMany({ user: admin._id }, { session });
    await audit(actor, 'ADMIN_DELETED', 'User', admin._id, `Admin ${admin.name} (${admin.email}) deleted`, undefined, session);
  });
  await revokeAllSessions(admin._id, 'ADMIN_DELETED');
  await Session.deleteMany({ user: admin._id });
  return { deleted: true };
}

export async function getAdminUserId(id: string) {
  const user = await User.findOne({ _id: id, role: 'ADMIN' }, { _id: 1 }).lean();
  if (!user) throw notFound('Admin');
  return String(user._id);
}
