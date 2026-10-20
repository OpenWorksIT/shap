/**
 * Costs counted twice, and putting them right (or back).
 *
 * Two ways a purchase ends up in the books twice, both through bank statements:
 *  1. Imported twice: the same statement line (same date, amount and description) came in
 *     twice, in two statement files (often one of them under the wrong account), and each copy
 *     was matched to or turned into a cost.
 *  2. Captured, then added from a statement: you captured the slip, and the statement line was
 *     added as a new cost instead of being matched to it.
 * Two costs you captured yourself are never paired automatically: the same shop sells many
 * things at nearly the same price. Open a cost to compare it with others by hand.
 *
 * Every merge is recorded in cost_merges with what it changed, so it can be undone.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { assertOpen } from '../lib/books.js';
import { badRequest, HttpError, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { similar } from './bank/match.js';

const FROM_STATEMENT = 'From statement:%';
/** A statement line's description with only letters and digits, for "the same transaction". */
const norm = (a: string) => `lower(regexp_replace(${a}.description, '[^A-Za-z0-9]+', '', 'g'))`;
/** Which of two costs to keep: the one on a job, then one you captured, then one with a slip. */
const rank = (a: string) =>
  `((case when ${a}.project_id is not null then 8 else 0 end) + (case when ${a}.note not like '${FROM_STATEMENT}' then 4 else 0 end) + (case when ${a}.receipt_id is not null then 2 else 0 end))`;
const removable = (a: string) => `not exists (select 1 from assets x where x.cost_id = ${a}.id)`;

export interface Duplicate {
  kind: 'imported_twice' | 'captured_twice';
  removeId: string;
  date: string;
  amountCents: number;
  description: string;
  supplier: string;
  category: string;
  source: string | null;
  projectName: string | null;
  projectNumber: number | null;
  fromStatement: boolean;
  /** Where the removed cost's statement line is (imported twice: the copy of the line goes too). */
  lineAccount: string | null;
  keepId: string | null;
  keepDate: string | null;
  keepAmountCents: number | null;
  keepDescription: string;
  keepSupplier: string;
  keepCategory: string | null;
  keepSource: string | null;
  keepProjectId: string | null;
  keepProjectName: string | null;
  keepProjectNumber: number | null;
  keepLineAccount: string | null;
}

const COST_COLS = (a: string, p: string) => `${a}.id as ${p}id, ${a}.date::text as ${p}date, ${a}.amount_cents as ${p}amount_cents,
  ${a}.description as ${p}description, ${a}.supplier as ${p}supplier, ${a}.note as ${p}note,
  (select xk.name from cost_categories xk where xk.id = ${a}.category_id) as ${p}category,
  (select xs.name from payment_sources xs where xs.id = ${a}.source_id) as ${p}source,
  ${a}.project_id as ${p}project_id, (select xp.name from projects xp where xp.id = ${a}.project_id) as ${p}project_name,
  (select xp.number from projects xp where xp.id = ${a}.project_id) as ${p}project_number`;
const ACCOUNT = (line: string) => `(select xs.name from payment_sources xs where xs.id = ${line}.source_id)`;

type Row = Record<string, unknown>;

