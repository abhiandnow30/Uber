import { logger } from '../../logger.js';
import { EmailOutbox } from '../../models/system.js';
import { decrypt } from '../../utils/crypto.js';
import { metrics } from '../../metrics.js';
import { EmailSendError, getEmailProvider } from './providers.js';
import { renderEmail, type EmailTemplate } from './templates.js';

const LEASE_MS = 60_000;

export function backoffMs(attempt: number) {
  const base = 30_000 * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(base, 60 * 60_000);
  return Math.round(capped * (0.8 + Math.random() * 0.4));
}

/**
 * Claims and sends due outbox messages. Safe to run on several instances: each
 * message is claimed atomically with a lease. Delivery is at-least-once; a crash
 * between Graph accepting a message and the status update can cause a resend
 * after the lease expires (Graph sendMail has no idempotency key).
 */
export async function processOutboxBatch(limit = 20): Promise<number> {
  let processed = 0;
  for (; processed < limit; processed++) {
    const now = new Date();
    const job = await EmailOutbox.findOneAndUpdate(
      {
        $or: [
          { status: { $in: ['PENDING', 'RETRYING'] }, nextAttemptAt: { $lte: now } },
          { status: 'SENDING', lockedUntil: { $lt: now } }, // recover crashed workers
        ],
      },
      { $set: { status: 'SENDING', lockedUntil: new Date(now.getTime() + LEASE_MS) }, $inc: { attempts: 1 } },
      { sort: { nextAttemptAt: 1 }, new: true },
    ).select('+secretParams');
    if (!job) break;

    const provider = getEmailProvider();
    try {
      const secret = job.secretParams ? (JSON.parse(decrypt(job.secretParams)) as Record<string, string>) : {};
      const rendered = renderEmail(job.template as EmailTemplate, job.params ?? {}, secret);
      const result = await provider.send({
        to: job.to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        idempotencyKey: job.idempotencyKey,
      });
      await EmailOutbox.updateOne(
        { _id: job._id, status: 'SENDING' },
        {
          $set: {
            status: 'ACCEPTED',
            subject: rendered.subject,
            acceptedAt: new Date(),
            provider: provider.name,
            providerMessageId: result.providerMessageId,
            lastError: null,
          },
          $unset: { secretParams: 1, lockedUntil: 1 },
        },
      );
      metrics.inc('emails_accepted_total');
    } catch (err) {
      const transient = err instanceof EmailSendError ? err.transient : false;
      const message = (err as Error).message?.slice(0, 1000) ?? 'Unknown error';
      const exhausted = job.attempts >= job.maxAttempts;
      const willRetry = transient && !exhausted;
      const retryAfter = err instanceof EmailSendError ? err.retryAfterMs : undefined;
      await EmailOutbox.updateOne(
        { _id: job._id },
        {
          $set: {
            status: willRetry ? 'RETRYING' : 'FAILED',
            lastError: message,
            provider: provider.name,
            nextAttemptAt: new Date(Date.now() + Math.max(retryAfter ?? 0, backoffMs(job.attempts))),
          },
          $unset: { lockedUntil: 1 },
          $push: { errorHistory: { $each: [{ at: new Date(), error: message, transient }], $slice: -20 } },
        },
      );
      metrics.inc(willRetry ? 'emails_retried_total' : 'emails_failed_total');
      // Failed emails are only logged for whoever runs the server; they aren't shown to anyone in the app.
      logger.warn({ outboxId: String(job._id), template: job.template, transient, willRetry }, 'Email send failed');
    }
  }
  return processed;
}
