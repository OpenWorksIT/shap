/**
 * Inventory (docs/SALES_AND_STOCK.md): buying stock, sending it back, suppliers' credits,
 * counting it, and what it's worth. Full Shap only (Shap Pocket has sales without stock).
 *
 * A purchase is a supplier's invoice: a cost on the "Stock purchases" cost type (so it's paid, or
 * a bill to pay, and on the VAT201 like any cost), whose account is a clearing account. Each line
 * that arrived goes into stock at its cost out of that account; what was invoiced but didn't
 * arrive (short supplied) becomes a claim against the supplier. Stock received in bad order goes
 * back to the supplier as a claim too. A supplier's credit note settles claims (anything beyond
 * them lowers the cost of what was sold); a claim they won't settle is written off. A stock take
 * corrects each item to what's on the shelf, with the reason, the difference costed at average
 * cost into stock losses. Every one of these is recorded once, never changed or deleted, with
 * who and when, and the books audit checks the stock and the books agree.
 */
import type { FastifyInstance } from 'fastify';
import { claimWriteOffInput, stockPurchaseInput, stockReturnInput, stockTakeInput, supplierCreditInput, vatIncluded, vatRateOn } from '@shap/shared';
import { z } from 'zod';
import { requireRole, userOrThrow, type AuthUser } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { assertOpen, getSettings, q, today } from '../lib/books.js';
import { badRequest, notFound } from '../lib/errors.js';
import { milli, moveStock } from '../lib/stock.js';
import { parse } from '../lib/validate.js';
import { requireFeature } from './sales.js';
import { applyBillCredit, bills } from './bills.js';

const idParam = z.object({ id: z.string().uuid() });
const readers = { preHandler: requireRole('owner', 'accountant') };
const owner = { preHandler: requireRole('owner') };

async function stockCategory(db: Db): Promise<string> {
  const [c] = await db<{ id: string }[]>`select id from cost_categories where kind = 'stock' limit 1`;
  if (!c) throw new Error('The Stock purchases cost type is missing (migration 039)');
  return c.id;
}

/** Where a supplier was paid from: a real account, or the bills account (paid later). */
async function supplierSource(db: Db, sourceId: string): Promise<void> {
  const [s] = await db<{ role: string | null }[]>`select role from payment_sources where id = ${sourceId}`;
  if (!s || (s.role && s.role !== 'bills')) throw badRequest('Choose where it was paid from, or “Not paid yet (a bill)”');
}

async function stockedItems(db: Db, ids: string[]): Promise<Map<string, { description: string; qtyOnHand: string; lastMoved: string | null }>> {
  const rows = await db<{ id: string; description: string; stocked: boolean; qtyOnHand: string; lastMoved: string | null }[]>`
    select i.id, i.description, i.stocked, i.qty_on_hand, (select max(date)::text from stock_moves m where m.item_id = i.id) as last_moved
    from items i where i.id = any(${ids}::uuid[])`;
  const m = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    const r = m.get(id);
    if (!r) throw badRequest('Something isn’t in the item list');
    if (!r.stocked) throw badRequest(`${r.description} isn’t a stocked item (tick “Keep stock of it” on the item first)`);
  }
  return m;
}

