import pino from 'pino';
import { config } from './config.js';

/**
 * Structured logger. Sensitive fields are redacted wherever they appear so that
 * PINs, tokens, passwords and cookies never reach log storage.
 */
export const logger = pino({
  level: config.isTest ? 'silent' : config.LOG_LEVEL,
  redact: {
    paths: [
      'password',
      '*.password',
      'pin',
      '*.pin',
      'token',
      '*.token',
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-csrf-token"]',
      'res.headers["set-cookie"]',
      '*.clientSecret',
      '*.secret',
    ],
    censor: '[REDACTED]',
  },
  base: { service: 'cab-booking-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
});
