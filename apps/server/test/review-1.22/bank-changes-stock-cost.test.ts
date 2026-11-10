/**
 * From the independent review of 1.22 (it failed before the fix): stock purchases are meant to stay as captured (refuseStock), but the bank
 * matching rounds the matched cost to the statement (up to R1), and create-costs takes any cost
 * type id, the Stock purchases type included. Either leaves the stock purchases clearing account
 * out. Made-up data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditBooks } from '../../src/audit/books.js';
import { balance, login, ref, setup, type TestEnv, expectCleanAudit } from '../helpers.js';

const D = '2026-07-01';

describe('the bank and stock purchases', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let bank: string;
  let item: { id: string };

  const line = async (amountCents: number, fp: string) => {
    const [st] = await env.sql<{ id: string }[]>`insert into bank_statements (source_id, filename, from_date, to_date) values (${bank}, ${fp + '.csv'}, ${D}, ${D}) returning id`;
    const [l] = await env.sql<{ id: string }[]>`insert into bank_lines (statement_id, source_id, date, description, amount_cents, fingerprint) values (${st!.id}, ${bank}, ${D}, 'MADE-UP SUPPLIER', ${amountCents}, ${fp}) returning id`;
    return l!.id;
  };

  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4740101508', features: { ...settings.features, inventory: true, bank: true } }, 'PUT');
    bank = await (await ref(env.sql)).src('Business bank');
    item = await me.post('/api/items', { description: 'Made-up widget', unitPriceCents: 5_000, priceIncludesVat: true, stocked: true });
  });
  afterAll(() => env.close());

  it('matching a statement line a few cents different leaves the stock purchase as invoiced', async () => {
    const p = await me.post('/api/stock/purchases', { date: D, supplier: 'Made-up Supplier', reference: 'MU-1', sourceId: bank, lines: [{ itemId: item.id, qtyInvoiced: 10, unitCostCents: 2_300 }] });
    const id = await line(-26_453, 'fp-1');
    const res = await me.call({ method: 'POST', url: `/api/bank/lines/${id}/match`, payload: { items: [{ kind: 'cost', id: p.costId }] } });
    const [c] = await env.sql<{ amountCents: string }[]>`select amount_cents from costs where id = ${p.costId}`;
    expect(await balance(env.sql, 'stock_clearing')).toBe(0);
  });

  it('won’t make a statement line a stock purchase without its lines', async () => {
    const [stock] = await env.sql<{ id: string }[]>`select id from cost_categories where kind = 'stock'`;
    const id = await line(-11_500, 'fp-2');
    const res = await me.call({ method: 'POST', url: '/api/bank/lines/create-costs', payload: { items: [{ lineId: id, categoryId: stock!.id, force: true }] } });
    expect(res.statusCode).toBe(400);
  });

  it('leaves the books clean', async () => {
    await expectCleanAudit(env.sql, '2026-07-31');
  });
});
