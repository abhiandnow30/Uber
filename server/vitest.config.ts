import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['./test/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    pool: 'forks',
    env: {
      NODE_ENV: 'test',
      MONGODB_URI: 'injected-by-setup',
      PIN_HMAC_KEY: 'test-pin-hmac-key-0123456789abcdef0123456789',
      TOKEN_HMAC_KEY: 'test-token-hmac-key-0123456789abcdef012345678',
      DATA_ENCRYPTION_KEY: 'dGVzdC1lbmNyeXB0aW9uLWtleS0zMi1ieXRlcyEhISE=',
      EMAIL_MODE: 'mock',
      WORKERS_ENABLED: 'false',
      APP_BASE_URL: 'http://localhost:5173',
      ALLOWED_EMAIL_DOMAINS: '',
      // Never pick up a developer's real Microsoft settings from server/.env; SSO tests enable it explicitly.
      ENTRA_TENANT_ID: '',
      ENTRA_CLIENT_ID: '',
      ENTRA_CLIENT_SECRET: '',
      ENTRA_REDIRECT_URI: '',
      LOG_LEVEL: 'silent',
    },
  },
});
