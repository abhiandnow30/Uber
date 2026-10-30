import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anonymous, makeCoordinator } from './helpers.js';

describe('sign-in rate limiting', () => {
  beforeAll(() => {
    process.env.ENABLE_RATE_LIMIT_IN_TESTS = 'true';
  });
  afterAll(() => {
    delete process.env.ENABLE_RATE_LIMIT_IN_TESTS;
  });

  it('does not count successful sign-ins (shared office IP) but blocks repeated failures', async () => {
    // 40 colleagues behind one IP sign in successfully (makeCoordinator signs each one in with email + mobile)
    for (let i = 0; i < 40; i++) await makeCoordinator(['HYD'], `user${i}@test.com`);
    // failures from the same IP are limited
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) {
      statuses.push((await anonymous().post('/api/auth/coordinator-login', { email: `nobody${i}@test.com`, phone: '9000000000' })).status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});
