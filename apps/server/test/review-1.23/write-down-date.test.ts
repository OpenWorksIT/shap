/**
 * From the independent review of 1.23 (it failed before the fix): a write-down could be dated in
 * the past, but it's worked out from what's on hand now (the average cost runs in the order stock
 * moves), so dated before later movements it wrote down the wrong amount, and could leave stock
 * worth less than nothing at that date. Now it can't be dated before the item last moved (that's a
 * journal at the year end, for the accountant). All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectCleanAudit, ref, sessionFor, setup, type TestEnv } from '../helpers.js';

const FY = '2026-02-28';

describe('a write-down dated before the stock last moved', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof sessionFor>>;
  let bank: string;
  beforeAll(async () => {
    env = await setup();
    owner = await sessionFor(env, 'owner@example.co.za');
    const { settings } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...settings, features: { ...settings.features, inventory: true } }, 'PUT');
    bank = await (await ref(env.sql)).src('Business bank');
  });
  afterAll(() => env.close());

  it('is refused, and allowed on or after the last movement', async () => {
    const bulb = await owner.post('/api/items', { description: 'Fictional bulb', unitPriceCents: 100, priceIncludesVat: false, vatCode: 'standard', stocked: true });
    await owner.post('/api/stock/purchases', { date: '2026-01-10', supplier: 'Fictional Supplier', reference: 'B-1', sourceId: bank, lines: [{ itemId: bulb.id, qtyInvoiced: 1, unitCostCents: 1_000 }] });
    await owner.post('/api/stock/purchases', { date: '2026-05-10', supplier: 'Fictional Supplier', reference: 'B-2', sourceId: bank, lines: [{ itemId: bulb.id, qtyInvoiced: 100, unitCostCents: 1_000 }] });
    const back = await owner.call({ method: 'POST', url: '/api/stock/write-downs', payload: { date: FY, lines: [{ itemId: bulb.id, unitValueCents: 100 }] } });
    expect(back.statusCode).toBe(400);
    expect(back.json().error ?? back.body).toMatch(/moved on 2026-05-10/);
    // Nothing was written down at the year end.
    const atYearEnd = (await owner.get(`/api/stock/valuation?date=${FY}`)).rows.find((r: { id: string }) => r.id === bulb.id);
    expect(Number(atYearEnd.valueCents)).toBe(1_000);
    // On the day of the last movement: 101 at R10 written down to R1 each.
    const r = await owner.post('/api/stock/write-downs', { date: '2026-05-10', lines: [{ itemId: bulb.id, unitValueCents: 100 }] });
    expect(r.valueCents).toBe(-90_900);
    await expectCleanAudit(env.sql, '2026-07-31');
  });
});
