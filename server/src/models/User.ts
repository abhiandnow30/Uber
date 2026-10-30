import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { ACCOUNT_STATUSES, ROLES } from '../domain.js';

const userSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, unique: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    role: { type: String, enum: ROLES, required: true, index: true },
    status: { type: String, enum: ACCOUNT_STATUSES, required: true, index: true },
    statusReason: { type: String },
    statusChangedAt: { type: Date },
    entraOid: { type: String, sparse: true, unique: true },
    lastLoginAt: { type: Date },
    activatedAt: { type: Date },
    invitedAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export type UserAttrs = InferSchemaType<typeof userSchema>;
export type UserDoc = HydratedDocument<UserAttrs>;
export const User = mongoose.model('User', userSchema);