/** A supplier's invoice for stock: the cost, each line into stock, anything short a claim. */
export async function recordPurchase(tx: Db, user: AuthUser, raw: unknown): Promise<{ costId: string; claims: number }> {
  const input = parse(stockPurchaseInput, raw);
  await assertOpen(tx, input.date);
  await supplierSource(tx, input.sourceId);
  await stockedItems(tx, input.lines.map((l) => l.itemId));
  const settings = await getSettings(tx);
  // Claimable VAT only for a VAT vendor; otherwise what was paid (VAT and all) is the cost.
  const rate = settings.vatRegistered ? vatRateOn(input.date) : 0;
  if (!settings.vatRegistered && (input.vatCents ?? 0) > 0) {
    throw badRequest('Not registered for VAT, so none of it can be claimed: type each price as you paid it, VAT included, without a VAT amount');
  }
  const lines = input.lines.map((l) => {
    const received = l.qtyReceived ?? l.qtyInvoiced;
    if (milli(received) > milli(l.qtyInvoiced)) throw badRequest('More can’t arrive than was invoiced: capture the extra as its own purchase');
    const typed = Math.round((milli(l.qtyInvoiced) * l.unitCostCents) / 1000);
    const claimable = rate > 0 && l.vatCode === 'standard';
    // VAT charged that can't be claimed is part of what the stock cost (IFRS for SMEs 13.6), and of what's paid.
    const lineCents = rate > 0 && l.vatCode === 'not_claimable' ? Math.round((typed * (10000 + rate)) / 10000) : typed;
    const unitCostCents = lineCents === typed ? l.unitCostCents : Math.round((l.unitCostCents * (10000 + rate)) / 10000);
    return { ...l, received, lineCents, unitCostCents, claimable, typed };
  });
  const net = lines.reduce((t, l) => t + l.lineCents, 0);
  const vatWorked = Math.round((lines.filter((l) => l.claimable).reduce((t, l) => t + l.typed, 0) * rate) / 10000);
  let vat = vatWorked;
  if (input.vatCents != null && rate > 0) {
    // The supplier's own VAT figure, when it's theirs by rounding (a cent a line at most).
    if (Math.abs(input.vatCents - vatWorked) > lines.length) throw badRequest(`The VAT on these lines comes to ${(vatWorked / 100).toFixed(2)}: check the lines, or the VAT on the invoice`);
    vat = input.vatCents;
  }
  const amount = net + vat;
  if (amount <= 0) throw badRequest('A purchase is for more than nothing');
  if (vat > vatIncluded(amount, rate) + 1) throw badRequest('More VAT than the invoice can hold');
  const anyStandard = lines.some((l) => l.vatCode === 'standard');
  const [cost] = await tx<{ id: string }[]>`
    insert into costs (date, description, amount_cents, vat_cents, vat_code, supplier, category_id, source_id, receipt_id, note, bill_number, due_date, no_job, created_by)
    values (${input.date}, ${`Stock from ${input.supplier}${input.reference ? ` (${input.reference})` : ''}`}, ${amount}, ${vat},
            ${vat > 0 ? 'standard' : anyStandard && rate === 0 ? 'no_vat' : (lines[0]!.vatCode as string)}, ${input.supplier},
            ${await stockCategory(tx)}, ${input.sourceId}, ${input.receiptId ?? null}, ${input.note}, ${input.reference}, ${input.dueDate ?? null}, true, ${user.id})
    returning id`;
  let claims = 0;
  for (const [i, l] of lines.entries()) {
    const [pl] = await tx<{ id: string }[]>`
      insert into stock_purchase_lines (cost_id, item_id, qty_invoiced, qty_received, unit_cost_cents, line_cents, vat_code, sort)
      values (${cost!.id}, ${l.itemId}, ${l.qtyInvoiced}, ${l.received}, ${l.unitCostCents}, ${l.lineCents}, ${l.vatCode}, ${i}) returning id`;
    let inValue = 0;
    if (milli(l.received) > 0) {
      // All of it arrived: in at exactly the line's cost (no cent of rounding left as a claim).
      const all = milli(l.received) === milli(l.qtyInvoiced);
      const m = await moveStock(tx, { itemId: l.itemId, date: input.date, kind: 'purchase', qty: l.received, unitCostCents: l.unitCostCents, valueCents: all ? l.lineCents : undefined, contra: 'stock_clearing', costId: cost!.id, purchaseLineId: pl!.id, reason: input.reference ? `Invoice ${input.reference}` : '', userId: user.id });
      inValue = m.valueCents;
    }
    const short = l.lineCents - inValue;
    if (short > 0) {
      await tx`insert into stock_claims (date, kind, supplier, item_id, cost_id, qty, value_cents, reason, created_by)
        values (${input.date}, 'short', ${input.supplier}, ${l.itemId}, ${cost!.id}, ${(milli(l.qtyInvoiced) - milli(l.received)) / 1000}, ${short}, 'Invoiced but not delivered', ${user.id})`;
      claims++;
    }
  }
  await audit(tx, { userId: user.id, action: 'stock_purchase', entity: 'cost', entityId: cost!.id, details: { supplier: input.supplier, reference: input.reference, amountCents: amount, lines: lines.length, shortClaims: claims } });
  return { costId: cost!.id, claims };
}

