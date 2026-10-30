import mongoose, { Schema, type InferSchemaType } from 'mongoose';
import { ACCESS_REQUEST_STATUSES, EMAIL_STATUSES, EXCEPTION_TYPES } from '../domain.js';

// ---------------------------------------------------------------------------
// Sessions (server-side, revocable). Only a keyed hash of the cookie is stored.
// ---------------------------------------------------------------------------
const sessionSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    csrfToken: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    revokedAt: { type: Date },
    revokeReason: { type: String },
    ip: { type: String },
    userAgent: { type: String },
    authMethod: { type: String, enum: ['SSO', 'PHONE'] },
  },
  { timestamps: true },
);
// Clean up long-expired sessions automatically.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });
export const Session = mongoose.model('Session', sessionSchema);

// ---------------------------------------------------------------------------
// In-app notifications (persisted; pushed over websockets when online).
// ---------------------------------------------------------------------------
const notificationSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    data: { type: Schema.Types.Mixed, default: {} },
    readAt: { type: Date, default: null },
    idempotencyKey: { type: String },
  },
  { timestamps: true },
);
notificationSchema.index({ user: 1, readAt: 1, createdAt: -1 });
notificationSchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);
export const Notification = mongoose.model('Notification', notificationSchema);

// ---------------------------------------------------------------------------
// Email outbox (transactional outbox pattern). Written in the same DB
// transaction as the business change; sent asynchronously by the worker.
// ---------------------------------------------------------------------------
const emailOutboxSchema = new Schema(
  {
    idempotencyKey: { type: String, required: true, unique: true },
    template: { type: String, required: true },
    to: { type: String, required: true, lowercase: true },
    toUser: { type: Schema.Types.ObjectId, ref: 'User' },
    params: { type: Schema.Types.Mixed, default: {} }, // non-secret render params
    subject: { type: String },
    status: { type: String, enum: EMAIL_STATUSES, default: 'PENDING', index: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 6 },
    nextAttemptAt: { type: Date, default: () => new Date(), index: true },
    lockedUntil: { type: Date },
    lastError: { type: String },
    errorHistory: { type: [{ at: Date, error: String, transient: Boolean }], default: [] },
    provider: { type: String },
    providerMessageId: { type: String },
    acceptedAt: { type: Date },
    deliveredAt: { type: Date },
    deliveryEvidence: { type: String },
    relatedBooking: { type: Schema.Types.ObjectId, ref: 'CabRequest', index: true },
  },
  { timestamps: true },
);
emailOutboxSchema.index({ status: 1, nextAttemptAt: 1 });
export const EmailOutbox = mongoose.model('EmailOutbox', emailOutboxSchema);
export type EmailOutboxAttrs = InferSchemaType<typeof emailOutboxSchema>;

// ---------------------------------------------------------------------------
// Audit log (append-only).
// ---------------------------------------------------------------------------
const auditLogSchema = new Schema(
  {
    actor: { type: Schema.Types.ObjectId, ref: 'User' },
    actorRole: { type: String },
    actorEmail: { type: String },
    action: { type: String, required: true, index: true },
    entityType: { type: String, required: true },
    entityId: { type: String },
    summary: { type: String },
    details: { type: Schema.Types.Mixed },
    ip: { type: String },
    userAgent: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
export const AuditLog = mongoose.model('AuditLog', auditLogSchema);

