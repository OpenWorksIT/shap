import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, userOrThrow } from '../../auth.js';
import type { Ctx } from '../../context.js';
import type { Db } from '../../db/index.js';
import { audit } from '../../lib/audit.js';
import { assertOpen, q } from '../../lib/books.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { depositDueSql, syncProjectOfDocument } from '../documents.js';
import { guessCategory, guessIncome, similar, suggestMatches, supplierFrom, type Suggestion } from './match.js';

/** By hand, a match may be out by up to R1 (a supplier's or bank's rounding); the largest item takes the difference. */
const HAND_ROUNDING_CENTS = 100;
import { fingerprints, parseStatementCsv } from './parse.js';

const uuid = z.string().uuid();
const KINDS = ['cost', 'receipt', 'wage_payment', 'journal'] as const;
type Kind = (typeof KINDS)[number];

interface LineRow {
  id: string;
  statementId: string;
  sourceId: string;
  date: string;
  description: string;
  amountCents: number;
  balanceCents: number | null;
  ignored: boolean;
}

/**
 * Like the lock date, but a cost that was never matched to a payment can still be matched
 * inside an agreed year: the accountant's figures pin that year's statements either way.
 */
async function assertCanChange(db: Db, dates: string[]) {
  const [s] = await db<{ lockDate: string | null }[]>`select lock_date from settings where id`;
  if (!s?.lockDate) return;
  for (const d of dates) {
    if (d > s.lockDate) continue;
    const [agreed] = await db`select 1 from year_ends where fy_end >= ${d}::date limit 1`;
    if (!agreed) await assertOpen(db, d);
  }
}

/**
 * Changing these statement lines (taking them out, moving them) touches only what's matched to
 * them: that's what must be after the lock date. Lines matched to nothing aren't in the books.
 */
async function assertLinesChangeable(db: Db, lineIds: string[]) {
  if (!lineIds.length) return;
  const [r] = await db<{ first: string | null }[]>`
    select min(d)::text as first from (
      select c.date as d from costs c join bank_matches m on m.kind = 'cost' and m.record_id = c.id where m.bank_line_id = any(${lineIds}::uuid[])
      union all select r.date from receipts r join bank_matches m on m.kind = 'receipt' and m.record_id = r.id where m.bank_line_id = any(${lineIds}::uuid[])
      union all select w.date from wage_payments w join bank_matches m on m.kind = 'wage_payment' and m.record_id = w.id where m.bank_line_id = any(${lineIds}::uuid[])
      union all select j.date from journals j join bank_matches m on m.kind = 'journal' and m.record_id = j.id where m.bank_line_id = any(${lineIds}::uuid[])
    ) x`;
  if (r?.first) await assertOpen(db, r.first);
}

/**
 * Money out that looks like a cost you already captured and that isn't tied to the bank yet:
 * about the same amount (within R1) from up to 12 days before to 5 days after, and either the
 * same supplier by name, or the exact amount within 3 days. Adding such a line as a new cost
 * would count the purchase twice, so it's held back and the captured one shown instead.
 */
async function twinsFor(db: Db, lines: { id: string; date: string; amountCents: number; description: string }[]) {
  const outs = lines.filter((l) => l.amountCents < 0);
  const found = new Map<string, { costId: string; label: string }>();
  if (!outs.length) return found;
  const rows = (await db.unsafe(
    `select x.line_id, c.id, c.date::text, c.amount_cents, c.description, c.supplier, p.name as project_name
     from unnest($1::uuid[], $2::date[], $3::bigint[]) as x(line_id, d, a)
     join lateral (
       select c.* from costs c
       where abs(c.amount_cents + x.a) <= 100 and c.date between x.d - 12 and x.d + 5
         and not exists (select 1 from bank_matches m where m.kind = 'cost' and m.record_id = c.id)
       order by (c.amount_cents = -x.a) desc, abs(c.date - x.d) limit 8
     ) c on true
     left join projects p on p.id = c.project_id`,
    [outs.map((l) => l.id), outs.map((l) => l.date), outs.map((l) => l.amountCents)],
  )) as unknown as { lineId: string; id: string; date: string; amountCents: number; description: string; supplier: string; projectName: string | null }[];
  for (const l of outs) {
    const twin = rows.find((c) => {
      if (c.lineId !== l.id) return false;
      const named = similar(l.description, c.supplier) || similar(l.description, c.description);
      const near = c.amountCents === -l.amountCents && Math.abs(Date.parse(c.date) - Date.parse(l.date)) <= 3 * 864e5;
      return named || near;
    });
    if (twin) {
      found.set(l.id, {
        costId: twin.id,
        label: `${twin.description}${twin.supplier && twin.supplier !== twin.description ? ` – ${twin.supplier}` : ''}, ${twin.date}, ${(twin.amountCents / 100).toFixed(2)}${twin.projectName ? ` (${twin.projectName})` : ''}`,
      });
    }
  }
  return found;
}

/** Is this date open for changes (after the lock date)? */
const isOpen = (db: Db, date: string) => assertOpen(db, date).then(() => true, () => false);

/** Records already tied to a statement line, so they aren't suggested twice. */
const unmatched = (kind: Kind, alias: string) => `not exists (select 1 from bank_matches m where m.kind = '${kind}' and m.record_id = ${alias}.id)`;

