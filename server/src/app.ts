import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express, { Router } from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { logger } from './logger.js';
import { metrics } from './metrics.js';
import { emitDataChanged } from './realtime.js';
import { csrfProtection, loadSession, requireAuth } from './middleware/auth.js';
import { apiLimiter, errorHandler, notFoundHandler } from './middleware/common.js';
import { EmailOutbox } from './models/system.js';
import { adminRouter } from './routes/admin.routes.js';
import { authRouter } from './routes/auth.routes.js';
import { notificationRouter } from './routes/notification.routes.js';
import { operationsRouter } from './routes/operations.routes.js';
import { driverRouter, employeeRouter } from './routes/self.routes.js';
import { getPolicy } from './services/policy.service.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          frameAncestors: ["'none'"],
          formAction: ["'self'", 'https://login.microsoftonline.com'],
        },
      },
      hsts: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  if (!config.isTest) {
    app.use(
      pinoHttp({
        logger,
        autoLogging: { ignore: (req) => req.url?.startsWith('/api/health') ?? false },
        // Never log query strings (activation/reset tokens travel there).
        serializers: { req: (req) => ({ id: req.id, method: req.method, url: String(req.url).split('?')[0] }) },
      }),
    );
  }
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());
  app.use((_req, res, next) => {
    res.on('finish', () => metrics.inc(`http_responses_${Math.floor(res.statusCode / 100)}xx_total`));
    next();
  });

  // ---- Health & metrics (unauthenticated, no sensitive data) ----
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/health/ready', async (_req, res) => {
    try {
      await mongoose.connection.db!.admin().ping();
      res.json({ status: 'ready', db: 'up' });
    } catch {
      res.status(503).json({ status: 'not_ready', db: 'down' });
    }
  });
  app.get('/api/metrics', async (req, res) => {
    if (!config.METRICS_TOKEN || req.get('authorization') !== `Bearer ${config.METRICS_TOKEN}`) return res.status(404).end();
    const counts = await EmailOutbox.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
    const gauges = Object.fromEntries(counts.map((c) => [`email_outbox_${String(c._id).toLowerCase()}`, c.n]));
    res.type('text/plain').send(metrics.render(gauges));
  });

  // ---- API ----
  const api = Router();
  // Every successful change, by any role, refreshes everyone's open screens (see emitDataChanged).
  // Skipped: sign-in/password requests, marking one's own notifications read, and the one POST
  // that only looks things up (it would make screens refresh each other in a loop).
  api.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || /^\/(auth|notifications)\//.test(req.path) || req.path === '/ops/trips/eligible') return next();
    res.on('finish', () => {
      if (res.statusCode < 400) emitDataChanged();
    });
    next();
  });
  api.use(loadSession);
  api.use(apiLimiter);
  api.use(csrfProtection);
  api.use('/auth', authRouter);
  api.get('/policy', requireAuth, async (_req, res) => {
    const p = await getPolicy();
    res.json({ officeLocations: p.officeLocations, shifts: p.shifts, booking: p.booking, version: p.version });
  });
  api.use('/notifications', requireAuth, notificationRouter);
  api.use('/admin', requireAuth, adminRouter);
  api.use('/ops', requireAuth, operationsRouter);
  api.use('/me', requireAuth, employeeRouter);
  api.use('/driver', requireAuth, driverRouter);
  api.use(notFoundHandler);
  app.use('/api', api);

  // ---- Static frontend (production build) ----
  const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api|socket\.io).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
