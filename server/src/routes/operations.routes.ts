import { Router } from 'express';
import { z } from 'zod';
import { actorFromRequest, requireRole } from '../middleware/auth.js';
import { body, objectId, query } from '../middleware/common.js';
import {
  assignBooking,
  assignSchema,
  assignTrip,
  eligibleResources,
  reassignBooking,
  regeneratePin,
  renameTrip,
  tripEligibleResources,
  tripEligibleSchema,
  tripRenameSchema,
  tripSchema,
} from '../services/assignment.service.js';
import { audit } from '../services/audit.service.js';
import {
  approveBooking,
  bookingListSchema,
  cancelBookingByOperations,
  decideCancellationRequest,
  clearFlag,
  getBookingForOperations,
  listBookings,
  markDelayed,
  rejectBooking,
} from '../services/booking.service.js';
import {
  createDriver,
  createVehicle,
  driverListSchema,
  driverSchema,
  driverUpdateSchema,
  employmentSchema,
  flagDriverUnavailable,
  getDriver,
  getVehicle,
  linkDriverVehicle,
  linkSchema,
  listDrivers,
  listLinks,
  listVehicles,
  removeUnavailability,
  setDriverEmployment,
  setVehicleStatus,
  unavailabilitySchema,
  unlinkDriverVehicle,
  updateDriver,
  updateVehicle,
  vehicleListSchema,
  vehicleSchema,
  vehicleStatusSchema,
  verifyDriver,
  verifyDriverSchema,
} from '../services/fleet.service.js';
import { coordinatorDashboard, dashboardQuerySchema } from '../services/report.service.js';
import { assertInScope, officeScope, scopeFilter } from '../services/scope.service.js';
import { completeByOperations, noShowByOperations, overrideStart } from '../services/trip.service.js';
import { AppError, notFound } from '../utils/errors.js';
import { paged, paginationSchema } from '../utils/listing.js';

/** Shared operational API for coordinators (office-scoped) and admins (all offices). */
export const operationsRouter = Router();
operationsRouter.use(requireRole('ADMIN', 'COORDINATOR'));

const reason = (min = 3) => z.object({ reason: z.string().trim().min(min, `Reason must be at least ${min} characters`).max(500) });

