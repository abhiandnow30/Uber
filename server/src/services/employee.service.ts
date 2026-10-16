import type { PipelineStage } from 'mongoose';
import { z } from 'zod';
import { config } from '../config.js';
import { withTransaction, type TxContext } from '../db.js';
import { OPEN_STATUSES } from '../domain.js';
import { CabRequest } from '../models/booking.js';
import { Employee, EMPLOYEE_EDITABLE_FIELDS } from '../models/Employee.js';
import { AuthToken, Notification, Session } from '../models/system.js';
import { User } from '../models/User.js';
import { AppError, badRequest, conflict, notFound } from '../utils/errors.js';
import { escapeRegex, paged, resolveSort, type Pagination } from '../utils/listing.js';
import { audit, type Actor } from './audit.service.js';
import { employeesUseMicrosoftOnly, issueActivation, normalizeEmail } from './auth.service.js';
import { cancelBookingInternal } from './booking.service.js';
import { activeOfficeCodes } from './policy.service.js';
import { revokeAllSessions } from './session.service.js';

export const EMPLOYEE_ID_RE = /^[A-Z0-9][A-Z0-9_-]{1,29}$/;
export const PHONE_RE = /^\+?[0-9][0-9 ()-]{6,19}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function emailDomainAllowed(email: string) {
  if (!config.allowedEmailDomains.length) return true;
  const domain = email.split('@')[1]?.toLowerCase();
  return !!domain && config.allowedEmailDomains.includes(domain);
}

export const employeeInputSchema = z.object({
  employeeId: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .refine((s) => EMPLOYEE_ID_RE.test(s), 'Employee ID must be 2-30 letters, digits, "-" or "_"'),
  fullName: z.string().trim().min(2, 'Full name is required').max(100),
  email: z
    .string()
    .trim()
    .transform(normalizeEmail)
    .refine((e) => EMAIL_RE.test(e) && e.length <= 254, 'Enter a valid email address')
    .refine(emailDomainAllowed, 'Email must use an official company domain'),
  phone: z
    .string()
    .trim()
    .max(25)
    .refine((p) => p === '' || PHONE_RE.test(p), 'Enter a valid phone number')
    .optional()
    .default(''),
  officeLocation: z.string().trim().toUpperCase().min(1, 'Office location is required'),
  route: z.string().trim().max(120).optional().default(''),
  homeAddress: z.string().trim().max(300).optional().default(''),
});
export type EmployeeInput = z.infer<typeof employeeInputSchema>;

export const employeeUpdateSchema = employeeInputSchema.omit({ employeeId: true }).partial();

async function assertOffice(code: string) {
  const offices = await activeOfficeCodes();
  if (!offices.includes(code)) throw badRequest(`Unknown or inactive office location "${code}". Valid: ${offices.join(', ')}`);
}

/**
 * Create employee + login user (status INVITED) atomically. Uniqueness is checked
 * against both Employee and User collections (an email may belong to a driver or
 * coordinator) and finally enforced by unique indexes.
 */
