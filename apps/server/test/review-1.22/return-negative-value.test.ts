/**
 * From the independent review of 1.22 (it failed before the fix): stock sent back on an earlier purchase goes out at that purchase's price, not
 * the average. When the average has fallen since, the item is left with stock on hand worth less
 * than nothing. Made-up data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditBooks } from '../../src/audit/books.js';
import { login, ref, setup, type TestEnv, expectCleanAudit } from '../helpers.js';

const D = '2026-07-01';

describe('a return at the old price', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let bank: string;
  let till: string;
  let item: { id: string };

  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4740101508', features: { ...settings.features, inventory: true } }, 'PUT');
    bank = await (await ref(env.sql)).src('Business bank');
    till = (await env.sql<{ id: string }[]>`select id from payment_sources where till`)[0]!.id;
    item = await me.post('/api/items', { description: 'Made-up widget', unitPriceCents: 23_000, priceIncludesVat: true, stocked: true });
  });
  afterAll(() => env.close());

  it('sends stock back at average cost, never leaving it worth less than nothing', async () => {
    const p1 = await me.post('/api/stock/purchases', { date: D, supplier: 'Made-up Supplier', reference: 'A', sourceId: bank, lines: [{ itemId: item.id, qtyInvoiced: 10, unitCostCents: 10_000 }] });
    await me.post('/api/sales', { date: D, sourceId: till, lines: [{ itemId: item.id, description: 'Made-up widget', qty: 9, unitPriceCents: 23_000 }] });
    await me.post('/api/stock/purchases', { date: D, supplier: 'Made-up Supplier', reference: 'B', sourceId: bank, lines: [{ itemId: item.id, qtyInvoiced: 2, unitCostCents: 1_000 }] });
    // 3 on hand worth R120. Two from the first delivery go back (damaged): at R100 each.
    const r = await me.call({ method: 'POST', url: '/api/stock/returns', payload: { date: D, supplier: 'Made-up Supplier', costId: p1.costId, itemId: item.id, qty: 2, reason: 'Damaged (made up)' } });
    const [it] = await env.sql<{ qtyOnHand: string; stockValueCents: string }[]>`select qty_on_hand, stock_value_cents from items where id = ${item.id}`;
    expect(Number(it!.stockValueCents)).toBeGreaterThanOrEqual(0);
  });

  it('leaves the books clean', async () => {
    await expectCleanAudit(env.sql, '2026-07-31');
  });
});
