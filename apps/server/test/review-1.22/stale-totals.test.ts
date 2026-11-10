/**
 * From the independent review of 1.22 (it failed before the fix): stock takes, claim write-offs, supplier returns and opening stock change the
 * ledger (ledger_detail reads stock_moves / stock_claims / stock_claim_settlements) but none of
 * those tables has a books_changed trigger, so ledger_totals (behind the reports, the statements
 * and the hash check on approval) goes stale. Made-up data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditBooks } from '../../src/audit/books.js';
import { balance, login, ref, setup, type TestEnv, expectCleanAudit } from '../helpers.js';

const D = '2026-07-01';

describe('ledger_totals after stock-only records', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let bank: string;
  let item: { id: string };

  const tbLosses = async () => {
    const tb = await me.get(`/api/reports/trial-balance?date=2026-07-31`);
    const rows = (tb.rows ?? tb.accounts ?? []) as { code: string; name: string; balanceCents: number }[];
    return rows.find((r) => /Stock losses/.test(r.name))?.balanceCents ?? 0;
  };
  const totalsOff = async () => (await auditBooks(env.sql, '2026-07-31')).find((i) => /quick totals/.test(i.text));

  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4740101508', features: { ...settings.features, inventory: true, bills: true } }, 'PUT');
    bank = await (await ref(env.sql)).src('Business bank');
    item = await me.post('/api/items', { description: 'Made-up widget', unitPriceCents: 5_000, priceIncludesVat: true, stocked: true });
    await me.post('/api/stock/purchases', { date: D, supplier: 'Made-up Supplier', reference: 'MU-1', sourceId: bank, lines: [{ itemId: item.id, qtyInvoiced: 10, unitCostCents: 1_000 }] });
    // Bring the cache up to date now.
    await me.get('/api/reports/trial-balance?date=2026-07-31');
  });
  afterAll(() => env.close());

  it('a stock take’s losses reach the trial balance at once', async () => {
    await me.post('/api/stock/takes', { date: D, lines: [{ itemId: item.id, countedQty: 8, reason: 'Two missing (made up)' }] });
    const ledger = await balance(env.sql, 'stock_losses');
    const tb = await tbLosses();
    const q = await totalsOff();
    expect(ledger).toBe(2_000);
    // Expected to FAIL if the bug is real: the TB still says 0.
    expect(tb).toBe(2_000);
  });

  it('leaves the books clean', async () => {
    await expectCleanAudit(env.sql, '2026-07-31');
  });
});
