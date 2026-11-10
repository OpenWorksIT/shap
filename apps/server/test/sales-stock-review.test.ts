/**
 * What the accountant bot's year of made-up trading found (1.22, before release), each put right:
 * voids, unclaimable VAT on stock, suppliers' credits on bills, goods returned on an invoice still
 * owed, a closed year staying closed, counts not back-dated into, the books audit's stock checks,
 * and the slips' and invoices' wording. Each test fails without its fix. All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditBooks } from '../src/audit/books.js';
import { balance, expectCleanAudit, ledgerTotal, login, ref, setup, type TestEnv } from './helpers.js';

const D = '2026-07-01';

describe('selling from stock: what the accountant bot found', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let bank: string;
  let bills: string;
  let till: string;
  let client: { id: string };
  let cutter: { id: string };
  let hamper: { id: string };
  const item = async (id: string) => (await env.sql<{ qtyOnHand: number; stockValueCents: number }[]>`select qty_on_hand, stock_value_cents from items where id = ${id}`)[0]!;

  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    const { settings, sources } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4740101508', features: { ...settings.features, inventory: true, bills: true } }, 'PUT');
    bank = await (await ref(env.sql)).src('Business bank');
    bills = sources.find((s: { role: string | null }) => s.role === 'bills').id;
    till = (await env.sql<{ id: string }[]>`select id from payment_sources where till`)[0]!.id;
    client = await me.post('/api/clients', { name: 'Fictional Tiler', address: '4 Pretend Lane, Fictional Town' });
    cutter = await me.post('/api/items', { description: 'Tile cutter (made up)', unitPriceCents: 115_000, priceIncludesVat: true, stocked: true });
    hamper = await me.post('/api/items', { description: 'Gift hamper (made up)', unitPriceCents: 25_000, stocked: true });
    await me.post('/api/stock/purchases', { date: '2026-06-01', supplier: 'Fictional Tools', reference: 'FT-1', sourceId: bank, lines: [{ itemId: cutter.id, qtyInvoiced: 4, unitCostCents: 60_000 }] });
  });
  afterAll(() => env.close());

  it('voids an invoice with its stock back on the invoice’s own date, so its cost of sales goes with its revenue', async () => {
    const inv = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: '2026-06-15', lines: [{ category: 'goods', description: 'Tile cutter (made up)', qty: 1, unitPriceCents: 100_000, itemId: cutter.id }] });
    await me.post(`/api/documents/${inv.id}/issue`);
    expect(await balance(env.sql, 'cos_goods')).toBe(60_000);
    await me.post(`/api/documents/${inv.id}/void`, { reason: 'Client cancelled (made up)' });
    const [back] = await env.sql<{ date: string }[]>`select date::text from stock_moves where document_id = ${inv.id} and kind = 'void'`;
    expect(back!.date).toBe('2026-06-15');
    expect(await balance(env.sql, 'cos_goods', '2026-06-30')).toBe(0);
    expect(await item(cutter.id)).toMatchObject({ qtyOnHand: 4, stockValueCents: 240_000 });
  });

  it('keeps a count as counted: nothing dated before it, a void after it pointed to a credit note', async () => {
    const inv = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: '2026-06-20', lines: [{ category: 'goods', description: 'Tile cutter (made up)', qty: 1, unitPriceCents: 100_000, itemId: cutter.id }] });
    await me.post(`/api/documents/${inv.id}/issue`);
    await me.post('/api/stock/takes', { date: '2026-06-25', lines: [{ itemId: cutter.id, countedQty: 3 }] });
    const early = await me.call({ method: 'POST', url: '/api/stock/purchases', payload: { date: '2026-06-24', supplier: 'Fictional Tools', sourceId: bank, lines: [{ itemId: cutter.id, qtyInvoiced: 1, unitCostCents: 60_000 }] } });
    expect(early.statusCode).toBe(400);
    expect(early.json().error).toMatch(/counted on 2026-06-25/);
    const voided = await me.call({ method: 'POST', url: `/api/documents/${inv.id}/void`, payload: { reason: 'Too late (made up)' } });
    expect(voided.statusCode).toBe(400);
    expect(voided.json().error).toMatch(/credit note/);
    // Taken back with a credit note instead, off what's owed, the cutter back into stock.
    const sale = await me.get(`/api/sales/${inv.id}`);
    const r = await me.post(`/api/documents/${inv.id}/refund`, { date: '2026-06-26', money: 'off_owing', reason: 'Cancelled after the count (made up)', lines: [{ lineId: sale.lines[0].id, qty: 1, restock: true }] });
    // R1 000 plus VAT, all of it taken off what's owed.
    expect(r.amountCents).toBe(115_000);
    expect(Number((await me.get(`/api/documents/${inv.id}`)).doc.paidCents)).toBe(115_000);
    expect(await item(cutter.id)).toMatchObject({ qtyOnHand: 4 });
    expect(await balance(env.sql, 'receivables')).toBe(0);
    // Never more than is owed.
    const inv2 = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: '2026-06-27', lines: [{ category: 'goods', description: 'Tile cutter (made up)', qty: 1, unitPriceCents: 100_000, itemId: cutter.id }] });
    await me.post(`/api/documents/${inv2.id}/issue`);
    await me.post(`/api/documents/${inv2.id}/receipts`, { date: '2026-06-28', amountCents: 80_000, sourceId: bank });
    const s2 = await me.get(`/api/sales/${inv2.id}`);
    const tooMuch = await me.call({ method: 'POST', url: `/api/documents/${inv2.id}/refund`, payload: { date: '2026-06-28', money: 'off_owing', reason: 'Returned (made up)', lines: [{ lineId: s2.lines[0].id, qty: 1 }] } });
    expect(tooMuch.statusCode).toBe(400);
  });

  it('counts VAT that can’t be claimed in what the stock cost and what’s owed', async () => {
    const p = await me.post('/api/stock/purchases', { date: D, supplier: 'Fictional Gifts', reference: 'FG-1', sourceId: bills, lines: [{ itemId: hamper.id, qtyInvoiced: 2, unitCostCents: 7_000, vatCode: 'not_claimable' }] });
    const [c] = await env.sql<{ amountCents: number; vatCents: number }[]>`select amount_cents, vat_cents from costs where id = ${p.costId}`;
    expect(c).toMatchObject({ amountCents: 16_100, vatCents: 0 });
    expect(await item(hamper.id)).toMatchObject({ qtyOnHand: 2, stockValueCents: 16_100 });
  });

  it('takes a supplier’s credit note off their bill: the bill owes that much less, no money moves', async () => {
    const before = await balance(env.sql, 'payables');
    const [hamperBill] = await env.sql<{ id: string }[]>`select id from costs where bill_number = 'FG-1'`;
    await me.post('/api/stock/returns', { date: D, supplier: 'Fictional Gifts', itemId: hamper.id, qty: 1, reason: 'Crushed in transit (made up)' });
    const claims = await me.get('/api/stock/claims');
    await me.post('/api/stock/credits', { date: D, supplier: 'Fictional Gifts', reference: 'FG-CN1', sourceId: bills, amountCents: 8_050, vatCents: 0, vatCode: 'no_vat', claimIds: claims.map((c: { id: string }) => c.id), billId: hamperBill!.id });
    const open = await me.get('/api/bills?state=open');
    expect(open.find((b: { id: string }) => b.id === hamperBill!.id).owingCents).toBe(8_050);
    expect(await balance(env.sql, 'payables')).toBe(before + 8_050);
    expect(await me.get('/api/bills?state=credits')).toEqual([]);
    // A credit not taken off a bill waits, and is taken off one later.
    await me.post('/api/stock/purchases', { date: D, supplier: 'Fictional Gifts', reference: 'FG-2', sourceId: bills, lines: [{ itemId: hamper.id, qtyInvoiced: 1, unitCostCents: 7_000, vatCode: 'not_claimable' }] });
    await me.post('/api/stock/credits', { date: D, supplier: 'Fictional Gifts', reference: 'FG-CN2', sourceId: bills, amountCents: 1_000, vatCents: 0, vatCode: 'no_vat', note: 'Settlement discount (made up)' });
    const [credit] = await me.get('/api/bills?state=credits');
    expect(credit.owingCents).toBe(-1_000);
    const [fg2] = await env.sql<{ id: string }[]>`select id from costs where bill_number = 'FG-2'`;
    await me.post(`/api/costs/${fg2!.id}/bill-credits`, { date: D, creditId: credit.id, amountCents: 1_000 });
    expect(await me.get('/api/bills?state=credits')).toEqual([]);
    expect((await me.get('/api/bills?state=open')).find((b: { id: string }) => b.id === fg2!.id).owingCents).toBe(8_050 - 1_000);
    const again = await me.call({ method: 'POST', url: `/api/costs/${fg2!.id}/bill-credits`, payload: { date: D, creditId: credit.id, amountCents: 1 } });
    expect(again.statusCode).toBe(400);
  });

  it('makes a sale’s slip a slip, and an invoice paid at the counter says so', async () => {
    const s = await me.post('/api/sales', { date: D, sourceId: till, lines: [{ description: 'Key cut (made up)', qty: 1, unitPriceCents: 2_500, category: 'other' }] });
    expect(s.doc.terms).toBe('');
    const pdf = await me.call({ method: 'GET', url: `/api/documents/${s.id}/pdf` });
    expect(pdf.headers['content-disposition']).toMatch(/Sale /);
    const inv = await me.post(`/api/sales/${s.id}/invoice`, { clientId: client.id });
    expect(inv.doc.terms).toMatch(/Paid in full/);
    // Never voided, never paid again: refunded.
    expect((await me.call({ method: 'POST', url: `/api/documents/${s.id}/void`, payload: { reason: 'x' } })).statusCode).toBe(400);
    const walkIn = await me.post('/api/sales', { date: D, sourceId: till, lines: [{ description: 'Key cut (made up)', qty: 1, unitPriceCents: 2_500 }] });
    const paidAgain = await me.call({ method: 'POST', url: `/api/documents/${walkIn.id}/receipts`, payload: { date: D, amountCents: 100, sourceId: bank } });
    expect(paidAgain.statusCode).toBe(400);
    expect(paidAgain.json().error).toMatch(/refund/);
  });

  it('reports up to a past day from the start of that day’s financial year', async () => {
    const r = await me.call({ method: 'GET', url: '/api/reports/income-statement?to=2026-02-28' });
    expect(r.statusCode).toBe(200);
    const x = await me.call({ method: 'GET', url: '/api/accountant-export?dataset=journal&to=2026-02-28&preview=1' });
    expect(x.statusCode).toBe(200);
  });

  it('keeps a closed year closed: a sale in it isn’t made an invoice', async () => {
    const s = await me.post('/api/sales', { date: '2026-06-02', sourceId: till, lines: [{ description: 'Key cut (made up)', qty: 1, unitPriceCents: 2_500 }] });
    await env.sql`update settings set lock_date = '2026-06-30'`;
    const r = await me.call({ method: 'POST', url: `/api/sales/${s.id}/invoice`, payload: { clientId: client.id } });
    expect(r.statusCode).toBe(400);
    await env.sql`update settings set lock_date = null`;
  });

  it('the audit: an item stocked again after selling it unstocked, and opening stock cleared by the opening balances', async () => {
    const tape = await me.post('/api/items', { description: 'Tape (made up)', unitPriceCents: 2_300, stocked: true });
    await me.post(`/api/items/${tape.id}/opening`, { date: '2026-06-01', qty: 2, unitCostCents: 900, from: 'opening_balances' });
    // Opening stock against the opening balances, cleared by a journal by hand (as they are).
    const r = await ref(env.sql);
    await me.post('/api/journals', { date: '2026-06-01', description: 'Opening balances (made up)', lines: [{ accountId: await r.acc('stock_opening'), debitCents: 1_800 }, { accountId: await r.acc('owner_loan'), creditCents: 1_800 }] });
    const said = async (re: RegExp) => (await auditBooks(env.sql, '2026-07-31')).find((i) => re.test(i.text));
    expect(await said(/Opening stock account/)).toBeUndefined();
    // Counted to nothing, unstocked, sold unstocked, stocked again: still clean.
    await me.post('/api/stock/takes', { date: '2026-06-02', lines: [{ itemId: tape.id, countedQty: 0, reason: 'Used in the shop (made up)' }] });
    await me.post(`/api/items/${tape.id}`, { description: 'Tape (made up)', unitPriceCents: 2_300, stocked: false }, 'PUT');
    await me.post('/api/sales', { date: D, sourceId: till, lines: [{ itemId: tape.id, description: 'Tape (made up)', qty: 1, unitPriceCents: 2_300 }] });
    await new Promise((r) => setTimeout(r, 20));
    await me.post(`/api/items/${tape.id}`, { description: 'Tape (made up)', unitPriceCents: 2_300, stocked: true }, 'PUT');
    expect(await said(/didn't move stock by their quantity/)).toBeUndefined();
    expect(await said(/moved stock by exactly its quantity/)).toMatchObject({ level: 'ok' });
    expect(await ledgerTotal(env.sql)).toBe(0);
    await expectCleanAudit(env.sql, '2026-07-31');
  });
});

describe('selling from stock, not registered for VAT', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  afterAll(() => env.close());

  it('takes prices as paid (VAT and all), and judges stock against the selling price as it is', async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, businessType: 'sole_prop', vatRegistered: false, vatNumber: '', features: { ...settings.features, inventory: true } }, 'PUT');
    const bank = await (await ref(env.sql)).src('Business bank');
    const mark = await me.post('/api/items', { description: 'Bookmark (made up)', unitPriceCents: 1_000, priceIncludesVat: true, stocked: true });
    const refused = await me.call({ method: 'POST', url: '/api/stock/purchases', payload: { date: D, supplier: 'Fictional Crafts', sourceId: bank, vatCents: 135, lines: [{ itemId: mark.id, qtyInvoiced: 10, unitCostCents: 900 }] } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/VAT included/);
    await me.post('/api/stock/purchases', { date: D, supplier: 'Fictional Crafts', sourceId: bank, lines: [{ itemId: mark.id, qtyInvoiced: 10, unitCostCents: 900 }] });
    // R9 a bookmark, sold at R10 with no VAT in it: not above its selling price.
    const items = await auditBooks(env.sql, '2026-07-31');
    expect(items.find((i) => /valued above its selling price/.test(i.text))).toBeUndefined();
    await expectCleanAudit(env.sql, '2026-07-31');
  });
});
