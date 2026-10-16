import type { ClientSession } from 'mongoose';
import type { Role } from '../domain.js';
import { logger } from '../logger.js';
import { AuditLog } from '../models/system.js';

export type Actor = {
  id: string;
  role: Role | 'SYSTEM';
  email?: string;
  ip?: string;
  userAgent?: string;
};

export const SYSTEM_ACTOR: Actor = { id: '', role: 'SYSTEM', email: 'system' };

// Secrets and personal location data are never copied into audit details.
const SENSITIVE_KEYS = /pass(word)?|pin|token|secret|cookie|authorization|address|landmark/i;

/** Strip anything that looks like a secret before persisting audit details. */
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if ((value as { _bsontype?: string })._bsontype === 'ObjectId') return String(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? '[REDACTED]' : sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

export async function audit(
  actor: Actor,
  action: string,
  entityType: string,
  entityId: string | { toString(): string } | null | undefined,
  summary: string,
  details?: Record<string, unknown>,
  session?: ClientSession | null,
) {
  try {
    await AuditLog.create(
      [
        {
          actor: actor.id || undefined,
          actorRole: actor.role,
          actorEmail: actor.email,
          action,
          entityType,
          entityId: entityId ? String(entityId) : undefined,
          summary,
          details: details ? sanitize(details) : undefined,
          ip: actor.ip,
          userAgent: actor.userAgent?.slice(0, 300),
        },
      ],
      { session: session ?? undefined },
    );
  } catch (err) {
    // Inside a transaction we must propagate so the business change is rolled back
    // rather than committed without its audit record.
    if (session) throw err;
    logger.error({ err, action }, 'Failed to write audit log');
  }
}
