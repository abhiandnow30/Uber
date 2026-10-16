import mongoose, { Schema } from 'mongoose';
import { DRIVER_VERIFICATION } from '../domain.js';

/** History of driver <-> vehicle associations. isCurrent=true means the live link. */
const linkSchema = new Schema(
  {
    driver: { type: Schema.Types.ObjectId, ref: 'Driver', required: true },
    vehicle: { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true },
    startedAt: { type: Date, required: true, default: () => new Date() },
    endedAt: { type: Date, default: null },
    isCurrent: { type: Boolean, default: true },
    linkedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    unlinkedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reason: { type: String },
    endReason: { type: String },
  },
  { timestamps: true },
);
// At most one current link per driver and per vehicle.
linkSchema.index({ driver: 1 }, { unique: true, partialFilterExpression: { isCurrent: true }, name: 'one_current_link_per_driver' });
linkSchema.index({ vehicle: 1 }, { unique: true, partialFilterExpression: { isCurrent: true }, name: 'one_current_link_per_vehicle' });
linkSchema.index({ driver: 1, startedAt: -1 });
linkSchema.index({ vehicle: 1, startedAt: -1 });

export const DriverVehicleLink = mongoose.model('DriverVehicleLink', linkSchema);

const driverVerificationSchema = new Schema(
  {
    driver: { type: Schema.Types.ObjectId, ref: 'Driver', required: true, index: true },
    status: { type: String, enum: DRIVER_VERIFICATION, required: true },
    documentsChecked: { type: [String], default: [] },
    notes: { type: String },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const DriverVerification = mongoose.model('DriverVerification', driverVerificationSchema);
