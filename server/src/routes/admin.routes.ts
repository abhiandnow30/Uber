import { Router } from 'express';
import { z } from 'zod';
import { ACCOUNT_STATUSES } from '../domain.js';
import { actorFromRequest, requireRole } from '../middleware/auth.js';
import { body, objectId, query } from '../middleware/common.js';
import { Coordinator } from '../models/Coordinator.js';
import { Driver } from '../models/Driver.js';
import { Employee } from '../models/Employee.js';
import { AuditLog, EmailOutbox } from '../models/system.js';
import { User } from '../models/User.js';
import { setAccountStatus } from '../services/account.service.js';
import { adminSchema, createAdmin, deleteAdmin, getAdminUserId, listAdmins } from '../services/admin.service.js';
import { audit } from '../services/audit.service.js';
import { issueActivation } from '../services/auth.service.js';
import { coordinatorSchema, createCoordinator, deleteCoordinator, getCoordinator, listCoordinators, updateCoordinator } from '../services/coordinator.service.js';
import { retryOutboxMessage } from '../services/email/outbox.worker.js';
import {
  createEmployee,
  deleteEmployee,
  employeeInputSchema,
  employeeListSchema,
  employeeUpdateSchema,
  getEmployee,
  listEmployees,
  resendInvitation,
  revokeInvitation,
  updateEmployee,
} from '../services/employee.service.js';
import { getPolicy, policyUpdateSchema, updatePolicy } from '../services/policy.service.js';
import { adminDashboard, buildReport, dashboardQuerySchema, reportQuerySchema, reportSectionTable } from '../services/report.service.js';
import { withTransaction } from '../db.js';
import { toCsv, toXlsx } from '../utils/csv.js';
import { AppError, notFound } from '../utils/errors.js';
import { escapeRegex, paged, paginationSchema } from '../utils/listing.js';

export const adminRouter = Router();
adminRouter.use(requireRole('ADMIN'));

const statusSchema = z.object({ status: z.enum(ACCOUNT_STATUSES), reason: z.string().trim().max(500).optional() });

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
adminRouter.get('/dashboard', async (req, res) => {
  res.json(await adminDashboard(query(dashboardQuerySchema, req)));
});

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------
adminRouter.get('/employees', async (req, res) => {
  res.json(await listEmployees(query(paginationSchema, req), query(employeeListSchema, req)));
});

adminRouter.post('/employees', async (req, res) => {
  const input = body(employeeInputSchema.extend({ sendInvitation: z.boolean().optional().default(true) }), req);
  const { sendInvitation, ...data } = input;
  const employee = await createEmployee(actorFromRequest(req), data, { sendInvitation, source: 'MANUAL' });
  res.status(201).json(employee);
});

/** Routes (cab names) already in use, so admins pick an existing one instead of retyping it. */
adminRouter.get('/employees/routes', async (_req, res) => {
  const routes = (await Employee.distinct('route', { route: { $nin: [null, ''] }, deletedAt: null })) as string[];
  res.json(routes.sort((a, b) => a.localeCompare(b)));
});

adminRouter.get('/employees/export', async (req, res) => {
  const format = String(req.query.format ?? 'csv');
  const f = query(employeeListSchema, req);
  const all = await listEmployees({ page: 1, pageSize: 100_000, q: query(paginationSchema, req).q }, f);
  const headers = ['Employee ID', 'Full name', 'Email', 'Phone', 'Office', 'Route', 'Status', 'Last login', 'Created'];
  const rows = (all.items as Array<Record<string, unknown>>).map((e) => [
    e.employeeId, e.fullName, e.email, e.phone, e.officeLocation, e.route, e.status,
    e.lastLoginAt ? new Date(e.lastLoginAt as string).toISOString() : '', new Date(e.createdAt as string).toISOString(),
  ]);
  await audit(actorFromRequest(req), 'EMPLOYEES_EXPORTED', 'Employee', null, `Exported ${rows.length} employees as ${format}`, { filters: f });
  if (format === 'xlsx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="employees.xlsx"');
    return res.send(await toXlsx('Employees', headers, rows));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="employees.csv"');
  res.send(toCsv(headers, rows));
});

