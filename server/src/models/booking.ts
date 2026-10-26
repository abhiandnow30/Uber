import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { ASSIGNMENT_STATUSES, BOOKING_STATUSES, PIN_STATUSES, ROLES, TRIP_LEGS, TRIP_TYPES } from '../domain.js';

// ---------------------------------------------------------------------------
// Cab request (booking). One document per trip leg; round trips share tripGroupId.
// ---------------------------------------------------------------------------
const cabRequestSchema = new Schema(
  {
    reference: { type: String, required: true, unique: true },
    employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    employeeUser: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    officeLocation: { type: String, required: true, index: true },
    pickupLocation: { type: String, required: true, trim: true },
    dropLocation: { type: String, required: true, trim: true },
    travelDate: { type: String, required: true, index: true }, // YYYY-MM-DD in office time zone
    pickupTime: { type: String, required: true }, // HH:mm in office time zone
    timezone: { type: String, required: true },
    scheduledPickupAt: { type: Date, required: true, index: true }, // UTC instant
    passengers: { type: Number, required: true, min: 1 },
    tripType: { type: String, enum: TRIP_TYPES, default: 'ONE_WAY' },
    leg: { type: String, enum: TRIP_LEGS, default: 'OUTBOUND' },
    tripGroupId: { type: String, required: true, index: true },
    shift: { type: String },
    notes: { type: String, trim: true, maxlength: 500 },
    status: { type: String, enum: BOOKING_STATUSES, required: true, index: true },
    approvalRequired: { type: Boolean, default: false },
    // The date the employee's shift starts; travelDate is the cab's date (next day after midnight).
    shiftDate: { type: String },
    // IN = home → office, OUT = office → home. For IN rides the shift start is when the employee must
    // reach the office (reportBy, HH:mm); the transport team sets the actual pickup time when assigning
    // the cab, so until then pickupTime/scheduledPickupAt hold the reach-by time and pickupTimeSet is false.
    direction: { type: String, enum: ['IN', 'OUT'] },
    // The employee's shift times for this day (HH:mm), as entered when requesting.
    shiftStart: { type: String },
    shiftEnd: { type: String },
    reportBy: { type: String },
    pickupTimeSet: { type: Boolean, default: true },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    rejectedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    rejectionReason: { type: String },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User' },
    cancelledByRole: { type: String, enum: ROLES },
    cancellationReason: { type: String },
    cancelledAt: { type: Date },
    currentAssignment: { type: Schema.Types.ObjectId, ref: 'CabAssignment' },
    isDelayed: { type: Boolean, default: false, index: true },
    delayReason: { type: String },
    completedAt: { type: Date },
    // Idempotency: the client sends a UUID per form submission.
    clientRequestId: { type: String },
    // Set while the booking is open; unique so an employee cannot hold two open
    // bookings for the same pickup instant (accidental double submission).
    openSlotKey: { type: String },
    // employee:shiftDay:leg. Set until the booking is cancelled or rejected; unique so an
    // employee gets one cab per shift day (a 7 PM shift's 1 AM cab counts for the day the shift started).
    shiftDayKey: { type: String },
    // The work day this cab counts for (kept after cancellation, unlike shiftDayKey).
    workDay: { type: String, index: true },
    flaggedForReview: { type: Boolean, default: false },
    flagReason: { type: String },
    // Once a cab is assigned the employee can't cancel directly; they ask the transport team.
    cancellationRequest: {
      status: { type: String, enum: ['PENDING', 'APPROVED', 'DECLINED'] },
      reason: { type: String },
      requestedAt: { type: Date },
      decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      decidedAt: { type: Date },
      note: { type: String },
    },
  },
  { timestamps: true },
);
cabRequestSchema.index(
  { employeeUser: 1, clientRequestId: 1 },
  { unique: true, partialFilterExpression: { clientRequestId: { $type: 'string' } }, name: 'idempotent_submission' },
);
cabRequestSchema.index(
  { openSlotKey: 1 },
  { unique: true, partialFilterExpression: { openSlotKey: { $type: 'string' } }, name: 'one_open_booking_per_slot' },
);
cabRequestSchema.index(
  { shiftDayKey: 1 },
  { unique: true, partialFilterExpression: { shiftDayKey: { $type: 'string' } }, name: 'one_booking_per_shift_day' },
);
cabRequestSchema.index({ officeLocation: 1, travelDate: 1, status: 1 });

export type CabRequestAttrs = InferSchemaType<typeof cabRequestSchema>;
export type CabRequestDoc = HydratedDocument<CabRequestAttrs>;
export const CabRequest = mongoose.model('CabRequest', cabRequestSchema);