/** Stock sent back to the supplier: out of stock, owed back as a claim. */
export async function recordReturn(tx: Db, user: AuthUser, raw: unknown): Promise<{ claimId: string | null }> {
  const input = parse(stockReturnInput, raw);
  await assertOpen(tx, input.date);
  const items = await stockedItems(tx, [input.itemId]);
  const item = items.get(input.itemId)!;
  if (milli(input.qty) > milli(item.qtyOnHand)) throw badRequest(`Only ${Number(item.qtyOnHand)} of ${item.description} are in stock to send back`);
  // Which purchase it came in on (it can't go back more than came in on it). It goes out of stock at
  // what it's worth there (average cost), and that is the claim: the supplier's credit for it
  // settles the claim, anything more being a discount and anything less written off (a value
  // taken at an old price could leave the stock worth less than nothing).
  if (input.costId) {
    const [pl] = await tx<{ received: string; returned: string }[]>`
      select sum(pl.qty_received) as received,
        coalesce((select sum(-m.qty) from stock_moves m where m.cost_id = ${input.costId} and m.item_id = ${input.itemId} and m.kind = 'supplier_return'), 0) as returned
      from stock_purchase_lines pl where pl.cost_id = ${input.costId} and pl.item_id = ${input.itemId}`;
    if (!pl || pl.received == null) throw badRequest(`${item.description} wasn’t on that purchase`);
    if (milli(input.qty) > milli(pl.received) - milli(pl.returned)) throw badRequest('That’s more than came in on that purchase and hasn’t gone back yet');
  }
  // The claim first, so the movement can point at it; its value is what the movement takes out.
  const [probe] = await tx<{ qtyOnHand: string; stockValueCents: string }[]>`select qty_on_hand, stock_value_cents from items where id = ${input.itemId} for update`;
  const out =
    milli(input.qty) === milli(probe!.qtyOnHand)
      ? -Number(probe!.stockValueCents)
      : -Math.round((Number(probe!.stockValueCents) * milli(input.qty)) / milli(probe!.qtyOnHand));
  let claimId: string | null = null;
  if (-out > 0) {
    const [c] = await tx<{ id: string }[]>`
      insert into stock_claims (date, kind, supplier, item_id, cost_id, qty, value_cents, reason, created_by)
      values (${input.date}, 'return', ${input.supplier}, ${input.itemId}, ${input.costId ?? null}, ${input.qty}, ${-out}, ${input.reason}, ${user.id}) returning id`;
    claimId = c!.id;
  }
  await moveStock(tx, { itemId: input.itemId, date: input.date, kind: 'supplier_return', qty: -input.qty, valueCents: out, contra: 'supplier_claims', costId: input.costId ?? null, claimId, reason: input.reason, userId: user.id });
  await audit(tx, { userId: user.id, action: 'stock_return', entity: 'item', entityId: input.itemId, details: { supplier: input.supplier, qty: input.qty, valueCents: -out, reason: input.reason } });
  return { claimId };
}

/** What's still owed back on each claim (the claims locked first when settling some: two at once wait their turn). */
async function openClaims(db: Db, ids?: string[]) {
  if (ids?.length) await db`select id from stock_claims where id = any(${ids}::uuid[]) order by id for update`;
  return db<{ id: string; supplier: string; kind: string; date: string; qty: string; valueCents: string; settledCents: string; leftCents: string; itemId: string; description: string }[]>`
    select c.id, c.supplier, c.kind, c.date, c.qty, c.value_cents, c.item_id, i.description,
      coalesce(s.settled, 0) as settled_cents, (c.value_cents - coalesce(s.settled, 0)) as left_cents
    from stock_claims c join items i on i.id = c.item_id
    left join lateral (select sum(amount_cents) as settled from stock_claim_settlements x where x.claim_id = c.id) s on true
    where (${ids ?? null}::uuid[] is null or c.id = any(${ids ?? null}::uuid[]))
    order by c.date, c.created_at`;
}