export async function createEmployee(
  actor: Actor,
  input: EmployeeInput,
  opts: { sendInvitation?: boolean; source?: 'MANUAL' | 'ACCESS_REQUEST' | 'SSO' | 'SEED' } = {},
  outerTx?: TxContext,
) {
  await assertOffice(input.officeLocation);
  const run = async (tx: TxContext) => {
    const { session } = tx;
    const [byId, byEmail, userByEmail] = await Promise.all([
      Employee.findOne({ employeeId: input.employeeId }).session(session).lean(),
      Employee.findOne({ email: input.email }).session(session).lean(),
      User.findOne({ email: input.email }).session(session).lean(),
    ]);
    if (byId) throw conflict(byId.deletedAt ? `Employee ID ${input.employeeId} belonged to a deleted employee and can't be reused` : `Employee ID ${input.employeeId} already exists`, 'DUPLICATE_EMPLOYEE_ID');
    if (byEmail || userByEmail) throw conflict(`Email ${input.email} is already registered`, 'DUPLICATE_EMAIL');

    const [user] = await User.create(
      [{ email: input.email, name: input.fullName, phone: input.phone, role: 'EMPLOYEE', status: 'INVITED', statusChangedAt: new Date(), createdBy: actor.id || undefined }],
      { session },
    );
    const [employee] = await Employee.create(
      [{ ...input, user: user._id, source: opts.source ?? 'MANUAL' }],
      { session },
    );
    // With Microsoft-only sign-in the account activates on the employee's first Microsoft sign-in.
    if (opts.sendInvitation !== false && !employeesUseMicrosoftOnly()) await issueActivation(user, actor, session);
    await audit(
      actor,
      'EMPLOYEE_CREATED',
      'Employee',
      employee._id,
      `Employee ${input.employeeId} (${input.email}) created via ${opts.source ?? 'MANUAL'}`,
      { employeeId: input.employeeId, email: input.email },
      session,
    );
    return employee;
  };
  return outerTx ? run(outerTx) : withTransaction(run);
}

export async function updateEmployee(actor: Actor, id: string, patch: z.infer<typeof employeeUpdateSchema>) {
  if (patch.officeLocation) await assertOffice(patch.officeLocation);
  return withTransaction(async ({ session }) => {
    const employee = await Employee.findById(id).session(session);
    if (!employee) throw notFound('Employee');
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const field of EMPLOYEE_EDITABLE_FIELDS) {
      const value = patch[field];
      if (value !== undefined && value !== (employee[field] ?? '')) {
        changes[field] = { from: employee[field], to: value };
        employee.set(field, value);
      }
    }
    if (patch.email && patch.email !== employee.email) {
      const taken = await User.exists({ email: patch.email, _id: { $ne: employee.user } }).session(session);
      if (taken) throw conflict(`Email ${patch.email} is already registered`, 'DUPLICATE_EMAIL');
      changes.email = { from: employee.email, to: patch.email };
      employee.email = patch.email;
      await User.updateOne({ _id: employee.user }, { $set: { email: patch.email } }, { session });
      // Outstanding invitation links were sent to the old address: revoke them.
      await AuthToken.updateMany({ user: employee.user, usedAt: null, revokedAt: null }, { $set: { revokedAt: new Date() } }, { session });
    }
    if (patch.fullName || patch.phone !== undefined) {
      await User.updateOne(
        { _id: employee.user },
        { $set: { ...(patch.fullName ? { name: patch.fullName } : {}), ...(patch.phone !== undefined ? { phone: patch.phone } : {}) } },
        { session },
      );
    }
    if (!Object.keys(changes).length) return employee;
    if (changes.homeAddress) employee.homeAddressUpdatedAt = new Date();
    await employee.save({ session });
    await audit(actor, 'EMPLOYEE_UPDATED', 'Employee', employee._id, `Employee ${employee.employeeId} updated`, { changes }, session);
    return employee;
  });
}

export const employeeListSchema = z.object({
  officeLocation: z.string().trim().toUpperCase().max(20).optional(),
  route: z.string().trim().max(120).optional(),
  status: z.string().trim().toUpperCase().optional(),
  employeeId: z.string().trim().toUpperCase().max(30).optional(),
});

