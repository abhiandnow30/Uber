import { Router } from 'express';
import { z } from 'zod';
import { actorFromRequest, requireRole } from '../middleware/auth.js';
import { body, objectId, pinLimiter, query } from '../middleware/common.js';
import { CabRequest } from '../models/booking.js';
import { Employee } from '../models/Employee.js';
import { Notification } from '../models/system.js';
import {
  cancelMyBooking,
  createBooking,
  createBookingSchema,
  getMyBooking,
  hasCabForCurrentWorkDay,
  listMyBookings,
  requestCancellation,
  updateBookingSchema,
  updateMyBooking,
} from '../services/booking.service.js';
import {
  acknowledge,
  addDriverNote,
  completeTrip,
  driverCancel,
  driverCancelSchema,
  driverHome,
  driverRide,
  driverRideHistory,
  markArrived,
  markEnRoute,
  markNoShow,
  setDuty,
  verifyPinAndStart,
} from '../services/trip.service.js';
import { OPEN_STATUSES, TERMINAL_STATUSES } from '../domain.js';
import { getMyProfile, selfProfileSchema, updateMyProfile } from '../services/employee.service.js';
import { paginationSchema } from '../utils/listing.js';
import { AppError } from '../utils/errors.js';

// ===========================================================================
// Employee self-service: every query is filtered by the caller's own user id.
// ===========================================================================
export const employeeRouter = Router();
employeeRouter.use(requireRole('EMPLOYEE'));

employeeRouter.get('/home', async (req, res) => {
  const me = req.auth!.user._id;
  const employee = await Employee.findOne({ user: me }).select('officeLocation').lean();
  const [pending, upcoming, recent, unread, bookedToday] = await Promise.all([
    CabRequest.find({ employeeUser: me, status: { $in: ['REQUESTED', 'PENDING_APPROVAL', 'APPROVED'] } }).sort({ scheduledPickupAt: 1 }).limit(10).lean(),
    CabRequest.find({ employeeUser: me, status: { $in: ['ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'] } })
      .sort({ scheduledPickupAt: 1 })
      .limit(10)
      .populate({ path: 'currentAssignment', select: 'driver vehicle', populate: [{ path: 'driver', select: 'fullName phone' }, { path: 'vehicle', select: 'registrationNumber model' }] })
      .lean(),
    CabRequest.find({ employeeUser: me, status: { $in: TERMINAL_STATUSES } }).sort({ scheduledPickupAt: -1 }).limit(5).lean(),
    Notification.countDocuments({ user: me, readAt: null }),
    employee?.officeLocation ? hasCabForCurrentWorkDay(String(me), employee.officeLocation) : false,
  ]);
  const active = upcoming.find((b) => ['DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'].includes(b.status)) ?? null;
  res.json({ pending, upcoming, activeTrip: active, recent, unreadNotifications: unread, openStatuses: OPEN_STATUSES, bookedToday });
});

employeeRouter.get('/profile', async (req, res) => {
  res.json(await getMyProfile(actorFromRequest(req)));
});

employeeRouter.patch('/profile', async (req, res) => {
  res.json(await updateMyProfile(actorFromRequest(req), body(selfProfileSchema, req)));
});

employeeRouter.get('/bookings', async (req, res) => {
  const scope = typeof req.query.scope === 'string' ? req.query.scope : undefined;
  res.json(await listMyBookings(actorFromRequest(req), query(paginationSchema, req), scope));
});

employeeRouter.post('/bookings', async (req, res) => {
  const result = await createBooking(actorFromRequest(req), body(createBookingSchema, req));
  res.status(result.duplicate ? 200 : 201).json(result);
});

employeeRouter.get('/bookings/:id', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); // contains the ride-start PIN
  res.json(await getMyBooking(actorFromRequest(req), String(req.params.id)));
});

// Change a ride while no cab is assigned (same rules as a new request).
employeeRouter.patch('/bookings/:id', async (req, res) => {
  res.json(await updateMyBooking(actorFromRequest(req), String(req.params.id), body(updateBookingSchema, req)));
});
employeeRouter.post('/bookings/:id/cancel', async (req, res) => {
  const input = body(z.object({ reason: z.string().trim().min(3).max(500) }), req);
  res.json(await cancelMyBooking(actorFromRequest(req), String(req.params.id), input.reason));
});

employeeRouter.post('/bookings/:id/cancellation-request', async (req, res) => {
  const input = body(z.object({ reason: z.string().trim().min(3).max(500) }), req);
  res.json(await requestCancellation(actorFromRequest(req), String(req.params.id), input.reason));
});

// ===========================================================================
// Driver dashboard: every action is checked against the caller's own driver profile.
// ===========================================================================
export const driverRouter = Router();
driverRouter.use(requireRole('DRIVER'));

driverRouter.get('/home', async (req, res) => {
  res.json(await driverHome(actorFromRequest(req)));
});
driverRouter.get('/rides/history', async (req, res) => {
  const p = query(paginationSchema, req);
  res.json(await driverRideHistory(actorFromRequest(req), p.page, p.pageSize));
});
driverRouter.get('/rides/:id', async (req, res) => {
  res.json(await driverRide(actorFromRequest(req), String(req.params.id)));
});
driverRouter.post('/duty', async (req, res) => {
  res.json(await setDuty(actorFromRequest(req), body(z.object({ onDuty: z.boolean() }), req).onDuty));
});
driverRouter.post('/rides/:id/acknowledge', async (req, res) => {
  res.json(await acknowledge(actorFromRequest(req), objectId(req.params.id, 'Ride')));
});
// Drivers can't hand back a ride for their own reasons: they call the coordinator, who changes the cab.
driverRouter.post('/rides/:id/decline', () => {
  throw new AppError(403, 'DRIVER_CANNOT_CANCEL', "Drivers can't cancel a ride. Please call your transport coordinator.");
});
// …but they may cancel because of the employee (no-show, not coming, other).
driverRouter.post('/rides/:id/cancel', async (req, res) => {
  res.json(await driverCancel(actorFromRequest(req), objectId(req.params.id, 'Ride'), body(driverCancelSchema, req)));
});
driverRouter.post('/rides/:id/en-route', async (req, res) => {
  await markEnRoute(actorFromRequest(req), objectId(req.params.id, 'Ride'));
  res.json({ status: 'DRIVER_EN_ROUTE' });
});
driverRouter.post('/rides/:id/arrived', async (req, res) => {
  await markArrived(actorFromRequest(req), objectId(req.params.id, 'Ride'));
  res.json({ status: 'ARRIVED' });
});
driverRouter.post('/rides/:id/start', pinLimiter, async (req, res) => {
  const input = body(z.object({ pin: z.string().trim().max(12) }), req);
  res.json(await verifyPinAndStart(actorFromRequest(req), objectId(req.params.id, 'Ride'), input.pin));
});
driverRouter.post('/rides/:id/complete', async (req, res) => {
  const input = body(z.object({ notes: z.string().trim().max(1000).optional() }), req);
  res.json(await completeTrip(actorFromRequest(req), objectId(req.params.id, 'Ride'), input.notes));
});
driverRouter.post('/rides/:id/no-show', async (req, res) => {
  res.json(await markNoShow(actorFromRequest(req), objectId(req.params.id, 'Ride'), body(z.object({ reason: z.string().trim().min(3).max(500) }), req).reason));
});
driverRouter.post('/rides/:id/notes', async (req, res) => {
  await addDriverNote(actorFromRequest(req), objectId(req.params.id, 'Ride'), body(z.object({ note: z.string().trim().max(1000) }), req).note);
  res.json({ ok: true });
});