/** A supplier's credit note: a negative cost on stock purchases, settling claims; the rest a discount. */
export async function recordSupplierCredit(tx: Db, user: AuthUser, raw: unknown): Promise<{ costId: string; settled: number; discountCents: number }> {
  const input = parse(supplierCreditInput, raw);
  await assertOpen(tx, input.date);
  await supplierSource(tx, input.sourceId);
  const settings = await getSettings(tx);
  const rate = settings.vatRegistered ? vatRateOn(input.date) : 0;
  const vat = rate > 0 && input.vatCode === 'standard' ? input.vatCents : 0;
  if (vat > vatIncluded(input.amountCents, rate) + 1) throw badRequest('More VAT than the credit can hold');
  const net = input.amountCents - vat;
  const claims = input.claimIds.length ? await openClaims(tx, input.claimIds) : [];
  if (claims.length !== input.claimIds.length) throw badRequest('A claim chosen isn’t there');
  for (const c of claims) {
    if (c.supplier.trim().toLowerCase() !== input.supplier.trim().toLowerCase()) throw badRequest(`That claim is against ${c.supplier}, not ${input.supplier}`);
    if (Number(c.leftCents) <= 0) throw badRequest('A claim chosen is already settled');
  }
  const [cost] = await tx<{ id: string }[]>`
    insert into costs (date, description, amount_cents, vat_cents, vat_code, supplier, category_id, source_id, note, bill_number, no_job, created_by)
    values (${input.date}, ${`Credit from ${input.supplier}${input.reference ? ` (${input.reference})` : ''}`}, ${-input.amountCents}, ${-vat},
            ${vat > 0 ? 'standard' : input.vatCode === 'standard' ? 'no_vat' : input.vatCode}, ${input.supplier}, ${await stockCategory(tx)},
            ${input.sourceId}, ${input.note}, ${input.reference}, true, ${user.id})
    returning id`;
  let left = net;
  let settled = 0;
  for (const c of claims) {
    const take = Math.min(left, Number(c.leftCents));
    if (take <= 0) break;
    await tx`insert into stock_claim_settlements (claim_id, date, kind, amount_cents, cost_id, reason, created_by)
      values (${c.id}, ${input.date}, 'credit', ${take}, ${cost!.id}, ${input.reference ? `Credit ${input.reference}` : 'Supplier credit'}, ${user.id})`;
    left -= take;
    settled++;
  }
  if (left > 0) {
    await tx`insert into stock_claim_settlements (claim_id, date, kind, amount_cents, cost_id, reason, created_by)
      values (null, ${input.date}, 'discount', ${left}, ${cost!.id}, ${input.note || 'Supplier credit beyond any claim'}, ${user.id})`;
  }
  // Off what's owed to them: taken off the bill it's against (as much of it as that bill still owes).
  if (input.billId) {
    const [src] = await tx<{ role: string | null }[]>`select role from payment_sources where id = ${input.sourceId}`;
    if (src?.role !== 'bills') throw badRequest('A credit is taken off a bill when it’s off what’s owed to them (Not paid yet)');
    const [bill] = (await bills(tx, 'all')).filter((b) => b.id === input.billId);
    if (!bill || Number(bill.owingCents) <= 0) throw badRequest('That bill isn’t owing anything');
    await applyBillCredit(tx, user.id, input.billId, { date: input.date < bill.date ? bill.date : input.date, creditId: cost!.id, amountCents: Math.min(input.amountCents, Number(bill.owingCents)) });
  }
  await audit(tx, { userId: user.id, action: 'supplier_credit', entity: 'cost', entityId: cost!.id, details: { supplier: input.supplier, reference: input.reference, amountCents: input.amountCents, claims: settled, discountCents: Math.max(left, 0), billId: input.billId ?? null } });
  return { costId: cost!.id, settled, discountCents: Math.max(left, 0) };
}

