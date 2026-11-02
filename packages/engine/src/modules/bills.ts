/**
 * Supplier bills: costs "paid from" the suppliers' account (Not paid yet), so the expense and VAT
 * land on the bill's date and the amount is owed until it's paid. Paying moves money from the
 * bank to the supplier.
 */
import type { App as FastifyInstance } from '../http.js';
import { billPaymentInput } from '@shap/shared';
import { z } from 'zod';
import { requireRole, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
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

/** Bills with what's been paid on each. */
export async function bills(db: Db, state: 'open' | 'paid' | 'all' = 'open'): Promise<BillRow[]> {
  const rows = await db<BillRow[]>`
    select c.id, c.date, c.due_date, c.bill_number, c.supplier, c.description, c.amount_cents,
      coalesce(p.paid, 0)::bigint as paid_cents, (c.amount_cents - coalesce(p.paid, 0))::bigint as owing_cents,
      pr.name as project_name, k.name as category_name
    from costs c
    join payment_sources s on s.id = c.source_id and s.role = 'bills'
    join cost_categories k on k.id = c.category_id
    left join projects pr on pr.id = c.project_id
    left join lateral (select sum(amount_cents) as paid from bill_payments where cost_id = c.id) p on true
    order by coalesce(c.due_date, c.date), c.date`;
  return rows.filter((r) => (state === 'all' ? true : state === 'open' ? Number(r.owingCents) > 0 : Number(r.owingCents) <= 0));
}

export function registerBillRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;

  app.get('/api/bills', { preHandler: requireRole('owner', 'accountant') }, async (req) => {
    const state = (q(req).state as 'open' | 'paid' | 'all' | undefined) ?? 'open';
    const list = await bills(sql, state);
    const payments = await sql`
      select bp.*, s.name as source_name from bill_payments bp join payment_sources s on s.id = bp.source_id
      where bp.cost_id = any(${list.map((b) => b.id)}::uuid[]) order by bp.date`;
    return list.map((b) => ({ ...b, payments: payments.filter((p) => p.costId === b.id) }));
  });

  app.post('/api/costs/:id/bill-payments', { preHandler: requireRole('owner') }, async (req) => {
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

  app.delete('/api/bill-payments/:id', { preHandler: requireRole('owner') }, async (req) => {
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
