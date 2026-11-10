/**
 * Supplier bills: costs "paid from" the suppliers' account (Not paid yet), so the expense and VAT
 * land on the bill's date and the amount is owed until it's paid. Paying moves money from the
 * bank to the supplier. A supplier's credit note on account (a negative cost) is taken off one of
 * their bills: a payment made with the credit, which moves no money.
 */
import type { FastifyInstance } from 'fastify';
import { billCreditInput, billPaymentInput } from '@shap/shared';
import { z } from 'zod';
import { requireAccess, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Db as AnyDb } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { assertOpen, q } from '../lib/books.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

type Db = Ctx['sql'];
const idParam = z.object({ id: z.string().uuid() });

export interface BillRow {
  id: string;
  date: string;
  dueDate: string | null;
  billNumber: string;
  supplier: string;
  description: string;
  amountCents: number;
  paidCents: number;
  owingCents: number;
  projectName: string | null;
  categoryName: string;
}

/**
 * Bills with what's been paid on each (in money, or with a credit note); and the suppliers'
 * credit notes, with what's left of each to use (as a negative amount owing).
 */
export async function bills(db: Db | AnyDb, state: 'open' | 'paid' | 'all' | 'credits' = 'open'): Promise<BillRow[]> {
  const rows = await (db as Db)<BillRow[]>`
    select c.id, c.date, c.due_date, c.bill_number, c.supplier, c.description, c.amount_cents,
      coalesce(p.paid, 0)::bigint as paid_cents, (c.amount_cents - coalesce(p.paid, 0) + coalesce(u.used, 0))::bigint as owing_cents,
      pr.name as project_name, k.name as category_name
    from costs c
    join payment_sources s on s.id = c.source_id and s.role = 'bills'
    join cost_categories k on k.id = c.category_id
    left join projects pr on pr.id = c.project_id
    left join lateral (select sum(amount_cents) as paid from bill_payments where cost_id = c.id) p on true
    left join lateral (select sum(amount_cents) as used from bill_payments where credit_cost_id = c.id) u on true
    order by coalesce(c.due_date, c.date), c.date`;
  return rows.filter((r) =>
    state === 'all' ? true : state === 'open' ? Number(r.owingCents) > 0 : state === 'credits' ? Number(r.owingCents) < 0 : Number(r.owingCents) <= 0 && Number(r.amountCents) > 0,
  );
}

/** Takes (part of) a supplier's credit note off one of their bills. Call inside a transaction. */
export async function applyBillCredit(tx: AnyDb, userId: string, billId: string, raw: unknown): Promise<{ id: string }> {
  const input = parse(billCreditInput, raw);
  const all = await bills(tx, 'all');
  const bill = all.find((b) => b.id === billId);
  const credit = all.find((b) => b.id === input.creditId);
  if (!bill || Number(bill.amountCents) <= 0) throw notFound('Bill');
  if (!credit || Number(credit.amountCents) >= 0) throw badRequest('That isn’t a supplier’s credit note on account');
  if (bill.supplier.trim().toLowerCase() !== credit.supplier.trim().toLowerCase()) throw badRequest(`That credit is from ${credit.supplier || 'another supplier'}, not ${bill.supplier || 'this one'}`);
  if (input.amountCents > Number(bill.owingCents)) throw badRequest(`That's more than is owed on the bill (${(Number(bill.owingCents) / 100).toFixed(2)})`);
  if (input.amountCents > -Number(credit.owingCents)) throw badRequest(`That's more than is left of the credit (${(-Number(credit.owingCents) / 100).toFixed(2)})`);
  if (input.date < bill.date || input.date < credit.date) throw badRequest('A credit is taken off a bill on or after the dates of both');
  await assertOpen(tx, input.date);
  const [src] = await tx<{ id: string }[]>`select id from payment_sources where role = 'bills'`;
  const [row] = await tx<{ id: string }[]>`
    insert into bill_payments (cost_id, date, amount_cents, source_id, note, credit_cost_id)
    values (${billId}, ${input.date}, ${input.amountCents}, ${src!.id}, ${`Credit ${credit.billNumber || credit.description}`}, ${input.creditId}) returning id`;
  await audit(tx, { userId, action: 'apply_bill_credit', entity: 'cost', entityId: billId, details: { creditId: input.creditId, amountCents: input.amountCents } });
  return row!;
}

export function registerBillRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;

  app.get('/api/bills', { preHandler: requireAccess('bills.pay', 'costs.view') }, async (req) => {
    const state = (q(req).state as 'open' | 'paid' | 'all' | undefined) ?? 'open';
    const list = await bills(sql, state);
    const payments = await sql`
      select bp.*, s.name as source_name from bill_payments bp join payment_sources s on s.id = bp.source_id
      where bp.cost_id = any(${list.map((b) => b.id)}::uuid[]) order by bp.date`;
    return list.map((b) => ({ ...b, payments: payments.filter((p) => p.costId === b.id) }));
  });

  app.post('/api/costs/:id/bill-payments', { preHandler: requireAccess('bills.pay') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const input = parse(billPaymentInput, req.body);
    const [bill] = (await bills(sql, 'all')).filter((b) => b.id === id);
    if (!bill) throw notFound('Bill');
    if (input.amountCents > Number(bill.owingCents)) throw badRequest(`That's more than is owed on the bill (${(Number(bill.owingCents) / 100).toFixed(2)})`);
    if (input.date < bill.date) throw badRequest('A bill can’t be paid before its date');
    const [src] = await sql<{ role: string | null }[]>`select role from payment_sources where id = ${input.sourceId}`;
    if (!src || src.role) throw badRequest('Choose the account it was paid from');
    await assertOpen(sql, input.date);
    const [row] = await sql`insert into bill_payments ${sql({ ...input, costId: id })} returning *`;
    await audit(sql, { userId: user.id, action: 'pay_bill', entity: 'cost', entityId: id, ip: req.ip, details: { amountCents: input.amountCents } });
    return row;
  });

  app.post('/api/costs/:id/bill-credits', { preHandler: requireAccess('bills.pay') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    return sql.begin((tx) => applyBillCredit(tx, user.id, id, req.body));
  });

  app.delete('/api/bill-payments/:id', { preHandler: requireAccess('bills.pay') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const [p] = await sql<{ date: string; costId: string }[]>`select date, cost_id from bill_payments where id = ${id}`;
    if (!p) throw notFound('Payment');
    await assertOpen(sql, p.date);
    await sql`delete from bill_payments where id = ${id}`;
    await audit(sql, { userId: user.id, action: 'unpay_bill', entity: 'cost', entityId: p.costId, ip: req.ip });
    return { ok: true };
  });
}