/** Counts each item: the difference corrected at average cost, into stock losses, with why. */
export async function recordStockTake(tx: Db, user: AuthUser, raw: unknown): Promise<{ id: string; corrected: number; valueCents: number }> {
  const input = parse(stockTakeInput, raw);
  await assertOpen(tx, input.date);
  const ids = input.lines.map((l) => l.itemId);
  if (new Set(ids).size !== ids.length) throw badRequest('Each item once in a count');
  const items = await stockedItems(tx, ids);
  for (const l of input.lines) {
    const it = items.get(l.itemId)!;
    if (it.lastMoved && it.lastMoved > input.date) throw badRequest(`${it.description} has movements after ${input.date}: count it as at a later date (today)`);
  }
  const [take] = await tx<{ id: string }[]>`insert into stock_takes (date, note, created_by) values (${input.date}, ${input.note}, ${user.id}) returning id`;
  let corrected = 0;
  let value = 0;
  for (const l of input.lines) {
    const [now] = await tx<{ qtyOnHand: string; stockValueCents: string; description: string }[]>`select qty_on_hand, stock_value_cents, description from items where id = ${l.itemId} for update`;
    const diffM = milli(l.countedQty) - milli(now!.qtyOnHand);
    const reason = (l.reason || input.note).trim();
    if (diffM !== 0 && reason.length < 2) throw badRequest(`Say why ${now!.description} differs from what Shap had (stolen, damaged, miscounted…)`);
    await tx`insert into stock_take_lines (stock_take_id, item_id, system_qty, counted_qty, reason)
      values (${take!.id}, ${l.itemId}, ${now!.qtyOnHand}, ${l.countedQty}, ${l.reason})`;
    if (diffM === 0) continue;
    const haveM = milli(now!.qtyOnHand);
    // Found stock comes in at what the stock is worth on average (or its latest cost).
    const unit = diffM > 0 && haveM > 0 ? (Number(now!.stockValueCents) * 1000) / haveM : undefined;
    const m = await moveStock(tx, { itemId: l.itemId, date: input.date, kind: 'count', qty: diffM / 1000, unitCostCents: unit, contra: 'stock_losses', stockTakeId: take!.id, reason, userId: user.id });
    corrected++;
    value += m.valueCents;
  }
  await audit(tx, { userId: user.id, action: 'stock_take', entity: 'stock_take', entityId: take!.id, details: { date: input.date, items: input.lines.length, corrected, valueCents: value } });
  return { id: take!.id, corrected, valueCents: value };
}

/** What's in stock as at a date: each item's quantity and value from its movements up to then. */
export async function stockValuation(db: Db, at: string) {
  return db<{ id: string; description: string; sku: string; unit: string; qty: string; valueCents: string; unitPriceCents: string; priceIncludesVat: boolean; vatCode: string }[]>`
    select i.id, i.description, i.sku, i.unit, i.unit_price_cents, i.price_includes_vat, i.vat_code,
      coalesce(sum(m.qty), 0) as qty, coalesce(sum(m.value_cents), 0)::bigint as value_cents
    from items i left join stock_moves m on m.item_id = i.id and m.date <= ${at}::date
    where i.stocked or exists (select 1 from stock_moves x where x.item_id = i.id)
    group by i.id order by i.description`;
}

