import mongoose, { Schema, type InferSchemaType } from 'mongoose';
import { VEHICLE_STATUSES, VEHICLE_TYPES } from '../domain.js';

const vehicleSchema = new Schema(
  {
    registrationNumber: { type: String, required: true, uppercase: true, trim: true, unique: true },
    model: { type: String, required: true, trim: true },
    vehicleType: { type: String, enum: VEHICLE_TYPES, required: true },
    capacity: { type: Number, required: true, min: 1, max: 60 },
    status: { type: String, enum: VEHICLE_STATUSES, default: 'ACTIVE', index: true },
    maintenanceNotes: { type: String },
    maintenanceDueAt: { type: Date },
    insuranceExpiry: { type: Date },
    permitExpiry: { type: Date },
    currentDriver: { type: Schema.Types.ObjectId, ref: 'Driver' },
    officeLocation: { type: String, required: true, index: true },
    // Concurrency token, see Driver.scheduleLock.
    scheduleLock: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export type VehicleAttrs = InferSchemaType<typeof vehicleSchema>;
export const Vehicle = mongoose.model('Vehicle', vehicleSchema);
