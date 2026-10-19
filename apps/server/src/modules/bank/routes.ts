import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, userOrThrow } from '../../auth.js';
import type { Ctx } from '../../context.js';
import type { Db } from '../../db/index.js';
import { audit } from '../../lib/audit.js';
import { assertOpen, q } from '../../lib/books.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { depositDueSql } from '../documents.js';
import { guessCategory, suggestMatches, supplierFrom, type Suggestion } from './match.js';
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

/** Records already tied to a statement line, so they aren't suggested twice. */
const unmatched = (kind: Kind, alias: string) => `not exists (select 1 from bank_matches m where m.kind = '${kind}' and m.record_id = ${alias}.id)`;

async function candidates(db: Db, sourceId: string, from: string, to: string) {
  const [costs, receipts, wages, invoices] = await Promise.all([
    db.unsafe(
      `select c.id, c.date::text, c.amount_cents, c.supplier, c.description, c.source_id from costs c
       where c.date between ($2::date - 10) and ($3::date + 4) and (c.source_id is null or c.source_id = $1) and ${unmatched('cost', 'c')}`,
      [sourceId, from, to],
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
    costs: costs as unknown as { id: string; date: string; amountCents: number; supplier: string; description: string; sourceId: string | null }[],
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
  if (costIds.length) await tx`update costs set source_id = ${line.sourceId} where id = any(${costIds}::uuid[]) and (source_id is null or source_id <> ${line.sourceId})`;
  await tx`update bank_lines set ignored = false where id = ${line.id}`;
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
  const importInput = z.object({ sourceId: uuid, csv: z.string().min(10).max(10_000_000), filename: z.string().max(200).default(''), flip: z.boolean().default(false) });

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
      sample: parsed.rows.slice(0, 12),
    };
  });

  app.post('/api/bank/statements', owner, async (req) => {
    const user = userOrThrow(req);
    const input = parse(importInput, req.body);
    const parsed = read(input.csv, input.flip);
    const keys = fingerprints(parsed.rows);
    const rows = parsed.rows;
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
      select s.id, s.source_id, ps.name as source_name, s.filename, s.from_date, s.to_date, s.closing_balance_cents, s.line_count, s.created_at
      from bank_statements s join payment_sources ps on ps.id = s.source_id order by s.created_at desc limit 200`;
  });

  app.delete('/api/bank/statements/:id', owner, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const r = await sql`delete from bank_statements where id = ${id}`;
    if (!r.count) throw notFound('Statement');
    await audit(sql, { userId: user.id, action: 'delete', entity: 'bank_statement', entityId: id, ip: req.ip });
    return { ok: true };
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
          await assertOpen(tx, l.date);
          const [r] = await tx<{ id: string }[]>`
            insert into receipts (invoice_id, date, amount_cents, source_id, method, reference, note)
            values (${s.ids[0]!}, ${l.date}, ${l.amountCents}, ${l.sourceId}, 'eft', '', ${`From statement: ${l.description}`}) returning id`;
          await link(tx, l, [{ kind: 'receipt', id: r!.id }]);
        } else {
          if (s.kind === 'cost') {
            const dates = await tx<{ date: string }[]>`select date::text from costs where id = any(${s.ids}::uuid[])`;
            await assertCanChange(tx, dates.map((d) => d.date));
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
          categoryId: l.amountCents < 0 && !m ? guessCategory(l.description, categories, history) : null,
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
    if (items.some((i) => i.kind !== 'journal') && total !== -line.amountCents) {
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
    const { id } = parse(z.object({ id: uuid }), req.params);
    await sql`delete from bank_matches where bank_line_id = ${id}`;
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
          .array(z.object({ lineId: uuid, categoryId: uuid, supplier: z.string().trim().max(120).default(''), description: z.string().trim().max(200).default(''), projectId: uuid.nullable().default(null) }))
          .min(1)
          .max(1000),
      }),
      req.body,
    );
    let created = 0;
    await sql.begin(async (tx) => {
      for (const it of items) {
        const line = await loadLine(tx, it.lineId);
        if (line.amountCents >= 0) throw badRequest(`${line.date} ${line.description}: money in can’t be a cost`);
        const [taken] = await tx`select 1 from bank_matches where bank_line_id = ${line.id} limit 1`;
        if (taken) continue;
        await assertOpen(tx, line.date);
        const [c] = await tx<{ id: string }[]>`
          insert into costs (date, description, amount_cents, supplier, category_id, source_id, project_id, note, created_by)
          values (${line.date}, ${it.description || supplierFrom(line.description)}, ${-line.amountCents}, ${it.supplier || supplierFrom(line.description)},
                  ${it.categoryId}, ${line.sourceId}, ${it.projectId}, ${`From statement: ${line.description}`}, ${user.id})
          returning id`;
        await link(tx, line, [{ kind: 'cost', id: c!.id }]);
        created++;
      }
      await audit(tx, { userId: user.id, action: 'create_from_statement', entity: 'cost', ip: req.ip, details: { created } });
    });
    return { created };
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

