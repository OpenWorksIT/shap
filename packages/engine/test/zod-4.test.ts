/**
 * From the independent review of Shap 1.23.1 / Pocket 1.7.1, the move to zod 4 (each failed before
 * its fix): a refused request said what zod 4 says when a schema has no words of its own, rather
 * than "Required" and "Invalid" as before; and an unknown accountant export threw instead of
 * being refused. All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import '@shap/shared';
import { login, ref, setup, type TestEnv } from './helpers.js';

describe('the words a refused request comes back with', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app);
  });
  afterAll(() => env.close());

  it('says a field left out is required, and doesn’t show a pattern', async () => {
    const left = await me.call({ method: 'POST', url: '/api/clients', payload: { email: 'made.up@example.co.za' } });
    expect(left.statusCode).toBe(400);
    expect(left.json().error).toBe('Required');
    const bank = await (await ref(env.sql)).src('Business bank');
    const pattern = await me.call({ method: 'POST', url: '/api/sars-payments', payload: { kind: 'emp201', period: '', date: '2026-06-05', amountCents: 1_000, sourceId: bank } });
    expect(pattern.statusCode).toBe(400);
    expect(pattern.json().error).toBe('Choose the month');
    // A pattern with no words of its own says "Invalid", not the pattern.
    expect(z.string().regex(/^\d{4}-\d{2}$/).safeParse('').error?.issues[0]?.message).toBe('Invalid');
  });

  it('refuses an unknown accountant export', async () => {
    expect((await me.call({ method: 'GET', url: '/api/accountant-export?dataset=made-up' })).statusCode).toBe(400);
  });
});
