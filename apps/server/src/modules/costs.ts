import type { FastifyInstance } from 'fastify';
import { assignSourceInput, costInput, PURCHASE_VAT, vatIncluded, vatRateOn, type PurchaseVatCode } from '@shap/shared';
import { z } from 'zod';
import { requireRole, seesMoney, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { assertOpen, getSettings, isIsoDate, q } from '../lib/books.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

const idParam = z.object({ id: z.string().uuid() });

/**
 * The VAT a cost may claim: none unless the business is a VAT vendor, none on the owner's
 * personal spending, the same sign as the amount, and no more than the VAT a VAT-inclusive
 * amount can hold (a cent's rounding allowed).
 */
async function claimableVat(db: Db, input: { date: string; amountCents: number; vatCents: number; categoryId: string; vatCode?: PurchaseVatCode }): Promise<number> {
  const settings = await getSettings(db);
  // Zero-rated, exempt, no VAT on the slip, or VAT that can't be claimed (entertainment, a car): none claimed.
  if (!settings.vatRegistered || !input.vatCents || !PURCHASE_VAT[input.vatCode ?? 'standard'].claim) return 0;
  const [cat] = await db<{ kind: string }[]>`select kind from cost_categories where id = ${input.categoryId}`;
  if (cat?.kind === 'personal') return 0;
  if (Math.sign(input.vatCents) !== Math.sign(input.amountCents)) throw badRequest('The VAT has to go the same way as the amount (both negative on a refund).');
  const most = vatIncluded(Math.abs(input.amountCents), vatRateOn(input.date)) + 1;
  if (Math.abs(input.vatCents) > most) throw badRequest(`That’s more VAT than R${(Math.abs(input.amountCents) / 100).toFixed(2)} can include (at most R${(most / 100).toFixed(2)}).`);
  return input.vatCents;
}

export function registerCostRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;

  // Site capture logs a slip's basics; it must not reach into the money machinery. It can't claim
  // input VAT, post a negative (credit-note) amount, raise a supplier bill to pay later, or pay
  // from an internal (role) account — those stay owner-only, so the parsed cost is pinned here.
  const limitCaptureCost = async (input: z.infer<typeof costInput>): Promise<z.infer<typeof costInput>> => {
    if (input.amountCents < 0) throw badRequest('A cost can’t be a negative amount');
    if (input.sourceId) {
      const [src] = await sql<{ role: string | null }[]>`select role from payment_sources where id = ${input.sourceId}`;
      if (!src || src.role) throw badRequest('Choose a normal account it was paid from, or leave it for the owner to set');
    }
    return { ...input, vatCents: 0, vatCode: input.vatCode === 'standard' ? 'no_vat' : input.vatCode, billNumber: '', dueDate: null };
  };

  app.get('/api/costs', { preHandler: requireRole('owner', 'accountant') }, async (req) => {
    const { from, to, category, project, source, search, kind } = q(req);
    const f = isIsoDate(from) ? from : null;
    const t = isIsoDate(to) ? to : null;
    const s = search?.trim() || null;
    return sql`
      select c.*, k.name as category_name, k.kind as category_kind, src.name as source_name,
        p.name as project_name, p.number as project_number, a.id as asset_id
      from costs c join cost_categories k on k.id = c.category_id left join payment_sources src on src.id = c.source_id
      left join projects p on p.id = c.project_id left join assets a on a.cost_id = c.id
      where (${f}::date is null or c.date >= ${f}::date) and (${t}::date is null or c.date <= ${t}::date)
        and (${category ?? null}::uuid is null or c.category_id = ${category ?? null}::uuid)
        and (${project ?? null}::uuid is null or c.project_id = ${project ?? null}::uuid)
        and (${source && source !== 'none' ? source : null}::uuid is null or c.source_id = ${source && source !== 'none' ? source : null}::uuid)
        and (${source === 'none'} = false or c.source_id is null)
        and (${kind && kind !== 'materials-unallocated' ? kind : null}::text is null or k.kind = ${kind && kind !== 'materials-unallocated' ? kind : null}::text)
        and (${kind === 'materials-unallocated'} = false or (k.kind = 'materials' and c.project_id is null and not c.no_job))
        and (${s}::text is null or c.description ilike '%' || ${s} || '%' or c.supplier ilike '%' || ${s} || '%')
      order by c.date desc, c.created_at desc
      limit 2000
    `;
  });

  /**
   * Tidy several costs at once: put them on a job, mark them as not for a job (parts for the
   * yard, say), or change their type (advertising captured as parts).
   */
  app.post('/api/costs/bulk', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const input = parse(
      z
        .object({
          ids: z.array(z.string().uuid()).min(1).max(2000),
          projectId: z.string().uuid().optional(),
          noJob: z.literal(true).optional(),
          categoryId: z.string().uuid().optional(),
        })
        .refine((i) => [i.projectId, i.noJob, i.categoryId].filter((x) => x != null).length === 1, 'Choose one change'),
      req.body,
    );
    const dates = await sql<{ date: string }[]>`select date::text from costs where id = any(${input.ids}::uuid[])`;
    await assertOpen(sql, ...dates.map((d) => d.date));
    const res = input.projectId
      ? await sql`update costs set project_id = ${input.projectId}, no_job = false where id = any(${input.ids}::uuid[])`
      : input.noJob
        ? await sql`update costs set no_job = true where id = any(${input.ids}::uuid[])`
        : await sql`update costs set category_id = ${input.categoryId!} where id = any(${input.ids}::uuid[])`;
    await audit(sql, { userId: user.id, action: 'bulk_update', entity: 'cost', ip: req.ip, details: { count: res.count, change: input.projectId ? 'job' : input.noJob ? 'no_job' : 'type' } });
    return { updated: res.count };
  });

  /** Suppliers you've used, most used first, for the picker on the phone. Site capture sees only
   *  the suppliers on its own entries, not the owner's full (sometimes sensitive) supplier list. */
  app.get('/api/costs/suppliers', { preHandler: requireRole() }, async (req) => {
    const user = userOrThrow(req);
    const rows = seesMoney(user)
      ? await sql<{ supplier: string }[]>`select supplier from costs where supplier <> '' group by supplier order by count(*) desc, supplier limit 200`
      : await sql<{ supplier: string }[]>`select supplier from costs where supplier <> '' and created_by = ${user.id} group by supplier order by count(*) desc, supplier limit 200`;
    return rows.map((r) => r.supplier);
  });

  app.get('/api/costs/:id', { preHandler: requireRole() }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const [row] = await sql`select c.*, a.id as asset_id from costs c left join assets a on a.cost_id = c.id
      where c.id = ${id} and (${seesMoney(user)} or c.created_by = ${user.id})`;
    if (!row) throw notFound('Cost');
    return row;
  });

  app.post('/api/costs', { preHandler: requireRole('owner', 'capture') }, async (req) => {
    const user = userOrThrow(req);
    const input = user.role === 'owner' ? parse(costInput, req.body) : await limitCaptureCost(parse(costInput, req.body));
    await assertOpen(sql, input.date);
    const vat = await claimableVat(sql, input);
    const [row] = await sql`
      insert into costs ${sql({ ...input, vatCents: vat, projectId: input.projectId ?? null, receiptId: input.receiptId ?? null, plannedItemId: input.plannedItemId ?? null, createdBy: user.id })}
      returning *`;
    await audit(sql, { userId: user.id, action: 'create', entity: 'cost', entityId: row!.id, ip: req.ip });
    return row;
  });

  app.put('/api/costs/:id', { preHandler: requireRole('owner', 'capture') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const input = user.role === 'owner' ? parse(costInput, req.body) : await limitCaptureCost(parse(costInput, req.body));
    const [old] = await sql<{ date: string; createdBy: string | null; createdAt: Date }[]>`select date, created_by, created_at from costs where id = ${id}`;
    if (!old) throw notFound('Cost');
    if (user.role !== 'owner' && (old.createdBy !== user.id || Date.now() - old.createdAt.getTime() > 24 * 3600_000)) throw forbidden('Ask the owner to change this cost');
    await assertOpen(sql, old.date, input.date);
    const vat = await claimableVat(sql, input);
    // A bill with payments on it: still a bill, and never less than what's been paid.
    const [bill] = await sql<{ paid: number; sourceId: string | null }[]>`
      select coalesce(sum(bp.amount_cents), 0)::bigint as paid, c.source_id from costs c join bill_payments bp on bp.cost_id = c.id where c.id = ${id} group by c.source_id`;
    if (bill) {
      if (input.sourceId !== bill.sourceId) throw badRequest('This bill has payments recorded on it: it stays a bill. Delete the payments first to change how it was paid.');
      if (input.amountCents < Number(bill.paid)) throw badRequest(`R${(Number(bill.paid) / 100).toFixed(2)} has been paid on this bill: it can’t be less than that.`);
    }
    const row = await sql.begin(async (tx) => {
      const [r] = await tx`
        update costs set ${tx({ ...input, vatCents: vat, projectId: input.projectId ?? null, receiptId: input.receiptId ?? null, plannedItemId: input.plannedItemId ?? null })}
        where id = ${id} returning *`;
      // An asset bought through this cost keeps the cost's figure (ex VAT).
      await tx`update assets set cost_cents = ${input.amountCents - vat} where cost_id = ${id} and cost_cents <> ${input.amountCents - vat}`;
      return r;
    });
    await audit(sql, { userId: user.id, action: 'update', entity: 'cost', entityId: id, ip: req.ip });
    return row;
  });

  /**
   * One purchase paid more than one way (R650 cash and R650 by EFT): the cost becomes several,
   * one per payment, each saying which account paid it. Everything else (job, type, supplier,
   * slip) is the same on each part; VAT is shared out in proportion.
   */
  app.post('/api/costs/:id/split', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const { parts } = parse(
      z.object({ parts: z.array(z.object({ amountCents: z.number().int(), sourceId: z.string().uuid().nullable() })).min(2).max(10) }),
      req.body,
    );
    const [c] = await sql<{ date: string; amountCents: number; vatCents: number; note: string }[]>`
      select date::text, amount_cents, vat_cents, note from costs where id = ${id}`;
    if (!c) throw notFound('Cost');
    await assertOpen(sql, c.date);
    const total = parts.reduce((t, p) => t + p.amountCents, 0);
    if (total !== c.amountCents) throw badRequest(`The parts add up to R${(total / 100).toFixed(2)}, not R${(c.amountCents / 100).toFixed(2)}`);
    if (parts.some((p) => p.amountCents === 0 || Math.sign(p.amountCents) !== Math.sign(c.amountCents))) throw badRequest('Every part needs an amount');
    const [asset] = await sql`select 1 from assets where cost_id = ${id}`;
    if (asset) throw badRequest('This cost bought an asset, so it can’t be split');
    const [paid] = await sql`select 1 from bank_matches where kind = 'cost' and record_id = ${id}`;
    if (paid) throw badRequest('This cost is matched to a bank statement line. Unmatch it there first, then split it.');
    const sourceIds = [...new Set(parts.map((p) => p.sourceId).filter((x): x is string => Boolean(x)))];
    if (sourceIds.length) {
      const [found] = await sql<{ n: number }[]>`select count(*)::int as n from payment_sources where id = any(${sourceIds}::uuid[])`;
      if (found!.n !== sourceIds.length) throw badRequest('Choose where each part was paid from');
    }
    // VAT in proportion; the first part takes the rounding.
    const vats = parts.map((p) => Math.round((c.vatCents * p.amountCents) / c.amountCents));
    vats[0]! += c.vatCents - vats.reduce((t, v) => t + v, 0);
    const note = `Split from R${(c.amountCents / 100).toFixed(2)}, paid ${parts.length} ways`;
    const ids = await sql.begin(async (tx) => {
      await tx`update costs set amount_cents = ${parts[0]!.amountCents}, vat_cents = ${vats[0]!}, source_id = ${parts[0]!.sourceId},
          note = case when note = '' then ${note} else note || ' · ' || ${note} end
        where id = ${id}`;
      const out = [id];
      for (let i = 1; i < parts.length; i++) {
        const [r] = await tx<{ id: string }[]>`
          insert into costs (date, description, amount_cents, vat_cents, supplier, category_id, source_id, project_id, no_job, receipt_id, note, created_by)
          select date, description, ${parts[i]!.amountCents}, ${vats[i]!}, supplier, category_id, ${parts[i]!.sourceId}, project_id, no_job, receipt_id,
            case when note = '' then ${note} else note end, ${user.id}
          from costs where id = ${id} returning id`;
        out.push(r!.id);
      }
      await audit(tx, { userId: user.id, action: 'split', entity: 'cost', entityId: id, ip: req.ip, details: { parts: parts.map((p) => p.amountCents), ids: out } });
      return out;
    });
    return { ids };
  });

  app.delete('/api/costs/:id', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const [old] = await sql<{ date: string }[]>`select date from costs where id = ${id}`;
    if (!old) throw notFound('Cost');
    await assertOpen(sql, old.date);
    const [asset] = await sql`select 1 from assets where cost_id = ${id}`;
    if (asset) throw badRequest('This cost bought an asset: delete the asset first (Accounts → Assets).');
    const [paid] = await sql`select 1 from bill_payments where cost_id = ${id} limit 1`;
    if (paid) throw badRequest('This bill has payments recorded on it: delete those first (Bills), so the money that left the bank stays in the books until you do.');
    await sql.begin(async (tx) => {
      await tx`delete from costs where id = ${id}`;
      await audit(tx, { userId: user.id, action: 'delete', entity: 'cost', entityId: id, ip: req.ip });
    });
    return { ok: true };
  });

  /** Say which account or card paid a batch of costs that weren't captured yet. */
  app.post('/api/costs/assign-source', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const input = parse(assignSourceInput, req.body);
    const dates = await sql<{ date: string }[]>`select date from costs where id = any(${input.ids}::uuid[])`;
    await assertOpen(sql, ...dates.map((d) => d.date));
    const res = await sql`update costs set source_id = ${input.sourceId} where id = any(${input.ids}::uuid[])`;
    await audit(sql, { userId: user.id, action: 'assign_source', entity: 'cost', ip: req.ip, details: { count: res.count, sourceId: input.sourceId } });
    return { updated: res.count };
  });

  /** Helper for the phone: the VAT inside an amount at the company's rate. */
  app.get('/api/costs/vat-in', { preHandler: requireRole() }, async (req) => {
    const settings = await getSettings(sql);
    const amount = Number(q(req).amount ?? 0);
    return { vatCents: settings.vatRegistered ? vatIncluded(amount, settings.vatRateBp) : 0 };
  });
}