adminRouter.get('/employees/:id', async (req, res) => {
  res.json(await getEmployee(objectId(req.params.id, 'Employee')));
});

adminRouter.patch('/employees/:id', async (req, res) => {
  res.json(await updateEmployee(actorFromRequest(req), objectId(req.params.id, 'Employee'), body(employeeUpdateSchema, req)));
});

adminRouter.post('/employees/:id/delete', async (req, res) => {
  const input = body(z.object({ reason: z.string().trim().max(300).optional().default('') }), req);
  res.json(await deleteEmployee(actorFromRequest(req), objectId(req.params.id, 'Employee'), input.reason || 'Deleted by admin'));
});

adminRouter.post('/employees/:id/status', async (req, res) => {
  const emp = await Employee.findOne({ _id: objectId(req.params.id, 'Employee'), deletedAt: null }).lean();
  if (!emp) throw notFound('Employee');
  const input = body(statusSchema, req);
  const user = await setAccountStatus(actorFromRequest(req), String(emp.user), input.status, input.reason);
  res.json({ status: user.status });
});

adminRouter.post('/employees/:id/invitation', async (req, res) => {
  res.json(await resendInvitation(actorFromRequest(req), objectId(req.params.id, 'Employee')));
});

adminRouter.delete('/employees/:id/invitation', async (req, res) => {
  res.json(await revokeInvitation(actorFromRequest(req), objectId(req.params.id, 'Employee')));
});

// ---------------------------------------------------------------------------
// Admins
// ---------------------------------------------------------------------------
adminRouter.get('/admins', async (req, res) => {
  res.json(await listAdmins(query(paginationSchema, req)));
});
adminRouter.post('/admins', async (req, res) => {
  res.status(201).json(await createAdmin(actorFromRequest(req), body(adminSchema, req)));
});
adminRouter.post('/admins/:id/status', async (req, res) => {
  const userId = await getAdminUserId(objectId(req.params.id, 'Admin'));
  const input = body(statusSchema, req);
  res.json({ status: (await setAccountStatus(actorFromRequest(req), userId, input.status, input.reason)).status });
});
adminRouter.post('/admins/:id/delete', async (req, res) => {
  res.json(await deleteAdmin(actorFromRequest(req), objectId(req.params.id, 'Admin')));
});
adminRouter.post('/admins/:id/invitation', async (req, res) => {
  res.json(await resendForUser(req, await getAdminUserId(objectId(req.params.id, 'Admin'))));
});

// ---------------------------------------------------------------------------
// Coordinators
// ---------------------------------------------------------------------------
adminRouter.get('/coordinators', async (req, res) => {
  res.json(await listCoordinators(query(paginationSchema, req)));
});
adminRouter.post('/coordinators', async (req, res) => {
  res.status(201).json(await createCoordinator(actorFromRequest(req), body(coordinatorSchema, req)));
});
adminRouter.get('/coordinators/:id', async (req, res) => {
  res.json(await getCoordinator(objectId(req.params.id, 'Coordinator')));
});
adminRouter.patch('/coordinators/:id', async (req, res) => {
  res.json(await updateCoordinator(actorFromRequest(req), objectId(req.params.id, 'Coordinator'), body(coordinatorSchema.partial(), req)));
});
adminRouter.post('/coordinators/:id/delete', async (req, res) => {
  res.json(await deleteCoordinator(actorFromRequest(req), objectId(req.params.id, 'Coordinator')));
});
adminRouter.post('/coordinators/:id/status', async (req, res) => {
  const c = await Coordinator.findOne({ _id: objectId(req.params.id, 'Coordinator'), deletedAt: null }).lean();
  if (!c) throw notFound('Coordinator');
  const input = body(statusSchema, req);
  res.json({ status: (await setAccountStatus(actorFromRequest(req), String(c.user), input.status, input.reason)).status });
});

