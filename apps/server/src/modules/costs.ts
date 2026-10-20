import type { FastifyInstance } from 'fastify';
import { assignSourceInput, costInput, vatIncluded } from '@shap/shared';
import { z } from 'zod';
import { requireRole, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { assertOpen, getSettings, isIsoDate, q } from '../lib/books.js';
import { forbidden, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

const idParam = z.object({ id: z.string().uuid() });

export function registerCostRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;

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

  /**
   * Costs added from a bank statement that look like a cost already captured (same amount,
   * give or take rounding, within a fortnight, not itself matched to the bank): the same
   * purchase counted twice. Merging keeps the captured one (its job, type and slip) and ties it
   * to the statement line instead.
   */
  app.get('/api/costs/duplicates', { preHandler: requireRole('owner', 'accountant') }, async () => findDuplicates(sql));

  app.post('/api/costs/merge', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { pairs } = parse(z.object({ pairs: z.array(z.object({ copyId: z.string().uuid(), originalId: z.string().uuid() })).min(1).max(1000) }), req.body);
    let merged = 0;
    await sql.begin(async (tx) => {
      for (const p of pairs) {
        const [c] = await tx<{ id: string; date: string; amountCents: number; sourceId: string | null; note: string }[]>`
          select c.id, c.date::text, c.amount_cents, c.source_id, c.note from costs c
          where c.id = ${p.copyId} and c.note like 'From statement:%'
            and exists (select 1 from bank_matches m where m.kind = 'cost' and m.record_id = c.id)
            and not exists (select 1 from assets a where a.cost_id = c.id)`;
        const [o] = await tx<{ id: string; date: string; amountCents: number }[]>`
          select o.id, o.date::text, o.amount_cents from costs o where o.id = ${p.originalId} and o.id <> ${p.copyId}
            and not exists (select 1 from bank_matches m where m.kind = 'cost' and m.record_id = o.id)`;
        if (!c || !o || Math.abs(c.amountCents - o.amountCents) > 100) continue;
        await assertOpen(tx, c.date, o.date);
        await tx`update bank_matches set record_id = ${o.id} where kind = 'cost' and record_id = ${c.id}`;
        const note = o.amountCents === c.amountCents ? '' : `Rounded by R${((c.amountCents - o.amountCents) / 100).toFixed(2)} to match the statement`;
        await tx`update costs set source_id = ${c.sourceId}, amount_cents = ${c.amountCents},
          note = case when ${note} = '' then note when note = '' then ${note} else note || ' · ' || ${note} end where id = ${o.id}`;
        await tx`delete from costs where id = ${c.id}`;
        merged++;
      }
      await audit(tx, { userId: user.id, action: 'merge_duplicates', entity: 'cost', ip: req.ip, details: { merged } });
    });
    return { merged };
  });

  /** Suppliers you've used, most used first, for the picker on the phone. */
  app.get('/api/costs/suppliers', { preHandler: requireRole() }, async () => {
    const rows = await sql<{ supplier: string }[]>`
      select supplier from costs where supplier <> '' group by supplier order by count(*) desc, supplier limit 200`;
    return rows.map((r) => r.supplier);
  });

  app.get('/api/costs/:id', { preHandler: requireRole() }, async (req) => {
    const { id } = parse(idParam, req.params);
    const [row] = await sql`select c.*, a.id as asset_id from costs c left join assets a on a.cost_id = c.id where c.id = ${id}`;
    if (!row) throw notFound('Cost');
    return row;
  });

  app.post('/api/costs', { preHandler: requireRole('owner', 'capture') }, async (req) => {
    const user = userOrThrow(req);
    const input = parse(costInput, req.body);
    await assertOpen(sql, input.date);
    const settings = await getSettings(sql);
    // Not a VAT vendor: no input VAT to claim, whatever the slip says.
    const vat = settings.vatRegistered ? input.vatCents : 0;
    const [row] = await sql`
      insert into costs ${sql({ ...input, vatCents: vat, projectId: input.projectId ?? null, receiptId: input.receiptId ?? null, plannedItemId: input.plannedItemId ?? null, createdBy: user.id })}
      returning *`;
    await audit(sql, { userId: user.id, action: 'create', entity: 'cost', entityId: row!.id, ip: req.ip });
    return row;
  });

  app.put('/api/costs/:id', { preHandler: requireRole('owner', 'capture') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const input = parse(costInput, req.body);
    const [old] = await sql<{ date: string; createdBy: string | null; createdAt: Date }[]>`select date, created_by, created_at from costs where id = ${id}`;
    if (!old) throw notFound('Cost');
    if (user.role !== 'owner' && (old.createdBy !== user.id || Date.now() - old.createdAt.getTime() > 24 * 3600_000)) throw forbidden('Ask the owner to change this cost');
    await assertOpen(sql, old.date, input.date);
    const settings = await getSettings(sql);
    const vat = settings.vatRegistered ? input.vatCents : 0;
    const [row] = await sql`
      update costs set ${sql({ ...input, vatCents: vat, projectId: input.projectId ?? null, receiptId: input.receiptId ?? null, plannedItemId: input.plannedItemId ?? null })}
      where id = ${id} returning *`;
    await audit(sql, { userId: user.id, action: 'update', entity: 'cost', entityId: id, ip: req.ip });
    return row;
  });

  app.delete('/api/costs/:id', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const [old] = await sql<{ date: string }[]>`select date from costs where id = ${id}`;
    if (!old) throw notFound('Cost');
    await assertOpen(sql, old.date);
    await sql.begin(async (tx) => {
      await tx`update assets set cost_id = null, source_id = coalesce(source_id, (select source_id from costs where id = ${id})) where cost_id = ${id}`;
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

export async function findDuplicates(db: Db) {
  const rows = await db<
    {
      copyId: string; date: string; amountCents: number; description: string; supplier: string; copySource: string | null; copyCategory: string;
      originalId: string; originalDate: string; originalAmountCents: number; originalDescription: string; originalSupplier: string;
      originalSource: string | null; originalCategory: string; projectId: string | null; projectName: string | null; projectNumber: number | null;
    }[]
  >`
    select s.id as copy_id, s.date::text, s.amount_cents, s.description, s.supplier, ss.name as copy_source, sk.name as copy_category,
      o.id as original_id, o.date::text as original_date, o.amount_cents as original_amount_cents, o.description as original_description,
      o.supplier as original_supplier, os.name as original_source, ok.name as original_category,
      o.project_id, p.name as project_name, p.number as project_number
    from costs s
    join cost_categories sk on sk.id = s.category_id
    left join payment_sources ss on ss.id = s.source_id
    join lateral (
      select o.* from costs o
      where o.id <> s.id and abs(o.amount_cents - s.amount_cents) <= 100 and o.date between (s.date - 12) and (s.date + 5)
        and o.note not like 'From statement:%'
        and not exists (select 1 from bank_matches m2 where m2.kind = 'cost' and m2.record_id = o.id)
      order by (o.amount_cents = s.amount_cents) desc, (o.project_id is not null) desc, abs(o.date - s.date), o.created_at
      limit 1
    ) o on true
    join cost_categories ok on ok.id = o.category_id
    left join payment_sources os on os.id = o.source_id
    left join projects p on p.id = o.project_id
    where s.note like 'From statement:%' and exists (select 1 from bank_matches m where m.kind = 'cost' and m.record_id = s.id)
    order by s.date desc`;
  // One copy per captured cost.
  const used = new Set<string>();
  return rows.filter((r) => (used.has(r.originalId) ? false : (used.add(r.originalId), true)));
}