// ---------------------------------------------------------------------------
// Cab assignment: a booking bound to a driver + vehicle for a time window.
// ---------------------------------------------------------------------------
const cabAssignmentSchema = new Schema(
  {
    booking: { type: Schema.Types.ObjectId, ref: 'CabRequest', required: true, index: true },
    bookingReference: { type: String, required: true },
    employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    driver: { type: Schema.Types.ObjectId, ref: 'Driver', required: true },
    vehicle: { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true },
    officeLocation: { type: String, required: true },
    assignedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ASSIGNMENT_STATUSES, default: 'ACTIVE', index: true },
    // Reserved time window used for conflict detection.
    windowStart: { type: Date, required: true },
    windowEnd: { type: Date, required: true },
    scheduledPickupAt: { type: Date, required: true },
    acknowledgedAt: { type: Date },
    declinedAt: { type: Date },
    declineReason: { type: String },
    enRouteAt: { type: Date },
    arrivedAt: { type: Date },
    startedAt: { type: Date },
    completedAt: { type: Date },
    startMethod: { type: String, enum: ['PIN', 'OVERRIDE'] },
    overrideBy: { type: Schema.Types.ObjectId, ref: 'User' },
    overrideReason: { type: String },
    completionMethod: { type: String, enum: ['DRIVER', 'OVERRIDE'] },
    completionOverrideBy: { type: Schema.Types.ObjectId, ref: 'User' },
    completionOverrideReason: { type: String },
    endedAt: { type: Date },
    endedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    endReason: { type: String },
    driverNotes: { type: String, maxlength: 1000 },
    replacedBy: { type: Schema.Types.ObjectId, ref: 'CabAssignment' },
    unacknowledgedAlertedAt: { type: Date },
    // Client-supplied Idempotency-Key so a retried "assign" click cannot double-assign.
    requestKey: { type: String },
    // Shared trip: several rides assigned together to one cab. Rides of the same trip may overlap
    // in time (they ride together); the name is the coordinator's label, e.g. "Kondapur & Madhapur Cab".
    tripId: { type: String, index: true },
    tripName: { type: String, trim: true, maxlength: 120 },
  },
  { timestamps: true },
);
cabAssignmentSchema.index(
  { booking: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE' }, name: 'one_active_assignment_per_booking' },
);
cabAssignmentSchema.index(
  { requestKey: 1 },
  { unique: true, partialFilterExpression: { requestKey: { $type: 'string' } }, name: 'idempotent_assignment' },
);
cabAssignmentSchema.index({ driver: 1, status: 1, windowStart: 1, windowEnd: 1 });
cabAssignmentSchema.index({ vehicle: 1, status: 1, windowStart: 1, windowEnd: 1 });

export type CabAssignmentAttrs = InferSchemaType<typeof cabAssignmentSchema>;
export const CabAssignment = mongoose.model('CabAssignment', cabAssignmentSchema);

// ---------------------------------------------------------------------------
// Ride-start credential (PIN). Never stored in plaintext.
//  - pinHash:   HMAC-SHA256(PIN_HMAC_KEY, salt:pin), used for verification
//  - pinCipher: AES-256-GCM copy so the *assigned employee only* can view it again
// ---------------------------------------------------------------------------
const rideStartCredentialSchema = new Schema(
  {
    assignment: { type: Schema.Types.ObjectId, ref: 'CabAssignment', required: true, index: true },
    booking: { type: Schema.Types.ObjectId, ref: 'CabRequest', required: true, index: true },
    employeeUser: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    pinHash: { type: String, required: true, select: false },
    salt: { type: String, required: true, select: false },
    pinCipher: { type: String, required: true, select: false },
    status: { type: String, enum: PIN_STATUSES, default: 'ACTIVE', index: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, required: true },
    lastAttemptAt: { type: Date },
    usedAt: { type: Date },
    revokedAt: { type: Date },
    revokeReason: { type: String },
  },
  { timestamps: true },
);
// Exactly one live PIN per assignment; older (revoked/expired/locked) ones are kept as history.
rideStartCredentialSchema.index(
  { assignment: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE' }, name: 'one_active_pin_per_assignment' },
);
export const RideStartCredential = mongoose.model('RideStartCredential', rideStartCredentialSchema);

// ---------------------------------------------------------------------------
// Status history (append-only)
// ---------------------------------------------------------------------------
const tripStatusHistorySchema = new Schema(
  {
    booking: { type: Schema.Types.ObjectId, ref: 'CabRequest', required: true, index: true },
    assignment: { type: Schema.Types.ObjectId, ref: 'CabAssignment' },
    from: { type: String },
    to: { type: String, required: true },
    event: { type: String, required: true },
    actor: { type: Schema.Types.ObjectId, ref: 'User' },
    actorRole: { type: String },
    reason: { type: String },
    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
export const TripStatusHistory = mongoose.model('TripStatusHistory', tripStatusHistorySchema);
