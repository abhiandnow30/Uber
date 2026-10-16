import type { ClientSession, Types } from 'mongoose';
import type { DriverAvailability } from '../domain.js';
import { CabAssignment } from '../models/booking.js';
import { Driver } from '../models/Driver.js';
import { User } from '../models/User.js';

const ASSIGNED_HORIZON_MS = 12 * 3600_000;

/**
 * Availability is derived on the server from employment/account state, the
 * driver's on-duty toggle and their actual assignments. The client can never set it.
 */
export async function computeDriverAvailability(driverId: Types.ObjectId | string, session?: ClientSession | null): Promise<DriverAvailability> {
  const driver = await Driver.findById(driverId).session(session ?? null);
  if (!driver) return 'OFFLINE';
  if (driver.employmentStatus !== 'ACTIVE') return 'SUSPENDED';
  if (driver.user) {
    const user = await User.findById(driver.user).session(session ?? null).lean();
    if (user && user.status === 'SUSPENDED') return 'SUSPENDED';
  }
  const onTrip = await CabAssignment.exists({ driver: driver._id, status: 'ACTIVE', startedAt: { $ne: null }, completedAt: null }).session(
    session ?? null,
  );
  if (onTrip) return 'ON_TRIP';
  if (!driver.onDuty) return 'OFFLINE';
  const now = Date.now();
  const upcoming = await CabAssignment.exists({
    driver: driver._id,
    status: 'ACTIVE',
    windowEnd: { $gt: new Date(now) },
    windowStart: { $lt: new Date(now + ASSIGNED_HORIZON_MS) },
  }).session(session ?? null);
  return upcoming ? 'ASSIGNED' : 'AVAILABLE';
}

export async function refreshDriverAvailability(driverId: Types.ObjectId | string, session?: ClientSession | null) {
  const availability = await computeDriverAvailability(driverId, session);
  await Driver.updateOne({ _id: driverId }, { $set: { availability } }, { session: session ?? undefined });
  return availability;
}
