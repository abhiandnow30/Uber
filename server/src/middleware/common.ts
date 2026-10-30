import type { NextFunction, Request, Response } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import mongoose from 'mongoose';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { AppError, validationError } from '../utils/errors.js';

/** Parse and replace req.body with the validated value. */
export function body<S extends ZodTypeAny>(schema: S, req: Request): z.infer<S> {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) throw zodToError(parsed.error);
  return parsed.data;
}

export function query<S extends ZodTypeAny>(schema: S, req: Request): z.infer<S> {
  const parsed = schema.safeParse(req.query ?? {});
  if (!parsed.success) throw zodToError(parsed.error);
  return parsed.data;
}

export function zodToError(err: ZodError) {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  const first = err.issues[0];
  const label = first?.path.join('.') ? `${first.path.join('.')}: ` : '';
  return validationError(`${label}${first?.message ?? 'Invalid input'}`, { fields });
}

export function objectId(value: string | string[] | undefined, what = 'id'): string {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v || !mongoose.isValidObjectId(v)) throw new AppError(404, 'NOT_FOUND', `${what} not found`);
  return v;
}

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction) {
  next(new AppError(404, 'NOT_FOUND', 'Route not found'));
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    if (err.status >= 500) logger.error({ err, path: req.path }, 'Request failed');
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof ZodError) {
    const e = zodToError(err);
    return res.status(e.status).json({ error: { code: e.code, message: e.message, details: e.details } });
  }
  const e = err as { type?: string; status?: number; code?: string | number; message?: string };
  if (e?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Malformed JSON body' } });
  }
  if (e?.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } });
  }
  if (e?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: { code: 'FILE_TOO_LARGE', message: 'File exceeds the maximum allowed size' } });
  }
  if (e?.code === 11000) {
    return res.status(409).json({ error: { code: 'DUPLICATE', message: 'A record with these unique values already exists' } });
  }
  logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: config.isProd ? 'An unexpected error occurred' : String(e?.message ?? err) },
  });
}

const limiterDefaults: Partial<Options> = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res, _next, options) =>
    res.status(options.statusCode).json({ error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests. Please slow down and try again shortly.' } }),
};

const skipInTests = () => config.isTest && process.env.ENABLE_RATE_LIMIT_IN_TESTS !== 'true';

// NOTE: the in-memory store is per-process. Use a shared store (e.g. Redis) when
// running multiple API instances.
// Offices often share one NAT IP, so successful sign-ins are not counted (only
// failures); driver and coordinator sign-in also lock out after repeated failures.
export const authLimiter = rateLimit({ ...limiterDefaults, windowMs: 15 * 60_000, limit: 30, skipSuccessfulRequests: true, skip: skipInTests });
export const publicFormLimiter = rateLimit({ ...limiterDefaults, windowMs: 60 * 60_000, limit: 10, skip: skipInTests });
// Keyed per signed-in user (falls back to IP), so a shared office IP is not one bucket.
export const apiLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 60_000,
  limit: 300,
  keyGenerator: (req) => (req.auth ? `user:${req.auth.user._id}` : `ip:${req.ip}`),
  skip: skipInTests,
});
export const pinLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 10 * 60_000,
  limit: 15,
  keyGenerator: (req) => `pin:${req.auth?.user?._id ?? req.ip}`,
  skip: skipInTests,
});
