import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anonymous, makeUser, PASSWORD } from './helpers.js';

describe('login rate limiting', () => {
  beforeAll(() => {
    process.env.ENABLE_RATE_LIMIT_IN_TESTS = 'true';
  });
  afterAll(() => {
    delete process.env.ENABLE_RATE_LIMIT_IN_TESTS;
  });

  it('does not count successful sign-ins (shared office IP) but blocks repeated failures', async () => {
    for (let i = 0; i < 40; i++) await makeUser('EMPLOYEE', `user${i}@test.com`);
    // 40 colleagues behind one IP sign in successfully
    for (let i = 0; i < 40; i++) {
      const r = await anonymous().post('/api/auth/login', { email: `user${i}@test.com`, password: PASSWORD });
      expect(r.status).toBe(200);
    }
    // failures from the same IP are limited
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) {
      statuses.push((await anonymous().post('/api/auth/login', { email: `nobody${i}@test.com`, password: 'wrong-pass-1' })).status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});