async function candidates(db: Db, sourceId: string, from: string, to: string) {
  const [costs, receipts, wages, invoices] = await Promise.all([
    db.unsafe(
      `select c.id, c.date::text, c.amount_cents, c.supplier, c.description, c.source_id, s.name as source_name, p.name as project_name
       from costs c left join payment_sources s on s.id = c.source_id left join projects p on p.id = c.project_id
       where c.date between ($1::date - 12) and ($2::date + 5) and ${unmatched('cost', 'c')}`,
      [from, to],
    ),
    db.unsafe(
      `select r.id, r.date::text, r.amount_cents, r.source_id, 'Payment recorded for invoice ' || d.number || coalesce(' (' || c.name || ')', '') as label
       from receipts r join documents d on d.id = r.invoice_id left join clients c on c.id = d.client_id
       where r.source_id = $1 and r.date between ($2::date - 10) and ($3::date + 4) and ${unmatched('receipt', 'r')}`,
      [sourceId, from, to],
    ),
    db.unsafe(
      `select wp.id, wp.date::text, wp.amount_cents, wp.source_id, w.name as worker_name from wage_payments wp join workers w on w.id = wp.worker_id
       where wp.source_id = $1 and wp.date between ($2::date - 5) and ($3::date + 4) and ${unmatched('wage_payment', 'wp')}`,
      [sourceId, from, to],
    ),
    db.unsafe(
      `select d.id, d.number, coalesce(c.name, '') as client_name, d.issue_date::text,
         (d.total_cents - coalesce(r.paid, 0))::bigint as balance_cents,
         greatest(${depositDueSql} - coalesce(r.paid, 0), 0)::bigint as deposit_outstanding_cents
       from documents d left join clients c on c.id = d.client_id
       left join lateral (select sum(amount_cents) as paid from receipts where invoice_id = d.id) r on true
       where d.kind = 'invoice' and d.status = 'issued' and d.written_off_on is null and d.total_cents - coalesce(r.paid, 0) > 0`,
    ),
  ]);
  return {
    costs: costs as unknown as { id: string; date: string; amountCents: number; supplier: string; description: string; sourceId: string | null; sourceName: string | null; projectName: string | null }[],
    receipts: receipts as unknown as { id: string; date: string; amountCents: number; sourceId: string; label: string }[],
    wages: wages as unknown as { id: string; date: string; amountCents: number; sourceId: string; workerName: string }[],
    invoices: invoices as unknown as { id: string; number: string; clientName: string; issueDate: string; balanceCents: number; depositOutstandingCents: number }[],
  };
}

/** What a line is matched to, described for the screen. */
async function matchesFor(db: Db, lineIds: string[]) {
  if (!lineIds.length) return new Map<string, { kind: Kind; id: string; label: string; amountCents: number }[]>();
  const rows = await db<{ bankLineId: string; kind: Kind; recordId: string; label: string | null; amountCents: number | null }[]>`
    select m.bank_line_id, m.kind, m.record_id,
      coalesce(
        (select c.description || coalesce(' – ' || nullif(c.supplier, ''), '') from costs c where m.kind = 'cost' and c.id = m.record_id),
        (select 'Payment for invoice ' || d.number from receipts r join documents d on d.id = r.invoice_id where m.kind = 'receipt' and r.id = m.record_id),
        (select 'Wages: ' || w.name from wage_payments wp join workers w on w.id = wp.worker_id where m.kind = 'wage_payment' and wp.id = m.record_id),
        (select j.description from journals j where m.kind = 'journal' and j.id = m.record_id)) as label,
      coalesce(
        (select c.amount_cents from costs c where m.kind = 'cost' and c.id = m.record_id),
        (select r.amount_cents from receipts r where m.kind = 'receipt' and r.id = m.record_id),
        (select wp.amount_cents from wage_payments wp where m.kind = 'wage_payment' and wp.id = m.record_id),
        (select sum(jl.debit_cents) from journal_lines jl where m.kind = 'journal' and jl.journal_id = m.record_id)) as amount_cents
    from bank_matches m where m.bank_line_id = any(${lineIds}::uuid[])`;
  const out = new Map<string, { kind: Kind; id: string; label: string; amountCents: number }[]>();
  for (const r of rows) {
    // A record deleted since it was matched no longer counts.
    if (r.label == null) continue;
    out.set(r.bankLineId, [...(out.get(r.bankLineId) ?? []), { kind: r.kind, id: r.recordId, label: r.label, amountCents: Number(r.amountCents) }]);
  }
  return out;
}

/** Ties records to a statement line; costs not yet matched to a payment take the statement's account. */
async function link(tx: Db, line: LineRow, items: { kind: Kind; id: string }[]) {
  for (const it of items) {
    await tx`insert into bank_matches (bank_line_id, kind, record_id) values (${line.id}, ${it.kind}, ${it.id})
      on conflict (kind, record_id) do update set bank_line_id = excluded.bank_line_id`;
  }
  const costIds = items.filter((i) => i.kind === 'cost').map((i) => i.id);
  if (costIds.length) {
    // The statement says which account paid; what the cost said before is kept for unmatching.
    await tx`update bank_matches m set source_changed = true, prev_source_id = c.source_id from costs c
      where m.kind = 'cost' and m.record_id = c.id and m.bank_line_id = ${line.id} and c.id = any(${costIds}::uuid[])
        and c.source_id is distinct from ${line.sourceId}::uuid and not m.source_changed`;
    await tx`update costs set source_id = ${line.sourceId} where id = any(${costIds}::uuid[]) and source_id is distinct from ${line.sourceId}::uuid`;
  }
  await tx`update bank_lines set ignored = false where id = ${line.id}`;
  // Rounding: the books follow the statement. The largest item absorbs the few cents' difference.
  if (costIds.length && line.amountCents < 0) {
    const [t] = await tx<{ total: number }[]>`
      select (coalesce((select sum(c.amount_cents) from costs c join bank_matches m on m.kind = 'cost' and m.record_id = c.id where m.bank_line_id = ${line.id}), 0)
        + coalesce((select sum(w.amount_cents) from wage_payments w join bank_matches m on m.kind = 'wage_payment' and m.record_id = w.id where m.bank_line_id = ${line.id}), 0))::bigint as total`;
    const diff = -line.amountCents - t!.total;
    if (diff !== 0 && Math.abs(diff) <= HAND_ROUNDING_CENTS) {
      const note = `Rounded by ${diff > 0 ? '+' : '−'}R${(Math.abs(diff) / 100).toFixed(2)} to match the statement`;
      const [big] = await tx<{ id: string }[]>`select id from costs where id = any(${costIds}::uuid[]) order by amount_cents desc limit 1`;
      await tx`update bank_matches m set prev_amount_cents = c.amount_cents, prev_note = c.note from costs c
        where m.kind = 'cost' and m.record_id = c.id and c.id = ${big!.id} and m.prev_amount_cents is null`;
      await tx`update costs set amount_cents = amount_cents + ${diff}, note = case when note = '' then ${note} else note || ' · ' || ${note} end
        where id = ${big!.id}`;
    }
  }
}

