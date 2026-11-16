/**
 * Accounts → Another package's books (Shap Accountant phase 2, docs/ACCOUNTANT.md): bring in the
 * trial balance and the general ledger a client's own package exports (Xero, QuickBooks, Sage), to
 * check and compile the financial statements here while the client keeps working there. Read and
 * mapped in import/ledger.ts; here the preview, the mapping of their accounts to these books' (kept
 * for next time), and the journals.
 *
 * - The general ledger for a period: one journal per transaction, replacing what an earlier import
 *   of the same period brought in. It's the client's own entries, so their figures and dates are
 *   kept as they are.
 * - A trial balance at a date: one journal that brings every account to the trial balance on that
 *   date: a balance sheet account to its balance, an income or expense account to its year to date
 *   (the year these books' year end gives), and retained earnings to what the earlier years left.
 *   After a ledger for the same year it comes to nothing (a check that the ledger is all there);
 *   on its own, it gives the year's statements their figures.
 *
 * Nothing goes into a closed period or a year whose statements were approved; it all goes in at once
 * or not at all.
 */
import type { FastifyInstance } from 'fastify';
import { addDays, financialYear, formatDate, formatZar, ACCOUNT_TYPES, type AccountType } from '@shap/shared';
import { z } from 'zod';
import { requireAccess, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { assertOpen, freshTotals, getSettings } from '../lib/books.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { readLedger, sheetRows, transactionsOf, type LedgerAccount, type LedgerFile } from './import/ledger.js';

const fileInput = z.object({ name: z.string().max(200), dataBase64: z.string().max(40_000_000), asAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() });
const filesInput = z.object({ files: z.array(fileInput).min(1).max(12) });
const applyInput = filesInput.extend({
  mapping: z
    .array(
      z.object({
        code: z.string().max(40),
        name: z.string().max(300),
        accountId: z.string().uuid().nullable().default(null),
        /** No account chosen: a new one of this type, with the package's code and name. */
        newType: z.enum(ACCOUNT_TYPES).nullable().default(null),
      }),
    )
    .max(5000),
});

const addDay = (iso: string) => addDays(iso, 1);
const keyOf = (a: { code: string; name: string }) => `${a.code.trim().toLowerCase()}|${a.name.trim().toLowerCase()}`;
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

async function readFiles(files: z.infer<typeof filesInput>['files']): Promise<LedgerFile[]> {
  const out: LedgerFile[] = [];
  for (const f of files) {
    const bytes = Buffer.from(f.dataBase64, 'base64');
    const read = readLedger(f.name, await sheetRows(f.name, bytes));
    out.push(f.asAt && read.kind === 'trialBalance' ? { ...read, asAt: f.asAt } : read);
  }
  return out;
}

interface ShapAccount {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  systemKey: string | null;
}

/** Each of their accounts, with the one in these books it goes to: as last time, the same code, the same name, or none yet. */
async function suggest(db: Db, accounts: LedgerAccount[]) {
  const ours = await db<ShapAccount[]>`select id, code, name, type, system_key from accounts where active order by code`;
  const kept = new Map((await db<{ sourceCode: string; sourceName: string; accountId: string }[]>`select source_code, source_name, account_id from ledger_import_accounts`).map((r) => [keyOf({ code: r.sourceCode, name: r.sourceName }), r.accountId]));
  const byCode = new Map(ours.map((a) => [a.code.toLowerCase(), a]));
  const byName = new Map(ours.map((a) => [words(a.name), a]));
  return accounts.map((a) => {
    const remembered = kept.get(keyOf(a));
    if (remembered && ours.some((o) => o.id === remembered)) return { ...a, accountId: remembered, how: 'as last time' as const };
    const same = (a.code && byCode.get(a.code.toLowerCase())) || byName.get(words(a.name));
    if (same && (!a.type || same.type === a.type)) return { ...a, accountId: same.id, how: 'same name or code' as const };
    return { ...a, accountId: null, how: 'new' as const };
  });
}

/** Every account in the files, once. */
function accountsIn(files: LedgerFile[]): LedgerAccount[] {
  const all = new Map<string, LedgerAccount>();
  for (const f of files) for (const a of [...f.tb, ...f.lines]) if (!all.has(keyOf(a))) all.set(keyOf(a), { code: a.code, name: a.name, type: a.type });
  return [...all.values()].sort((a, b) => (a.code || a.name).localeCompare(b.code || b.name, 'en', { numeric: true }));
}

export function registerBooksImportRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;
  const may = { preHandler: requireAccess('books.adjust') };

  /** What's in the files: their kind, dates, totals, and their accounts with where each would go. */
  app.post('/api/books-import/read', { ...may, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { files } = parse(filesInput, req.body);
    const read = await readFiles(files);
    const accounts = await suggest(sql, accountsIn(read));
    const ours = await sql<ShapAccount[]>`select id, code, name, type, system_key from accounts where active order by code`;
    const out = [];
    for (const f of read) {
      const lines = f.kind === 'trialBalance' ? f.tb : f.lines;
      const debits = lines.reduce((s, l) => s + Math.max(l.cents, 0), 0);
      const credits = lines.reduce((s, l) => s + Math.max(-l.cents, 0), 0);
      // What these books already have in a ledger's period that no import brought in (it would be counted twice).
      let already = 0;
      if (f.kind === 'ledger' && f.from && f.to) {
        const [r] = await sql<{ n: number }[]>`
          select count(*)::int as n from ledger l
          where l.date between ${f.from}::date and ${f.to}::date and l.source <> 'year_end'
            and not (l.source = 'journal' and l.source_id in (select id from journals where ledger_import_id is not null))`;
        already = r?.n ?? 0;
      }
      out.push({ name: f.name, kind: f.kind, source: f.source, asAt: f.asAt, from: f.from, to: f.to, lines: lines.length, debits, credits, already, skipped: f.skipped.slice(0, 20) });
    }
    return {
      files: out,
      accounts,
      ours: ours.map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type })),
    };
  });

  app.post('/api/books-import/apply', { ...may, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const user = userOrThrow(req);
    const input = parse(applyInput, req.body);
    const files = await readFiles(input.files);
    for (const f of files) {
      if (f.kind === 'unknown') throw badRequest(`“${f.name}” isn’t a trial balance or ledger lines that Shap can read: ${f.skipped[0] ?? 'no headings found'}.`);
      if (f.kind === 'trialBalance' && !f.asAt) throw badRequest(`Give the date of the trial balance in “${f.name}”: its title doesn’t say.`);
      if (f.kind === 'ledger' && !f.lines.length) throw badRequest(`“${f.name}” has no ledger lines with amounts.`);
    }
    const result = await sql.begin(async (tx) => applyImport(tx, files, input.mapping, user.id));
    await audit(sql, { userId: user.id, action: 'books_import', entity: 'ledger_import', ip: req.ip, details: { files: files.map((f) => ({ name: f.name, kind: f.kind, source: f.source, asAt: f.asAt, from: f.from, to: f.to })) } });
    return result;
  });

  app.get('/api/books-import', { preHandler: requireAccess('books.adjust', 'reports.view') }, async () => ({
    imports: await sql`
      select i.id, i.kind, i.source, i.filename, i.date_from::text as date_from, i.date_to::text as date_to, i.lines, i.created_at, u.name as by
      from ledger_imports i left join users u on u.id = i.created_by order by i.date_to desc, i.created_at desc`,
  }));

  /** Take an import out again (its journals go with it), if its period is still open. */
  app.delete('/api/books-import/:id', may, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const [i] = await sql<{ dateFrom: string; dateTo: string }[]>`select date_from::text as date_from, date_to::text as date_to from ledger_imports where id = ${id}`;
    if (!i) throw notFound('Import');
    await assertOpen(sql, i.dateFrom, i.dateTo);
    await sql`delete from ledger_imports where id = ${id}`;
    await audit(sql, { userId: user.id, action: 'delete', entity: 'ledger_import', entityId: id, ip: req.ip });
    return { ok: true };
  });
}

