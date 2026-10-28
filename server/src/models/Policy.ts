import mongoose, { Schema, type InferSchemaType } from 'mongoose';

const officeSchema = new Schema(
  {
    code: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    address: { type: String, trim: true },
    timezone: { type: String, required: true }, // IANA, e.g. Asia/Kolkata
    // The Google Maps link of the office, and the exact spot taken from it.
    mapLink: { type: String, trim: true, maxlength: 2000 },
    location: {
      type: new Schema({ lat: { type: Number, min: -90, max: 90 }, lng: { type: Number, min: -180, max: 180 } }, { _id: false }),
      default: undefined,
    },
    active: { type: Boolean, default: true },
  },
  { _id: false },
);

const shiftSchema = new Schema(
  {
    code: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    direction: { type: String, enum: ['TO_OFFICE', 'FROM_OFFICE', 'ANY'], default: 'ANY' },
    // Shift hours (HH:mm). With these set, the cab time is fixed by the shift (defaultPickupTime)
    // and a cab time earlier than the start time means the next calendar day.
    startTime: { type: String },
    endTime: { type: String },
    defaultPickupTime: { type: String }, // HH:mm: the cab time for this shift
    active: { type: Boolean, default: true },
  },
  { _id: false },
);

/**
 * Booking policy. A single global document (key="global") holds organisation-wide
 * settings; it is versioned and every change is audited.
 */
const policySchema = new Schema(
  {
    key: { type: String, required: true, unique: true, default: 'global' },
    version: { type: Number, default: 1 },
    officeLocations: { type: [officeSchema], default: [] },
    shifts: { type: [shiftSchema], default: [] },
    // One-time data updates already applied to this document.
    migrations: { type: [String], default: [] },
    booking: {
      maxDaysAhead: { type: Number, default: 14 },
      minLeadMinutes: { type: Number, default: 120 }, // cut-off before pickup
      dailyCutoffTime: { type: String, default: '' }, // optional HH:mm cut-off for next-day bookings
      cancellationDeadlineMinutes: { type: Number, default: 60 },
      approvalRequired: { type: Boolean, default: false },
      maxPassengers: { type: Number, default: 4 },
      allowRoundTrip: { type: Boolean, default: false },
      // Cabs run only inside this daily window (may cross midnight, e.g. 20:00-06:00). Blank = any time.
      cabWindowStart: { type: String, default: '20:00' },
      cabWindowEnd: { type: String, default: '06:00' },
      // Employees must pick their shift; the cab time then comes from the shift.
      requireShift: { type: Boolean, default: true },
    },
    assignment: {
      defaultTripDurationMinutes: { type: Number, default: 90 },
      bufferMinutes: { type: Number, default: 15 },
      requireVerifiedDriver: { type: Boolean, default: true },
      acknowledgementTimeoutMinutes: { type: Number, default: 30 },
    },
    pin: {
      digits: { type: Number, default: 4 },
      maxAttempts: { type: Number, default: 5 },
      validAfterPickupMinutes: { type: Number, default: 240 },
    },
    exceptions: {
      latePickupThresholdMinutes: { type: Number, default: 15 },
      overdueTripMinutes: { type: Number, default: 180 },
    },
    notifications: {
      emailOnSubmitted: { type: Boolean, default: true },
      emailOnApprovalDecision: { type: Boolean, default: true },
      emailOnAssigned: { type: Boolean, default: true },
      emailOnChanged: { type: Boolean, default: true },
      emailOnCancelled: { type: Boolean, default: true },
      emailOnArrived: { type: Boolean, default: false },
      emailOnTripStarted: { type: Boolean, default: false },
      emailOnCompleted: { type: Boolean, default: true },
      emailOnDelay: { type: Boolean, default: true },
      // Daily email to signed-in employees without a cab for tomorrow, at reminders.dailyTime.
      dailyBookingReminder: { type: Boolean, default: true },
    },
    reminders: {
      // When the daily reminder goes out (HH:mm, each office's local time). Chosen by the admin.
      dailyTime: { type: String, default: '18:00' },
    },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export type PolicyAttrs = InferSchemaType<typeof policySchema>;
export const Policy = mongoose.model('Policy', policySchema);