/** Undoes matches on these lines: costs get back the account (and amount) they had before matching. */
async function unlink(tx: Db, lineIds: string[]) {
  if (!lineIds.length) return;
  await tx`update costs c set source_id = case when m.source_changed then m.prev_source_id else c.source_id end,
      amount_cents = coalesce(m.prev_amount_cents, c.amount_cents), note = coalesce(m.prev_note, c.note)
    from bank_matches m where m.kind = 'cost' and m.record_id = c.id and m.bank_line_id = any(${lineIds}::uuid[])
      and (m.source_changed or m.prev_amount_cents is not null)`;
  await tx`delete from bank_matches where bank_line_id = any(${lineIds}::uuid[])`;
}

const normDesc = (d: string) => d.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * The same transactions already imported under another account: this file is probably that
 * account's statement (or was imported there too). Same date, amount and description.
 */
async function alreadyElsewhere(db: Db, sourceId: string, rows: { date: string; amountCents: number; description: string }[], filename: string) {
  if (!rows.length) return null;
  const [hit] = (await db.unsafe(
    `select l.source_id, ps.name as source_name, count(distinct r.i)::int as lines,
       (select st.filename from bank_statements st where st.source_id = l.source_id and st.filename <> '' order by st.created_at desc limit 1) as filename
     from unnest($1::date[], $2::bigint[], $3::text[]) with ordinality as r(d, a, k, i)
     join bank_lines l on l.date = r.d and l.amount_cents = r.a and lower(regexp_replace(l.description, '[^A-Za-z0-9]+', '', 'g')) = r.k
     join payment_sources ps on ps.id = l.source_id
     where l.source_id <> $4
     group by l.source_id, ps.name order by lines desc limit 1`,
    [rows.map((r) => r.date), rows.map((r) => r.amountCents), rows.map((r) => normDesc(r.description)), sourceId],
  )) as unknown as { sourceId: string; sourceName: string; lines: number; filename: string | null }[];
  const [same] = filename
    ? await db<{ sourceName: string }[]>`select ps.name as source_name from bank_statements st join payment_sources ps on ps.id = st.source_id
        where st.filename = ${filename} and st.source_id <> ${sourceId} limit 1`
    : [];
  const many = hit && hit.lines >= 3 && hit.lines * 10 >= rows.length * 3;
  const all = hit && rows.length <= 5 && hit.lines === rows.length;
  if (!same && !many && !all) return null;
  return { sourceName: same?.sourceName ?? hit!.sourceName, lines: hit?.lines ?? 0, of: rows.length, sameFile: Boolean(same) };
}