export function registerStockRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;
  const on = () => requireFeature(sql, 'inventory', 'Inventory');

  app.post('/api/stock/purchases', owner, async (req) => {
    const user = userOrThrow(req);
    await on();
    return sql.begin((tx) => recordPurchase(tx, user, req.body));
  });

  app.get('/api/stock/purchases', readers, async (req) => {
    const { from, to } = q(req);
    const rows = await sql`
      select c.id, c.date, c.supplier, c.bill_number as reference, c.amount_cents, c.vat_cents, c.description, s.name as source_name, s.role as source_role,
        (select count(*)::int from stock_purchase_lines pl where pl.cost_id = c.id) as lines
      from costs c join cost_categories k on k.id = c.category_id and k.kind = 'stock' join payment_sources s on s.id = c.source_id
      where (${from ?? null}::date is null or c.date >= ${from ?? null}::date) and (${to ?? null}::date is null or c.date <= ${to ?? null}::date)
      order by c.date desc, c.created_at desc limit 1000`;
    return rows;
  });

  app.get('/api/stock/purchases/:id', readers, async (req) => {
    const { id } = parse(idParam, req.params);
    const [cost] = await sql`select c.*, s.name as source_name from costs c join payment_sources s on s.id = c.source_id where c.id = ${id}`;
    if (!cost) throw notFound('Purchase');
    const lines = await sql`select pl.*, i.description, i.unit from stock_purchase_lines pl join items i on i.id = pl.item_id where pl.cost_id = ${id} order by pl.sort`;
    const claims = await sql`select c.*, i.description from stock_claims c join items i on i.id = c.item_id where c.cost_id = ${id} order by c.created_at`;
    const settlements = await sql`select x.*, c.item_id from stock_claim_settlements x left join stock_claims c on c.id = x.claim_id where x.cost_id = ${id}`;
    return { cost, lines, claims, settlements };
  });

  app.post('/api/stock/returns', owner, async (req) => {
    const user = userOrThrow(req);
    await on();
    return sql.begin((tx) => recordReturn(tx, user, req.body));
  });

  app.post('/api/stock/credits', owner, async (req) => {
    const user = userOrThrow(req);
    await on();
    return sql.begin((tx) => recordSupplierCredit(tx, user, req.body));
  });

  app.get('/api/stock/claims', readers, async (req) => {
    const { state } = q(req);
    const rows = await openClaims(sql);
    const settlements = await sql`select x.*, cs.bill_number as credit_reference from stock_claim_settlements x left join costs cs on cs.id = x.cost_id where x.claim_id is not null order by x.date`;
    const all = rows.map((r) => ({ ...r, settlements: settlements.filter((s) => s.claimId === r.id) }));
    return state === 'all' ? all : all.filter((r) => Number(r.leftCents) > 0);
  });

  app.post('/api/stock/claims/:id/write-off', owner, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const input = parse(claimWriteOffInput, req.body);
    await on();
    await assertOpen(sql, input.date);
    return sql.begin(async (tx) => {
      const [c] = await openClaims(tx, [id]);
      if (!c) throw notFound('Claim');
      if (Number(c.leftCents) <= 0) throw badRequest('Nothing is left on this claim');
      if (input.date < String(c.date).slice(0, 10)) throw badRequest('It can’t be written off before it was made');
      await tx`insert into stock_claim_settlements (claim_id, date, kind, amount_cents, reason, created_by) values (${id}, ${input.date}, 'write_off', ${c.leftCents}, ${input.reason}, ${user.id})`;
      await audit(tx, { userId: user.id, action: 'claim_write_off', entity: 'stock_claim', entityId: id, details: { amountCents: Number(c.leftCents), reason: input.reason } });
      return { ok: true, amountCents: Number(c.leftCents) };
    });
  });

  app.post('/api/stock/takes', owner, async (req) => {
    const user = userOrThrow(req);
    await on();
    return sql.begin((tx) => recordStockTake(tx, user, req.body));
  });

  app.get('/api/stock/takes', readers, async () => {
    return sql`
      select t.*, u.name as by_name,
        (select count(*)::int from stock_take_lines l where l.stock_take_id = t.id) as items,
        (select count(*)::int from stock_moves m where m.stock_take_id = t.id) as corrected,
        (select coalesce(sum(value_cents), 0)::bigint from stock_moves m where m.stock_take_id = t.id) as value_cents
      from stock_takes t left join users u on u.id = t.created_by order by t.date desc, t.created_at desc limit 500`;
  });

  app.get('/api/stock/takes/:id', readers, async (req) => {
    const { id } = parse(idParam, req.params);
    const [take] = await sql`select t.*, u.name as by_name from stock_takes t left join users u on u.id = t.created_by where t.id = ${id}`;
    if (!take) throw notFound('Stock take');
    const lines = await sql`
      select l.*, i.description, i.unit, m.value_cents from stock_take_lines l join items i on i.id = l.item_id
      left join stock_moves m on m.stock_take_id = l.stock_take_id and m.item_id = l.item_id and m.kind = 'count'
      where l.stock_take_id = ${id} order by i.description`;
    return { take, lines };
  });

  app.get('/api/stock/valuation', readers, async (req) => {
    const { date } = q(req);
    const at = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today();
    const rows = await stockValuation(sql, at);
    return { date: at, rows, totalCents: rows.reduce((t, r) => t + Number(r.valueCents), 0) };
  });
}