/** Into the books: accounts, the ledgers (replacing the same period), then the trial balances. */
export async function applyImport(tx: Db, files: LedgerFile[], mapping: z.infer<typeof applyInput>['mapping'], userId: string | null) {
  const settings = await getSettings(tx);
  const [signedRow] = await tx<{ signed: string | null }[]>`select max(fy_end)::text as signed from financial_statements where status = 'approved'`;
  const signed = signedRow?.signed ?? null;
  const dates = files.flatMap((f) => (f.kind === 'trialBalance' ? [f.asAt!] : [f.from!, f.to!]));
  if (signed && dates.some((d) => d <= signed)) throw badRequest(`The financial statements to ${formatDate(signed)} were approved: nothing more goes into that year or before.`);
  await assertOpen(tx, ...dates);

  // Every account in the files has one in these books: as chosen, or a new one.
  const need = accountsIn(files);
  const chosen = new Map(mapping.map((m) => [keyOf(m), m]));
  const existing = new Map((await tx<ShapAccount[]>`select id, code, name, type, system_key from accounts`).map((a) => [a.id, a]));
  // An account brought in before is used again, not made twice (the same preview applied again).
  const remembered = new Map(
    (await tx<{ sourceCode: string; sourceName: string; accountId: string }[]>`select source_code, source_name, account_id from ledger_import_accounts`)
      .filter((r) => existing.has(r.accountId))
      .map((r) => [keyOf({ code: r.sourceCode, name: r.sourceName }), r.accountId]),
  );
  const codes = new Set([...existing.values()].map((a) => a.code.toLowerCase()));
  const accountOf = new Map<string, string>();
  let created = 0;
  for (const a of need) {
    const m = chosen.get(keyOf(a));
    if (m?.accountId) {
      if (!existing.has(m.accountId)) throw badRequest(`The account chosen for “${a.name}” isn’t in these books`);
      accountOf.set(keyOf(a), m.accountId);
    } else if (remembered.has(keyOf(a))) {
      accountOf.set(keyOf(a), remembered.get(keyOf(a))!);
    } else {
      const type = m?.newType ?? a.type;
      if (!type) throw badRequest(`Choose an account in these books for “${a.code ? `${a.code} ` : ''}${a.name}”, or what kind of account a new one is`);
      // Their code if it's free here, else theirs marked as brought in.
      let code = (a.code || a.name.slice(0, 12)).slice(0, 30);
      for (let n = 1; codes.has(code.toLowerCase()); n++) code = `${(a.code || 'X').slice(0, 24)}-in${n > 1 ? n : ''}`;
      codes.add(code.toLowerCase());
      const [row] = await tx<{ id: string }[]>`insert into accounts (code, name, type) values (${code}, ${a.name.slice(0, 200)}, ${type}) returning id`;
      accountOf.set(keyOf(a), row!.id);
      created++;
    }
    await tx`insert into ledger_import_accounts (source_code, source_name, account_id) values (${a.code}, ${a.name}, ${accountOf.get(keyOf(a))!})
             on conflict (source_code, source_name) do update set account_id = excluded.account_id, updated_at = now()`;
  }
  const idOf = (a: { code: string; name: string }) => accountOf.get(keyOf(a))!;

  // A trial balance brought in earlier was worked out from the books as they were: a ledger or an
  // earlier trial balance coming in under it would leave it wrong. Brought in again together, or refused.
  const tbFiles = files.filter((x) => x.kind === 'trialBalance').sort((a, b) => a.asAt!.localeCompare(b.asAt!));
  const again = new Set(tbFiles.map((f) => f.asAt!));
  const under = [...files.filter((x) => x.kind === 'ledger').map((f) => f.from!), ...tbFiles.map((f) => addDay(f.asAt!))].sort()[0];
  if (under) {
    const stale = await tx<{ d: string }[]>`select date_to::text as d from ledger_imports where kind = 'trialBalance' and date_to >= ${under}::date order by date_to`;
    const missing = stale.map((r) => r.d).filter((d) => !again.has(d));
    if (missing.length)
      throw badRequest(
        `The trial balance at ${missing.map((d) => formatDate(d)).join(' and ')} was brought in before, and worked out from the books as they were then. Bring it in again with these files (all of them at once), or take it out first.`,
      );
  }

  const results: { name: string; kind: string; journals: number; adjustedCents?: number }[] = [];
  // The ledgers first, so a trial balance at their end checks them.
  for (const f of files.filter((x) => x.kind === 'ledger')) {
    const from = f.from!;
    const to = f.to!;
    const overlap = await tx<{ id: string; dateFrom: string; dateTo: string }[]>`
      select id, date_from::text as date_from, date_to::text as date_to from ledger_imports where kind = 'ledger' and date_from <= ${to} and date_to >= ${from}`;
    for (const o of overlap) {
      if (o.dateFrom < from || o.dateTo > to)
        throw badRequest(`An earlier ledger from ${formatDate(o.dateFrom)} to ${formatDate(o.dateTo)} overlaps “${f.name}” (${formatDate(from)} to ${formatDate(to)}) but isn’t inside it. Bring in a period that covers it, or take that one out first.`);
      await tx`delete from ledger_imports where id = ${o.id}`;
    }
    const txs = transactionsOf(f.lines);
    const [imp] = await tx<{ id: string }[]>`
      insert into ledger_imports (kind, source, filename, date_from, date_to, lines, created_by)
      values ('ledger', ${f.source}, ${f.name}, ${from}, ${to}, ${f.lines.length}, ${userId}) returning id`;
    for (const t of txs) {
      const [j] = await tx<{ id: string }[]>`
        insert into journals (date, description, reference, kind, created_by, ledger_import_id)
        values (${t.date}, ${(t.description || `From ${f.source}`).slice(0, 300)}, ${t.reference || `${f.source} ledger`}, 'import', ${userId}, ${imp!.id}) returning id`;
      // One line per account (a transaction can touch an account twice).
      const per = new Map<string, { cents: number; memo: string }>();
      for (const l of t.lines) {
        const id = idOf(l);
        const p = per.get(id) ?? { cents: 0, memo: l.description };
        p.cents += l.cents;
        per.set(id, p);
      }
      const lines = [...per.entries()].filter(([, p]) => p.cents !== 0);
      if (!lines.length) {
        await tx`delete from journals where id = ${j!.id}`;
        continue;
      }
      for (const [accountId, p] of lines)
        await tx`insert into journal_lines (journal_id, account_id, debit_cents, credit_cents, memo)
                 values (${j!.id}, ${accountId}, ${p.cents > 0 ? p.cents : 0}, ${p.cents < 0 ? -p.cents : 0}, ${p.memo.slice(0, 300)})`;
    }
    results.push({ name: f.name, kind: 'ledger', journals: txs.length });
  }

  for (const f of tbFiles) {
    const d = f.asAt!;
    const target = new Map<string, number>();
    for (const l of f.tb) target.set(idOf(l), (target.get(idOf(l)) ?? 0) + l.cents);
    const off = [...target.values()].reduce((s, v) => s + v, 0);
    if (off !== 0) throw badRequest(`The trial balance in “${f.name}” doesn’t balance: debits and credits are ${formatZar(Math.abs(off))} apart. Export it again with every account.`);
    // The same date brought in before: replaced.
    await tx`delete from ledger_imports where kind = 'trialBalance' and date_to = ${d}`;
    const start = financialYear(d, settings.fyEndMonth).start;
    const accounts = await tx<ShapAccount[]>`select id, code, name, type, system_key from accounts`;
    const typeOf = new Map(accounts.map((a) => [a.id, a.type]));
    const re = accounts.find((a) => a.systemKey === 'retained_earnings')!.id;
    const pl = (id: string) => ['income', 'cost_of_sales', 'expense'].includes(typeOf.get(id) ?? '');
    await freshTotals(tx);
    const rows = await tx<{ accountId: string; before: number; year: number }[]>`
      select account_id,
        coalesce(sum(amount_cents) filter (where date < ${start}::date), 0)::bigint as before,
        coalesce(sum(amount_cents) filter (where date >= ${start}::date and date <= ${d}::date), 0)::bigint as year
      from ledger_totals where date <= ${d}::date group by account_id`;
    // What these books say on that date, as a trial balance does: income and expenses for the year,
    // the rest to date, and the earlier years' income and expenses in retained earnings.
    const have = new Map<string, number>();
    const add = (id: string, c: number) => have.set(id, (have.get(id) ?? 0) + c);
    for (const r of rows) {
      if (pl(r.accountId)) {
        add(r.accountId, Number(r.year));
        add(re, Number(r.before));
      } else add(r.accountId, Number(r.before) + Number(r.year));
    }
    const ids = new Set([...target.keys(), ...have.keys()]);
    const lines = [...ids].map((id) => ({ id, cents: (target.get(id) ?? 0) - (have.get(id) ?? 0) })).filter((l) => l.cents !== 0);
    const [imp] = await tx<{ id: string }[]>`
      insert into ledger_imports (kind, source, filename, date_from, date_to, lines, created_by)
      values ('trialBalance', ${f.source}, ${f.name}, ${d}, ${d}, ${f.tb.length}, ${userId}) returning id`;
    if (lines.length) {
      const [j] = await tx<{ id: string }[]>`
        insert into journals (date, description, reference, kind, created_by, ledger_import_id)
        values (${d}, ${`Trial balance at ${formatDate(d)} from ${f.source}`}, ${`${f.source} trial balance`}, 'import', ${userId}, ${imp!.id}) returning id`;
      for (const l of lines)
        await tx`insert into journal_lines (journal_id, account_id, debit_cents, credit_cents, memo)
                 values (${j!.id}, ${l.id}, ${l.cents > 0 ? l.cents : 0}, ${l.cents < 0 ? -l.cents : 0}, 'To the trial balance')`;
    }
    results.push({ name: f.name, kind: 'trialBalance', journals: lines.length ? 1 : 0, adjustedCents: lines.reduce((s, l) => s + Math.max(l.cents, 0), 0) });
  }
  return { created, results };
}
