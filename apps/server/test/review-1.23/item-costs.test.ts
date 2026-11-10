/**
 * From the independent review of 1.23 (it failed before the fix): "Change items and prices" without
 * "See what stock cost" read an item's cost and stock value from what saving it returned, though the
 * item list hides them. All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectCleanAudit, ref, sessionFor, setup, type TestEnv } from '../helpers.js';

describe('an item’s cost, from saving it', () => {
  let env: TestEnv;
  let globe: { id: string };
  beforeAll(async () => {
    env = await setup();
    const owner = await sessionFor(env, 'owner@example.co.za');
    const { settings } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...settings, features: { ...settings.features, inventory: true } }, 'PUT');
    const bank = await (await ref(env.sql)).src('Business bank');
    globe = await owner.post('/api/items', { description: 'Fictional globe', sku: 'FG1', unitPriceCents: 4_600, priceIncludesVat: true, stocked: true });
    await owner.post('/api/stock/purchases', { date: '2026-07-01', supplier: 'Fictional Wholesale', reference: 'FW-1', sourceId: bank, lines: [{ itemId: globe.id, qtyInvoiced: 10, unitCostCents: 1_234 }] });
    await owner.post('/api/users', { name: 'Pricer (made up)', email: 'pricer@example.co.za', role: 'staff', profileId: null, access: ['items.edit'], password: 'test-password-1' });
  });
  afterAll(() => env.close());

  it('keeps the cost from someone who changes prices but may not see what stock cost', async () => {
    const pricer = await sessionFor(env, 'pricer@example.co.za');
    const costs = (o: Record<string, unknown>) => Object.keys(o).filter((k) => /cost|value/i.test(k));
    expect(costs((await pricer.get('/api/items'))[0])).toEqual([]);
    const saved = await pricer.post(`/api/items/${globe.id}`, { description: 'Fictional globe', sku: 'FG1', unitPriceCents: 4_900, priceIncludesVat: true, stocked: true }, 'PUT');
    expect(saved.unitPriceCents).toBe(4_900);
    expect(costs(saved)).toEqual([]);
    const made = await pricer.post('/api/items', { description: 'Fictional atlas', sku: 'FA1', unitPriceCents: 9_900, priceIncludesVat: true, stocked: false });
    expect(costs(made)).toEqual([]);
    await expectCleanAudit(env.sql, '2026-07-31');
  });
});
