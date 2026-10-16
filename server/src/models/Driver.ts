import mongoose, { Schema, type InferSchemaType } from 'mongoose';
import { DRIVER_AVAILABILITY, DRIVER_EMPLOYMENT, DRIVER_VERIFICATION } from '../domain.js';

const unavailabilitySchema = new Schema(
  {
    from: { type: Date, required: true },
    to: { type: Date, required: true },
    reason: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { _id: true, timestamps: { createdAt: true, updatedAt: false } },
);

const driverSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', unique: true, sparse: true },
    driverCode: { type: String, required: true, uppercase: true, trim: true, unique: true },
    fullName: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    // Last 10 digits of phone, used for mobile sign-in (kept in sync on save).
    phoneKey: { type: String, index: true },
    phoneLoginFailures: { type: Number, default: 0 },
    phoneLoginLockedUntil: { type: Date },
    email: { type: String, lowercase: true, trim: true },
    licenseNumber: { type: String, required: true, uppercase: true, trim: true, unique: true },
    licenseExpiry: { type: Date, required: true },
    verificationStatus: { type: String, enum: DRIVER_VERIFICATION, default: 'PENDING', index: true },
    verifiedAt: { type: Date },
    verifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    employmentStatus: { type: String, enum: DRIVER_EMPLOYMENT, default: 'ACTIVE', index: true },
    // Server-maintained; drivers can only toggle onDuty, never set availability directly.
    availability: { type: String, enum: DRIVER_AVAILABILITY, default: 'OFFLINE', index: true },
    onDuty: { type: Boolean, default: false },
    currentVehicle: { type: Schema.Types.ObjectId, ref: 'Vehicle' },
    officeLocation: { type: String, required: true, index: true },
    unavailablePeriods: { type: [unavailabilitySchema], default: [] },
    lastSeenAt: { type: Date },
    // Concurrency token: bumped inside every assignment transaction so that two
    // concurrent assignments touching this driver produce a write conflict.
    scheduleLock: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

driverSchema.pre('validate', function () {
  if (this.phone) this.phoneKey = this.phone.replace(/\D/g, '').slice(-10);
});

export type DriverAttrs = InferSchemaType<typeof driverSchema>;
export const Driver = mongoose.model('Driver', driverSchema);
