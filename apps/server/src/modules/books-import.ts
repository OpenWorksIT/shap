/**
 * Accounts → From another package (Shap Accountant phase 2, docs/ACCOUNTANT.md): bring in the trial
 * balance and the general ledger a client's own package exports (Xero, QuickBooks, Sage), to check
 * and compile the financial statements here while the client keeps working there. Read in
 * import/ledger.ts; here the preview, the check of what would happen, the mapping of their accounts
 * to these books' (kept for next time), and the journals.
 *
 * - The general ledger for a period: one journal per transaction, replacing what an earlier import
 *   of the same period brought in. It's the client's own entries, so their figures and dates are
 *   kept as they are. Every line must fall in the period.
 * - A trial balance at a date: one journal that brings what was brought in from the package to the
 *   trial balance on that date: a balance sheet account to its balance, an income or expense account
 *   (and dividends) to its year to date (the year these books' year end gives), and retained earnings
 *   to what the earlier years left. The practice's own entries here stay on top of it. After a ledger
 *   for the same year it comes to nothing (a check that the ledger is all there).
 *
 * Nothing goes into a closed period, an agreed year or a year whose statements were approved; it
 * all goes in at once or not at all. The check (POST …/check) runs it all and undoes it, to show
 * what it would do first.
 */
import type { FastifyInstance } from 'fastify';
import { addDays, financialYear, formatDate, formatZar, sha256Hex, ACCOUNT_TYPES, type AccountType } from '@shap/shared';
import { z } from 'zod';
import { requireAccess, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { assertOpen, effectiveLock, freshTotals, getSettings } from '../lib/books.js';
import { badRequest, HttpError, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { lineFromWords, readLedger, sheetRows, transactionsOf, type LedgerAccount, type LedgerFile } from './import/ledger.js';

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
const PL: AccountType[] = ['income', 'cost_of_sales', 'expense'];
const side = (t: AccountType) => (PL.includes(t) ? 'the income statement' : 'the balance sheet');

interface ReadFile extends LedgerFile {
  /** SHA-256 of the file as brought in: which export the figures came from (ISRS 4410 38(b)). */
  hash: string;
}

/** Every cell read in one request, across its files (each is held to less on its own: ledger.ts). */
const MAX_CELLS_PER_REQUEST = 4_000_000;
/** New accounts one import may add to the chart: a package's whole chart is a few hundred. */
export const MAX_NEW_ACCOUNTS = 500;

async function readFiles(files: z.infer<typeof filesInput>['files']): Promise<ReadFile[]> {
  const out: ReadFile[] = [];
  let cells = 0;
  for (const f of files) {
    const bytes = Buffer.from(f.dataBase64, 'base64');
    const rows = await sheetRows(f.name, bytes);
    cells += rows.reduce((n, r) => n + r.length, 0);
    if (cells > MAX_CELLS_PER_REQUEST) throw badRequest('These files are too big to read together: bring them in a few at a time.');
    const read = readLedger(f.name, rows);
    out.push({ ...(f.asAt && read.kind === 'trialBalance' ? { ...read, asAt: f.asAt } : read), hash: sha256Hex(bytes.toString('latin1')) });
  }
  return out;
}

interface ShapAccount {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  systemKey: string | null;
  active: boolean;
}

/** Names that are the same account: the same words, or one inside the other ("Rent" and "Rent paid"). */
const sameName = (a: string, b: string) => {
  const x = words(a);
  const y = words(b);
  return Boolean(x && y) && (x === y || (x.length >= 4 && y.includes(x)) || (y.length >= 4 && x.includes(y)));
};

/**
 * Shap's own accounts that mean something to its tax and control checks: an account of the package's
 * by one of these names goes to Shap's, so the estimates leave income tax out, the VAT is the VAT,
 * PAYE is PAYE (SARS review of 1.28).
 */
const SYSTEM_BY_NAME: [RegExp, string, AccountType[]][] = [
  [/\bvat\b|value added tax|output tax|input tax/, 'vat', ['liability', 'asset']],
  [/\bpaye\b|employees.? tax/, 'paye_payable', ['liability']],
  [/\buif\b|unemployment insurance/, 'uif_payable', ['liability']],
  [/\bsdl\b|skills development/, 'sdl_payable', ['liability']],
  [/income tax (expense|charge)|tax expense|company tax expense|^taxation$|^income tax$/, 'income_tax', ['expense']],
  [/provisional tax|income tax (payable|owed|due|liability)|sars income tax/, 'income_tax_payable', ['liability', 'asset']],
  [/dividends? (payable|owed)|shareholders for dividend/, 'dividends_payable', ['liability']],
  [/^dividends?( (paid|declared))?$/, 'dividends', ['equity']],
  [/interest (received|income|earned)/, 'interest_income', ['income']],
  [/(profit|loss|gain)s? on (the )?(disposal|sale) of (fixed |non-current )?assets/, 'disposal_gain_loss', ['income', 'expense']],
  [/^retained (earnings|income)$|accumulated (profit|loss)/, 'retained_earnings', ['equity']],
  [/^(share|stated|issued share) capital$|^ordinary shares$/, 'share_capital', ['equity']],
  [/^accounts receivable|^trade (debtors|receivables)$|^debtors( control)?$/, 'receivables', ['asset']],
  [/^accounts payable|^trade (creditors|payables)$|^creditors( control)?$/, 'payables', ['liability']],
];

/**
 * Each of their accounts, with the one in these books it goes to: as last time, the same name (of the
 * same kind, when the file says its kind), the same code and name, or none yet. A code alone never
 * decides it: the packages' numbers aren't Shap's.
 */
async function suggest(db: Db, accounts: LedgerAccount[]) {
  const ours = await db<ShapAccount[]>`select id, code, name, type, system_key, active from accounts where active order by code`;
  const kept = new Map((await db<{ sourceCode: string; sourceName: string; accountId: string }[]>`select source_code, source_name, account_id from ledger_import_accounts`).map((r) => [keyOf({ code: r.sourceCode, name: r.sourceName }), r.accountId]));
  return accounts.map((a) => {
    const remembered = kept.get(keyOf(a));
    if (remembered && ours.some((o) => o.id === remembered)) return { ...a, accountId: remembered, how: 'as last time' as const };
    const fits = (o: ShapAccount) => !a.type || o.type === a.type;
    const byName = ours.find((o) => fits(o) && words(o.name) === words(a.name)) ?? ours.find((o) => fits(o) && a.code && o.code.toLowerCase() === a.code.toLowerCase() && sameName(o.name, a.name));
    if (byName) return { ...a, accountId: byName.id, how: 'same name or code' as const };
    const n = words(a.name.replace(/\(.*?\)/g, ''));
    const rule = SYSTEM_BY_NAME.find(([re, , types]) => re.test(n) && (!a.type || types.includes(a.type)));
    const system = rule && ours.find((o) => o.systemKey === rule[1]);
    if (system) return { ...a, accountId: system.id, how: 'Shap’s own account for it' as const };
    return { ...a, accountId: null, how: 'new' as const };
  });
}

/** Every account in the files, once, with its kind from whichever file gives one. */
function accountsIn(files: LedgerFile[]): LedgerAccount[] {
  const all = new Map<string, LedgerAccount>();
  for (const f of files)
    for (const a of [...f.tb, ...f.lines]) {
      const had = all.get(keyOf(a));
      if (!had) all.set(keyOf(a), { code: a.code, name: a.name, type: a.type, typeWords: a.typeWords ?? '' });
      else if (!had.type && a.type) all.set(keyOf(a), { ...had, type: a.type, typeWords: a.typeWords ?? '' });
    }
  return [...all.values()].sort((a, b) => (a.code || a.name).localeCompare(b.code || b.name, 'en', { numeric: true }));
}

/** Thrown inside the check's transaction, so everything it did is undone. */
class Rollback<T> extends Error {
  constructor(readonly result: T) {
    super('rollback');
  }
}

export function registerBooksImportRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;
  const may = { preHandler: requireAccess('books.adjust') };

  const checked = async (input: z.infer<typeof applyInput>) => {
    const files = await readFiles(input.files);
    for (const f of files) {
      if (f.kind === 'unknown') throw badRequest(`“${f.name}” isn’t a trial balance or ledger lines that Shap can read: ${f.skipped[0] ?? 'no headings found'}.`);
      if (f.kind === 'trialBalance' && !f.asAt) throw badRequest(`Give the date of the trial balance in “${f.name}”: its title doesn’t say.`);
      if (f.kind === 'ledger' && !f.lines.length) throw badRequest(`“${f.name}” has no ledger lines with amounts.`);
      if (f.outside) throw badRequest(`${f.outside} ${f.outside === 1 ? 'line' : 'lines'} in “${f.name}” fall outside its period (${formatDate(f.from)} to ${formatDate(f.to)}): check the file’s dates (day or month first?) and export it again.`);
    }
    return files;
  };

  /** What's in the files: their kind, dates, totals, and their accounts with where each would go. */
  app.post('/api/books-import/read', { ...may, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { files } = parse(filesInput, req.body);
    const read = await readFiles(files);
    const settings = await getSettings(sql);
    const accounts = await suggest(sql, accountsIn(read));
    const ours = await sql<ShapAccount[]>`select id, code, name, type, system_key, active from accounts where active order by code`;
    const out = [];
    for (const f of read) {
      const lines = f.kind === 'trialBalance' ? f.tb : f.lines;
      const debits = lines.reduce((s, l) => s + Math.max(l.cents, 0), 0);
      const credits = lines.reduce((s, l) => s + Math.max(-l.cents, 0), 0);
      // What these books already have in a ledger's period that no import brought in (it would be counted twice).
      let already = 0;
      if (f.kind === 'ledger' && f.from && f.to) {
        const [r] = await sql<{ n: number }[]>`
          select count(distinct (l.source, l.source_id))::int as n from ledger l
          where l.date between ${f.from}::date and ${f.to}::date and l.source <> 'year_end'
            and not (l.source = 'journal' and l.source_id in (select id from journals where ledger_import_id is not null))`;
        already = r?.n ?? 0;
      }
      // A trial balance's income and expenses are taken as the year to date of these books' year (the
      // year end in Settings): shown, so a package whose year runs otherwise is seen before it comes in.
      const yearFrom = f.kind === 'trialBalance' && f.asAt ? financialYear(f.asAt, settings.fyEndMonth).start : null;
      out.push({ name: f.name, kind: f.kind, source: f.source, asAt: f.asAt, from: f.from, to: f.to, yearFrom, lines: lines.length, debits, credits, already, outside: f.outside, columns: f.columns, skipped: f.skipped.slice(0, 20) });
    }
    return {
      files: out,
      accounts: accounts.map((a) => ({ ...a, line: lineFromWords(a.typeWords ?? '', a.name, a.type) })),
      ours: ours.map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type })),
    };
  });

  /** What bringing them in would do (run, then undone): each journal, each trial balance's adjustments. */
  app.post('/api/books-import/check', { ...may, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const user = userOrThrow(req);
    const input = parse(applyInput, req.body);
    const files = await checked(input);
    try {
      await sql.begin(async (tx) => {
        throw new Rollback(await applyImport(tx, files, input.mapping, user.id, user.role === 'owner'));
      });
    } catch (err) {
      if (err instanceof Rollback) return err.result as ImportResult;
      throw err;
    }
    throw new HttpError(500, 'The check didn’t finish', 'internal');
  });

  app.post('/api/books-import/apply', { ...may, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const user = userOrThrow(req);
    const input = parse(applyInput, req.body);
    const files = await checked(input);
    return sql.begin(async (tx) => {
      const result = await applyImport(tx, files, input.mapping, user.id, user.role === 'owner');
      await audit(tx, {
        userId: user.id,
        action: 'books_import',
        entity: 'ledger_import',
        entityId: result.results.map((r) => r.importId).join(','),
        ip: req.ip,
        details: { files: result.results.map((r) => ({ id: r.importId, name: r.name, kind: r.kind, from: r.from, to: r.to, lines: r.lines, hash: r.hash })), replaced: result.replaced },
      });
      // Each import it replaced, on the record by itself: which file's figures went out of the books.
      for (const o of result.replaced)
        await audit(tx, { userId: user.id, action: 'replace', entity: 'ledger_import', entityId: o.id, ip: req.ip, details: { kind: o.kind, from: o.from, to: o.to, file: o.file, by: result.results.map((r) => r.importId).join(',') } });
      return result;
    });
  });

  app.get('/api/books-import', { preHandler: requireAccess('books.adjust', 'reports.view') }, async () => ({
    imports: await sql`
      select i.id, i.kind, i.source, i.filename, i.file_hash, i.date_from::text as date_from, i.date_to::text as date_to, i.lines, i.created_at, u.name as by
      from ledger_imports i left join users u on u.id = i.created_by order by i.date_to desc, i.created_at desc`,
  }));

  /** Take an import out again (its journals go with it), if its period is still open and no later trial balance stands on it. */
  app.delete('/api/books-import/:id', may, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const [i] = await sql<{ kind: string; dateFrom: string; dateTo: string; source: string; filename: string; lines: number; fileHash: string }[]>`
      select kind, date_from::text as date_from, date_to::text as date_to, source, filename, lines, file_hash from ledger_imports where id = ${id}`;
    if (!i) throw notFound('Import');
    if (i.source === 'Shap Pocket') throw badRequest('A Shap Pocket client’s books come from their shares: they aren’t taken out here.');
    const [first] = await sql<{ d: string | null }[]>`select min(date)::text as d from journals where ledger_import_id = ${id}`;
    await assertOpen(sql, first?.d ?? i.dateFrom, i.dateFrom, i.dateTo);
    const [later] = await sql<{ d: string }[]>`
      select date_to::text as d from ledger_imports where kind = 'trialBalance' and id <> ${id} and date_to >= ${i.kind === 'trialBalance' ? addDay(i.dateTo) : i.dateFrom}::date order by date_to limit 1`;
    if (later) throw badRequest(`The trial balance at ${formatDate(later.d)} was worked out with this in the books: take that one out first, or bring the two in again together.`);
    await sql.begin(async (tx) => {
      await tx`delete from ledger_imports where id = ${id}`;
      await audit(tx, { userId: user.id, action: 'delete', entity: 'ledger_import', entityId: id, ip: req.ip, details: { kind: i.kind, from: i.dateFrom, to: i.dateTo, file: i.filename, lines: i.lines, hash: i.fileHash } });
    });
    return { ok: true };
  });
}

