/**
 * From the independent review of 1.22 (it failed before the fix): a discount line can sit in a VAT class with nothing else in it: a standard-rated
 * discount on zero-rated goods gives the sale negative output VAT. Made-up data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, setup, type TestEnv, expectCleanAudit } from '../helpers.js';

describe('a discount in the wrong VAT class', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4740101508', features: { ...settings.features, sales: true } }, 'PUT');
  });
  afterAll(() => env.close());

  it('refuses a discount bigger than what it discounts in its VAT class', async () => {
    const till = (await env.sql<{ id: string }[]>`select id from payment_sources where till`)[0]!.id;
    const res = await me.call({
      method: 'POST',
      url: '/api/sales',
      payload: { date: '2026-07-01', sourceId: till, lines: [
        { description: 'Brown bread x 100 (made up)', qty: 100, unitPriceCents: 2_000, vatCode: 'zero' },
        { description: 'Discount (made up)', qty: 1, unitPriceCents: -1_150_00, vatCode: 'standard' },
      ] },
    });

    expect(res.statusCode).toBe(400);
  });

  it('leaves the books clean', async () => {
    await expectCleanAudit(env.sql, '2026-07-31');
  });
});
