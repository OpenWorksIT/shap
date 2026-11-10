/**
 * Sales and stock (docs/SALES_AND_STOCK.md), through the API as the screens use it, with the
 * books checked at each step: every movement at weighted average cost, the inventory account
 * always the stock's value, stock purchases clearing always empty, claims against suppliers
 * what's still owed back, the VAT201 and debtors right, and the books audit clean at the end.
 * All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { featuresFor } from '@shap/shared';
import { auditBooks } from '../src/audit/books.js';
import { mergeCosts } from '../src/modules/duplicates.js';
import { balance, expectCleanAudit, ledgerTotal, login, ref, setup, type TestEnv } from './helpers.js';

const D = '2026-07-01';

describe('selling, from the counter and from stock', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let till: string;
  let bank: string;
  let bills: string;
  let globes: { id: string };
  let cable: { id: string };
  let service: { id: string };
  const item = async (id: string) => (await env.sql<{ qtyOnHand: string; stockValueCents: string; lastCostCents: string }[]>`select qty_on_hand, stock_value_cents, last_cost_cents from items where id = ${id}`)[0]!;
  const stockValue = async () => Number((await env.sql<{ v: string }[]>`select coalesce(sum(stock_value_cents), 0) as v from items`)[0]!.v);
  const books = async () => ({
    inventory: await balance(env.sql, 'inventory'),
    clearing: await balance(env.sql, 'stock_clearing'),
    claims: await balance(env.sql, 'supplier_claims'),
  });

  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    const { settings, sources } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4740101508', features: { ...settings.features, inventory: true, bills: true } }, 'PUT');
    const r = await ref(env.sql);
    bank = await r.src('Business bank');
    till = (await env.sql<{ id: string }[]>`select id from payment_sources where till`)[0]!.id;
    bills = sources.find((s: { role: string | null }) => s.role === 'bills').id;
    globes = await me.post('/api/items', { description: 'LED globe 9W (made up)', sku: 'LED9', unitPriceCents: 4_600, priceIncludesVat: true, stocked: true });
    cable = await me.post('/api/items', { description: 'Cable 2.5mm per metre (made up)', sku: 'CAB25', unit: 'm', unitPriceCents: 1_150, priceIncludesVat: true, stocked: true });
    service = await me.post('/api/items', { description: 'Call-out (made up)', category: 'labour', unitPriceCents: 45_000, priceIncludesVat: false });
  });
  afterAll(() => env.close());

  it('switches sales on with inventory, and opens the till', async () => {
    const { settings } = await me.get('/api/reference');
    expect(settings.features.sales).toBe(true);
    const [t] = await env.sql<{ active: boolean }[]>`select active from payment_sources where till`;
    expect(t!.active).toBe(true);
  });

  it('buys stock: what arrived into stock, what didn’t a claim, the clearing account empty', async () => {
    // 100 globes at R20, 50 metres of cable at R6, but only 40 metres arrived; on account.
    const p = await me.post('/api/stock/purchases', {
      date: D,
      supplier: 'Fictional Wholesale',
      reference: 'FW-1001',
      sourceId: bills,
      lines: [
        { itemId: globes.id, qtyInvoiced: 100, unitCostCents: 2_000 },
        { itemId: cable.id, qtyInvoiced: 50, qtyReceived: 40, unitCostCents: 600 },
      ],
    });
    expect(p.claims).toBe(1);
    expect(await item(globes.id)).toMatchObject({ qtyOnHand: 100, stockValueCents: 200000 });
    expect(await item(cable.id)).toMatchObject({ qtyOnHand: 40, stockValueCents: 24000 });
    // R2 300 + VAT R345 owed; R2 240 in stock, R60 claimed, nothing left in clearing.
    expect(await books()).toEqual({ inventory: 224_000, clearing: 0, claims: 6_000 });
    expect(await balance(env.sql, 'payables')).toBe(-264_500);
    expect(await balance(env.sql, 'vat')).toBe(34_500);
  });

  it('sells at the counter: paid on the spot, out of stock at average cost, VAT by line', async () => {
    const s = await me.post('/api/sales', {
      date: D,
      sourceId: till,
      method: 'cash',
      lines: [
        { itemId: globes.id, description: 'LED globe 9W (made up)', qty: 10, unitPriceCents: 4_600 },
        { itemId: cable.id, description: 'Cable 2.5mm per metre (made up)', qty: 5, unitPriceCents: 1_150, unit: 'm' },
        // A zero-rated line, and one without stock (a service).
        { description: 'Brown bread (made up)', qty: 1, unitPriceCents: 1_800, vatCode: 'zero' },
        { itemId: service.id, description: 'Call-out (made up)', qty: 1, unitPriceCents: 51_750, category: 'labour' },
      ],
    });
    expect(s.kind).toBe('sale');
    expect(s.doc.number).toBe(s.saleNumber);
    // R460 + R57.50 + R18 (zero) + R517.50 = R1 053 including VAT.
    expect(Number(s.doc.totalCents)).toBe(105_300);
    expect(Number(s.doc.vatCents)).toBe(13_500);
    expect(await item(globes.id)).toMatchObject({ qtyOnHand: 90, stockValueCents: 180000 });
    expect(await item(cable.id)).toMatchObject({ qtyOnHand: 35, stockValueCents: 21000 });
    expect(await balance(env.sql, 'receivables')).toBe(0);
    expect(await balance(env.sql, 'cos_goods')).toBe(23_000);
    expect(await balance(env.sql, 'revenue_goods')).toBe(-(40_000 + 5_000 + 1_800));
    expect((await books()).inventory).toBe(await stockValue());
  });

  it('asks for the customer over R5 000, and makes it an invoice paid at once', async () => {
    const big = { date: D, sourceId: bank, method: 'eft', lines: [{ itemId: globes.id, description: 'LED globe 9W (made up)', qty: 120, unitPriceCents: 4_600 }] };
    const refused = await me.call({ method: 'POST', url: '/api/sales', payload: big });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/Over R5 000 SARS wants a full tax invoice/);
    const client = await me.post('/api/clients', { name: 'Fictional Contractor (Pty) Ltd', address: '3 Test Street, Fictional Town', vatNumber: '4000000002' });
    const s = await me.post('/api/sales', { ...big, clientId: client.id });
    expect(s.kind).toBe('invoice');
    expect(s.doc.saleNumber).toBe(s.saleNumber);
    expect(s.doc.number).not.toBe(s.saleNumber);
    // Sold more than there was: stock goes below nothing, the rest at the latest cost.
    expect(await item(globes.id)).toMatchObject({ qtyOnHand: -30, stockValueCents: -60000 });
    expect(await balance(env.sql, 'receivables')).toBe(0);
  });

  it('values stock that arrives after it was sold at what it cost, the difference to cost of sales', async () => {
    const before = await balance(env.sql, 'cos_goods');
    // 50 more globes at R22: the 30 sold short really cost R22 each (R60 more), 20 left at R22.
    await me.post('/api/stock/purchases', { date: D, supplier: 'Fictional Wholesale', reference: 'FW-1002', sourceId: bank, lines: [{ itemId: globes.id, qtyInvoiced: 50, unitCostCents: 2_200 }] });
    expect(await item(globes.id)).toMatchObject({ qtyOnHand: 20, stockValueCents: 44000, lastCostCents: 2200 });
    expect((await balance(env.sql, 'cos_goods')) - before).toBe(6_000);
    expect(await books()).toMatchObject({ clearing: 0 });
    expect((await books()).inventory).toBe(await stockValue());
  });

  it('makes a sale an invoice afterwards: the customer added, the amounts and VAT as they were', async () => {
    const s = await me.post('/api/sales', { date: D, sourceId: till, lines: [{ itemId: cable.id, description: 'Cable 2.5mm per metre (made up)', qty: 10, unitPriceCents: 1_150, unit: 'm' }, { description: 'Exempt item (made up)', qty: 1, unitPriceCents: 1_000, vatCode: 'exempt' }] });
    const before = { vat: await balance(env.sql, 'vat'), rev: await balance(env.sql, 'revenue_goods'), cos: await balance(env.sql, 'cos_goods') };
    const client = await me.post('/api/clients', { name: 'Fictional Walk-in Builder', address: '9 Test Lane, Fictional Town' });
    const inv = await me.post(`/api/sales/${s.id}/invoice`, { clientId: client.id });
    expect(inv.doc.kind).toBe('invoice');
    expect(inv.doc.saleNumber).toBe(s.saleNumber);
    expect(inv.doc.clientName).toBe('Fictional Walk-in Builder');
    expect(Number(inv.doc.totalCents)).toBe(Number(s.doc.totalCents));
    expect(inv.lines.map((l: { vatCode: string }) => l.vatCode)).toEqual(['standard', 'exempt']);
    expect({ vat: await balance(env.sql, 'vat'), rev: await balance(env.sql, 'revenue_goods'), cos: await balance(env.sql, 'cos_goods') }).toEqual(before);
    // Once: it's an invoice now.
    expect((await me.call({ method: 'POST', url: `/api/sales/${s.id}/invoice`, payload: { clientId: client.id } })).statusCode).toBe(400);
  });

  it('refunds: a credit note for what came back, paid out, the good ones back into stock at their cost', async () => {
    const s = await me.post('/api/sales', { date: D, sourceId: till, lines: [{ itemId: globes.id, description: 'LED globe 9W (made up)', qty: 4, unitPriceCents: 4_600 }] });
    const line = s.lines[0];
    const before = { globes: await item(globes.id) };
    // Two back: one in good order, one damaged (not back into stock). Done as two refunds.
    const r1 = await me.post(`/api/documents/${s.id}/refund`, { date: D, sourceId: till, reason: 'Changed their mind', lines: [{ lineId: line.id, qty: 1, restock: true }] });
    expect(r1.amountCents).toBe(4_600);
    const r2 = await me.post(`/api/documents/${s.id}/refund`, { date: D, sourceId: till, reason: 'Arrived broken', lines: [{ lineId: line.id, qty: 1, restock: false }] });
    expect(r2.amountCents).toBe(4_600);
    const after = await item(globes.id);
    expect(Number(after.qtyOnHand)).toBe(Number(before.globes.qtyOnHand) + 1);
    expect(Number(after.stockValueCents)).toBe(Number(before.globes.stockValueCents) + 2_200);
    // No more back than was sold.
    const more = await me.call({ method: 'POST', url: `/api/documents/${s.id}/refund`, payload: { date: D, sourceId: till, reason: 'Again', lines: [{ lineId: line.id, qty: 3, restock: true }] } });
    expect(more.statusCode).toBe(400);
    // The credit notes are on the VAT: R1 200 of VAT back on R9 200... (each R6.00).
    const cns = await env.sql<{ vatCents: string; creditedInvoiceId: string }[]>`select vat_cents, credited_invoice_id from documents where kind = 'credit_note' and credited_invoice_id = ${s.id}`;
    expect(cns.map((c) => Number(c.vatCents))).toEqual([600, 600]);
    expect(await balance(env.sql, 'credit_clearing')).toBe(0);
    // A sale stays: no deleting, changing, or taking its payment away.
    expect((await me.call({ method: 'DELETE', url: `/api/documents/${s.id}` })).statusCode).toBe(400);
    expect((await me.call({ method: 'PUT', url: `/api/documents/${s.id}`, payload: { issueDate: D, lines: [] } })).statusCode).toBe(400);
    const [rc] = await env.sql<{ id: string }[]>`select sale_receipt_id as id from documents where id = ${s.id}`;
    expect((await me.call({ method: 'DELETE', url: `/api/receipts/${rc!.id}` })).statusCode).toBe(400);
    // A walk-in's sale with a zero-rated line: its credit note is short like the slip, no customer needed.
    const [bread] = await env.sql<{ id: string; documentId: string }[]>`
      select l.id, l.document_id from document_lines l join documents d on d.id = l.document_id where d.kind = 'sale' and l.vat_code = 'zero' limit 1`;
    const r3 = await me.post(`/api/documents/${bread!.documentId}/refund`, { date: D, sourceId: till, reason: 'Stale (made up)', lines: [{ lineId: bread!.id, qty: 1 }] });
    expect(r3.amountCents).toBe(1_800);
  });

  it('sends stock back to the supplier and settles the claims with their credit; the rest a discount', async () => {
    const [purchase] = await env.sql<{ id: string }[]>`select id from costs where bill_number = 'FW-1001'`;
    // 5 metres of cable arrived damaged: back to the supplier, at what they charged (R6).
    const r = await me.post('/api/stock/returns', { date: D, supplier: 'Fictional Wholesale', costId: purchase!.id, itemId: cable.id, qty: 5, reason: 'Received in bad order' });
    expect(r.claimId).toBeTruthy();
    expect(await books()).toMatchObject({ claims: 6_000 + 3_000, clearing: 0 });
    const claims = await me.get('/api/stock/claims');
    expect(claims.map((c: { leftCents: string }) => Number(c.leftCents)).sort()).toEqual([3_000, 6_000]);
    // Their credit: R103.50 incl VAT (R90 for the claims, R0 extra) then a second with a discount.
    await me.post('/api/stock/credits', { date: D, supplier: 'Fictional Wholesale', reference: 'FW-CN-1', sourceId: bills, amountCents: 10_350, vatCents: 1_350, claimIds: claims.map((c: { id: string }) => c.id) });
    expect(await books()).toMatchObject({ claims: 0, clearing: 0 });
    const cos = await balance(env.sql, 'cos_goods');
    await me.post('/api/stock/credits', { date: D, supplier: 'Fictional Wholesale', reference: 'FW-CN-2', sourceId: bills, amountCents: 1_150, vatCents: 150 });
    expect(await balance(env.sql, 'cos_goods')).toBe(cos - 1_000);
    expect(await books()).toMatchObject({ claims: 0, clearing: 0 });
    // A claim against a different supplier can't be settled by this one's credit.
    const other = await me.post('/api/stock/returns', { date: D, supplier: 'Another Fictional Supplier', itemId: cable.id, qty: 1, reason: 'Wrong item' });
    const wrong = await me.call({ method: 'POST', url: '/api/stock/credits', payload: { date: D, supplier: 'Fictional Wholesale', sourceId: bills, amountCents: 690, vatCents: 90, claimIds: [other.claimId] } });
    expect(wrong.statusCode).toBe(400);
    // Written off instead, with why: to stock losses.
    const losses = await balance(env.sql, 'stock_losses');
    await me.post(`/api/stock/claims/${other.claimId}/write-off`, { date: D, reason: 'Supplier closed down' });
    expect((await balance(env.sql, 'stock_losses')) - losses).toBe(600);
    expect(await books()).toMatchObject({ claims: 0, clearing: 0 });
  });

  it('counts the shelf: each difference corrected, with why, into stock losses', async () => {
    const g = await item(globes.id);
    const c = await item(cable.id);
    const missing = await me.call({ method: 'POST', url: '/api/stock/takes', payload: { date: D, lines: [{ itemId: globes.id, countedQty: Number(g.qtyOnHand) - 2 }] } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toMatch(/Say why/);
    const losses = await balance(env.sql, 'stock_losses');
    const t = await me.post('/api/stock/takes', {
      date: D,
      note: 'Month-end count',
      lines: [
        { itemId: globes.id, countedQty: Number(g.qtyOnHand) - 2, reason: 'Two broken in the store room' },
        { itemId: cable.id, countedQty: Number(c.qtyOnHand) + 1, reason: 'Offcut found' },
      ],
    });
    expect(t.corrected).toBe(2);
    const g2 = await item(globes.id);
    expect(Number(g2.qtyOnHand)).toBe(Number(g.qtyOnHand) - 2);
    // Two globes out at average cost (R22), a metre of cable in at its average (R6).
    expect((await balance(env.sql, 'stock_losses')) - losses).toBe(4_400 - 600);
    const history = await me.get(`/api/items/${globes.id}/history`);
    expect(history.moves.map((m: { kind: string }) => m.kind)).toEqual(['purchase', 'sale', 'sale', 'purchase', 'revalue', 'sale', 'refund', 'count']);
    expect(history.moves.at(-1)).toMatchObject({ reason: 'Two broken in the store room', stockTakeNote: 'Month-end count' });
    expect(Number(history.moves.at(-1).qtyAfter)).toBe(Number(g2.qtyOnHand));
    expect((await books()).inventory).toBe(await stockValue());
  });

  it('moves stock with invoices too: out when issued, back when voided', async () => {
    const client = await me.post('/api/clients', { name: 'Fictional Trade Customer', address: '5 Test Avenue, Fictional Town' });
    const before = await item(globes.id);
    const inv = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: D, lines: [{ category: 'goods', itemId: globes.id, description: 'LED globe 9W (made up)', qty: 3, unitPriceCents: 4_000 }] });
    await me.post(`/api/documents/${inv.id}/issue`);
    expect(Number((await item(globes.id)).qtyOnHand)).toBe(Number(before.qtyOnHand) - 3);
    // Its lines are fixed now (the stock went out on them).
    const changed = await me.call({ method: 'PUT', url: `/api/documents/${inv.id}`, payload: { clientId: client.id, issueDate: D, lines: [{ category: 'goods', itemId: globes.id, description: 'LED globe 9W (made up)', qty: 4, unitPriceCents: 4_000 }] } });
    expect(changed.statusCode).toBe(400);
    await me.post(`/api/documents/${inv.id}/void`, { reason: 'Raised in error' });
    expect(await item(globes.id)).toEqual(before);
  });

  it('keeps every record as made: stock movements can’t be changed or deleted, nor stock purchases', async () => {
    await expect(env.sql`update stock_moves set qty = 0`).rejects.toThrow(/can’t be changed|can't be changed/);
    await expect(env.sql`delete from stock_moves`).rejects.toThrow(/can’t be changed|can't be changed/);
    const [purchase] = await env.sql<{ id: string }[]>`select id from costs where bill_number = 'FW-1001'`;
    expect((await me.call({ method: 'DELETE', url: `/api/costs/${purchase!.id}` })).statusCode).toBe(400);
    const [stockType] = await env.sql<{ id: string }[]>`select id from cost_categories where kind = 'stock'`;
    const viaCosts = await me.call({ method: 'POST', url: '/api/costs', payload: { date: D, description: 'Stock by the back door', amountCents: 1_000, vatCents: 0, categoryId: stockType!.id, sourceId: bank } });
    expect(viaCosts.statusCode).toBe(400);
    // Nor folded away as a duplicate of another cost.
    const [other] = await env.sql<{ id: string }[]>`select id from costs where bill_number <> 'FW-1001' or bill_number is null limit 1`;
    const why = await env.sql.begin((tx) => mergeCosts(tx, purchase!.id, other?.id ?? null, { byHand: true }));
    expect(why).toMatch(/stock purchase/);
    expect((await env.sql`select 1 from costs where id = ${purchase!.id}`).length).toBe(1);
  });

  it('balances, and the books audit finds nothing to fix', async () => {
    expect(await ledgerTotal(env.sql)).toBe(0);
    expect(await books()).toEqual({ inventory: await stockValue(), clearing: 0, claims: 0 });
    await expectCleanAudit(env.sql, '2026-07-31');
  });

  it('the audit catches stock and sales put wrong behind the app’s back', async () => {
    const at = '2026-07-31';
    const said = async (re: RegExp) => (await auditBooks(env.sql, at)).find((i) => re.test(i.text));
    // An item's stock changed without a movement.
    await env.sql`update items set qty_on_hand = qty_on_hand + 1 where id = ${globes.id}`;
    expect(await said(/isn't the sum of their movements/)).toMatchObject({ level: 'fail' });
    expect(await said(/inventory account/)).toMatchObject({ level: 'ok' });
    await env.sql`update items set qty_on_hand = qty_on_hand - 1, stock_value_cents = stock_value_cents + 100 where id = ${globes.id}`;
    expect(await said(/inventory account \(/)).toMatchObject({ level: 'fail' });
    await env.sql`update items set stock_value_cents = stock_value_cents - 100 where id = ${globes.id}`;
    // A stock purchase with no lines: nothing into stock, left in clearing.
    const [stockType] = await env.sql<{ id: string }[]>`select id from cost_categories where kind = 'stock'`;
    const [c] = await env.sql<{ id: string }[]>`insert into costs (date, description, amount_cents, vat_cents, supplier, category_id, source_id) values (${D}, 'Stock with no lines', 11_500, 1_500, 'Fictional Wholesale', ${stockType!.id}, ${bank}) returning id`;
    expect(await said(/left in stock purchases/)).toMatchObject({ level: 'fail' });
    expect(await said(/lines don't add up/)).toMatchObject({ level: 'fail' });
    await env.sql`delete from costs where id = ${c!.id}`;
    // A sale whose payment went missing.
    const [sale] = await env.sql<{ id: string; receiptId: string }[]>`select id, sale_receipt_id as receipt_id from documents where kind = 'sale' limit 1`;
    await env.sql`update documents set sale_receipt_id = null where id = ${sale!.id}`;
    expect(await said(/sales without their payment/)).toMatchObject({ level: 'fail' });
    await env.sql`update documents set sale_receipt_id = ${sale!.receiptId} where id = ${sale!.id}`;
    // A stocked item on a sale that never left stock.
    const [line] = await env.sql<{ id: string }[]>`insert into document_lines (document_id, sort, category, description, qty, unit_price_cents, line_total_cents, item_id)
      values (${sale!.id}, 99, 'goods', 'Slipped in (made up)', 1, 0, 0, ${globes.id}) returning id`;
    expect(await said(/didn't move stock by their quantity/)).toMatchObject({ level: 'fail' });
    await env.sql`delete from document_lines where id = ${line!.id}`;
    // Valued above what it sells for; sold below nothing.
    await env.sql`update items set unit_price_cents = 100 where id = ${cable.id}`;
    expect(await said(/valued above its selling price/)).toMatchObject({ level: 'warn' });
    await env.sql`update items set unit_price_cents = 1_150 where id = ${cable.id}`;
    // The safeguard gone.
    await env.sql`drop trigger stock_moves_fixed on stock_moves`;
    expect(await said(/stock records can be changed/)).toMatchObject({ level: 'fail' });
    await env.sql`create trigger stock_moves_fixed before update or delete on stock_moves for each row execute function stock_record_fixed()`;
    await expectCleanAudit(env.sql, at);
  });
});

describe('the setup questions', () => {
  const base = { workflow: 'invoice' as const, employees: false, casual: false, company: false };
  it('switches on sales, and inventory only with sales', () => {
    expect(featuresFor({ ...base, selling: { sales: true, inventory: true } })).toMatchObject({ sales: true, inventory: true });
    expect(featuresFor({ ...base, selling: { sales: true, inventory: false } })).toMatchObject({ sales: true, inventory: false });
    expect(featuresFor({ ...base, selling: { sales: false, inventory: true } })).toMatchObject({ sales: false, inventory: false });
  });
  it('switches the financial statements on when Shap is to draw them up, and leaves them alone when not asked', () => {
    expect(featuresFor({ ...base, statements: true }).statements).toBe(true);
    expect(featuresFor({ ...base, statements: false }).statements).toBe(false);
    expect('statements' in featuresFor(base)).toBe(false);
    expect('sales' in featuresFor(base)).toBe(false);
  });
});