export async function listEmployees(p: Pagination, f: z.infer<typeof employeeListSchema>) {
  const match: Record<string, unknown> = { deletedAt: null };
  if (f.officeLocation) match.officeLocation = f.officeLocation;
  if (f.route) match.route = f.route;
  if (f.employeeId) match.employeeId = f.employeeId;
  if (p.q) {
    const rx = new RegExp(escapeRegex(p.q), 'i');
    match.$or = [{ fullName: rx }, { email: rx }, { employeeId: rx }, { route: rx }];
  }
  const sort = resolveSort(p.sort, ['fullName', 'employeeId', 'officeLocation', 'route', 'createdAt', 'email'], { createdAt: -1, _id: 1 });
  const pipeline: PipelineStage[] = [
    { $match: match },
    { $lookup: { from: 'users', localField: 'user', foreignField: '_id', as: 'u' } },
    { $unwind: '$u' },
    ...(f.status ? [{ $match: { 'u.status': f.status } }] : []),
    {
      $facet: {
        items: [
          { $sort: sort },
          { $skip: (p.page - 1) * p.pageSize },
          { $limit: p.pageSize },
          {
            $project: {
              employeeId: 1, fullName: 1, email: 1, phone: 1, officeLocation: 1,
              route: 1, source: 1, createdAt: 1, user: 1,
              status: '$u.status', lastLoginAt: '$u.lastLoginAt', invitedAt: '$u.invitedAt', activatedAt: '$u.activatedAt',
            },
          },
        ],
        total: [{ $count: 'n' }],
      },
    },
  ];
  const [res] = await Employee.aggregate(pipeline);
  return paged(res.items, res.total[0]?.n ?? 0, p);
}

