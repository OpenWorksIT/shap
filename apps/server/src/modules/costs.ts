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
import { similar } from './bank/match.js';

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
    const { pairs, byHand } = parse(
      z.object({ pairs: z.array(z.object({ copyId: z.string().uuid(), originalId: z.string().uuid() })).min(1).max(1000), byHand: z.boolean().default(false) }),
      req.body,
    );
    let merged = 0;
    const failed: { copyId: string; reason: string }[] = [];
    await sql.begin(async (tx) => {
      for (const p of pairs) {
        const why = await mergeCosts(tx, p.copyId, p.originalId, byHand);
        if (why) failed.push({ copyId: p.copyId, reason: why });
        else merged++;
      }
      await audit(tx, { userId: user.id, action: 'merge_duplicates', entity: 'cost', ip: req.ip, details: { merged, failed: failed.length } });
    });
    return { merged, failed };
  });

  /** Costs that could be this one counted twice: about the same amount, within a fortnight. */
  app.get('/api/costs/:id/twins', { preHandler: requireRole('owner') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return sql`
      select o.id, o.date::text, o.amount_cents, o.description, o.supplier, k.name as category_name, s.name as source_name,
        o.project_id, p.name as project_name, p.number as project_number, o.note like 'From statement:%' as from_statement,
        exists (select 1 from bank_matches m where m.kind = 'cost' and m.record_id = o.id) as bank_matched
      from costs c join costs o on o.id <> c.id and abs(o.amount_cents - c.amount_cents) <= 100 and o.date between c.date - 14 and c.date + 14
      join cost_categories k on k.id = o.category_id left join payment_sources s on s.id = o.source_id left join projects p on p.id = o.project_id
      where c.id = ${id}
      order by (o.amount_cents = c.amount_cents) desc, abs(o.date - c.date), o.created_at limit 10`;
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

/**
 * Folds `copyId` into `originalId`: the original is kept (its job, type and slip), filled in
 * from the copy where it has nothing, and takes the copy's tie to the bank. Returns why not, or null.
 */
export async function mergeCosts(tx: Db, copyId: string, originalId: string, byHand = false): Promise<string | null> {
  if (copyId === originalId) return 'That’s the same cost';
  const [c] = await tx<{ id: string; date: string; amountCents: number; sourceId: string | null; projectId: string | null; receiptId: string | null; supplier: string }[]>`
    select id, date::text, amount_cents, source_id, project_id, receipt_id, supplier from costs where id = ${copyId}`;
  const [o] = await tx<{ id: string; date: string; amountCents: number; projectId: string | null; receiptId: string | null; supplier: string }[]>`
    select id, date::text, amount_cents, project_id, receipt_id, supplier from costs where id = ${originalId}`;
  if (!c || !o) return 'One of them was already deleted';
  if (Math.abs(c.amountCents - o.amountCents) > 100) return 'The amounts differ by more than R1';
  const [asset] = await tx`select 1 from assets where cost_id = ${c.id}`;
  if (asset) return 'The one to remove is an asset purchase';
  await assertOpen(tx, c.date, o.date);
  type L = { id: string; statementId: string; sourceId: string; date: string; amountCents: number; others: number };
  const lines = (costId: string) => tx<L[]>`
    select l.id, l.statement_id, l.source_id, l.date::text, l.amount_cents,
      (select count(*)::int from bank_matches x where x.bank_line_id = l.id and x.record_id <> ${costId}) as others
    from bank_matches m join bank_lines l on l.id = m.bank_line_id where m.kind = 'cost' and m.record_id = ${costId}`;
  const [cl, ol] = [await lines(c.id), await lines(o.id)];
  let note = '';
  if (cl.length && !ol.length) {
    // The usual case: the statement paid the one you captured.
    await tx`update bank_matches set record_id = ${o.id} where kind = 'cost' and record_id = ${c.id}`;
    if (o.amountCents !== c.amountCents) note = `Rounded by R${((c.amountCents - o.amountCents) / 100).toFixed(2)} to match the statement`;
    await tx`update costs set source_id = ${c.sourceId}, amount_cents = ${c.amountCents} where id = ${o.id}`;
  } else if (cl.length && ol.length) {
    // Both tied to the bank: fine only if it's one transaction imported twice (in two different statement files).
    const importedTwice = cl.every(
      (a) => !a.others && ol.some((b) => b.id !== a.id && b.statementId !== a.statementId && b.sourceId === a.sourceId && b.amountCents === a.amountCents && b.date === a.date),
    );
    if (importedTwice) await tx`delete from bank_lines where id = any(${cl.map((a) => a.id)}::uuid[])`;
    // You say they're one purchase: the copy's statement line goes back on the to-do list to check.
    else if (byHand) await tx`delete from bank_matches where kind = 'cost' and record_id = ${c.id}`;
    else return 'The bank shows these as two separate payments';
  }
  await tx`update costs set
      project_id = coalesce(project_id, ${c.projectId}::uuid),
      no_job = case when project_id is null and ${c.projectId}::uuid is not null then false else no_job end,
      receipt_id = coalesce(receipt_id, ${c.receiptId}::uuid),
      supplier = case when supplier = '' then ${c.supplier} else supplier end,
      note = case when ${note} = '' then note when note = '' then ${note} else note || ' · ' || ${note} end
    where id = ${o.id}`;
  await tx`delete from costs where id = ${c.id}`;
  return null;
}

type DupRow = {
  copyId: string; date: string; amountCents: number; description: string; supplier: string; note: string; copySource: string | null; copyCategory: string;
  originalId: string; originalDate: string; originalAmountCents: number; originalDescription: string; originalSupplier: string;
  originalSource: string | null; originalCategory: string; projectId: string | null; projectName: string | null; projectNumber: number | null;
};

/**
 * Statement copies of a cost already captured: about the same amount, a few days apart, and
 * the same supplier by name. Same day and exact amount but different names is listed as
 * "check" (not likely). Amount alone is never enough: plenty of things cost R300.
 */
export async function findDuplicates(db: Db) {
  const rows = await db<DupRow[]>`
    select s.id as copy_id, s.date::text, s.amount_cents, s.description, s.supplier, s.note, ss.name as copy_source, sk.name as copy_category,
      o.id as original_id, o.date::text as original_date, o.amount_cents as original_amount_cents, o.description as original_description,
      o.supplier as original_supplier, os.name as original_source, ok.name as original_category,
      o.project_id, p.name as project_name, p.number as project_number
    from costs s
    join cost_categories sk on sk.id = s.category_id
    left join payment_sources ss on ss.id = s.source_id
    join costs o on o.id <> s.id and abs(o.amount_cents - s.amount_cents) <= 100 and o.date between (s.date - 12) and (s.date + 5)
      and o.note not like 'From statement:%'
      and (
        not exists (select 1 from bank_matches m2 where m2.kind = 'cost' and m2.record_id = o.id)
        or not exists (select 1 from bank_matches m3 where m3.kind = 'cost' and m3.record_id = s.id)
        or exists (
          select 1 from bank_matches ms join bank_lines ls on ls.id = ms.bank_line_id
          join bank_matches mo on mo.kind = 'cost' and mo.record_id = o.id join bank_lines lo on lo.id = mo.bank_line_id
          where ms.kind = 'cost' and ms.record_id = s.id and lo.id <> ls.id and lo.source_id = ls.source_id
            and lo.statement_id <> ls.statement_id and lo.amount_cents = ls.amount_cents and lo.date = ls.date))
    join cost_categories ok on ok.id = o.category_id
    left join payment_sources os on os.id = o.source_id
    left join projects p on p.id = o.project_id
    where s.note like 'From statement:%' and not exists (select 1 from assets a where a.cost_id = s.id)
    order by s.date desc`;
  const scored = rows
    .map((r) => {
      const said = `${r.note.replace(/^From statement:\s*/, '').split(' · ')[0]} ${r.description} ${r.supplier}`;
      const named = similar(said, r.originalSupplier) || similar(said, r.originalDescription) || similar(`${r.originalSupplier} ${r.originalDescription}`, r.supplier);
      const sameDay = r.date === r.originalDate && r.amountCents === r.originalAmountCents;
      const dayGap = Math.abs(Date.parse(r.date) - Date.parse(r.originalDate)) / 864e5;
      return { ...r, likely: named, score: (named ? 100 : 0) + (sameDay ? 20 : 0) + (r.amountCents === r.originalAmountCents ? 10 : 0) + (r.projectId ? 5 : 0) - dayGap };
    })
    .filter((r) => r.likely || r.date === r.originalDate)
    .sort((a, b) => b.score - a.score);
  // Each copy and each captured cost in one pair only, the best first.
  const usedCopy = new Set<string>();
  const usedOrig = new Set<string>();
  const out = [];
  for (const r of scored) {
    if (usedCopy.has(r.copyId) || usedOrig.has(r.originalId)) continue;
    usedCopy.add(r.copyId);
    usedOrig.add(r.originalId);
    const { note: _n, score: _s, ...rest } = r;
    out.push(rest);
  }
  return out.sort((a, b) => (a.likely === b.likely ? b.date.localeCompare(a.date) : a.likely ? -1 : 1));
}
