import { DateTime } from 'luxon';
import { z } from 'zod';
import { CabAssignment, CabRequest } from '../models/booking.js';
import { Coordinator } from '../models/Coordinator.js';
import { Driver } from '../models/Driver.js';
import { Employee } from '../models/Employee.js';
import { AuditLog } from '../models/system.js';
import { User } from '../models/User.js';
import { Vehicle } from '../models/Vehicle.js';
import { badRequest } from '../utils/errors.js';
import { DATE_RE } from '../utils/time.js';
import type { Actor } from './audit.service.js';
import { currentWorkDay, workDayMatch } from './booking.service.js';
import { getPolicy } from './policy.service.js';
import { assertInScope, bookingScope, scopeFilter } from './scope.service.js';

export const dashboardQuerySchema = z.object({
  date: z.string().regex(DATE_RE).optional(),
  officeLocation: z.string().trim().toUpperCase().optional(),
  // Coordinator dashboard: today's or tomorrow's work day (a shift's after-midnight cabs count for the day it started).
  day: z.enum(['today', 'tomorrow']).optional(),
});

async function defaultDate() {
  const policy = await getPolicy();
  const tz = policy.officeLocations[0]?.timezone ?? 'UTC';
  return DateTime.now().setZone(tz).toFormat('yyyy-MM-dd');
}