export async function findDuplicates(db: Db): Promise<Duplicate[]> {
  // 1. The same line imported twice, each copy tied to one cost.
  const twice = (await db.unsafe(`
    select ${COST_COLS('a', 'r_')}, ${ACCOUNT('la')} as r_line_account,
      ${COST_COLS('b', 'k_')}, ${ACCOUNT('lb')} as k_line_account
    from bank_lines la
    join bank_lines lb on lb.date = la.date and lb.amount_cents = la.amount_cents and lb.id <> la.id
      and lb.statement_id <> la.statement_id and ${norm('lb')} = ${norm('la')}
    join bank_matches ma on ma.bank_line_id = la.id and ma.kind = 'cost'
    join costs a on a.id = ma.record_id
    join bank_matches mb on mb.bank_line_id = lb.id and mb.kind = 'cost'
    join costs b on b.id = mb.record_id
    where a.id <> b.id and ${removable('a')}
      and (select count(*) from bank_matches x where x.bank_line_id = la.id) = 1
      and (select count(*) from bank_matches x where x.bank_line_id = lb.id) = 1
      and (${rank('b')} > ${rank('a')} or (${rank('b')} = ${rank('a')} and (b.created_at, b.id) < (a.created_at, a.id)))
    order by la.date desc`)) as unknown as Row[];

  // 1b. The same line imported twice, the other copy paid for by something else (a slip captured
  //     item by item, wages): the cost added from this copy goes, nothing to fold it into.
  const lone = (await db.unsafe(`
    select distinct on (a.id) ${COST_COLS('a', 'r_')}, ${ACCOUNT('la')} as r_line_account,
      ${ACCOUNT('lb')} as k_line_account,
      lb.description as k_description
    from bank_lines la
    join bank_lines lb on lb.date = la.date and lb.amount_cents = la.amount_cents and lb.id <> la.id
      and lb.statement_id <> la.statement_id and ${norm('lb')} = ${norm('la')}
    join bank_matches ma on ma.bank_line_id = la.id and ma.kind = 'cost'
    join costs a on a.id = ma.record_id
    where a.note like '${FROM_STATEMENT}' and ${removable('a')}
      and (select count(*) from bank_matches x where x.bank_line_id = la.id) = 1
      and exists (select 1 from bank_matches x where x.bank_line_id = lb.id)
      and not (exists (select 1 from bank_matches x where x.bank_line_id = lb.id and x.kind = 'cost')
               and (select count(*) from bank_matches x where x.bank_line_id = lb.id) = 1)
    order by a.id`)) as unknown as Row[];

  // 2. Captured, then the statement line added as a new cost instead of matched to it.
  const captured = (await db.unsafe(`
    select ${COST_COLS('s', 'r_')}, (select xs.name from payment_sources xs join bank_lines xl on xl.source_id = xs.id
        join bank_matches xm on xm.bank_line_id = xl.id where xm.kind = 'cost' and xm.record_id = s.id limit 1) as r_line_account,
      ${COST_COLS('o', 'k_')}, null as k_line_account
    from costs s
    join costs o on o.amount_cents between s.amount_cents - 100 and s.amount_cents + 100
      and o.date between s.date - 12 and s.date + 5 and o.id <> s.id
    where s.note like '${FROM_STATEMENT}' and o.note not like '${FROM_STATEMENT}' and ${removable('s')}
      and (o.amount_cents = s.amount_cents or abs(o.amount_cents - s.amount_cents) * 100 <= abs(s.amount_cents))
      and (s.project_id is null or s.project_id = o.project_id)
      and not exists (select 1 from bank_matches m where m.kind = 'cost' and m.record_id = o.id)`)) as unknown as Row[];

  const used = new Set<string>();
  const out: Duplicate[] = [];
  const take = (r: Row, kind: Duplicate['kind'], keep: boolean) => {
    const removeId = r.rId as string;
    const keepId = keep ? (r.kId as string) : null;
    if (used.has(removeId) || (keepId && used.has(keepId))) return;
    used.add(removeId);
    if (keepId) used.add(keepId);
    out.push({
      kind,
      removeId,
      date: r.rDate as string,
      amountCents: Number(r.rAmountCents),
      description: r.rDescription as string,
      supplier: r.rSupplier as string,
      category: r.rCategory as string,
      source: (r.rSource as string) ?? null,
      projectName: (r.rProjectName as string) ?? null,
      projectNumber: (r.rProjectNumber as number) ?? null,
      fromStatement: String(r.rNote).startsWith('From statement:'),
      lineAccount: (r.rLineAccount as string) ?? null,
      keepId,
      keepDate: keep ? (r.kDate as string) : null,
      keepAmountCents: keep ? Number(r.kAmountCents) : null,
      keepDescription: (r.kDescription as string) ?? '',
      keepSupplier: keep ? (r.kSupplier as string) : '',
      keepCategory: keep ? (r.kCategory as string) : null,
      keepSource: keep ? ((r.kSource as string) ?? null) : null,
      keepProjectId: keep ? ((r.kProjectId as string) ?? null) : null,
      keepProjectName: keep ? ((r.kProjectName as string) ?? null) : null,
      keepProjectNumber: keep ? ((r.kProjectNumber as number) ?? null) : null,
      keepLineAccount: (r.kLineAccount as string) ?? null,
    });
  };
  for (const r of twice) take(r, 'imported_twice', true);
  for (const r of lone) take(r, 'imported_twice', false);
  // Captured twice needs the supplier to match by name, and the closest one wins.
  const statementText = (r: Row) => `${String(r.rNote).replace(/^From statement:\s*/, '').split(' · ')[0]} ${r.rDescription} ${r.rSupplier}`;
  const named = captured
    .filter((r) => {
      const said = statementText(r);
      return similar(said, r.kSupplier as string) || similar(said, r.kDescription as string);
    })
    .sort(
      (x, y) =>
        Number(y.kAmountCents === y.rAmountCents) - Number(x.kAmountCents === x.rAmountCents) ||
        Math.abs(Date.parse(x.rDate as string) - Date.parse(x.kDate as string)) - Math.abs(Date.parse(y.rDate as string) - Date.parse(y.kDate as string)),
    );
  for (const r of named) take(r, 'captured_twice', true);
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

const SAME_LINE = (t: string, l: string) => `${t}.id <> ${l}.id and ${t}.statement_id <> ${l}.statement_id and ${t}.date = ${l}.date
  and ${t}.amount_cents = ${l}.amount_cents and ${norm(t)} = ${norm(l)}`;

/**
 * Removes `removeId`, folding it into `keepId` (kept: its job, type and slip; filled in from the
 * removed one where it has nothing; it takes over the removed one's tie to the bank). With no
 * cost to keep, only a cost added from a line imported twice can go. Returns why not, or null.
 * What it changes is recorded first (in SQL, so the snapshot is exact) for undoMerge.
 */
export async function mergeCosts(tx: Db, removeId: string, keepId: string | null, opts: { byHand?: boolean; userId?: string | null } = {}): Promise<string | null> {
  if (removeId === keepId) return 'That’s the same cost';
  const [c] = await tx<{ date: string; amountCents: number; sourceId: string | null; projectId: string | null; receiptId: string | null; plannedItemId: string | null; supplier: string; note: string }[]>`
    select date::text, amount_cents, source_id, project_id, receipt_id, planned_item_id, supplier, note from costs where id = ${removeId}`;
  if (!c) return 'It was already removed';
  const [asset] = await tx`select 1 from assets where cost_id = ${removeId}`;
  if (asset) return 'The one to remove is an asset purchase';
  const [o] = keepId ? await tx<{ date: string; amountCents: number }[]>`select date::text, amount_cents from costs where id = ${keepId}` : [];
  if (keepId && !o) return 'The one to keep was deleted';
  if (o && Math.abs(c.amountCents - o.amountCents) > 100) return 'The amounts differ by more than R1';
  await assertOpen(tx, c.date, ...(o ? [o.date] : []));

  const lines = await tx.unsafe(
    `select l.id,
       (select count(*)::int from bank_matches x where x.bank_line_id = l.id and not (x.kind = 'cost' and x.record_id = $1)) as others,
       exists (select 1 from bank_lines t join bank_matches tm on tm.bank_line_id = t.id where ${SAME_LINE('t', 'l')}) as twin_paid,
       exists (select 1 from bank_lines t join bank_matches tm on tm.bank_line_id = t.id and tm.kind = 'cost' and tm.record_id = $2::uuid
         where ${SAME_LINE('t', 'l')}) as twin_of_kept
     from bank_matches m join bank_lines l on l.id = m.bank_line_id where m.kind = 'cost' and m.record_id = $1`,
    [removeId, keepId],
  ) as unknown as { id: string; others: number; twinPaid: boolean; twinOfKept: boolean }[];
  const [keptPaid] = keepId ? await tx`select 1 from bank_matches where kind = 'cost' and record_id = ${keepId}` : [];

  // Decide first, change nothing yet.
  let action: 'none' | 'move' | 'drop' | 'unmatch' = 'none';
  if (!keepId) {
    if (!c.note.startsWith('From statement:') || !lines.length || lines.some((l) => !l.twinPaid || l.others)) {
      return 'Only a cost added from a statement line that was imported twice can go without one to keep';
    }
    action = 'drop';
  } else if (lines.length && !keptPaid) action = 'move';
  else if (lines.length) {
    if (lines.every((l) => l.twinOfKept && !l.others)) action = 'drop';
    else if (opts.byHand) action = 'unmatch';
    else return 'The bank shows these as two separate payments';
  }
  const dropIds = action === 'drop' ? lines.map((l) => l.id) : [];

  // The record to undo from, taken before anything changes.
  await tx`
    insert into cost_merges (user_id, kept_id, removed, kept_before, matches, lines)
    select ${opts.userId ?? null}, ${keepId}::uuid,
      (select to_jsonb(c) from costs c where c.id = ${removeId}),
      (select to_jsonb(k) from costs k where k.id = ${keepId}::uuid),
      coalesce((select jsonb_agg(to_jsonb(m)) from bank_matches m where m.kind = 'cost' and m.record_id = ${removeId}), '[]'),
      coalesce((select jsonb_agg(to_jsonb(l)) from bank_lines l where l.id = any(${dropIds}::uuid[])), '[]')`;

  let note = '';
  if (action === 'move') {
    // The usual case: the statement paid for the one you captured.
    // The tie moves over, remembering the kept cost's own account and amount so unmatching restores them.
    await tx`update bank_matches m set record_id = ${keepId}, source_changed = k.source_id is distinct from ${c.sourceId}::uuid,
        prev_source_id = k.source_id, prev_amount_cents = case when k.amount_cents <> ${c.amountCents} then k.amount_cents end,
        prev_note = case when k.amount_cents <> ${c.amountCents} then k.note end
      from costs k where k.id = ${keepId} and m.kind = 'cost' and m.record_id = ${removeId}`;
    if (o!.amountCents !== c.amountCents) note = `Rounded by R${((c.amountCents - o!.amountCents) / 100).toFixed(2)} to match the statement`;
    await tx`update costs set source_id = ${c.sourceId}, amount_cents = ${c.amountCents} where id = ${keepId}`;
  } else if (action === 'unmatch') {
    // You say they're one purchase: the removed one's statement line goes back on the to-do list.
    await tx`delete from bank_matches where kind = 'cost' and record_id = ${removeId}`;
  } else if (action === 'drop') {
    // That statement line was imported twice: this copy of it goes too.
    await tx`delete from bank_lines where id = any(${dropIds}::uuid[])`;
  }
  if (keepId) {
    await tx`update costs set
        project_id = coalesce(project_id, ${c.projectId}::uuid),
        no_job = case when project_id is null and ${c.projectId}::uuid is not null then false else no_job end,
        receipt_id = coalesce(receipt_id, ${c.receiptId}::uuid),
        planned_item_id = coalesce(planned_item_id, ${c.plannedItemId}::uuid),
        supplier = case when supplier = '' then ${c.supplier} else supplier end,
        note = case when ${note} = '' then note when note = '' then ${note} else note || ' · ' || ${note} end
      where id = ${keepId}`;
  }
  await tx`delete from costs where id = ${removeId}`;
  return null;
}

/** Puts a merge back: the removed cost, its ties to the bank, any statement lines dropped, and the kept cost as it was. */
export async function undoMerge(tx: Db, id: string): Promise<void> {
  const [m] = await tx<{ keptId: string | null; removedId: string; removedDate: string; undoneAt: string | null }[]>`
    select kept_id, removed->>'id' as removed_id, removed->>'date' as removed_date, undone_at from cost_merges where id = ${id} for update`;
  if (!m) throw notFound('Merge');
  if (m.undoneAt) throw badRequest('That merge was already undone');
  const [back] = await tx`select 1 from costs where id = ${m.removedId}`;
  if (back) throw badRequest('That cost is already back');
  await assertOpen(tx, m.removedDate);
  if (m.keptId) {
    const [k] = await tx`select 1 from costs where id = ${m.keptId}`;
    if (!k) throw badRequest('The cost that was kept has since been deleted, so this can’t be undone');
  }
  // Statement lines dropped as imported twice come back (unless the same line was imported again since).
  const [clash] = await tx`
    select 1 from cost_merges cm cross join jsonb_populate_recordset(null::bank_lines, cm.lines) d
    join bank_lines l on l.id = d.id or (l.source_id = d.source_id and l.fingerprint = d.fingerprint)
    where cm.id = ${id} limit 1`;
  if (clash) throw badRequest('A statement line it removed has been imported again since, so this can’t be undone');
  await tx`insert into bank_lines select d.* from cost_merges cm cross join jsonb_populate_recordset(null::bank_lines, cm.lines) d where cm.id = ${id}`;
  await tx`insert into costs select d.* from cost_merges cm cross join jsonb_populate_record(null::costs, cm.removed) d where cm.id = ${id}`;
  if (m.keptId) {
    await tx`
      update costs c set amount_cents = k.amount_cents, source_id = k.source_id, project_id = k.project_id, no_job = k.no_job,
        receipt_id = k.receipt_id, planned_item_id = k.planned_item_id, supplier = k.supplier, note = k.note
      from cost_merges cm cross join jsonb_populate_record(null::costs, cm.kept_before) k
      where cm.id = ${id} and c.id = cm.kept_id`;
  }
  const lineIds = await tx<{ lineId: string }[]>`
    select d.bank_line_id as line_id from cost_merges cm cross join jsonb_populate_recordset(null::bank_matches, cm.matches) d where cm.id = ${id}`;
  for (const { lineId } of lineIds) {
    // A tie that moved to the kept cost moves back; otherwise the line must still be free.
    if (m.keptId) await tx`delete from bank_matches where kind = 'cost' and record_id = ${m.keptId} and bank_line_id = ${lineId}`;
    const [taken] = await tx`select 1 from bank_matches where bank_line_id = ${lineId}`;
    if (taken) throw badRequest('A statement line it was tied to has been matched to something else since, so this can’t be undone');
    await tx`insert into bank_matches select d.* from cost_merges cm cross join jsonb_populate_recordset(null::bank_matches, cm.matches) d
      where cm.id = ${id} and d.bank_line_id = ${lineId}`;
  }
  await tx`update cost_merges set undone_at = now() where id = ${id}`;
}

export function registerDuplicateRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;
  const uuid = z.string().uuid();

  app.get('/api/costs/duplicates', { preHandler: requireRole('owner', 'accountant') }, async () => findDuplicates(sql));

  app.post('/api/costs/merge', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { pairs, byHand } = parse(
      z.object({ pairs: z.array(z.object({ removeId: uuid, keepId: uuid.nullable() })).min(1).max(1000), byHand: z.boolean().default(false) }),
      req.body,
    );
    const results: { removeId: string; ok: boolean; reason?: string }[] = [];
    await sql.begin(async (tx) => {
      for (const p of pairs) {
        // Each on its own, so one that can't be merged doesn't hold back the rest.
        const why = await tx.savepoint(async (sp) => {
          const r = await mergeCosts(sp, p.removeId, p.keepId, { byHand, userId: user.id });
          if (r) throw new Skip(r);
          return null;
        }).catch((err) => {
          // Can't be merged (or in the closed period): say why on that one, carry on with the rest.
          if (err instanceof Skip || err instanceof HttpError) return err.message;
          throw err;
        });
        results.push(why ? { removeId: p.removeId, ok: false, reason: why } : { removeId: p.removeId, ok: true });
      }
      const merged = results.filter((r) => r.ok).length;
      await audit(tx, { userId: user.id, action: 'merge_duplicates', entity: 'cost', ip: req.ip, details: { merged, failed: results.length - merged, removed: results.filter((r) => r.ok).map((r) => r.removeId) } });
    });
    return { merged: results.filter((r) => r.ok).length, results };
  });

  app.get('/api/costs/merges', { preHandler: requireRole('owner', 'accountant') }, async () => {
    return sql`
      select m.id, m.at, m.undone_at, m.kept_id, m.removed->>'date' as date, (m.removed->>'amount_cents')::bigint as amount_cents,
        m.removed->>'description' as description, m.removed->>'supplier' as supplier, jsonb_array_length(m.lines) as lines_dropped,
        k.description as kept_description, k.date::text as kept_date, p.number as kept_project_number, p.name as kept_project_name
      from cost_merges m left join costs k on k.id = m.kept_id left join projects p on p.id = k.project_id
      order by m.at desc limit 300`;
  });

  app.post('/api/costs/merges/:id/undo', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    await sql.begin(async (tx) => {
      await undoMerge(tx, id);
      await audit(tx, { userId: user.id, action: 'undo_merge', entity: 'cost', entityId: id, ip: req.ip });
    });
    return { ok: true };
  });

  /** Costs that could be this one counted twice: about the same amount, within a fortnight. */
  app.get('/api/costs/:id/twins', { preHandler: requireRole('owner') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    return sql`
      select o.id, o.date::text, o.amount_cents, o.description, o.supplier, k.name as category_name, s.name as source_name,
        o.project_id, p.name as project_name, p.number as project_number, o.note like 'From statement:%' as from_statement,
        exists (select 1 from bank_matches m where m.kind = 'cost' and m.record_id = o.id) as bank_matched
      from costs c join costs o on o.id <> c.id and abs(o.amount_cents - c.amount_cents) <= 100 and o.date between c.date - 14 and c.date + 14
      join cost_categories k on k.id = o.category_id left join payment_sources s on s.id = o.source_id left join projects p on p.id = o.project_id
      where c.id = ${id}
      order by (o.amount_cents = c.amount_cents) desc, abs(o.date - c.date), o.created_at limit 10`;
  });
}

class Skip extends Error {}
