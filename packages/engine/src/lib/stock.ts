/**
 * The stock ledger (docs/SALES_AND_STOCK.md): every movement of a stocked item goes through
 * moveStock, inside the transaction that records what caused it, with the item locked so two
 * movements can't cost against the same stock at once.
 *
 * Weighted average cost (IFRS for SMEs 13.18): stock coming in adds its cost; stock going out
 * takes its share of the value (all of it when the last units go, so nothing is left over).
 * Selling more than is in stock is allowed: the shortfall goes out at the latest cost known, and
 * when stock arrives the stock that's left is valued at what it cost, the difference being the
 * true cost of what was sold before it came in (a revaluation against cost of sales). A count
 * corrects the quantity, at average cost, against stock losses.
 *
 * Quantities are kept to three decimals (worked in thousandths), values in cents. A movement is
 * never changed or deleted (a database trigger refuses it): a correction is a movement of its own.
 */
import type { Db } from '../db/index.js';
import { badRequest } from './errors.js';

export type MoveKind = 'opening' | 'purchase' | 'supplier_return' | 'sale' | 'refund' | 'count' | 'revalue' | 'void';
export type Contra = 'stock_clearing' | 'supplier_claims' | 'cos_goods' | 'stock_losses' | 'stock_opening';

export interface MoveInput {
  itemId: string;
  date: string;
  kind: MoveKind;
  /** In (positive) or out (negative), in units. */
  qty: number;
  /** For stock coming in at a known cost per unit (excluding VAT): a purchase or opening stock. */
  unitCostCents?: number;
  /** An exact value instead (a refund back in at what it went out at, a reversal). */
  valueCents?: number;
  contra: Contra;
  documentId?: string | null;
  documentLineId?: string | null;
  costId?: string | null;
  purchaseLineId?: string | null;
  stockTakeId?: string | null;
  claimId?: string | null;
  reversesId?: string | null;
  reason?: string;
  userId?: string | null;
}

export interface Moved {
  id: string;
  valueCents: number;
}

/** Thousandths of a unit, exactly. */
export const milli = (q: number | string): number => Math.round(Number(q) * 1000);
const units = (m: number) => m / 1000;

interface ItemState {
  description: string;
  stocked: boolean;
  qtyOnHand: string | number;
  stockValueCents: string | number;
  lastCostCents: string | number;
}

async function insertMove(db: Db, m: MoveInput, qtyM: number, value: number, afterM: number, afterValue: number): Promise<Moved> {
  const [r] = await db<{ id: string }[]>`
    insert into stock_moves (item_id, date, kind, qty, value_cents, contra, document_id, document_line_id, cost_id, purchase_line_id,
                             stock_take_id, claim_id, reverses_id, reason, qty_after, value_after_cents, created_by)
    values (${m.itemId}, ${m.date}, ${m.kind}, ${units(qtyM)}, ${value}, ${m.contra}, ${m.documentId ?? null}, ${m.documentLineId ?? null},
            ${m.costId ?? null}, ${m.purchaseLineId ?? null}, ${m.stockTakeId ?? null}, ${m.claimId ?? null}, ${m.reversesId ?? null},
            ${m.reason ?? ''}, ${units(afterM)}, ${afterValue}, ${m.userId ?? null})
    returning id`;
  return { id: r!.id, valueCents: value };
}

/**
 * Records one movement (and the revaluation it brings about, if any). Returns the movement and its
 * value: what it took out of (negative) or put into the stock.
 */
