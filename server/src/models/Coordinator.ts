import mongoose, { Schema, type InferSchemaType } from 'mongoose';

const coordinatorSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true, unique: true },
    phone: { type: String, trim: true },
    // Operational scope. A coordinator only sees requests/drivers/vehicles in these offices.
    officeLocations: { type: [String], default: [] },
    // Sign-in is email + this phone number; repeated failures lock it for a while.
    phoneLoginFailures: { type: Number, default: 0 },
    phoneLoginLockedUntil: { type: Date },
    // Set when an admin deletes a coordinator who has history (rides assigned, actions in the
    // audit log): only the name is kept so that history stays readable.
    deletedAt: { type: Date, index: true },
    deletedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export type CoordinatorAttrs = InferSchemaType<typeof coordinatorSchema>;
export const Coordinator = mongoose.model('Coordinator', coordinatorSchema);
