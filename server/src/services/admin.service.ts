import { z } from 'zod';
import { withTransaction } from '../db.js';
import { User } from '../models/User.js';
import { conflict, notFound } from '../utils/errors.js';
import { escapeRegex, paged, type Pagination } from '../utils/listing.js';
import { audit, type Actor } from './audit.service.js';
import { adminsUseMicrosoft, issueActivation, normalizeEmail } from './auth.service.js';
import { emailDomainAllowed, PHONE_RE } from './employee.service.js';

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
      .select('name email phone status statusReason lastLoginAt invitedAt activatedAt createdAt +passwordHash entraOid')
      .lean(),
    User.countDocuments(filter),
    User.aggregate([{ $match: { role: 'ADMIN' } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  const byStatus = Object.fromEntries(counts.map((c) => [c._id, c.n])) as Record<string, number>;
  return {
    ...paged(
      // never send the hash; the page only needs to know whether a direct reactivation is possible
      items.map(({ passwordHash, entraOid, ...u }) => ({ ...u, hasCredentials: !!(passwordHash || entraOid) })),
      total,
      p,
    ),
    summary: { total: Object.values(byStatus).reduce((a, b) => a + b, 0), active: byStatus.ACTIVE ?? 0, invited: byStatus.INVITED ?? 0 },
  };
}

/**
 * Creates an admin in "Invited" status. With Microsoft sign-in they activate on their first
 * Microsoft sign-in; otherwise they get the same set-password email as coordinators.
 */
export async function createAdmin(actor: Actor, input: z.infer<typeof adminSchema>) {
  return withTransaction(async ({ session }) => {
    if (await User.exists({ email: input.email }).session(session)) throw conflict(`Email ${input.email} is already registered`, 'DUPLICATE_EMAIL');
    const [user] = await User.create(
      [{ email: input.email, name: input.fullName, phone: input.phone, role: 'ADMIN', status: 'INVITED', statusChangedAt: new Date(), createdBy: actor.id }],
      { session },
    );
    if (!adminsUseMicrosoft()) await issueActivation(user, actor, session);
    await audit(actor, 'ADMIN_CREATED', 'User', user._id, `Admin ${input.email} created`, undefined, session);
    return { _id: user._id, name: user.name, email: user.email, phone: user.phone, status: user.status };
  });
}

export async function getAdminUserId(id: string) {
  const user = await User.findOne({ _id: id, role: 'ADMIN' }, { _id: 1 }).lean();
  if (!user) throw notFound('Admin');
  return String(user._id);
}
