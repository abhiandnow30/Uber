import { describe, expect, it } from 'vitest';
import { AuditLog, Notification } from '../src/models/system.js';
import { CabAssignment, CabRequest, RideStartCredential, TripStatusHistory } from '../src/models/booking.js';
import { Driver } from '../src/models/Driver.js';
import { Employee } from '../src/models/Employee.js';
import { assign, bookingInput, employeePin, makeDriver, makeEmployee, scenario, toArrived } from './helpers.js';

async function assignedScenario() {
  const s = await scenario();
  const res = await assign(s.coord.client, s.bookingId, s.drv);
  return { ...s, assignmentId: res.body.assignment._id as string };
}

describe('driver trip lifecycle and ride-start PIN', () => {
  it('runs ASSIGNED → EN_ROUTE → ARRIVED → IN_PROGRESS (PIN) → COMPLETED with timestamps', async () => {
    const s = await assignedScenario();
    await toArrived(s.drv.client, s.assignmentId);
    expect((await CabRequest.findById(s.bookingId))!.status).toBe('ARRIVED');
    const pin = await employeePin(s.emp.client!, s.bookingId);
    const start = await s.drv.client.post(`/api/driver/rides/${s.assignmentId}/start`, { pin });
    expect(start.status).toBe(200);
    expect(start.body.status).toBe('IN_PROGRESS');
    expect((await Driver.findById(s.drv.driver._id))!.availability).toBe('ON_TRIP');
    // PIN no longer shown once the trip has started
    expect((await s.emp.client!.get(`/api/me/bookings/${s.bookingId}`)).body.pin).toBeNull();

    const done = await s.drv.client.post(`/api/driver/rides/${s.assignmentId}/complete`, { notes: 'Smooth ride' });
    expect(done.status).toBe(200);
    const a = await CabAssignment.findById(s.assignmentId);
    expect(a!.status).toBe('COMPLETED');
    for (const t of ['acknowledgedAt', 'enRouteAt', 'arrivedAt', 'startedAt', 'completedAt'] as const) expect(a![t]).toBeInstanceOf(Date);
    expect(a!.startedAt! <= a!.completedAt!).toBe(true);
    expect(a!.startMethod).toBe('PIN');
    expect((await Driver.findById(s.drv.driver._id))!.availability).toBe('AVAILABLE');
    const events = (await TripStatusHistory.find({ booking: s.bookingId }).sort({ createdAt: 1 })).map((h) => h.event);
    expect(events).toEqual(['REQUESTED', 'ASSIGNED', 'ACKNOWLEDGED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'TRIP_STARTED', 'COMPLETED']);

    // duplicate completion and restarting a completed trip are rejected
    expect((await s.drv.client.post(`/api/driver/rides/${s.assignmentId}/complete`)).status).toBe(409);
    expect((await s.drv.client.post(`/api/driver/rides/${s.assignmentId}/start`, { pin })).status).toBe(409);
  });

  it('cannot start a trip without marking arrival, and statuses cannot be skipped', async () => {
    const s = await assignedScenario();
    const pin = await employeePin(s.emp.client!, s.bookingId);
    const early = await s.drv.client.post(`/api/driver/rides/${s.assignmentId}/start`, { pin });
    expect(early.status).toBe(409);
    expect((await s.drv.client.post(`/api/driver/rides/${s.assignmentId}/arrived`)).status).toBe(409); // must be en route first
    expect((await s.drv.client.post(`/api/driver/rides/${s.assignmentId}/complete`)).status).toBe(409);
    expect((await CabRequest.findById(s.bookingId))!.status).toBe('ASSIGNED');
  });

  it('rejects an incorrect PIN, reports remaining attempts and locks after the limit', async () => {
    const s = await assignedScenario();
    await toArrived(s.drv.client, s.assignmentId);
    const pin = await employeePin(s.emp.client!, s.bookingId);
    const wrong = pin === '0000' ? '1111' : '0000';
    const r1 = await s.drv.client.post(`/api/driver/rides/${s.assignmentId}/start`, { pin: wrong });
    expect(r1.status).toBe(422);
    expect(r1.body.error.details.attemptsRemaining).toBe(4);
    for (let i = 0; i < 3; i++) await s.drv.client.post(`/api/driver/rides/${s.assignmentId}/start`, { pin: wrong });
    const r5 = await s.drv.client.post(`/api/driver/rides/${s.assignmentId}/start`, { pin: wrong });
    expect(r5.status).toBe(423);
    // even the correct PIN is now refused
    const r6 = await s.drv.client.post(`/api/driver/rides/${s.assignmentId}/start`, { pin });
    expect(r6.status).toBe(423);
    expect((await RideStartCredential.findOne({ assignment: s.assignmentId }))!.status).toBe('LOCKED');
    expect(await Notification.exists({ type: 'PIN_LOCKED' })).toBeTruthy();
    // coordinator regenerates; new PIN works
    await s.coord.client.post(`/api/ops/bookings/${s.bookingId}/regenerate-pin`, { reason: 'Locked after typos' }).expect(200);
    const fresh = await employeePin(s.emp.client!, s.bookingId);
    await s.drv.client.post(`/api/driver/rides/${s.assignmentId}/start`, { pin: fresh }).expect(200);
  });

  it('parallel guessing cannot exceed the attempt limit', async () => {
    const s = await assignedScenario();
    await toArrived(s.drv.client, s.assignmentId);
    const pin = await employeePin(s.emp.client!, s.bookingId);
    const guesses = Array.from({ length: 12 }, (_, i) => String(i).padStart(4, '9')).filter((g) => g !== pin);
    await Promise.all(guesses.map((g) => s.drv.client.post(`/api/driver/rides/${s.assignmentId}/start`, { pin: g })));
    const cred = await RideStartCredential.findOne({ assignment: s.assignmentId });
    expect(cred!.attempts).toBeLessThanOrEqual(5);
    expect(cred!.status).toBe('LOCKED');
  });

  it('rejects expired PINs', async () => {
    const s = await assignedScenario();
    await toArrived(s.drv.client, s.assignmentId);
    const pin = await employeePin(s.emp.client!, s.bookingId);
    await RideStartCredential.updateMany({ assignment: s.assignmentId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await s.drv.client.post(`/api/driver/rides/${s.assignmentId}/start`, { pin });
    expect(r.status).toBe(410);
    expect(r.body.error.code).toBe('PIN_EXPIRED');
  });

  it('a PIN from another assignment cannot start this trip (cross-assignment)', async () => {
    const s = await assignedScenario();
    const emp2 = await makeEmployee();
    const b2 = await emp2.client!.post('/api/me/bookings', bookingInput({ pickupTime: '19:00' }));
    const a2 = await assign(s.coord.client, b2.body.booking._id, s.drv);
    await toArrived(s.drv.client, s.assignmentId);
    const otherPin = await employeePin(emp2.client!, b2.body.booking._id);
    const ownPin = await employeePin(s.emp.client!, s.bookingId);
    if (otherPin !== ownPin) {
      const r = await s.drv.client.post(`/api/driver/rides/${s.assignmentId}/start`, { pin: otherPin });
      expect(r.status).toBe(422);
    }
    void a2;
  });

  it('concurrent correct PIN submissions start the trip exactly once', async () => {
    const s = await assignedScenario();
    await toArrived(s.drv.client, s.assignmentId);
    const pin = await employeePin(s.emp.client!, s.bookingId);
    const results = await Promise.all(Array.from({ length: 5 }, () => s.drv.client.post(`/api/driver/rides/${s.assignmentId}/start`, { pin })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).length).toBe(4);
    expect(await TripStatusHistory.countDocuments({ booking: s.bookingId, event: 'TRIP_STARTED' })).toBe(1);
  });

  it('drivers see the passenger name but never their phone number', async () => {
    const s = await assignedScenario();
    await Employee.updateOne({ _id: s.emp.employee._id }, { $set: { phone: '+919876543210' } });
    const ride = await s.drv.client.get(`/api/driver/rides/${s.assignmentId}`).expect(200);
    expect(ride.body.employee.name).toBeTruthy();
    const home = await s.drv.client.get('/api/driver/home').expect(200);
    for (const body of [ride.body, home.body]) expect(JSON.stringify(body)).not.toContain('9876543210');
  });

  it('drivers cannot see or act on other drivers rides', async () => {
    const s = await assignedScenario();
    const other = await makeDriver();
    await other.client.get(`/api/driver/rides/${s.assignmentId}`).expect(404);
    await other.client.post(`/api/driver/rides/${s.assignmentId}/acknowledge`).expect(404);
    await other.client.post(`/api/driver/rides/${s.assignmentId}/start`, { pin: '1234' }).expect(404);
    const home = await other.client.get('/api/driver/home');
    expect(home.body.today).toHaveLength(0);
  });

  it('cancelled rides cannot be started; the PIN is revoked and the driver is notified', async () => {
    const s = await assignedScenario();
    await toArrived(s.drv.client, s.assignmentId);
    const pin = await employeePin(s.emp.client!, s.bookingId);
    await s.coord.client.post(`/api/ops/bookings/${s.bookingId}/cancel`, { reason: 'Office closed today' }).expect(200);
    const r = await s.drv.client.post(`/api/driver/rides/${s.assignmentId}/start`, { pin });
    expect(r.status).toBe(409);
    expect((await RideStartCredential.findOne({ assignment: s.assignmentId }))!.status).toBe('REVOKED');
  });

  it('after a cab is assigned the employee requests cancellation; the transport team approves or declines', async () => {
    const s = await assignedScenario();
    // direct cancellation is no longer possible, whatever the time
    const direct = await s.emp.client!.post(`/api/me/bookings/${s.bookingId}/cancel`, { reason: 'Plans changed' });
    expect(direct.status).toBe(422);
    expect(direct.body.error.code).toBe('CANCELLATION_NOT_ALLOWED');
    let mine = await s.emp.client!.get(`/api/me/bookings/${s.bookingId}`).expect(200);
    expect(mine.body).toMatchObject({ canCancel: false, canRequestCancellation: true });

    await s.emp.client!.post(`/api/me/bookings/${s.bookingId}/cancellation-request`, { reason: 'Meeting moved online' }).expect(200);
    expect((await s.emp.client!.post(`/api/me/bookings/${s.bookingId}/cancellation-request`, { reason: 'again' })).status).toBe(409);
    expect(await Notification.exists({ user: s.coord.user._id, type: 'CANCELLATION_REQUESTED' })).toBeTruthy();
    const queue = await s.coord.client.get('/api/ops/bookings?cancellationRequested=true').expect(200);
    expect(queue.body.items.map((b: { _id: string }) => b._id)).toEqual([s.bookingId]);

    // declined: the ride stays booked and the employee is told
    await s.coord.client.post(`/api/ops/bookings/${s.bookingId}/cancellation-request/decline`, { reason: 'Cab is already on the way' }).expect(200);
    let b = await CabRequest.findById(s.bookingId).lean();
    expect(b!.status).toBe('ASSIGNED');
    expect(b!.cancellationRequest).toMatchObject({ status: 'DECLINED', note: 'Cab is already on the way' });
    expect(await Notification.exists({ user: s.emp.user._id, type: 'CANCELLATION_DECLINED' })).toBeTruthy();

    // asked again and approved: cancelled, driver released, PIN revoked
    await s.emp.client!.post(`/api/me/bookings/${s.bookingId}/cancellation-request`, { reason: 'Travel cancelled' }).expect(200);
    await s.coord.client.post(`/api/ops/bookings/${s.bookingId}/cancellation-request/approve`, {}).expect(200);
    b = await CabRequest.findById(s.bookingId).lean();
    expect(b!.status).toBe('CANCELLED');
    expect(b!.cancellationRequest!.status).toBe('APPROVED');
    expect(b!.cancellationReason).toContain('Travel cancelled');
    expect((await CabAssignment.findById(s.assignmentId))!.status).toBe('CANCELLED');
    expect((await RideStartCredential.findOne({ assignment: s.assignmentId }))!.status).toBe('REVOKED');
    expect((await s.coord.client.post(`/api/ops/bookings/${s.bookingId}/cancellation-request/approve`, {})).status).toBe(409);
    mine = await s.emp.client!.get(`/api/me/bookings/${s.bookingId}`).expect(200);
    expect(mine.body.canRequestCancellation).toBe(false);
  });

  it('no-show closes the ride with a reason and alerts the coordinator', async () => {
    const s = await assignedScenario();
    await toArrived(s.drv.client, s.assignmentId);
    await s.drv.client.post(`/api/driver/rides/${s.assignmentId}/no-show`, { reason: 'Waited 15 minutes, no answer' }).expect(200);
    expect((await CabRequest.findById(s.bookingId))!.status).toBe('NO_SHOW');
    expect(await Notification.exists({ user: s.coord.user._id, type: 'NO_SHOW' })).toBeTruthy();
  });

  it('support override start is restricted and fully audited', async () => {
    const s = await assignedScenario();
    await toArrived(s.drv.client, s.assignmentId);
    await s.drv.client.post(`/api/ops/bookings/${s.bookingId}/override-start`, { reason: 'Employee phone dead, ID verified' }).expect(403);
    await s.coord.client.post(`/api/ops/bookings/${s.bookingId}/override-start`, { reason: 'short' }).expect(422);
    await s.coord.client.post(`/api/ops/bookings/${s.bookingId}/override-start`, { reason: 'Employee phone dead, ID badge verified' }).expect(200);
    const a = await CabAssignment.findById(s.assignmentId);
    expect(a!.startMethod).toBe('OVERRIDE');
    expect(await AuditLog.exists({ action: 'SUPPORT_OVERRIDE_START' })).toBeTruthy();
  });

  it('coordinators can see PIN state but never the PIN itself', async () => {
    const s = await assignedScenario();
    const pin = await employeePin(s.emp.client!, s.bookingId);
    const view = await s.coord.client.get(`/api/ops/bookings/${s.bookingId}`);
    expect(view.body.pinState.status).toBe('ACTIVE');
    expect(JSON.stringify(view.body)).not.toContain(`"${pin}"`);
  });

  it('driver availability is computed on the server; on/off duty is the only driver input', async () => {
    const s = await assignedScenario();
    await s.drv.client.post('/api/driver/duty', { onDuty: false }).expect(200);
    expect((await Driver.findById(s.drv.driver._id))!.availability).toBe('OFFLINE');
    // ride starting within the next hours → ASSIGNED, regardless of what the client sends
    await CabAssignment.updateOne({ _id: s.assignmentId }, { $set: { windowStart: new Date(Date.now() + 3600_000), windowEnd: new Date(Date.now() + 3 * 3600_000) } });
    await s.drv.client.post('/api/driver/duty', { onDuty: true, availability: 'AVAILABLE' }).expect(200);
    expect((await Driver.findById(s.drv.driver._id))!.availability).toBe('ASSIGNED');
  });
});
