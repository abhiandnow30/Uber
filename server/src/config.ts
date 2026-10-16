import 'dotenv/config';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),
  MONGODB_URI: z.string().min(1).default('memory'),
  PIN_HMAC_KEY: z.string().min(32, 'PIN_HMAC_KEY must be at least 32 characters'),
  DATA_ENCRYPTION_KEY: z.string().min(1),
  TOKEN_HMAC_KEY: z.string().min(32, 'TOKEN_HMAC_KEY must be at least 32 characters'),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  SESSION_IDLE_MINUTES: z.coerce.number().positive().default(120),
  COOKIE_SECURE: bool(false),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  EMAIL_MODE: z.enum(['mock', 'graph', 'smtp']).default('mock'),
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().default(587)),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  SMTP_FROM: z.string().optional().default(''),
  GRAPH_TENANT_ID: z.string().optional().default(''),
  GRAPH_CLIENT_ID: z.string().optional().default(''),
  GRAPH_CLIENT_SECRET: z.string().optional().default(''),
  GRAPH_SENDER_MAILBOX: z.string().optional().default(''),
  ENTRA_TENANT_ID: z.string().optional().default(''),
  ENTRA_CLIENT_ID: z.string().optional().default(''),
  ENTRA_CLIENT_SECRET: z.string().optional().default(''),
  ENTRA_REDIRECT_URI: z.string().optional().default(''),
  WORKERS_ENABLED: bool(true),
  // Comma-separated list of official email domains (e.g. "contoso.com"). Blank = any domain.
  ALLOWED_EMAIL_DOMAINS: z.string().optional().default(''),
  METRICS_TOKEN: z.string().optional().default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid server configuration:\n${issues}`);
  }
  const cfg = parsed.data;

  const encKey = Buffer.from(cfg.DATA_ENCRYPTION_KEY, 'base64');
  if (encKey.length !== 32) {
    throw new Error('DATA_ENCRYPTION_KEY must be base64 encoding of exactly 32 bytes');
  }

  if (cfg.NODE_ENV === 'production') {
    const problems: string[] = [];
    if (cfg.MONGODB_URI === 'memory') problems.push('MONGODB_URI=memory is not allowed in production');
    if (!cfg.COOKIE_SECURE) problems.push('COOKIE_SECURE must be true in production (HTTPS)');
    if (/change-me|dev-only/i.test(cfg.PIN_HMAC_KEY + cfg.TOKEN_HMAC_KEY))
      problems.push('Development secrets detected; set real PIN_HMAC_KEY / TOKEN_HMAC_KEY');
    if (cfg.DATA_ENCRYPTION_KEY === 'ZGV2LW9ubHktZW5jcnlwdGlvbi1rZXktMzJieXRlcyE=')
      problems.push('Development DATA_ENCRYPTION_KEY detected');
    if (cfg.EMAIL_MODE === 'mock') problems.push('EMAIL_MODE=mock is not allowed in production');
    if (!(cfg.ENTRA_TENANT_ID && cfg.ENTRA_CLIENT_ID && cfg.ENTRA_CLIENT_SECRET && cfg.ENTRA_REDIRECT_URI))
      problems.push('Microsoft sign-in (ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET, ENTRA_REDIRECT_URI) is required: employees sign in only with Microsoft');
    if (problems.length) throw new Error(`Refusing to start in production:\n  - ${problems.join('\n  - ')}`);
  }

  if (cfg.EMAIL_MODE === 'graph') {
    const missing = ['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'GRAPH_SENDER_MAILBOX'].filter(
      (k) => !(cfg as Record<string, unknown>)[k],
    );
    if (missing.length) throw new Error(`EMAIL_MODE=graph requires: ${missing.join(', ')}`);
  }
  if (cfg.EMAIL_MODE === 'smtp') {
    const missing = ['SMTP_HOST'].filter((k) => !(cfg as Record<string, unknown>)[k]);
    if (missing.length) throw new Error(`EMAIL_MODE=smtp requires: ${missing.join(', ')}`);
  }

  return {
    ...cfg,
    isProd: cfg.NODE_ENV === 'production',
    isTest: cfg.NODE_ENV === 'test',
    encryptionKey: encKey,
    allowedEmailDomains: cfg.ALLOWED_EMAIL_DOMAINS.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
    ssoEnabled: Boolean(cfg.ENTRA_TENANT_ID && cfg.ENTRA_CLIENT_ID && cfg.ENTRA_CLIENT_SECRET && cfg.ENTRA_REDIRECT_URI),
  };
}

export const config = load();
export type AppConfig = typeof config;