export async function getEmployee(id: string) {
  const employee = await Employee.findOne({ _id: id, deletedAt: null }).lean();
  if (!employee) throw notFound('Employee');
  const user = await User.findById(employee.user).select('+passwordHash').lean();
  const [bookings, counts, pendingInvite] = await Promise.all([
    CabRequest.find({ employee: employee._id }).sort({ scheduledPickupAt: -1 }).limit(50).lean(),
    CabRequest.aggregate([{ $match: { employee: employee._id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    AuthToken.findOne({ user: employee.user, purpose: 'ACTIVATION', usedAt: null, revokedAt: null, expiresAt: { $gt: new Date() } })
      .select('expiresAt createdAt')
      .lean(),
  ]);
  return {
    ...employee,
    status: user?.status,
    statusReason: user?.statusReason,
    lastLoginAt: user?.lastLoginAt,
    invitedAt: user?.invitedAt,
    activatedAt: user?.activatedAt,
    // Whether the account can be re-activated directly (has signed in before) or must be re-invited.
    hasCredentials: !!(user?.passwordHash || user?.entraOid),
    pendingInvitation: pendingInvite ? { expiresAt: pendingInvite.expiresAt, sentAt: pendingInvite.createdAt } : null,
    bookingCounts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
    bookings,
  };
}

export async function resendInvitation(actor: Actor, employeeId: string) {
  const employee = await Employee.findById(employeeId).lean();
  if (!employee) throw notFound('Employee');
  return withTransaction(async ({ session }) => {
    const user = await User.findById(employee.user).session(session);
    if (!user) throw notFound('User');
    if (user.status !== 'INVITED') {
      throw new AppError(409, 'INVALID_STATE', `Invitations can only be sent to accounts in INVITED status (current: ${user.status})`);
    }
    const res = await issueActivation(user, actor, session);
    await audit(actor, 'INVITATION_SENT', 'User', user._id, `Activation invitation (re)sent to ${user.email}`, undefined, session);
    return res;
  });
}

export async function revokeInvitation(actor: Actor, employeeId: string) {
  const employee = await Employee.findById(employeeId).lean();
  if (!employee) throw notFound('Employee');
  const res = await AuthToken.updateMany(
    { user: employee.user, purpose: 'ACTIVATION', usedAt: null, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
  await audit(actor, 'INVITATION_REVOKED', 'User', employee.user, `Outstanding invitations revoked for ${employee.email}`, { count: res.modifiedCount });
  return { revoked: res.modifiedCount };
}

// ---------------------------------------------------------------------------
// Employee self-service profile (own record only; identity fields are admin-managed)
// ---------------------------------------------------------------------------
export const selfProfileSchema = z
  .object({
    homeAddress: z.string().trim().min(5, 'Enter your full home address').max(300),
    phone: z
      .string()
      .trim()
      .max(25)
      .refine((p) => p === '' || PHONE_RE.test(p), 'Enter a valid phone number')
      .optional(),
  })
  .strict();

export async function getMyProfile(actor: Actor) {
  const employee = await Employee.findOne({ user: actor.id }).lean();
  if (!employee) throw notFound('Employee profile');
  return employee;
}

export async function updateMyProfile(actor: Actor, input: z.infer<typeof selfProfileSchema>) {
  return withTransaction(async ({ session }) => {
    const employee = await Employee.findOne({ user: actor.id }).session(session);
    if (!employee) throw notFound('Employee profile');
    const changed: string[] = [];
    if (input.homeAddress !== (employee.homeAddress ?? '')) changed.push('homeAddress');
    if (input.phone !== undefined && input.phone !== (employee.phone ?? '')) changed.push('phone');
    if (!changed.length) return employee;
    employee.homeAddress = input.homeAddress;
    if (changed.includes('homeAddress')) employee.homeAddressUpdatedAt = new Date();
    if (input.phone !== undefined) {
      employee.phone = input.phone;
      await User.updateOne({ _id: employee.user }, { $set: { phone: input.phone } }, { session });
    }
    await employee.save({ session });
    // The address itself is personal data: audit which fields changed, not their values.
    await audit(actor, 'EMPLOYEE_PROFILE_SELF_UPDATED', 'Employee', employee._id, `${employee.employeeId} updated own profile`, { fields: changed }, session);
    return employee;
  });
}

// ---------------------------------------------------------------------------
// Delete (e.g. the employee resigned)
// ---------------------------------------------------------------------------
/**
 * Removes an employee. Upcoming rides are cancelled first (drivers released, team notified).
 * Someone who never booked a ride is deleted outright; someone with ride history keeps only
 * their name on past rides: personal details are erased and the account can never sign in again.
 */
export async function deleteEmployee(actor: Actor, id: string, reason: string) {
  const employee = await Employee.findOne({ _id: id, deletedAt: null }).lean();
  if (!employee) throw notFound('Employee');
  if (await CabRequest.exists({ employee: employee._id, status: 'IN_PROGRESS' })) {
    throw new AppError(409, 'TRIP_IN_PROGRESS', `${employee.fullName} is on a trip right now. Delete them after the trip ends.`);
  }
  const open = await CabRequest.find({ employee: employee._id, status: { $in: OPEN_STATUSES } }, { _id: 1 }).lean();
  for (const b of open) {
    await cancelBookingInternal(actor, b._id, `Employee left the company: ${reason}`, OPEN_STATUSES);
  }
  const hasHistory = !!(await CabRequest.exists({ employee: employee._id }));

  await withTransaction(async ({ session }) => {
    const summary = `Employee ${employee.employeeId} (${employee.fullName}, ${employee.email}) deleted: ${reason}`;
    if (!hasHistory) {
      await Employee.deleteOne({ _id: employee._id }, { session });
      await User.deleteOne({ _id: employee.user }, { session });
      await AuthToken.deleteMany({ user: employee.user }, { session });
      await Notification.deleteMany({ user: employee.user }, { session });
    } else {
      const now = new Date();
      await Employee.updateOne(
        { _id: employee._id },
        { $set: { deletedAt: now, deletedReason: reason, deletedBy: actor.id }, $unset: { phone: 1, homeAddress: 1, homeAddressUpdatedAt: 1, route: 1 } },
        { session },
      );
      await User.updateOne({ _id: employee.user }, { $set: { status: 'INACTIVE', statusReason: `Deleted: ${reason}`, statusChangedAt: now }, $unset: { phone: 1 } }, { session });
      await AuthToken.updateMany({ user: employee.user, usedAt: null, revokedAt: null }, { $set: { revokedAt: now } }, { session });
    }
    await audit(actor, 'EMPLOYEE_DELETED', 'Employee', employee._id, summary, { reason, cancelledBookings: open.length, permanent: !hasHistory }, session);
  });
  await revokeAllSessions(employee.user, 'EMPLOYEE_DELETED');
  if (!hasHistory) await Session.deleteMany({ user: employee.user });
  return { permanent: !hasHistory, cancelledBookings: open.length };
}