export function registerBankRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;
  const readers = { preHandler: requireRole('owner', 'accountant') };
  const owner = { preHandler: requireRole('owner') };

  const loadLine = async (db: Db, id: string): Promise<LineRow> => {
    const [l] = await db<LineRow[]>`select id, statement_id, source_id, date::text, description, amount_cents, balance_cents, ignored from bank_lines where id = ${id}`;
    if (!l) throw notFound('Statement line');
    return l;
  };

  // ---------------------------------------------------------------- import
  const importInput = z.object({
    sourceId: uuid,
    csv: z.string().min(10).max(10_000_000),
    filename: z.string().max(200).default(''),
    flip: z.boolean().default(false),
    // Import even though the same transactions are already under another account.
    otherAccountOk: z.boolean().default(false),
  });

  const read = (csv: string, flip: boolean) => {
    try {
      return parseStatementCsv(csv, { flip });
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  };

  app.post('/api/bank/preview', owner, async (req) => {
    const input = parse(importInput, req.body);
    const parsed = read(input.csv, input.flip);
    const keys = fingerprints(parsed.rows);
    const existing = await sql<{ fingerprint: string }[]>`select fingerprint from bank_lines where source_id = ${input.sourceId} and fingerprint = any(${keys})`;
    const have = new Set(existing.map((e) => e.fingerprint));
    const [src] = await sql<{ kind: string }[]>`select kind from payment_sources where id = ${input.sourceId}`;
    const outs = parsed.rows.filter((r) => r.amountCents < 0).length;
    return {
      columns: parsed.columns,
      skipped: parsed.skipped,
      pending: parsed.pending,
      count: parsed.rows.length,
      duplicates: keys.filter((k) => have.has(k)).length,
      from: parsed.rows[0]!.date,
      to: parsed.rows[parsed.rows.length - 1]!.date,
      inCents: parsed.rows.filter((r) => r.amountCents > 0).reduce((s, r) => s + r.amountCents, 0),
      outCents: -parsed.rows.filter((r) => r.amountCents < 0).reduce((s, r) => s + r.amountCents, 0),
      // A card statement often shows purchases as positive numbers.
      looksFlipped: src?.kind === 'card' && outs < parsed.rows.length / 3,
      elsewhere: await alreadyElsewhere(sql, input.sourceId, parsed.rows, input.filename),
      sample: parsed.rows.slice(0, 12),
    };
  });

  app.post('/api/bank/statements', owner, async (req) => {
    const user = userOrThrow(req);
    const input = parse(importInput, req.body);
    const parsed = read(input.csv, input.flip);
    const keys = fingerprints(parsed.rows);
    const rows = parsed.rows;
    const other = input.otherAccountOk ? null : await alreadyElsewhere(sql, input.sourceId, rows, input.filename);
    if (other) {
      throw badRequest(
        other.sameFile
          ? `This file was already imported under ${other.sourceName}. Choose that account, or import it here anyway if it really belongs to both.`
          : `${other.lines} of these ${other.of} transactions are already imported under ${other.sourceName}: this looks like its statement. Choose that account, or import it here anyway.`,
      );
    }
    const result = await sql.begin(async (tx) => {
      const last = [...rows].reverse().find((r) => r.balanceCents != null);
      const [st] = await tx<{ id: string }[]>`
        insert into bank_statements (source_id, filename, from_date, to_date, closing_balance_cents, created_by)
        values (${input.sourceId}, ${input.filename}, ${rows[0]!.date}, ${rows[rows.length - 1]!.date}, ${last?.balanceCents ?? null}, ${user.id}) returning id`;
      let added = 0;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        const res = await tx`
          insert into bank_lines (statement_id, source_id, date, description, amount_cents, balance_cents, fingerprint)
          values (${st!.id}, ${input.sourceId}, ${r.date}, ${r.description}, ${r.amountCents}, ${r.balanceCents}, ${keys[i]!})
          on conflict (source_id, fingerprint) do nothing`;
        added += res.count;
      }
      await tx`update bank_statements set line_count = ${added} where id = ${st!.id}`;
      await audit(tx, { userId: user.id, action: 'import_statement', entity: 'bank_statement', entityId: st!.id, ip: req.ip, details: { added, duplicates: rows.length - added } });
      return { id: st!.id, added, duplicates: rows.length - added };
    });
    // Sure matches go straight in; the rest wait for a look.
    const auto = await applySuggestions(input.sourceId, null, 70);
    return { ...result, autoMatched: auto };
  });

  app.get('/api/bank/statements', readers, async () => {
    return sql`
      select s.id, s.source_id, ps.name as source_name, s.filename, s.from_date::text, s.to_date::text, s.closing_balance_cents, s.created_at,
        (select count(*)::int from bank_lines l where l.statement_id = s.id) as line_count,
        (select count(*)::int from bank_lines l where l.statement_id = s.id and exists (select 1 from bank_matches m where m.bank_line_id = l.id)) as matched_count,
        (select count(*)::int from costs c join bank_matches m on m.kind = 'cost' and m.record_id = c.id join bank_lines l on l.id = m.bank_line_id
          where l.statement_id = s.id and c.note like 'From statement:%') as added_costs,
        -- Transactions also on another account's statements: imported under the wrong account?
        (select count(*)::int from bank_lines l where l.statement_id = s.id and exists (select 1 from bank_lines t where t.source_id <> l.source_id
          and t.date = l.date and t.amount_cents = l.amount_cents
          and lower(regexp_replace(t.description, '[^A-Za-z0-9]+', '', 'g')) = lower(regexp_replace(l.description, '[^A-Za-z0-9]+', '', 'g')))) as elsewhere_count,
        (select ps2.name from bank_lines l join bank_lines t on t.source_id <> l.source_id and t.date = l.date and t.amount_cents = l.amount_cents
          and lower(regexp_replace(t.description, '[^A-Za-z0-9]+', '', 'g')) = lower(regexp_replace(l.description, '[^A-Za-z0-9]+', '', 'g'))
          join payment_sources ps2 on ps2.id = t.source_id where l.statement_id = s.id group by ps2.name order by count(*) desc limit 1) as elsewhere_name
      from bank_statements s join payment_sources ps on ps.id = s.source_id order by s.created_at desc limit 200`;
  });

  /**
   * Takes a statement out again. Costs matched to its lines get back the account they had.
   * With removeAdded, what was added from it goes too (costs, invoice payments, transfers and
   * income entries created from its lines): as if it had never been imported.
   */
  app.delete('/api/bank/statements/:id', owner, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { removeAdded } = parse(z.object({ removeAdded: z.enum(['true', 'false']).default('false') }), req.query);
    const removed = await sql.begin(async (tx) => {
      const [st] = await tx<{ id: string }[]>`select id from bank_statements where id = ${id} for update`;
      if (!st) throw notFound('Statement');
      const lineIds = (await tx<{ id: string }[]>`select id from bank_lines where statement_id = ${id}`).map((l) => l.id);
      await assertLinesChangeable(tx, lineIds);
      const out = { costs: 0, receipts: 0, journals: 0 };
      if (removeAdded === 'true' && lineIds.length) {
        const added = (kind: Kind) => tx<{ id: string }[]>`select record_id as id from bank_matches where kind = ${kind} and bank_line_id = any(${lineIds}::uuid[])`;
        const costIds = (await tx<{ id: string }[]>`
          select c.id from costs c join bank_matches m on m.kind = 'cost' and m.record_id = c.id
          where m.bank_line_id = any(${lineIds}::uuid[]) and c.note like 'From statement:%'
            and not exists (select 1 from assets a where a.cost_id = c.id)`).map((r) => r.id);
        const receipts = await tx<{ id: string; invoiceId: string }[]>`
          select r.id, r.invoice_id from receipts r join bank_matches m on m.kind = 'receipt' and m.record_id = r.id
          where m.bank_line_id = any(${lineIds}::uuid[]) and r.note like 'From statement:%'`;
        const journalIds = (await added('journal')).map((r) => r.id);
        await tx`delete from bank_matches where bank_line_id = any(${lineIds}::uuid[]) and (record_id = any(${costIds}::uuid[]) or record_id = any(${receipts.map((r) => r.id)}::uuid[]) or kind = 'journal')`;
        if (costIds.length) out.costs = (await tx`delete from costs where id = any(${costIds}::uuid[])`).count;
        if (receipts.length) out.receipts = (await tx`delete from receipts where id = any(${receipts.map((r) => r.id)}::uuid[])`).count;
        if (journalIds.length) {
          await tx`delete from journal_lines where journal_id = any(${journalIds}::uuid[])`;
          out.journals = (await tx`delete from journals where id = any(${journalIds}::uuid[])`).count;
        }
        for (const inv of new Set(receipts.map((r) => r.invoiceId))) await syncProjectOfDocument(tx, inv);
      }
      await unlink(tx, lineIds);
      await tx`delete from bank_statements where id = ${id}`;
      await audit(tx, { userId: user.id, action: 'delete', entity: 'bank_statement', entityId: id, ip: req.ip, details: { lines: lineIds.length, ...out } });
      return out;
    });
    return { ok: true, removed };
  });

  /**
   * A statement imported under the wrong account (a card's statement loaded as the bank's):
   * the statement, its lines and everything matched to them move to the right account.
   * Lines the right account already has (that statement imported there too) are kept once:
   * whichever copy is matched stays. A transfer that would now be from the account to itself
   * is undone, and its line waits to be done again.
   */
  app.post('/api/bank/statements/:id/move', owner, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { sourceId } = parse(z.object({ sourceId: uuid }), req.body);
    const [st] = await sql<{ sourceId: string }[]>`select source_id from bank_statements where id = ${id}`;
    if (!st) throw notFound('Statement');
    if (st.sourceId === sourceId) throw badRequest('It’s already under that account');
    const [from] = await sql<{ accountId: string }[]>`select account_id from payment_sources where id = ${st.sourceId}`;
    const [to] = await sql<{ accountId: string; name: string }[]>`select account_id, name from payment_sources where id = ${sourceId}`;
    if (!to) throw badRequest('Choose the account');
    const result = await sql.begin(async (tx) => {
      await assertLinesChangeable(tx, (await tx<{ id: string }[]>`select id from bank_lines where statement_id = ${id}`).map((l) => l.id));
      const isMatched = (alias: string) => `exists (select 1 from bank_matches m where m.bank_line_id = ${alias}.id)`;
      // Lines already on the other account.
      const clashes = await tx.unsafe(
        `select a.id as here_id, b.id as there_id, ${isMatched('a')} as here_matched, ${isMatched('b')} as there_matched
         from bank_lines a join bank_lines b on b.source_id = $2 and b.fingerprint = a.fingerprint where a.statement_id = $1`,
        [id, sourceId],
      ) as unknown as { hereId: string; thereId: string; hereMatched: boolean; thereMatched: boolean }[];
      let alreadyThere = 0;
      for (const c of clashes) {
        if (c.hereMatched && c.thereMatched) throw badRequest('Some of these lines are already imported and matched under that account. Delete one of the two statements instead.');
        if (c.hereMatched) await tx`delete from bank_lines where id = ${c.thereId}`;
        else await tx`delete from bank_lines where id = ${c.hereId}`;
        alreadyThere++;
      }
      const lineIds = (await tx<{ id: string }[]>`select id from bank_lines where statement_id = ${id}`).map((l) => l.id);
      await tx`update bank_lines set source_id = ${sourceId} where id = any(${lineIds}::uuid[])`;
      await tx`update bank_statements set source_id = ${sourceId}, line_count = ${lineIds.length} where id = ${id}`;
      // Whatever those lines paid was paid from the right account.
      const costs = await tx`update costs set source_id = ${sourceId}
        where id in (select record_id from bank_matches where kind = 'cost' and bank_line_id = any(${lineIds}::uuid[]))`;
      const receipts = await tx`update receipts set source_id = ${sourceId}
        where id in (select record_id from bank_matches where kind = 'receipt' and bank_line_id = any(${lineIds}::uuid[]))`;
      const wages = await tx`update wage_payments set source_id = ${sourceId}
        where id in (select record_id from bank_matches where kind = 'wage_payment' and bank_line_id = any(${lineIds}::uuid[]))`;
      let journals = 0;
      let undone = 0;
      if (from!.accountId !== to.accountId) {
        const js = await tx<{ id: string }[]>`select record_id as id from bank_matches where kind = 'journal' and bank_line_id = any(${lineIds}::uuid[])`;
        for (const j of js) {
          await tx`update journal_lines set account_id = ${to.accountId} where journal_id = ${j.id} and account_id = ${from!.accountId}`;
          const [self] = await tx<{ n: number }[]>`select count(distinct account_id)::int as n from journal_lines where journal_id = ${j.id}`;
          if (self!.n < 2) {
            await tx`delete from bank_matches where kind = 'journal' and record_id = ${j.id}`;
            await tx`delete from journal_lines where journal_id = ${j.id}`;
            await tx`delete from journals where id = ${j.id}`;
            undone++;
          } else journals++;
        }
      }
      const moved = { lines: lineIds.length, alreadyThere, costs: costs.count, receipts: receipts.count, wages: wages.count, journals, transfersUndone: undone };
      await audit(tx, { userId: user.id, action: 'move_statement', entity: 'bank_statement', entityId: id, ip: req.ip, details: { from: st.sourceId, to: sourceId, ...moved } });
      return moved;
    });
    return result;
  });

  // ---------------------------------------------------------------- reconciling
  /** Every line for an account (optionally one statement), what it's matched to, and a suggestion for the rest. */
  const recon = async (sourceId: string, statementId: string | null) => {
    const lines = await sql<LineRow[]>`
      select id, statement_id, source_id, date::text, description, amount_cents, balance_cents, ignored from bank_lines
      where source_id = ${sourceId} and (${statementId}::uuid is null or statement_id = ${statementId}::uuid)
      order by date, created_at`;
    const matched = await matchesFor(sql, lines.map((l) => l.id));
    const open = lines.filter((l) => !matched.has(l.id) && !l.ignored);
    let suggestions = new Map<string, Suggestion>();
    if (open.length) {
      const cands = await candidates(sql, sourceId, open[0]!.date, open[open.length - 1]!.date);
      suggestions = suggestMatches(open, cands);
      // Lines the matcher couldn't place but that look like a cost already captured: suggested
      // too (never automatically), so they're matched rather than added a second time.
      const taken = new Set([...suggestions.values()].filter((s) => s.kind === 'cost').flatMap((s) => s.ids));
      const twins = await twinsFor(sql, open.filter((l) => !suggestions.has(l.id)));
      for (const [lineId, t] of twins) {
        if (taken.has(t.costId)) continue;
        taken.add(t.costId);
        suggestions.set(lineId, { kind: 'cost', ids: [t.costId], score: 40, label: `Already captured? ${t.label}` });
      }
    }
    return { lines, matched, suggestions };
  };

  const applySuggestions = async (sourceId: string, lineIds: string[] | null, minScore = 0) => {
    const { lines, suggestions } = await recon(sourceId, null);
    let n = 0;
    await sql.begin(async (tx) => {
      for (const l of lines) {
        const s = suggestions.get(l.id);
        if (!s || s.score < minScore || (lineIds && !lineIds.includes(l.id))) continue;
        // A suggested invoice payment is recorded when accepted; never automatically.
        if (s.kind === 'invoice') {
          if (!lineIds) continue;
          if (!(await isOpen(tx, l.date))) continue;
          const [r] = await tx<{ id: string }[]>`
            insert into receipts (invoice_id, date, amount_cents, source_id, method, reference, note)
            values (${s.ids[0]!}, ${l.date}, ${l.amountCents}, ${l.sourceId}, 'eft', '', ${`From statement: ${l.description}`}) returning id`;
          await link(tx, l, [{ kind: 'receipt', id: r!.id }]);
          await syncProjectOfDocument(tx, s.ids[0]!);
        } else {
          if (s.kind === 'cost') {
            const dates = await tx<{ date: string }[]>`select date::text from costs where id = any(${s.ids}::uuid[])`;
            // One in the closed period doesn't stop the rest.
            if (!(await assertCanChange(tx, dates.map((d) => d.date)).then(() => true, () => false))) continue;
          }
          await link(tx, l, s.ids.map((id) => ({ kind: s.kind as Kind, id })));
        }
        n++;
      }
    });
    return n;
  };

  app.get('/api/bank/recon', readers, async (req) => {
    const { sourceId, statementId } = q(req);
    if (!sourceId || !uuid.safeParse(sourceId).success) throw badRequest('Choose an account');
    const { lines, matched, suggestions } = await recon(sourceId, statementId && uuid.safeParse(statementId).success ? statementId : null);
    const categories = await sql<{ id: string; name: string; active: boolean }[]>`select id, name, active from cost_categories`;
    const history = await sql<{ supplier: string; categoryId: string }[]>`
      select supplier, category_id from costs where supplier <> '' order by date desc limit 3000`;
    const [src] = await sql<{ name: string; accountId: string }[]>`select name, account_id from payment_sources where id = ${sourceId}`;
    const incomeAccounts = await sql<{ id: string; code: string; name: string; systemKey: string | null }[]>`select id, code, name, system_key from accounts where type = 'income' and active`;
    // What the books say this account held at the last statement balance, to compare.
    const lastBal = [...lines].reverse().find((l) => l.balanceCents != null);
    let booksCents: number | null = null;
    if (lastBal && src) {
      const [b] = await sql<{ t: number }[]>`select coalesce(sum(amount_cents), 0)::bigint as t from ledger where account_id = ${src.accountId} and date <= ${lastBal.date}::date`;
      booksCents = b!.t;
    }
    return {
      source: src ?? null,
      statementBalance: lastBal ? { date: lastBal.date, cents: lastBal.balanceCents } : null,
      booksCents,
      lines: lines.map((l) => {
        const m = matched.get(l.id) ?? null;
        const s = m || l.ignored ? null : (suggestions.get(l.id) ?? null);
        return {
          ...l,
          state: m ? 'matched' : l.ignored ? 'ignored' : s ? 'suggested' : 'open',
          matches: m ?? [],
          suggestion: s,
          supplier: supplierFrom(l.description),
          categoryId: m ? null : l.amountCents < 0 ? guessCategory(l.description, categories, history) : guessCategory(l.description, categories, history, { fallback: false }),
          incomeAccountId: !m && l.amountCents > 0 ? guessIncome(l.description, incomeAccounts) : null,
        };
      }),
    };
  });

  app.post('/api/bank/accept', owner, async (req) => {
    const { sourceId, lineIds } = parse(z.object({ sourceId: uuid, lineIds: z.array(uuid).min(1).max(2000) }), req.body);
    return { matched: await applySuggestions(sourceId, lineIds) };
  });

  app.post('/api/bank/lines/ignore', owner, async (req) => {
    const { lineIds, ignored } = parse(z.object({ lineIds: z.array(uuid).min(1).max(2000), ignored: z.boolean() }), req.body);
    const r = await sql`update bank_lines set ignored = ${ignored} where id = any(${lineIds}::uuid[])
      and not exists (select 1 from bank_matches m where m.bank_line_id = bank_lines.id)`;
    return { updated: r.count };
  });

  /** Match a line by hand: the chosen records must add up to the statement amount. */
  app.post('/api/bank/lines/:id/match', owner, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { items } = parse(z.object({ items: z.array(z.object({ kind: z.enum(KINDS), id: uuid })).min(1).max(50) }), req.body);
    const line = await loadLine(sql, id);
    const sums = await sql<{ t: number; dates: string[] }[]>`
      select coalesce(sum(x.amount), 0)::bigint as t, array_agg(x.date::text) as dates from (
        select amount_cents as amount, date from costs where id = any(${items.filter((i) => i.kind === 'cost').map((i) => i.id)}::uuid[])
        union all select -amount_cents, date from receipts where id = any(${items.filter((i) => i.kind === 'receipt').map((i) => i.id)}::uuid[])
        union all select amount_cents, date from wage_payments where id = any(${items.filter((i) => i.kind === 'wage_payment').map((i) => i.id)}::uuid[])
      ) x`;
    const total = sums[0]!.t;
    if (items.some((i) => i.kind !== 'journal') && Math.abs(total + line.amountCents) > HAND_ROUNDING_CENTS) {
      throw badRequest(`Those add up to R${(Math.abs(total) / 100).toFixed(2)}, not the statement’s R${(Math.abs(line.amountCents) / 100).toFixed(2)}`);
    }
    await assertCanChange(sql, (sums[0]!.dates ?? []).filter(Boolean));
    await sql.begin(async (tx) => {
      await link(tx, line, items);
      await audit(tx, { userId: user.id, action: 'match', entity: 'bank_line', entityId: id, ip: req.ip, details: { items: items.length } });
    });
    return { ok: true };
  });

  app.delete('/api/bank/lines/:id/match', owner, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    await sql.begin(async (tx) => {
      await unlink(tx, [id]);
      await audit(tx, { userId: user.id, action: 'unmatch', entity: 'bank_line', entityId: id, ip: req.ip });
    });
    return { ok: true };
  });

  /** Records near a line that it could be matched to by hand. */
  app.get('/api/bank/lines/:id/candidates', readers, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const line = await loadLine(sql, id);
    if (line.amountCents < 0) {
      const costs = await sql`
        select c.id, c.date::text, c.amount_cents, c.description, c.supplier, s.name as source_name, p.name as project_name
        from costs c left join payment_sources s on s.id = c.source_id left join projects p on p.id = c.project_id
        where c.date between (${line.date}::date - 14) and (${line.date}::date + 5)
          and not exists (select 1 from bank_matches m where m.kind = 'cost' and m.record_id = c.id)
        order by abs(c.date - ${line.date}::date), c.date, c.created_at limit 300`;
      const wages = await sql`
        select wp.id, wp.date::text, wp.amount_cents, w.name as worker_name from wage_payments wp join workers w on w.id = wp.worker_id
        where wp.date between (${line.date}::date - 7) and (${line.date}::date + 3)
          and not exists (select 1 from bank_matches m where m.kind = 'wage_payment' and m.record_id = wp.id)
        order by wp.date`;
      return { costs, wages, invoices: [] };
    }
    const invoices = await sql`
      select d.id, d.number, d.issue_date::text, c.name as client_name, (d.total_cents - coalesce(r.paid, 0))::bigint as balance_cents
      from documents d left join clients c on c.id = d.client_id
      left join lateral (select sum(amount_cents) as paid from receipts where invoice_id = d.id) r on true
      where d.kind = 'invoice' and d.status = 'issued' and d.written_off_on is null and d.total_cents - coalesce(r.paid, 0) > 0
      order by d.issue_date desc`;
    return { costs: [], wages: [], invoices };
  });

  // ---------------------------------------------------------------- new records from the statement
  /** Debit orders, bank fees and the like that were never captured: costs straight from the lines. */
  app.post('/api/bank/lines/create-costs', owner, async (req) => {
    const user = userOrThrow(req);
    const { items } = parse(
      z.object({
        items: z
          .array(
            z
              .object({
                lineId: uuid,
                // A cost type (money out is a cost; money in a refund on that type) or, for money in, an income account.
                categoryId: uuid.nullable().default(null),
                incomeAccountId: uuid.nullable().default(null),
                // Add it even though a captured cost looks like the same purchase.
                force: z.boolean().default(false),
                supplier: z.string().trim().max(120).default(''),
                description: z.string().trim().max(200).default(''),
                projectId: uuid.nullable().default(null),
              })
              .refine((i) => Boolean(i.categoryId) !== Boolean(i.incomeAccountId), 'Choose a cost type or an income account'),
          )
          .min(1)
          .max(1000),
      }),
      req.body,
    );
    let created = 0;
    const skipped: { lineId: string; costId: string; label: string }[] = [];
    // Lines in the closed period are left (and counted), so the rest still go in.
    const locked: string[] = [];
    await sql.begin(async (tx) => {
      const [settings] = await tx<{ lockDate: string | null }[]>`select lock_date::text from settings where id`;
      for (const it of items) {
        const line = await loadLine(tx, it.lineId);
        const [taken] = await tx`select 1 from bank_matches where bank_line_id = ${line.id} limit 1`;
        if (taken) continue;
        if (settings?.lockDate && line.date <= settings.lockDate) {
          locked.push(line.id);
          continue;
        }
        // Already captured? A cost of the same amount around that date, not matched to the
        // bank yet, is almost always the same purchase: match it instead of adding it twice.
        if (line.amountCents < 0 && !it.force) {
          const twin = (await twinsFor(tx, [line])).get(line.id);
          if (twin) {
            skipped.push({ lineId: line.id, costId: twin.costId, label: twin.label });
            continue;
          }
        }
        if (it.incomeAccountId) {
          if (line.amountCents < 0) throw badRequest(`${line.date} ${line.description}: money out can’t be income`);
          const [acc] = await tx<{ type: string; name: string }[]>`select type, name from accounts where id = ${it.incomeAccountId}`;
          if (acc?.type !== 'income') throw badRequest('Choose an income account');
          const [src] = await tx<{ accountId: string }[]>`select account_id from payment_sources where id = ${line.sourceId}`;
          const text = it.description || `${acc.name}: ${supplierFrom(line.description)}`;
          const [j] = await tx<{ id: string }[]>`insert into journals (date, description, reference, kind, created_by) values (${line.date}, ${text}, ${line.description.slice(0, 100)}, 'manual', ${user.id}) returning id`;
          await tx`insert into journal_lines (journal_id, account_id, debit_cents, credit_cents, memo) values
            (${j!.id}, ${src!.accountId}, ${line.amountCents}, 0, ${text}), (${j!.id}, ${it.incomeAccountId}, 0, ${line.amountCents}, ${text})`;
          await link(tx, line, [{ kind: 'journal', id: j!.id }]);
          created++;
          continue;
        }
        // Money out is a cost; money in on a cost type is a refund (a negative cost).
        const [c] = await tx<{ id: string }[]>`
          insert into costs (date, description, amount_cents, supplier, category_id, source_id, project_id, note, created_by)
          values (${line.date}, ${it.description || supplierFrom(line.description)}, ${-line.amountCents}, ${it.supplier || supplierFrom(line.description)},
                  ${it.categoryId}, ${line.sourceId}, ${it.projectId}, ${`From statement: ${line.description}`}, ${user.id})
          returning id`;
        await link(tx, line, [{ kind: 'cost', id: c!.id }]);
        created++;
      }
      await audit(tx, { userId: user.id, action: 'create_from_statement', entity: 'cost', ip: req.ip, details: { created, skipped: skipped.length, locked: locked.length } });
    });
    return { created, skipped, locked };
  });

  /** Money in that pays an invoice. */
  app.post('/api/bank/lines/:id/receipt', owner, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { invoiceId } = parse(z.object({ invoiceId: uuid }), req.body);
    const line = await loadLine(sql, id);
    if (line.amountCents <= 0) throw badRequest('Only money in can pay an invoice');
    await assertOpen(sql, line.date);
    const [doc] = await sql<{ status: string; writtenOffOn: string | null }[]>`select status, written_off_on from documents where id = ${invoiceId} and kind = 'invoice'`;
    if (!doc || doc.status !== 'issued') throw badRequest('Choose an issued invoice');
    if (doc.writtenOffOn) throw badRequest('That invoice was written off. Undo the write-off first.');
    await sql.begin(async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        insert into receipts (invoice_id, date, amount_cents, source_id, method, note, created_by)
        values (${invoiceId}, ${line.date}, ${line.amountCents}, ${line.sourceId}, 'eft', ${`From statement: ${line.description}`}, ${user.id}) returning id`;
      await link(tx, line, [{ kind: 'receipt', id: r!.id }]);
      await syncProjectOfDocument(tx, invoiceId);
    });
    return { ok: true };
  });

  /** Money moved between two of your own accounts (a card repayment, money to or from your loan account). */
  app.post('/api/bank/lines/:id/transfer', owner, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { otherSourceId, description } = parse(z.object({ otherSourceId: uuid, description: z.string().trim().max(200).default('') }), req.body);
    const line = await loadLine(sql, id);
    await assertOpen(sql, line.date);
    const [here] = await sql<{ accountId: string; name: string }[]>`select account_id, name from payment_sources where id = ${line.sourceId}`;
    const [there] = await sql<{ accountId: string; name: string }[]>`select account_id, name from payment_sources where id = ${otherSourceId}`;
    if (!there) throw badRequest('Choose the other account');
    if (there.accountId === here!.accountId) throw badRequest('That’s the same account in the books');
    const amt = Math.abs(line.amountCents);
    const out = line.amountCents < 0;
    const text = description || (out ? `Transfer to ${there.name}` : `Transfer from ${there.name}`);
    await sql.begin(async (tx) => {
      const [j] = await tx<{ id: string }[]>`insert into journals (date, description, reference, kind, created_by) values (${line.date}, ${text}, ${line.description.slice(0, 100)}, 'manual', ${user.id}) returning id`;
      await tx`insert into journal_lines (journal_id, account_id, debit_cents, credit_cents, memo) values
        (${j!.id}, ${out ? there.accountId : here!.accountId}, ${amt}, 0, ${text}),
        (${j!.id}, ${out ? here!.accountId : there.accountId}, 0, ${amt}, ${text})`;
      await link(tx, line, [{ kind: 'journal', id: j!.id }]);
    });
    return { ok: true };
  });
}