export interface ImportResult {
  created: number;
  replaced: { id: string; kind: string; from: string; to: string; file: string }[];
  results: {
    importId: string;
    name: string;
    kind: 'ledger' | 'trialBalance';
    from: string;
    to: string;
    lines: number;
    hash: string;
    journals: number;
    /** A trial balance: the year its income and expenses are for, what it moved on each account, and the earlier years' part. */
    yearFrom?: string;
    adjustments?: { code: string; name: string; cents: number }[];
    earlierYearsCents?: number;
    /** The practice's own entries up to the date, which stay on top of the package's figures. */
    ownEntries?: number;
    /** The books begin with it: before it, the years shown start from nil. */
    opening?: boolean;
  }[];
}

/** Into the books: accounts, the ledgers (replacing the same period), then the trial balances. */
/**
 * `mayAddAccounts`: only the owner adds accounts to the chart (Settings → Accounts is theirs alone,
 * settings.ts); anyone else bringing books in chooses an account here for each of theirs.
 */
export async function applyImport(tx: Db, files: ReadFile[], mapping: z.infer<typeof applyInput>['mapping'], userId: string | null, mayAddAccounts = false): Promise<ImportResult> {
  const settings = await getSettings(tx);
  // Every date anything lands on: each ledger's lines and period, each trial balance's date.
  const dates = files.flatMap((f) => (f.kind === 'trialBalance' ? [f.asAt!] : [f.from!, f.to!, ...f.lines.map((l) => l.date)])).sort();
  const first = dates[0]!;
  const [signedRow] = await tx<{ signed: string | null; agreed: string | null }[]>`
    select (select max(fy_end)::text from financial_statements where status = 'approved') as signed, (select max(fy_end)::text from year_ends) as agreed`;
  const signed = signedRow?.signed ?? null;
  const agreed = signedRow?.agreed ?? null;
  if (signed && first <= signed) throw badRequest(`The financial statements to ${formatDate(signed)} were approved: nothing more goes into that year or before.`);
  if (agreed && first <= agreed) throw badRequest(`The year to ${formatDate(agreed)} was agreed at its figures (Accounts → Year end): nothing more goes into it or before. Reopen it first if it should change.`);
  await assertOpen(tx, first, dates.at(-1));

  // Every account in the files has one in these books: as chosen, or a new one.
  const need = accountsIn(files);
  const chosen = new Map(mapping.map((m) => [keyOf(m), m]));
  const existing = new Map((await tx<ShapAccount[]>`select id, code, name, type, system_key, active from accounts`).map((a) => [a.id, a]));
  // An account brought in before is used again, not made twice (the same preview applied again), while it's in use.
  const remembered = new Map(
    (await tx<{ sourceCode: string; sourceName: string; accountId: string }[]>`select source_code, source_name, account_id from ledger_import_accounts`)
      .filter((r) => existing.get(r.accountId)?.active)
      .map((r) => [keyOf({ code: r.sourceCode, name: r.sourceName }), r.accountId]),
  );
  const codes = new Set([...existing.values()].map((a) => a.code.toLowerCase()));
  const accountOf = new Map<string, string>();
  let created = 0;
  for (const a of need) {
    const m = chosen.get(keyOf(a));
    if (m?.accountId) {
      const to = existing.get(m.accountId);
      if (!to || !to.active) throw badRequest(`The account chosen for “${a.name}” isn’t in use in these books`);
      // Their kind, when the file says it, decides which statement it's on: never the other one.
      if (a.type && side(a.type) !== side(to.type))
        throw badRequest(`“${a.name}” is on ${side(a.type)} in their file, but “${to.name}” is on ${side(to.type)} here: choose an account of its kind, or a new one.`);
      accountOf.set(keyOf(a), m.accountId);
    } else if (remembered.has(keyOf(a))) {
      // (Its account from last time, still in use: not made twice by a preview applied again.)
      accountOf.set(keyOf(a), remembered.get(keyOf(a))!);
    } else {
      const named = `“${a.code ? `${a.code} ` : ''}${a.name}”`;
      if (!mayAddAccounts) throw new HttpError(403, `Choose an account in these books for ${named}: only the owner adds accounts to the chart (or ask them to bring this in).`, 'forbidden');
      if (created >= MAX_NEW_ACCOUNTS) throw badRequest(`That would add more than ${MAX_NEW_ACCOUNTS} accounts to the chart: choose accounts in these books for some of theirs, or bring the files in a few at a time.`);
      const type = m?.newType ?? a.type;
      if (!type) throw badRequest(`Choose an account in these books for ${named}, or what kind of account a new one is`);
      if (a.type && side(a.type) !== side(type)) throw badRequest(`“${a.name}” is on ${side(a.type)} in their file: a new account for it is too.`);
      // Their code if it fits the chart (10 characters, Settings → Accounts) and is free here; else
      // one marked as brought in (their own code stays with the mapping, for next time).
      let code = a.code && a.code.length <= 10 && /^[\w./-]+$/.test(a.code) ? a.code : '';
      for (let n = 1; !code || codes.has(code.toLowerCase()); n++) code = `IMP-${n}`;
      codes.add(code.toLowerCase());
      // Where it sits on the statements, from the package's own words for its kind (Fixed Asset, Bank…).
      const line = type === a.type ? lineFromWords(a.typeWords ?? '', a.name, type) : lineFromWords('', a.name, type);
      const [row] = await tx<{ id: string }[]>`insert into accounts (code, name, type, statement_line) values (${code}, ${a.name.slice(0, 120)}, ${type}, ${line}) returning id`;
      accountOf.set(keyOf(a), row!.id);
      existing.set(row!.id, { id: row!.id, code, name: a.name, type, systemKey: null, active: true });
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
  const under = [...files.filter((x) => x.kind === 'ledger').map((f) => [f.from!, ...f.lines.map((l) => l.date)].sort()[0]!), ...tbFiles.map((f) => addDay(f.asAt!))].sort()[0];
  if (under) {
    const stale = await tx<{ d: string }[]>`select date_to::text as d from ledger_imports where kind = 'trialBalance' and date_to >= ${under}::date order by date_to`;
    const missing = stale.map((r) => r.d).filter((d) => !again.has(d));
    if (missing.length)
      throw badRequest(
        `The trial balance at ${missing.map((d) => formatDate(d)).join(' and ')} was brought in before, and worked out from the books as they were then. Bring it in again with these files (all of them at once), or take it out first.`,
      );
  }

  const results: ImportResult['results'] = [];
  const replaced: ImportResult['replaced'] = [];
  const replace = async (where: { id: string; kind: string; dateFrom: string; dateTo: string; filename: string }) => {
    replaced.push({ id: where.id, kind: where.kind, from: where.dateFrom, to: where.dateTo, file: where.filename });
    await tx`delete from ledger_imports where id = ${where.id}`;
  };
  // The ledgers first, so a trial balance at their end checks them.
  for (const f of files.filter((x) => x.kind === 'ledger')) {
    const from = f.from!;
    const to = f.to!;
    const overlap = await tx<{ id: string; kind: string; dateFrom: string; dateTo: string; filename: string }[]>`
      select id, kind, date_from::text as date_from, date_to::text as date_to, filename from ledger_imports where kind = 'ledger' and source <> 'Shap Pocket' and date_from <= ${to} and date_to >= ${from}`;
    for (const o of overlap) {
      if (o.dateFrom < from || o.dateTo > to)
        throw badRequest(`An earlier ledger from ${formatDate(o.dateFrom)} to ${formatDate(o.dateTo)} overlaps “${f.name}” (${formatDate(from)} to ${formatDate(to)}) but isn’t inside it. Bring in a period that covers it, or take that one out first.`);
      await replace(o);
    }
    const txs = transactionsOf(f.lines);
    const [imp] = await tx<{ id: string }[]>`
      insert into ledger_imports (kind, source, filename, file_hash, date_from, date_to, lines, created_by)
      values ('ledger', ${f.source}, ${f.name}, ${f.hash}, ${from}, ${to}, ${f.lines.length}, ${userId}) returning id`;
    let journals = 0;
    for (const t of txs) {
      // One line per account (a transaction can touch an account twice); one that nets to nothing isn't a journal.
      const per = new Map<string, { cents: number; memo: string }>();
      for (const l of t.lines) {
        const id = idOf(l);
        const p = per.get(id) ?? { cents: 0, memo: l.description };
        p.cents += l.cents;
        per.set(id, p);
      }
      const lines = [...per.entries()].filter(([, p]) => p.cents !== 0);
      if (!lines.length) continue;
      const [j] = await tx<{ id: string }[]>`
        insert into journals (date, description, reference, kind, created_by, ledger_import_id)
        values (${t.date}, ${(t.description || `From ${f.source}`).slice(0, 300)}, ${t.reference || `${f.source} ledger`}, 'import', ${userId}, ${imp!.id}) returning id`;
      for (const [accountId, p] of lines)
        await tx`insert into journal_lines (journal_id, account_id, debit_cents, credit_cents, memo)
                 values (${j!.id}, ${accountId}, ${p.cents > 0 ? p.cents : 0}, ${p.cents < 0 ? -p.cents : 0}, ${p.memo.slice(0, 300)})`;
      journals++;
    }
    results.push({ importId: imp!.id, name: f.name, kind: 'ledger', from, to, lines: f.lines.length, hash: f.hash, journals });
  }

  for (const f of tbFiles) {
    const d = f.asAt!;
    // Its income and expenses are for the year to date: the year these books' year end gives. A
    // title that says another start (a trust's June year in the package) can't come in as it is.
    const ytdStart = financialYear(d, settings.fyEndMonth).start;
    if (f.from && f.from !== ytdStart)
      throw badRequest(
        `The trial balance in “${f.name}” is for ${formatDate(f.from)} to ${formatDate(d)}, but these books’ year runs from ${formatDate(ytdStart)} (their year end, in Settings). Run it in the package for the year from ${formatDate(ytdStart)}, or bring in the ledger for the period instead.`,
      );
    const target = new Map<string, number>();
    for (const l of f.tb) target.set(idOf(l), (target.get(idOf(l)) ?? 0) + l.cents);
    const off = [...target.values()].reduce((s, v) => s + v, 0);
    if (off !== 0) throw badRequest(`The trial balance in “${f.name}” doesn’t balance: debits and credits are ${formatZar(Math.abs(off))} apart. Export it again with every account.`);
    // The same date brought in before: replaced.
    for (const o of await tx<{ id: string; kind: string; dateFrom: string; dateTo: string; filename: string }[]>`
      select id, kind, date_from::text as date_from, date_to::text as date_to, filename from ledger_imports where kind = 'trialBalance' and date_to = ${d}`)
      await replace(o);
    const fy = financialYear(d, settings.fyEndMonth);
    const start = fy.start;
    const accounts = await tx<ShapAccount[]>`select id, code, name, type, system_key, active from accounts`;
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const re = accounts.find((a) => a.systemKey === 'retained_earnings')!.id;
    // Closed at each year end into retained earnings, as Shap's own trial balance does (reports.ts):
    // income and expenses, and the dividends declared.
    const yearly = (id: string) => PL.includes(byId.get(id)?.type as AccountType) || byId.get(id)?.systemKey === 'dividends';
    // What was brought in from the package, as a trial balance on that date says it. The practice's
    // own entries here (its adjustments) stay on top, so they aren't in it.
    const rows = await tx<{ accountId: string; before: string; year: string }[]>`
      select jl.account_id,
        coalesce(sum(jl.debit_cents - jl.credit_cents) filter (where j.date < ${start}::date), 0)::bigint as before,
        coalesce(sum(jl.debit_cents - jl.credit_cents) filter (where j.date >= ${start}::date), 0)::bigint as year
      from journal_lines jl join journals j on j.id = jl.journal_id
      where j.ledger_import_id is not null and j.date <= ${d}::date group by jl.account_id`;
    const have = new Map<string, number>();
    const add = (id: string, c: number) => have.set(id, (have.get(id) ?? 0) + c);
    for (const r of rows) {
      if (yearly(r.accountId)) {
        add(r.accountId, Number(r.year));
        add(re, Number(r.before));
      } else add(r.accountId, Number(r.before) + Number(r.year));
    }
    const ids = new Set([...target.keys(), ...have.keys()]);
    const lines = [...ids].map((id) => ({ id, cents: (target.get(id) ?? 0) - (have.get(id) ?? 0) })).filter((l) => l.cents !== 0);
    // Was anything brought in before this year? Then a change to retained earnings is the earlier
    // years' figures differing (a prior-period matter, IFRS for SMEs 10.21), not the opening position.
    const [before] = await tx<{ n: number }[]>`select count(*)::int as n from journals where ledger_import_id is not null and date < ${start}::date`;
    const earlier = before && before.n > 0 ? (lines.find((l) => l.id === re)?.cents ?? 0) : 0;
    if (earlier) {
      const lock = await effectiveLock(tx);
      const closedBefore = [lock, signed, agreed].filter((x): x is string => Boolean(x)).some((x) => x >= addDays(start, -1));
      if (closedBefore)
        throw badRequest(
          `The trial balance at ${formatDate(d)} gives the years before ${formatDate(start)} ${formatZar(Math.abs(earlier))} ${earlier < 0 ? 'more profit' : 'less profit'} than these books, and those years are closed here. Ask the client what changed in them (a prior-period matter for the accountant); reopen them first if it should come in.`,
        );
    }
    const [own] = await tx<{ n: number }[]>`
      select count(distinct (l.source, l.source_id))::int as n from ledger l where l.date <= ${d}::date
        and not (l.source = 'journal' and l.source_id in (select id from journals where ledger_import_id is not null))`;
    const [firstDate] = await tx<{ d: string | null }[]>`select min(date)::text as d from journals where ledger_import_id is not null`;
    const [imp] = await tx<{ id: string }[]>`
      insert into ledger_imports (kind, source, filename, file_hash, date_from, date_to, lines, created_by)
      values ('trialBalance', ${f.source}, ${f.name}, ${f.hash}, ${d}, ${d}, ${f.tb.length}, ${userId}) returning id`;
    if (lines.length) {
      const [j] = await tx<{ id: string }[]>`
        insert into journals (date, description, reference, kind, created_by, ledger_import_id)
        values (${d}, ${`Trial balance at ${formatDate(d)} from ${f.source}`}, ${`${f.source} trial balance`}, 'import', ${userId}, ${imp!.id}) returning id`;
      for (const l of lines)
        await tx`insert into journal_lines (journal_id, account_id, debit_cents, credit_cents, memo)
                 values (${j!.id}, ${l.id}, ${l.cents > 0 ? l.cents : 0}, ${l.cents < 0 ? -l.cents : 0}, 'To the trial balance')`;
    }
    results.push({
      importId: imp!.id,
      name: f.name,
      kind: 'trialBalance',
      from: d,
      to: d,
      lines: f.tb.length,
      hash: f.hash,
      journals: lines.length ? 1 : 0,
      yearFrom: start,
      adjustments: lines.map((l) => ({ code: byId.get(l.id)?.code ?? '', name: byId.get(l.id)?.name ?? '', cents: l.cents })).sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true })),
      earlierYearsCents: earlier,
      ownEntries: own?.n ?? 0,
      opening: !firstDate?.d || firstDate.d >= d,
    });
  }
  await freshTotals(tx);
  return { created, replaced, results };
}
