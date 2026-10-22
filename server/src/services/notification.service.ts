import type { ClientSession } from 'mongoose';
import type { TxContext } from '../db.js';
import { emitToUser } from '../realtime.js';
import { EmailOutbox, Notification } from '../models/system.js';
import { encrypt } from '../utils/crypto.js';
import { getPolicy } from './policy.service.js';
import type { EmailTemplate } from './email/templates.js';

export type InAppInput = {
  userId: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  idempotencyKey?: string;
};

/**
 * Persist an in-app notification (inside the caller's transaction when given)
 * and push it over the websocket after commit. Idempotent by key.
 */
export async function notifyInApp(tx: TxContext | null, input: InAppInput) {
  const session = tx?.session;
  const doc = {
    user: input.userId,
    type: input.type,
    title: input.title,
    body: input.body,
    data: input.data ?? {},
    readAt: null,
  };
  let created: { _id: unknown } | null = null;
  if (input.idempotencyKey) {
    const res = await Notification.updateOne(
      { idempotencyKey: input.idempotencyKey },
      { $setOnInsert: { ...doc, idempotencyKey: input.idempotencyKey } },
      { upsert: true, session },
    );
    if (!res.upsertedId) return; // already delivered for this event
    created = { _id: res.upsertedId };
  } else {
    const [n] = await Notification.create([doc], { session });
    created = n;
  }
  const push = () =>
    emitToUser(input.userId, 'notification', {
      _id: String(created!._id),
      ...doc,
      createdAt: new Date().toISOString(),
    });
  if (tx) tx.afterCommit(push);
  else push();
}

export type NotificationPreference =
  | 'emailOnSubmitted'
  | 'emailOnApprovalDecision'
  | 'emailOnAssigned'
  | 'emailOnChanged'
  | 'emailOnCancelled'
  | 'emailOnArrived'
  | 'emailOnTripStarted'
  | 'emailOnCompleted'
  | 'emailOnDelay'
  | 'dailyBookingReminder';

export type EmailInput = {
  idempotencyKey: string;
  template: EmailTemplate;
  to: string;
  toUserId?: string;
  params: Record<string, unknown>;
  /** Values like activation links. Encrypted at rest and wiped after sending. */
  secretParams?: Record<string, string>;
  relatedBookingId?: string;
  /** If set, the email is only queued when this policy preference is enabled. */
  preference?: NotificationPreference;
};

/**
 * Transactional outbox: the email job is written in the same transaction as the
 * business change, so an assignment can never exist without its notification job
 * (and a failed send can never roll back or duplicate the assignment).
 */
export async function enqueueEmail(session: ClientSession | null | undefined, input: EmailInput) {
  if (input.preference) {
    const policy = await getPolicy();
    const prefs = (policy.notifications ?? {}) as Record<string, boolean>;
    if (prefs[input.preference] === false) return null;
  }
  const res = await EmailOutbox.updateOne(
    { idempotencyKey: input.idempotencyKey },
    {
      $setOnInsert: {
        idempotencyKey: input.idempotencyKey,
        template: input.template,
        to: input.to.toLowerCase(),
        toUser: input.toUserId,
        params: input.params,
        secretParams: input.secretParams ? encrypt(JSON.stringify(input.secretParams)) : undefined,
        status: 'PENDING',
        nextAttemptAt: new Date(),
        relatedBooking: input.relatedBookingId,
      },
    },
    { upsert: true, session: session ?? undefined },
  );
  return res.upsertedId ?? null;
}