// Driver login accounts (admin-only account status / invitation management)
adminRouter.post('/drivers/:id/account-status', async (req, res) => {
  const d = await Driver.findById(objectId(req.params.id, 'Driver')).lean();
  if (!d?.user) throw notFound('Driver account');
  const input = body(statusSchema, req);
  res.json({ status: (await setAccountStatus(actorFromRequest(req), String(d.user), input.status, input.reason)).status });
});
async function resendForUser(req: Parameters<typeof actorFromRequest>[0], userId: string) {
  const actor = actorFromRequest(req);
  return withTransaction(async ({ session }) => {
    const user = await User.findById(userId).session(session);
    if (!user) throw notFound('User');
    if (user.status !== 'INVITED') throw new AppError(409, 'INVALID_STATE', `Invitations can only be sent to INVITED accounts (current: ${user.status})`);
    const r = await issueActivation(user, actor, session);
    await audit(actor, 'INVITATION_SENT', 'User', user._id, `Activation invitation (re)sent to ${user.email}`, undefined, session);
    return r;
  });
}

// ---------------------------------------------------------------------------
// Policies (read is available to all roles via /api/policy)
// ---------------------------------------------------------------------------
adminRouter.put('/policy', async (req, res) => {
  res.json(await updatePolicy(actorFromRequest(req), body(policyUpdateSchema, req)));
});
adminRouter.get('/policy', async (_req, res) => {
  res.json(await getPolicy());
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
adminRouter.get('/reports', async (req, res) => {
  res.json(await buildReport(query(reportQuerySchema, req)));
});

adminRouter.get('/reports/export', async (req, res) => {
  const q = query(reportQuerySchema.extend({ section: z.enum(['periods', 'drivers', 'vehicles', 'cancellations']), format: z.enum(['csv', 'xlsx']).default('csv') }), req);
  const report = await buildReport(q);
  const { headers, rows } = reportSectionTable(report, q.section);
  const name = `report-${q.section}-${q.from}-to-${q.to}`;
  await audit(actorFromRequest(req), 'REPORT_EXPORTED', 'Report', null, `Exported ${q.section} report ${q.from}..${q.to}`, { query: q });
  if (q.format === 'xlsx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
    return res.send(await toXlsx(q.section, headers, rows));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
  res.send(toCsv(headers, rows));
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
adminRouter.get('/audit', async (req, res) => {
  const p = query(paginationSchema, req);
  const f = query(z.object({ action: z.string().optional(), entityType: z.string().optional(), entityId: z.string().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() }), req);
  const filter: Record<string, unknown> = {};
  if (f.action) filter.action = f.action;
  if (f.entityType) filter.entityType = f.entityType;
  if (f.entityId) filter.entityId = f.entityId;
  if (f.from || f.to) filter.createdAt = { ...(f.from ? { $gte: f.from } : {}), ...(f.to ? { $lte: f.to } : {}) };
  if (p.q) {
    const rx = new RegExp(escapeRegex(p.q), 'i');
    filter.$or = [{ summary: rx }, { actorEmail: rx }, { action: rx }];
  }
  const [items, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip((p.page - 1) * p.pageSize).limit(p.pageSize).lean(),
    AuditLog.countDocuments(filter),
  ]);
  res.json(paged(items, total, p));
});

// ---------------------------------------------------------------------------
// Email outbox (failed notifications view)
// ---------------------------------------------------------------------------
adminRouter.get('/outbox', async (req, res) => {
  const p = query(paginationSchema, req);
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const filter: Record<string, unknown> = status ? { status: { $in: status.split(',') } } : {};
  if (p.q) filter.to = new RegExp(escapeRegex(p.q), 'i');
  const [items, total, counts] = await Promise.all([
    EmailOutbox.find(filter).sort({ createdAt: -1 }).skip((p.page - 1) * p.pageSize).limit(p.pageSize).select('-params').populate('relatedBooking', 'reference').lean(),
    EmailOutbox.countDocuments(filter),
    EmailOutbox.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  res.json({ ...paged(items, total, p), counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) });
});

adminRouter.post('/outbox/:id/retry', async (req, res) => {
  const job = await retryOutboxMessage(objectId(req.params.id, 'Message'));
  if (!job) throw new AppError(409, 'INVALID_STATE', 'Only failed messages can be retried');
  await audit(actorFromRequest(req), 'EMAIL_RETRY', 'EmailOutbox', job._id, `Retry requested for ${job.template} to ${job.to}`);
  res.json({ ok: true });
});