operationsRouter.get('/dashboard', async (req, res) => {
  res.json(await coordinatorDashboard(actorFromRequest(req), query(dashboardQuerySchema, req)));
});

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------
operationsRouter.get('/drivers', async (req, res) => {
  res.json(await listDrivers(actorFromRequest(req), query(paginationSchema, req), query(driverListSchema, req)));
});
operationsRouter.post('/drivers', async (req, res) => {
  res.status(201).json(await createDriver(actorFromRequest(req), body(driverSchema, req)));
});
operationsRouter.get('/drivers/:id', async (req, res) => {
  res.json(await getDriver(actorFromRequest(req), objectId(req.params.id, 'Driver')));
});
operationsRouter.patch('/drivers/:id', async (req, res) => {
  res.json(await updateDriver(actorFromRequest(req), objectId(req.params.id, 'Driver'), body(driverUpdateSchema, req)));
});
operationsRouter.post('/drivers/:id/verify', requireRole('ADMIN'), async (req, res) => {
  res.json(await verifyDriver(actorFromRequest(req), objectId(req.params.id, 'Driver'), body(verifyDriverSchema, req)));
});
operationsRouter.post('/drivers/:id/employment', async (req, res) => {
  res.json(await setDriverEmployment(actorFromRequest(req), objectId(req.params.id, 'Driver'), body(employmentSchema, req)));
});
operationsRouter.post('/drivers/:id/unavailability', async (req, res) => {
  res.json(await flagDriverUnavailable(actorFromRequest(req), objectId(req.params.id, 'Driver'), body(unavailabilitySchema, req)));
});
operationsRouter.delete('/drivers/:id/unavailability/:periodId', async (req, res) => {
  await removeUnavailability(actorFromRequest(req), objectId(req.params.id, 'Driver'), objectId(req.params.periodId, 'Period'));
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------
operationsRouter.get('/vehicles', async (req, res) => {
  res.json(await listVehicles(actorFromRequest(req), query(paginationSchema, req), query(vehicleListSchema, req)));
});
operationsRouter.post('/vehicles', async (req, res) => {
  res.status(201).json(await createVehicle(actorFromRequest(req), body(vehicleSchema, req)));
});
operationsRouter.get('/vehicles/:id', async (req, res) => {
  res.json(await getVehicle(actorFromRequest(req), objectId(req.params.id, 'Vehicle')));
});
operationsRouter.patch('/vehicles/:id', async (req, res) => {
  res.json(await updateVehicle(actorFromRequest(req), objectId(req.params.id, 'Vehicle'), body(vehicleSchema.omit({ registrationNumber: true }).partial(), req)));
});
operationsRouter.post('/vehicles/:id/status', async (req, res) => {
  res.json(await setVehicleStatus(actorFromRequest(req), objectId(req.params.id, 'Vehicle'), body(vehicleStatusSchema, req)));
});

// ---------------------------------------------------------------------------
// Driver-vehicle links
// ---------------------------------------------------------------------------
operationsRouter.get('/links', async (req, res) => {
  res.json(await listLinks(actorFromRequest(req), query(paginationSchema, req), req.query.current !== 'false'));
});
operationsRouter.post('/links', async (req, res) => {
  res.status(201).json(await linkDriverVehicle(actorFromRequest(req), body(linkSchema, req)));
});
operationsRouter.post('/links/:id/end', async (req, res) => {
  await unlinkDriverVehicle(actorFromRequest(req), objectId(req.params.id, 'Link'), body(reason(), req).reason);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Bookings & assignment
// ---------------------------------------------------------------------------
operationsRouter.get('/bookings', async (req, res) => {
  res.json(await listBookings(actorFromRequest(req), query(paginationSchema, req), query(bookingListSchema, req)));
});
operationsRouter.get('/bookings/:id', async (req, res) => {
  res.json(await getBookingForOperations(actorFromRequest(req), String(req.params.id)));
});
operationsRouter.get('/bookings/:id/eligible', async (req, res) => {
  res.json(await eligibleResources(actorFromRequest(req), objectId(req.params.id, 'Booking')));
});
// Shared trips: several rides on one cab.
operationsRouter.post('/trips/eligible', async (req, res) => {
  res.json(await tripEligibleResources(actorFromRequest(req), body(tripEligibleSchema, req).bookingIds));
});
operationsRouter.post('/trips', async (req, res) => {
  const key = req.get('idempotency-key')?.slice(0, 100);
  const result = await assignTrip(actorFromRequest(req), body(tripSchema, req), key);
  res.status(result.duplicate ? 200 : 201).json(result);
});
operationsRouter.patch('/trips/:tripId', async (req, res) => {
  const tripId = z.string().uuid('Invalid trip').parse(req.params.tripId);
  res.json(await renameTrip(actorFromRequest(req), tripId, body(tripRenameSchema, req).name));
});
operationsRouter.post('/bookings/:id/assign', async (req, res) => {
  const key = req.get('idempotency-key')?.slice(0, 100);
  const result = await assignBooking(actorFromRequest(req), objectId(req.params.id, 'Booking'), body(assignSchema, req), key);
  res.status(result.duplicate ? 200 : 201).json(result);
});
operationsRouter.post('/bookings/:id/reassign', async (req, res) => {
  res.json(await reassignBooking(actorFromRequest(req), objectId(req.params.id, 'Booking'), body(assignSchema, req)));
});
operationsRouter.post('/bookings/:id/approve', async (req, res) => {
  res.json(await approveBooking(actorFromRequest(req), objectId(req.params.id, 'Booking')));
});
operationsRouter.post('/bookings/:id/reject', async (req, res) => {
  res.json(await rejectBooking(actorFromRequest(req), objectId(req.params.id, 'Booking'), body(reason(), req).reason));
});
operationsRouter.post('/bookings/:id/cancel', async (req, res) => {
  res.json(await cancelBookingByOperations(actorFromRequest(req), objectId(req.params.id, 'Booking'), body(reason(), req).reason));
});
operationsRouter.post('/bookings/:id/cancellation-request/approve', async (req, res) => {
  res.json(await decideCancellationRequest(actorFromRequest(req), objectId(req.params.id, 'Booking'), 'APPROVED'));
});
operationsRouter.post('/bookings/:id/cancellation-request/decline', async (req, res) => {
  res.json(await decideCancellationRequest(actorFromRequest(req), objectId(req.params.id, 'Booking'), 'DECLINED', body(reason(), req).reason));
});
operationsRouter.post('/bookings/:id/delay', async (req, res) => {
  res.json(await markDelayed(actorFromRequest(req), objectId(req.params.id, 'Booking'), body(reason(), req).reason));
});
operationsRouter.post('/bookings/:id/clear-flag', async (req, res) => {
  await clearFlag(actorFromRequest(req), objectId(req.params.id, 'Booking'), body(reason(), req).reason);
  res.json({ ok: true });
});
operationsRouter.post('/bookings/:id/regenerate-pin', async (req, res) => {
  await regeneratePin(actorFromRequest(req), objectId(req.params.id, 'Booking'), body(reason(), req).reason);
  res.json({ ok: true });
});
operationsRouter.post('/bookings/:id/override-start', async (req, res) => {
  res.json(await overrideStart(actorFromRequest(req), objectId(req.params.id, 'Booking'), body(reason(10), req).reason));
});
operationsRouter.post('/bookings/:id/complete', async (req, res) => {
  res.json(await completeByOperations(actorFromRequest(req), objectId(req.params.id, 'Booking'), body(reason(10), req).reason));
});
operationsRouter.post('/bookings/:id/no-show', async (req, res) => {
  res.json(await noShowByOperations(actorFromRequest(req), objectId(req.params.id, 'Booking'), body(reason(), req).reason));
});

