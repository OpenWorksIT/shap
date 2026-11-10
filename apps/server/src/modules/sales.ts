/**
 * Sales at the counter and the item list (docs/SALES_AND_STOCK.md).
 *
 * A sale is a document of its own kind, paid on the spot: it posts like an invoice and its
 * payment at once, so debtors are untouched, the VAT is on the VAT201 for its date, and stocked
 * items go out of stock at average cost. A walk-in needs no client: the slip is the short
 * (abridged) tax invoice, up to R5 000. Over that, or with anything exported, SARS wants a full
 * tax invoice, so the customer is chosen and it's made an invoice paid at once.
 * https://www.sars.gov.za/businesses-and-employers/tax-invoices/
 *
 * Afterwards a sale can be made an invoice (the client's details added, every amount and VAT
 * class as it was) and taken back with a refund: a credit note for what came back, paid out of
 * the till or the bank, the goods back into stock (or not, if they came back damaged). Nothing
 * here is ever changed or deleted once made.
 */
import type { FastifyInstance } from 'fastify';
import {
  documentTotals,
  featureOn,
  itemInput,
  openingStockInput,
  refundInput,
  saleInput,
  saleToInvoiceInput,
  vatRateOn,
  type Feature,
} from '@shap/shared';
import { z } from 'zod';
import { can, requireAccess, type AuthUser, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import { pgCode, PG, type Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { assertOpen, getSettings, q, today } from '../lib/books.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { hideCosts, milli, moveStock, stockOutForDocument, unitCostOut } from '../lib/stock.js';
import { parse } from '../lib/validate.js';
import { assertTaxDocument, createDocument, defaultBrand, FULL_TAX_INVOICE_CENTS, loadDocument, nextNumber } from './documents.js';

const idParam = z.object({ id: z.string().uuid() });

/** A part of the app switched off in Settings: its changes are refused (what's recorded stays readable). */
export async function requireFeature(db: Db, f: Feature, label: string): Promise<void> {
  const s = await getSettings(db);
  if (!featureOn(s.features, f)) throw badRequest(`${label} is switched off. Switch it on in Settings → What you use.`);
}

/** A source money can go into or out of at the counter: a real account, not one of Shap's own. */
async function counterSource(db: Db, sourceId: string): Promise<void> {
  const [src] = await db<{ role: string | null }[]>`select role from payment_sources where id = ${sourceId}`;
  if (!src || src.role) throw badRequest('Choose where the money went: the till, the bank or a card machine’s account');
}

export interface SaleLine {
  id: string;
  itemId: string | null;
  qty: string;
  creditedQty: string;
}

/** Each line of a sale or invoice, with how much of it has been taken back already. */
async function linesWithCredits(db: Db, id: string): Promise<(Record<string, unknown> & SaleLine)[]> {
  return db<(Record<string, unknown> & SaleLine)[]>`
    select l.*, i.stocked, coalesce(c.qty, 0) as credited_qty
    from document_lines l
    left join items i on i.id = l.item_id
    left join lateral (
      select sum(cl.qty) as qty from document_lines cl join documents cn on cn.id = cl.document_id
      where cl.credited_line_id = l.id and cn.status = 'issued' and cn.kind = 'credit_note') c on true
    where l.document_id = ${id} order by l.sort`;
}

const PAID_AT_SALE = 'Paid in full when sold. Thank you.';

/** Makes a sale (or, with a client, an invoice paid at once). Call inside a transaction. */
export async function makeSale(tx: Db, user: AuthUser, raw: unknown): Promise<{ id: string; number: string; saleNumber: string; kind: 'sale' | 'invoice' }> {
  const input = parse(saleInput, raw);
  const settings = await getSettings(tx);
  if (!featureOn(settings.features, 'sales')) throw badRequest('Sales is switched off. Switch it on in Settings → What you use.');
  await assertOpen(tx, input.date);
  await counterSource(tx, input.sourceId);
  const itemIds = [...new Set(input.lines.map((l) => l.itemId).filter((x): x is string => Boolean(x)))];
  if (itemIds.length) {
    const found = await tx<{ id: string; active: boolean }[]>`select id, active from items where id = any(${itemIds}::uuid[])`;
    if (found.length !== itemIds.length) throw badRequest('Something on the sale isn’t in the item list any more');
  }
  if (input.clientId) {
    const [c] = await tx`select 1 from clients where id = ${input.clientId}`;
    if (!c) throw badRequest('That customer isn’t on the client list');
  }
  // A business that isn't registered for VAT sells without it.
  const vatRate = settings.vatRegistered ? vatRateOn(input.date) : 0;
  const lines = input.lines.map((l) => ({ ...l, vatCode: vatRate > 0 ? l.vatCode : ('standard' as const) }));
  const t = documentTotals(lines, vatRate, input.pricesIncludeVat);
  if (t.totalCents <= 0) throw badRequest('A sale is for more than nothing');
  if (!input.clientId && vatRate > 0 && (t.totalCents > FULL_TAX_INVOICE_CENTS || lines.some((l) => l.vatCode === 'export'))) {
    throw badRequest(
      t.totalCents > FULL_TAX_INVOICE_CENTS
        ? 'Over R5 000 SARS wants a full tax invoice, with the buyer’s name and address: choose the customer (or add them as a client).'
        : 'An export needs a full tax invoice, with the buyer’s name and address: choose the customer.',
    );
  }
  const kind = input.clientId ? 'invoice' : 'sale';
  const saleNumber = await nextNumber(tx, 'sale');
  const doc = await createDocument(
    tx,
    user,
    kind,
    {
      clientId: input.clientId ?? null,
      issueDate: input.date,
      dueDate: input.date,
      notes: input.note,
      // Paid on the spot: no payment terms (a slip, or an invoice already paid).
      terms: kind === 'invoice' ? PAID_AT_SALE : '',
      number: kind === 'sale' ? saleNumber : undefined,
      lines: lines.map((l) => ({ category: l.category, description: l.description, qty: l.qty, unit: l.unit, unitPriceCents: l.unitPriceCents, vatCode: l.vatCode, itemId: l.itemId ?? null })),
      pricesIncludeVat: input.pricesIncludeVat,
    },
    { status: 'issued' },
  );
  await tx`update documents set sale_number = ${saleNumber}, customer_name = ${input.customerName} where id = ${doc.id}`;
  await assertTaxDocument(tx, doc.id);
  const [total] = await tx<{ totalCents: string }[]>`select total_cents from documents where id = ${doc.id}`;
  const [r] = await tx<{ id: string }[]>`
    insert into receipts (invoice_id, date, amount_cents, source_id, method, reference, note, created_by)
    values (${doc.id}, ${input.date}, ${total!.totalCents}, ${input.sourceId}, ${input.method}, ${input.reference}, 'Paid at the counter', ${user.id}) returning id`;
  await tx`update documents set sale_receipt_id = ${r!.id} where id = ${doc.id}`;
  await stockOutForDocument(tx, doc.id, input.date, user.id);
  await audit(tx, { userId: user.id, action: 'sell', entity: kind, entityId: doc.id, details: { sale: saleNumber, number: doc.number, totalCents: Number(total!.totalCents) } });
  return { id: doc.id, number: doc.number, saleNumber, kind };
}

/** A sale made an invoice: the client's details on it, every amount and VAT class as it was. */
export async function saleToInvoice(tx: Db, user: AuthUser, id: string, raw: unknown): Promise<{ number: string }> {
  const { clientId } = parse(saleToInvoiceInput, raw);
  const [d] = await tx<{ kind: string; saleNumber: string; issueDate: string; projectId: string | null }[]>`select kind, sale_number, issue_date, project_id from documents where id = ${id} for update`;
  if (!d) throw notFound('Sale');
  if (d.kind !== 'sale') throw badRequest('This sale is already an invoice');
  // It becomes an invoice on the sale's date: that year has to be open.
  await assertOpen(tx, d.issueDate);
  const [c] = await tx`select 1 from clients where id = ${clientId}`;
  if (!c) throw badRequest('That customer isn’t on the client list');
  const number = await nextNumber(tx, 'invoice');
  await tx`
    update documents set kind = 'invoice', number = ${number}, client_id = ${clientId}, due_date = issue_date, terms = ${PAID_AT_SALE},
      brand_id = coalesce(brand_id, ${await defaultBrand(tx, d.projectId, clientId)}), invoiced_at = now(), updated_at = now()
    where id = ${id}`;
  // Over R5 000, or with zero-rated or exported items, the client's name and address must be on it.
  await assertTaxDocument(tx, id);
  await audit(tx, { userId: user.id, action: 'invoice_sale', entity: 'invoice', entityId: id, details: { sale: d.saleNumber, invoice: number, clientId } });
  return { number };
}

/**
 * Money back on a sale (or a paid invoice): a credit note for what came back, at the prices and
 * VAT classes it was sold at, paid out; what came back in good order goes back into stock at the
 * cost it went out at. Call inside a transaction.
 */
export async function refundDocument(tx: Db, user: AuthUser, id: string, raw: unknown): Promise<{ id: string; number: string; amountCents: number }> {
  const input = parse(refundInput, raw);
  const [d] = await tx<{ kind: string; status: string; number: string; issueDate: string; clientId: string | null; projectId: string | null; brandId: string | null; pricesIncludeVat: boolean; title: string }[]>`
    select kind, status, number, issue_date, client_id, project_id, brand_id, prices_include_vat, title from documents where id = ${id} for update`;
  if (!d || !(d.kind === 'sale' || d.kind === 'invoice')) throw notFound('Sale');
  if (d.status !== 'issued') throw badRequest('Only an issued sale or invoice can be refunded');
  await assertOpen(tx, input.date);
  if (input.date < d.issueDate) throw badRequest('A refund can’t be dated before the sale');
  const payOut = input.money === 'paid_out';
  if (payOut) {
    if (!input.sourceId) throw badRequest('Choose where the money was paid out of');
    await counterSource(tx, input.sourceId);
  } else if (d.kind !== 'invoice') throw badRequest('A sale was paid in full: money back on it is paid out');
  const lines = await linesWithCredits(tx, id);
  const seen = new Set<string>();
  const back = input.lines.map((r) => {
    if (seen.has(r.lineId)) throw badRequest('Each line once');
    seen.add(r.lineId);
    const l = lines.find((x) => x.id === r.lineId);
    if (!l) throw badRequest('That line isn’t on this sale');
    const left = milli(l.qty) - milli(l.creditedQty);
    if (milli(r.qty) > left) throw badRequest(`Only ${left / 1000} of “${String(l.description)}” can still come back`);
    return { r, l };
  });
  const cn = await createDocument(
    tx,
    user,
    'credit_note',
    {
      brandId: d.brandId,
      projectId: d.projectId,
      clientId: d.clientId,
      issueDate: input.date,
      title: d.title,
      creditedInvoiceId: id,
      creditReason: input.reason,
      lines: back.map(({ r, l }) => ({
        category: l.category as never,
        description: String(l.description),
        qty: r.qty,
        unit: String(l.unit ?? ''),
        unitPriceCents: Number(l.unitPriceCents),
        vatCode: l.vatCode as never,
        itemId: l.itemId,
      })),
      pricesIncludeVat: d.pricesIncludeVat,
    },
    { status: 'issued' },
  );
  const cnLines = await tx<{ id: string }[]>`select id from document_lines where document_id = ${cn.id} order by sort`;
  for (const [i, { r, l }] of back.entries()) {
    await tx`update document_lines set credited_line_id = ${r.lineId}, restock = ${Boolean(r.restock && l.stocked)} where id = ${cnLines[i]!.id}`;
  }
  await assertTaxDocument(tx, cn.id);
  const [money] = await tx<{ total: string; paid: string; refunded: string; owing: string }[]>`
    select (select total_cents from documents where id = ${cn.id}) as total,
      coalesce((select sum(amount_cents) from receipts where invoice_id = ${id} and method <> 'credit'), 0) as paid,
      coalesce((select sum(rf.amount_cents) from refunds rf join documents c on c.id = rf.credit_note_id where c.credited_invoice_id = ${id}), 0) as refunded,
      (select d.total_cents - d.written_off_cents - coalesce((select sum(amount_cents) from receipts r where r.invoice_id = d.id), 0) from documents d where d.id = ${id}) as owing`;
  const amount = Number(money!.total);
  if (amount <= 0) throw badRequest('Nothing to refund');
  if (payOut) {
    if (amount > Number(money!.paid) - Number(money!.refunded)) {
      throw badRequest(`That’s more than was paid for it and not yet refunded (${((Number(money!.paid) - Number(money!.refunded)) / 100).toFixed(2)}). Take the rest off what’s still owed instead.`);
    }
    await tx`insert into refunds (credit_note_id, date, amount_cents, source_id, method, reference, created_by)
      values (${cn.id}, ${input.date}, ${amount}, ${input.sourceId!}, ${input.method}, ${input.reference}, ${user.id})`;
  } else {
    // Taken off what the client still owes on the invoice, as a credit note issued on its own does.
    if (amount > Number(money!.owing)) throw badRequest(`That’s more than is still owed on the invoice (${(Number(money!.owing) / 100).toFixed(2)}). Pay the rest back as a refund.`);
    const [src] = await tx<{ id: string }[]>`select id from payment_sources where role = 'credit_notes'`;
    const [r] = await tx<{ id: string }[]>`
      insert into receipts (invoice_id, date, amount_cents, source_id, method, reference, note, created_by)
      values (${id}, ${input.date}, ${amount}, ${src!.id}, 'credit', ${cn.number}, 'Credit note', ${user.id}) returning id`;
    await tx`update documents set credit_receipt_id = ${r!.id} where id = ${cn.id}`;
  }
  for (const [i, { r, l }] of back.entries()) {
    if (!r.restock || !l.stocked || !l.itemId) continue;
    const [item] = await tx<{ lastCostCents: string }[]>`select last_cost_cents from items where id = ${l.itemId}`;
    const unit = (await unitCostOut(tx, l.id)) ?? Number(item!.lastCostCents);
    await moveStock(tx, {
      itemId: l.itemId,
      date: input.date,
      kind: 'refund',
      qty: r.qty,
      valueCents: Math.round((milli(r.qty) * unit) / 1000),
      contra: 'cos_goods',
      documentId: cn.id,
      documentLineId: cnLines[i]!.id,
      reason: input.reason,
      userId: user.id,
    });
  }
  await audit(tx, { userId: user.id, action: payOut ? 'refund' : 'goods_returned', entity: d.kind, entityId: id, details: { creditNote: cn.number, amountCents: amount, reason: input.reason, money: input.money } });
  return { id: cn.id, number: cn.number, amountCents: amount };
}


/**
 * Who may open a sale (or an invoice) from the counter: an invoice that wasn't a sale is the
 * invoices' (“See quotes and invoices”); someone selling without “See all sales and takings” opens
 * only their own sales.
 */
export function mayOpenSale(user: AuthUser, doc: { kind: string; saleNumber: string | null; createdBy: string | null }): void {
  const ok = !doc.saleNumber
    ? can(user, 'documents.view')
    : can(user, 'sales.view') || doc.createdBy === user.id || (doc.kind !== 'sale' && can(user, 'documents.view'));
  if (!ok) throw notFound('Sale');
}

export function registerSalesRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;

  // ---- items: the price list (and, stocked, what's on the shelf)
  app.get('/api/items', { preHandler: requireAccess('sales.sell', 'sales.view', 'items.edit', 'stock.view') }, async (req) => {
    const user = userOrThrow(req);
    const { search, stocked, active } = q(req);
    const s = search?.trim() || null;
    const rows = await sql`
      select i.*, case when i.qty_on_hand > 0 then round(i.stock_value_cents / i.qty_on_hand) else null end as average_cost_cents,
        (select max(date) from stock_moves m where m.item_id = i.id) as last_moved
      from items i
      where (${s}::text is null or i.description ilike '%' || ${s} || '%' or i.sku ilike '%' || ${s} || '%')
        and (${stocked ?? null}::text is null or i.stocked = (${stocked ?? null} = '1'))
        and (${active ?? null}::text is null or i.active = (${active ?? null} = '1'))
      order by i.active desc, i.description limit 2000`;
    return can(user, 'stock.costs') ? rows : rows.map(hideCosts);
  });

  app.post('/api/items', { preHandler: requireAccess('items.edit') }, async (req) => {
    const user = userOrThrow(req);
    const input = parse(itemInput, req.body);
    if (input.stocked) await requireFeature(sql, 'inventory', 'Inventory');
    try {
      const [row] = await sql`
        insert into items (description, sku, category, unit, unit_price_cents, price_includes_vat, vat_code, stocked, reorder_level, active, stocked_since)
        values (${input.description}, ${input.sku}, ${input.category}, ${input.unit}, ${input.unitPriceCents}, ${input.priceIncludesVat}, ${input.vatCode},
                ${input.stocked}, ${input.reorderLevel}, ${input.active}, ${input.stocked ? new Date() : null}) returning *`;
      await audit(sql, { userId: user.id, action: 'create', entity: 'item', entityId: row!.id, ip: req.ip, details: { description: input.description, stocked: input.stocked } });
      return row;
    } catch (err) {
      if (pgCode(err) === PG.uniqueViolation) throw conflict('There’s already an item with that name or code');
      throw err;
    }
  });

  app.put('/api/items/:id', { preHandler: requireAccess('items.edit') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const input = parse(itemInput, req.body);
    const [old] = await sql<{ stocked: boolean; qtyOnHand: string; stockValueCents: string; description: string; unitPriceCents: string }[]>`select * from items where id = ${id}`;
    if (!old) throw notFound('Item');
    if (input.stocked && !old.stocked) await requireFeature(sql, 'inventory', 'Inventory');
    if (old.stocked && !input.stocked && (milli(old.qtyOnHand) !== 0 || Number(old.stockValueCents) !== 0)) {
      throw badRequest('There’s still stock of this item: count it to nothing (a stock take) before it stops being stocked.');
    }
    try {
      const [row] = await sql`
        update items set description = ${input.description}, sku = ${input.sku}, category = ${input.category}, unit = ${input.unit},
          unit_price_cents = ${input.unitPriceCents}, price_includes_vat = ${input.priceIncludesVat}, vat_code = ${input.vatCode},
          stocked = ${input.stocked}, reorder_level = ${input.reorderLevel}, active = ${input.active}, updated_at = now(),
          stocked_since = case when ${input.stocked} and not stocked then now() else stocked_since end
        where id = ${id} returning *`;
      await audit(sql, { userId: user.id, action: 'update', entity: 'item', entityId: id, ip: req.ip, details: { description: input.description, was: old.description, priceCents: input.unitPriceCents, wasPriceCents: Number(old.unitPriceCents), stocked: input.stocked } });
      return row;
    } catch (err) {
      if (pgCode(err) === PG.uniqueViolation) throw conflict('There’s already an item with that name or code');
      throw err;
    }
  });

  /** Stock already on hand when an item starts being tracked: its first movement. */
  app.post('/api/items/:id/opening', { preHandler: requireAccess('stock.buy') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const input = parse(openingStockInput, req.body);
    await requireFeature(sql, 'inventory', 'Inventory');
    await assertOpen(sql, input.date);
    return sql.begin(async (tx) => {
      const [moved] = await tx`select 1 from stock_moves where item_id = ${id} limit 1`;
      if (moved) throw badRequest('This item already has stock movements: correct it with a stock take, or bring stock in with a purchase.');
      const m = await moveStock(tx, {
        itemId: id,
        date: input.date,
        kind: 'opening',
        qty: input.qty,
        unitCostCents: input.unitCostCents,
        contra: input.from === 'opening_balances' ? 'stock_opening' : 'cos_goods',
        reason: input.reason || (input.from === 'opening_balances' ? 'Opening stock (moved in)' : 'Opening stock (bought before, already in costs)'),
        userId: user.id,
      });
      await audit(tx, { userId: user.id, action: 'opening_stock', entity: 'item', entityId: id, ip: req.ip, details: { qty: input.qty, valueCents: m.valueCents, from: input.from } });
      return m;
    });
  });

  /** An item's whole story: every movement with what caused it, and the stock after each. */
  app.get('/api/items/:id/history', { preHandler: requireAccess('stock.view') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const [item] = await sql`select * from items where id = ${id}`;
    if (!item) throw notFound('Item');
    const moves = await sql`
      select m.*, u.name as by_name, d.kind as document_kind, d.number as document_number, d.sale_number, c.name as client_name,
        cs.supplier as cost_supplier, cs.bill_number as cost_reference, cs.amount_cents as cost_amount_cents,
        st.note as stock_take_note, cl.kind as claim_kind, cl.supplier as claim_supplier
      from stock_moves m
      left join users u on u.id = m.created_by
      left join documents d on d.id = m.document_id
      left join clients c on c.id = d.client_id
      left join costs cs on cs.id = m.cost_id
      left join stock_takes st on st.id = m.stock_take_id
      left join stock_claims cl on cl.id = m.claim_id
      where m.item_id = ${id} order by m.seq`;
    const sold = await sql`
      select d.id, d.kind, d.number, d.sale_number, d.issue_date, d.status, l.qty, l.line_total_cents, c.name as client_name
      from document_lines l join documents d on d.id = l.document_id left join clients c on c.id = d.client_id
      where l.item_id = ${id} and d.kind in ('sale', 'invoice', 'credit_note') and d.status <> 'draft' order by d.issue_date desc, d.created_at desc limit 500`;
    const audits = await sql`
      select a.at, a.action, a.details, u.name as by_name from audit_log a left join users u on u.id = a.user_id
      where a.entity = 'item' and a.entity_id = ${id} order by a.at desc limit 200`;
    if (!can(user, 'stock.costs')) return { item: hideCosts(item), moves: moves.map(hideCosts), documents: sold, changes: audits.map((a) => ({ ...a, details: hideCosts(a.details ?? {}) })) };
    return { item, moves, documents: sold, changes: audits };
  });

  // ---- sales
  app.get('/api/sales', { preHandler: requireAccess('sales.sell', 'sales.view') }, async (req) => {
    const user = userOrThrow(req);
    const { from, to, search } = q(req);
    const s = search?.trim() || null;
    // Selling without “See all sales”: your own.
    const mine = can(user, 'sales.view') ? null : user.id;
    return sql`
      select d.id, d.kind, d.number, d.sale_number, d.issue_date, d.total_cents, d.vat_cents, d.customer_name, d.invoiced_at,
        c.name as client_name, r.method, src.name as source_name,
        coalesce((select sum(rf.amount_cents) from refunds rf join documents cn on cn.id = rf.credit_note_id where cn.credited_invoice_id = d.id), 0)::bigint as refunded_cents
      from documents d
      left join clients c on c.id = d.client_id
      left join receipts r on r.id = d.sale_receipt_id
      left join payment_sources src on src.id = r.source_id
      where d.sale_number is not null and (${mine}::uuid is null or d.created_by = ${mine}::uuid)
        and (${from ?? null}::date is null or d.issue_date >= ${from ?? null}::date)
        and (${to ?? null}::date is null or d.issue_date <= ${to ?? null}::date)
        and (${s}::text is null or d.sale_number ilike '%' || ${s} || '%' or d.number ilike '%' || ${s} || '%' or d.customer_name ilike '%' || ${s} || '%'
             or c.name ilike '%' || ${s} || '%'
             or exists (select 1 from document_lines l where l.document_id = d.id and l.description ilike '%' || ${s} || '%'))
      order by d.issue_date desc, d.created_at desc limit 1000`;
  });

  app.get('/api/sales/:id', { preHandler: requireAccess('sales.sell', 'sales.view', 'documents.view') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const data = await loadDocument(sql, id);
    // A sale, or an invoice (its returns and refunds are taken the same way).
    const doc = data.doc as unknown as { kind: string; saleNumber: string | null; createdBy: string | null };
    if (!(doc.kind === 'sale' || doc.kind === 'invoice')) throw notFound('Sale');
    mayOpenSale(user, doc);
    const lines = await linesWithCredits(sql, id);
    const refunds = await sql`
      select rf.*, cn.number as credit_note_number, cn.credit_reason, s.name as source_name
      from refunds rf join documents cn on cn.id = rf.credit_note_id join payment_sources s on s.id = rf.source_id
      where cn.credited_invoice_id = ${id} order by rf.date, rf.created_at`;
    const stock = await sql`select m.*, i.description from stock_moves m join items i on i.id = m.item_id where m.document_id = ${id} order by m.seq`;
    return { ...data, lines, refunds, stock: can(user, 'stock.costs') ? stock : stock.map(hideCosts) };
  });

  app.post('/api/sales', { preHandler: requireAccess('sales.sell') }, async (req) => {
    const user = userOrThrow(req);
    const made = await sql.begin((tx) => makeSale(tx, user, req.body));
    return { ...made, ...(await loadDocument(sql, made.id)) };
  });

  app.post('/api/sales/:id/invoice', { preHandler: requireAccess('sales.sell') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const [doc] = await sql<{ kind: string; saleNumber: string | null; createdBy: string | null }[]>`select kind, sale_number, created_by from documents where id = ${id}`;
    if (!doc) throw notFound('Sale');
    mayOpenSale(user, doc);
    await sql.begin((tx) => saleToInvoice(tx, user, id, req.body));
    return loadDocument(sql, id);
  });

  app.post('/api/documents/:id/refund', { preHandler: requireAccess('sales.refund', 'documents.edit') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    // A sale's refund is the counter's (“Refund”); goods back on an invoice are the invoices'.
    const [doc] = await sql<{ saleNumber: string | null }[]>`select sale_number from documents where id = ${id}`;
    if (!doc) throw notFound('Sale');
    if (!can(user, doc.saleNumber ? 'sales.refund' : 'documents.edit')) throw forbidden(doc.saleNumber ? 'Refunds take “Refund” under Selling' : 'Goods back on an invoice take “Make and change them” under Quotes & invoices');
    return sql.begin((tx) => refundDocument(tx, user, id, req.body));
  });

  // Today's takings, for the top of the Sales screen.
  app.get('/api/sales-today', { preHandler: requireAccess('sales.sell', 'sales.view') }, async (req) => {
    const user = userOrThrow(req);
    const t = today();
    // The day's takings; selling without “See all sales and takings”, your own.
    const mine = can(user, 'sales.view') ? null : user.id;
    const [r] = await sql<{ count: number; total: string; refunded: string }[]>`
      select count(*)::int as count, coalesce(sum(total_cents), 0) as total,
        coalesce((select sum(rf.amount_cents) from refunds rf join documents cn on cn.id = rf.credit_note_id join documents s on s.id = cn.credited_invoice_id
                  where rf.date = ${t}::date and s.sale_number is not null and (${mine}::uuid is null or rf.created_by = ${mine}::uuid)), 0) as refunded
      from documents where sale_number is not null and issue_date = ${t}::date and (${mine}::uuid is null or created_by = ${mine}::uuid)`;
    return { date: t, count: r!.count, totalCents: Number(r!.total), refundedCents: Number(r!.refunded), mine: Boolean(mine) };
  });
}