async function bookingCounts(match: Record<string, unknown>) {
  const rows = await CabRequest.aggregate([{ $match: match }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  const by = Object.fromEntries(rows.map((r) => [r._id, r.n])) as Record<string, number>;
  const sum = (...k: string[]) => k.reduce((n, s) => n + (by[s] ?? 0), 0);
  return {
    total: Object.values(by).reduce((a, b) => a + b, 0),
    pendingAssignment: sum('REQUESTED', 'APPROVED'),
    pendingApproval: sum('PENDING_APPROVAL'),
    assigned: sum('ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED'),
    activeTrips: sum('IN_PROGRESS'),
    completed: sum('COMPLETED'),
    cancelledOrRejected: sum('CANCELLED', 'REJECTED', 'NO_SHOW'),
    byStatus: by,
  };
}

export async function adminDashboard(q: z.infer<typeof dashboardQuerySchema>) {
  const date = q.date ?? (await defaultDate());
  const office = q.officeLocation;
  const officeMatch = office ? { officeLocation: office } : {};
  const [
    totalEmployees, employeeStatus, activeCoordinators, activeVerifiedDrivers, totalVehicles, activeVehicles,
    busyVehicleIds, bookings, recentActivity, delayed, cancellationRequests,
  ] = await Promise.all([
    Employee.countDocuments({ ...officeMatch, deletedAt: null }),
    Employee.aggregate([{ $match: { ...officeMatch, deletedAt: null } }, { $lookup: { from: 'users', localField: 'user', foreignField: '_id', as: 'u' } }, { $unwind: '$u' }, { $group: { _id: '$u.status', n: { $sum: 1 } } }]),
    (async () => {
      const coords = await Coordinator.find(office ? { officeLocations: office } : {}, { user: 1 }).lean();
      return User.countDocuments({ _id: { $in: coords.map((c) => c.user) }, status: 'ACTIVE' });
    })(),
    Driver.countDocuments({ ...officeMatch, employmentStatus: 'ACTIVE' }),
    Vehicle.countDocuments(officeMatch),
    Vehicle.countDocuments({ ...officeMatch, status: 'ACTIVE' }),
    CabAssignment.distinct('vehicle', { ...officeMatch, status: 'ACTIVE', windowStart: { $lte: new Date() }, windowEnd: { $gte: new Date() } }),
    bookingCounts({ ...officeMatch, travelDate: date }),
    // sign-in/out events stay in the full audit log; the dashboard shows meaningful actions only
    AuditLog.find({ action: { $nin: ['LOGIN', 'LOGOUT'] } }).sort({ createdAt: -1 }).limit(8).select('action summary actorEmail actorRole createdAt').lean(),
    CabRequest.countDocuments({ ...officeMatch, travelDate: date, isDelayed: true }),
    CabRequest.countDocuments({ ...officeMatch, 'cancellationRequest.status': 'PENDING' }),
  ]);
  const es = Object.fromEntries(employeeStatus.map((r) => [r._id, r.n])) as Record<string, number>;
  return {
    date,
    officeLocation: office ?? null,
    employees: { total: totalEmployees, active: es.ACTIVE ?? 0, invited: es.INVITED ?? 0, inactive: (es.INACTIVE ?? 0) + (es.SUSPENDED ?? 0) },
    activeCoordinators,
    activeVerifiedDrivers,
    vehicles: { total: totalVehicles, available: Math.max(0, activeVehicles - busyVehicleIds.length) },
    bookings: { ...bookings, delayed },
    cancellationRequests,
    recentActivity,
  };
}

/**
 * The coordinator's night at a glance, for one work day (today's by default): what needs action,
 * the next rides still waiting for a cab, and whether there are drivers and cabs to cover them.
 */
export async function coordinatorDashboard(actor: Actor, q: z.infer<typeof dashboardQuerySchema>) {
  const bScope = await bookingScope(actor);
  const scope = bScope.offices;
  if (q.officeLocation) assertInScope(scope, q.officeLocation);
  const today = await currentWorkDay();
  const workDay = q.date ?? (q.day === 'tomorrow' ? DateTime.fromISO(today).plus({ days: 1 }).toFormat('yyyy-MM-dd') : today);
  const officeMatch = q.officeLocation ? { officeLocation: q.officeLocation } : scopeFilter(scope);
  const dayMatch = { ...officeMatch, ...workDayMatch(workDay) };
  const [bookings, delayed, nextWaiting, cancellationRequests, driversOnDuty, driversAvailable, activeCabs, cabsWithoutDriver] = await Promise.all([
    bookingCounts(dayMatch),
    CabRequest.countDocuments({ ...dayMatch, isDelayed: true, status: { $in: ['ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'] } }),
    CabRequest.find({ ...dayMatch, status: { $in: ['REQUESTED', 'APPROVED', 'PENDING_APPROVAL'] } })
      .sort({ scheduledPickupAt: 1 })
      .limit(5)
      .select('reference travelDate pickupTime pickupLocation dropLocation status employee')
      .populate('employee', 'fullName employeeId route')
      .lean(),
    CabRequest.countDocuments({ ...officeMatch, 'cancellationRequest.status': 'PENDING' }),
    Driver.countDocuments({ ...officeMatch, onDuty: true, employmentStatus: 'ACTIVE' }),
    Driver.countDocuments({ ...officeMatch, availability: 'AVAILABLE' }),
    Vehicle.countDocuments({ ...officeMatch, status: 'ACTIVE' }),
    Vehicle.countDocuments({ ...officeMatch, status: 'ACTIVE', currentDriver: null }),
  ]);
  return {
    date: workDay,
    day: q.date ? null : (q.day ?? 'today'),
    offices: scope,
    bookings: { ...bookings, delayed },
    nextWaiting,
    cancellationRequests,
    driversOnDuty,
    driversAvailable,
    cabs: { active: activeCabs, withoutDriver: cabsWithoutDriver },
  };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
export const reportQuerySchema = z.object({
  from: z.string().regex(DATE_RE),
  to: z.string().regex(DATE_RE),
  granularity: z.enum(['day', 'week', 'month']).default('day'),
  officeLocation: z.string().trim().toUpperCase().optional(),
});

export async function buildReport(q: z.infer<typeof reportQuerySchema>) {
  if (q.from > q.to) throw badRequest('"from" must be on or before "to"');
  const days = DateTime.fromISO(q.to).diff(DateTime.fromISO(q.from), 'days').days;
  if (days > 366) throw badRequest('Report range cannot exceed one year');
  const match: Record<string, unknown> = { travelDate: { $gte: q.from, $lte: q.to } };
  if (q.officeLocation) match.officeLocation = q.officeLocation;
  const periodExpr =
    q.granularity === 'day'
      ? '$travelDate'
      : q.granularity === 'month'
        ? { $substrBytes: ['$travelDate', 0, 7] }
        : { $dateToString: { format: '%G-W%V', date: { $dateFromString: { dateString: '$travelDate' } } } };

  const [periods, cancellations, drivers, vehicles] = await Promise.all([
    CabRequest.aggregate([
      { $match: match },
      {
        $group: {
          _id: periodExpr,
          requests: { $sum: 1 },
          assigned: { $sum: { $cond: [{ $ifNull: ['$currentAssignment', false] }, 1, 0] } },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', 'CANCELLED'] }, 1, 0] } },
          rejected: { $sum: { $cond: [{ $eq: ['$status', 'REJECTED'] }, 1, 0] } },
          noShow: { $sum: { $cond: [{ $eq: ['$status', 'NO_SHOW'] }, 1, 0] } },
          delayed: { $sum: { $cond: ['$isDelayed', 1, 0] } },
          passengers: { $sum: '$passengers' },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    CabRequest.aggregate([
      { $match: { ...match, status: 'CANCELLED' } },
      { $group: { _id: { role: '$cancelledByRole', reason: '$cancellationReason' }, n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 25 },
    ]),
    utilization('driver', match),
    utilization('vehicle', match),
  ]);
  const totals = periods.reduce(
    (t, p) => {
      for (const k of ['requests', 'assigned', 'completed', 'cancelled', 'rejected', 'noShow', 'delayed', 'passengers']) t[k] = (t[k] ?? 0) + p[k];
      return t;
    },
    {} as Record<string, number>,
  );
  return { query: q, totals, periods, cancellations, drivers, vehicles };
}

async function utilization(kind: 'driver' | 'vehicle', bookingMatch: Record<string, unknown>) {
  const bookingIds = await CabRequest.distinct('_id', bookingMatch);
  const rows = await CabAssignment.aggregate([
    { $match: { booking: { $in: bookingIds } } },
    {
      $group: {
        _id: `$${kind}`,
        assignments: { $sum: 1 },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] } },
        declined: { $sum: { $cond: [{ $eq: ['$status', 'DECLINED'] }, 1, 0] } },
        noShow: { $sum: { $cond: [{ $eq: ['$status', 'NO_SHOW'] }, 1, 0] } },
        reassigned: { $sum: { $cond: [{ $eq: ['$status', 'REASSIGNED'] }, 1, 0] } },
        tripMinutes: {
          $sum: { $cond: [{ $and: ['$completedAt', '$startedAt'] }, { $divide: [{ $subtract: ['$completedAt', '$startedAt'] }, 60000] }, 0] },
        },
        lateArrivals: { $sum: { $cond: [{ $and: ['$arrivedAt', { $gt: ['$arrivedAt', '$scheduledPickupAt'] }] }, 1, 0] } },
      },
    },
    { $lookup: { from: kind === 'driver' ? 'drivers' : 'vehicles', localField: '_id', foreignField: '_id', as: 'ref' } },
    { $unwind: '$ref' },
    { $sort: { completed: -1 } },
  ]);
  return rows.map((r) => ({
    id: r._id,
    name: kind === 'driver' ? `${r.ref.fullName} (${r.ref.driverCode})` : `${r.ref.registrationNumber} ${r.ref.model}`,
    assignments: r.assignments,
    completed: r.completed,
    declined: r.declined,
    noShow: r.noShow,
    reassigned: r.reassigned,
    tripMinutes: Math.round(r.tripMinutes),
    lateArrivals: r.lateArrivals,
  }));
}

export function reportSectionTable(report: Awaited<ReturnType<typeof buildReport>>, section: string): { headers: string[]; rows: unknown[][] } {
  switch (section) {
    case 'periods':
      return {
        headers: ['Period', 'Requests', 'Assigned', 'Completed', 'Cancelled', 'Rejected', 'No-show', 'Delayed', 'Passengers'],
        rows: report.periods.map((p) => [p._id, p.requests, p.assigned, p.completed, p.cancelled, p.rejected, p.noShow, p.delayed, p.passengers]),
      };
    case 'drivers':
    case 'vehicles':
      return {
        headers: [section === 'drivers' ? 'Driver' : 'Vehicle', 'Assignments', 'Completed', 'Declined', 'No-show', 'Reassigned', 'Trip minutes', 'Late arrivals'],
        rows: report[section].map((d) => [d.name, d.assignments, d.completed, d.declined, d.noShow, d.reassigned, d.tripMinutes, d.lateArrivals]),
      };
    case 'cancellations':
      return { headers: ['Cancelled by', 'Reason', 'Count'], rows: report.cancellations.map((c) => [c._id.role ?? '', c._id.reason ?? '', c.n]) };
    default:
      throw badRequest('Unknown report section');
  }
}