export async function moveStock(db: Db, m: MoveInput): Promise<Moved> {
  const [item] = await db<ItemState[]>`
    select description, stocked, qty_on_hand, stock_value_cents, last_cost_cents from items where id = ${m.itemId} for update`;
  if (!item) throw badRequest('That item isn’t in the item list');
  if (!item.stocked) throw badRequest(`${item.description} isn’t a stocked item`);
  // A count is what was on the shelf that day: nothing can slip in before it afterwards.
  const [counted] = await db<{ date: string | null }[]>`
    select max(t.date)::text as date from stock_takes t join stock_take_lines l on l.stock_take_id = t.id where l.item_id = ${m.itemId}`;
  if (counted?.date && m.date < counted.date) {
    throw badRequest(
      `${item.description} was counted on ${counted.date}: nothing can be dated before that count. Date it on or after ${counted.date}${m.kind === 'void' ? ', or take the goods back with a credit note (Returns) instead of voiding' : ''}.`,
    );
  }
  const qM = milli(m.qty);
  const haveM = milli(item.qtyOnHand);
  const have = Number(item.stockValueCents);
  const last = Number(item.lastCostCents);
  let value: number;
  if (m.valueCents != null) value = Math.round(m.valueCents);
  else if (qM > 0) value = Math.round((qM * (m.unitCostCents ?? last)) / 1000);
  else if (qM < 0) {
    const outM = -qM;
    if (haveM > 0 && outM <= haveM) value = outM === haveM ? -have : -Math.round((have * outM) / haveM);
    // More than there is: all of what's there, the rest at the latest cost.
    else if (haveM > 0) value = -(have + Math.round(((outM - haveM) * last) / 1000));
    else value = -Math.round((outM * last) / 1000);
  } else value = 0;
  let afterM = haveM + qM;
  let afterValue = have + value;
  const moved = await insertMove(db, m, qM, value, afterM, afterValue);

  // What the stock is worth now it's settled: once below zero, stock arriving at a known cost
  // values what's left at that cost; at nothing left, nothing is left in value either.
  let target: number | null = null;
  if (qM > 0 && haveM < 0 && m.unitCostCents != null) target = Math.round((afterM * m.unitCostCents) / 1000);
  else if (afterM === 0 && afterValue !== 0) target = 0;
  if (target != null && target !== afterValue) {
    const diff = target - afterValue;
    await insertMove(db, { ...m, kind: 'revalue', qty: 0, valueCents: diff, contra: 'cos_goods', reason: haveM < 0 && qM > 0 ? 'Stock sold before it arrived, at what it cost' : 'Nothing left in stock, so nothing left in value' }, 0, diff, afterM, target);
    afterValue = target;
  }
  const newLast = (m.kind === 'purchase' || m.kind === 'opening') && m.unitCostCents != null ? m.unitCostCents : last;
  await db`update items set qty_on_hand = ${units(afterM)}, stock_value_cents = ${afterValue}, last_cost_cents = ${newLast}, updated_at = now() where id = ${m.itemId}`;
  return moved;
}

/** What a stocked item's units went out at on a document line (per unit, in cents), for taking them back at the same cost. */
export async function unitCostOut(db: Db, documentLineId: string): Promise<number | null> {
  const [r] = await db<{ qty: string | null; value: string | null }[]>`
    select sum(-qty) as qty, sum(-value_cents) as value from stock_moves where document_line_id = ${documentLineId} and kind = 'sale' and qty <> 0`;
  const q = milli(r?.qty ?? 0);
  return q > 0 ? (Number(r!.value) * 1000) / q : null;
}

/** Takes a document's stock movements back (voiding it): each one reversed, as recorded. */
export async function reverseDocumentStock(db: Db, documentId: string, date: string, reason: string, userId: string | null): Promise<void> {
  const moves = await db<{ id: string; itemId: string; qty: string; valueCents: string; contra: Contra; documentLineId: string | null }[]>`
    select m.id, m.item_id, m.qty, m.value_cents, m.contra, m.document_line_id from stock_moves m
    where m.document_id = ${documentId} and m.kind <> 'void' and m.qty <> 0
      and not exists (select 1 from stock_moves r where r.reverses_id = m.id)
    order by m.seq`;
  for (const mv of moves) {
    await moveStock(db, {
      itemId: mv.itemId,
      date,
      kind: 'void',
      qty: -Number(mv.qty),
      valueCents: -Number(mv.valueCents),
      contra: mv.contra,
      documentId,
      documentLineId: mv.documentLineId,
      reversesId: mv.id,
      reason,
      userId,
    });
  }
}

/** Moves stock out for each stocked item on an issued invoice or sale. */
export async function stockOutForDocument(db: Db, documentId: string, date: string, userId: string | null): Promise<void> {
  const lines = await db<{ id: string; itemId: string; qty: string }[]>`
    select l.id, l.item_id, l.qty from document_lines l join items i on i.id = l.item_id
    where l.document_id = ${documentId} and i.stocked and l.qty > 0 order by l.sort`;
  for (const l of lines) {
    await moveStock(db, { itemId: l.itemId, date, kind: 'sale', qty: -Number(l.qty), contra: 'cos_goods', documentId, documentLineId: l.id, userId });
  }
}
