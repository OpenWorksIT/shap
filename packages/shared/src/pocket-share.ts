/**
 * The Shap Pocket share (Shap's docs/ACCOUNTANT.md, "A Shap Pocket share"): a one-person business's
 * books from their phone, stamped, for their accountant's Shap. Pocket makes it (its engine,
 * modules/share.ts); Shap brings it into the practice's copy of the books
 * (apps/server/src/modules/import/pocket-share.ts). This file is the same in both apps.
 *
 * A share carries Pocket's records themselves, whatever their date (its invoices, costs, assets, pay
 * runs, journals and the rest: SHARE_TABLES), not only their postings, so Shap's copy works out the
 * VAT201s, the payroll returns, the statements and the checks from what Pocket does. Left out: who
 * signs in, photos of slips, employees' ID, tax and bank numbers, the contact details of customers,
 * workers and jobs, the business's own contact and bank details (in its settings and on its trading
 * names), where trips went from and to, the logbook's vehicle, the tax estimates saved on the phone,
 * and Pocket's own statements and approvals (the practice's are in Shap). What goes is said in SHARE_WHAT_GOES, and
 * tested against a file. With it, every entry's key and hash, so Shap checks it reads the records
 * into the same postings Pocket did, and says what changed.
 */
import { z } from 'zod';
import { sha256Hex } from './sha256.js';

export const POCKET_SHARE_FORMAT = 'shap-pocket-share/1' as const;

/** A share number: one a phone could reach, so a doctored one can't lock out every later share. */
export const MAX_SHARE_NUMBER = 1_000_000;
/** Rows a share may carry, all tables together (a one-person business's books are far fewer). */
export const MAX_SHARE_ROWS = 400_000;
/** The most lines a journal takes (journalInput), in a share too. */
export const MAX_JOURNAL_LINES = 1000;

/**
 * The tables a share carries, in the order they're put back (each after those it refers to).
 * `leaveOut`: columns that never leave the phone (or that mean nothing in Shap's copy). `later`:
 * columns that point at a row put back after it, set once every row is in.
 */
export const SHARE_TABLES: { table: string; leaveOut?: string[]; later?: string[] }[] = [
  { table: 'accounts' },
  { table: 'payment_sources' },
  { table: 'cost_categories' },
  { table: 'brands', leaveOut: ['logo_id', 'email', 'phone', 'address', 'bank_details'] },
  { table: 'clients', leaveOut: ['contact_person', 'email', 'phone', 'address', 'notes'] },
  { table: 'work_types' },
  { table: 'workers', leaveOut: ['phone', 'notes'] },
  { table: 'projects', leaveOut: ['site_address', 'notes'] },
  { table: 'planned_items' },
  { table: 'items' },
  { table: 'journals' },
  { table: 'journal_lines' },
  { table: 'documents', leaveOut: ['pay_link', 'monthly_id', 'monthly_period', 'reminded_at', 'reminders'], later: ['source_quote_id', 'credited_invoice_id', 'credit_receipt_id', 'sale_receipt_id'] },
  { table: 'document_lines', later: ['credited_line_id'] },
  { table: 'receipts' },
  { table: 'refunds' },
  { table: 'costs', leaveOut: ['receipt_id'] },
  { table: 'bill_payments' },
  { table: 'assets' },
  { table: 'stock_purchase_lines' },
  { table: 'stock_takes' },
  { table: 'stock_take_lines' },
  { table: 'stock_claims' },
  { table: 'stock_claim_settlements' },
  { table: 'stock_moves', later: ['reverses_id'] },
  { table: 'labour_entries' },
  { table: 'wage_payments' },
  { table: 'worker_savings' },
  { table: 'employees', leaveOut: ['id_number', 'tax_number', 'bank_details'] },
  { table: 'pay_runs' },
  { table: 'pay_lines' },
  // What the illness was, or anything else personal, may be in a leave entry's note: it stays.
  { table: 'leave_entries', leaveOut: ['note'] },
  { table: 'leave_pay_years' },
  { table: 'dividends' },
  { table: 'sars_payments' },
  { table: 'partners' },
  { table: 'profit_shares' },
  { table: 'year_ends' },
  { table: 'year_end_figures' },
  { table: 'sbc_years' },
  // (Not the tax estimates saved on the phone: a sole proprietor's carry their own income from
  // elsewhere, retirement contributions and age. The practice works out its own.)
  // Where a trip went can be a customer's home: its date, kilometres and reason go.
  { table: 'trips', leaveOut: ['from_place', 'to_place'] },
  // The vehicle's name can be its registration: the year's odometer readings go.
  { table: 'logbook_years', leaveOut: ['vehicle'] },
  { table: 'time_entries' },
  { table: 'balance_checks' },
  { table: 'statement_details' },
  // The business's own details, the way it keeps its books: one row.
  {
    table: 'settings',
    leaveOut: ['logo_id', 'install_id', 'usage_consent', 'market_consent', 'market_notice_seen', 'market_sent_month', 'terms_version', 'terms_accepted_at', 'bank_details', 'pay_link', 'payshap_id', 'phone', 'email', 'address'],
  },
];
export const SHARE_TABLE_NAMES = SHARE_TABLES.map((t) => t.table);

/** Columns that name who signed in on the phone: no one Shap's copy knows, so left empty. */
export const SHARE_USER_COLUMNS = ['created_by', 'user_id', 'updated_by', 'uploaded_by', 'approved_by', 'compiled_by', 'reopened_by', 'made_by'];

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(d)) && d >= '1990-01-01' && d <= '2100-12-31', 'A real date');
const hash = z.string().regex(/^[0-9a-f]{64}$/);

export const pocketShareSchema = z.object({
  format: z.literal(POCKET_SHARE_FORMAT),
  stamp: z.object({
    number: z.number().int().positive().max(MAX_SHARE_NUMBER),
    madeAt: z.string().datetime({ offset: true }),
    /** The day it was made (the phone's date). The records are the whole of the books, whatever their dates. */
    through: date,
    previous: z.object({ number: z.number().int().positive().max(MAX_SHARE_NUMBER), madeAt: z.string().datetime({ offset: true }) }).nullable(),
    app: z.literal('Shap Pocket'),
    /** These books, once and for all (Pocket makes it when the books are first set up). */
    books: z.string().uuid(),
    /** The Pocket that made it, for the words when it's too new for this Shap. */
    version: z.string().max(20),
  }),
  /** Each table's rows, as Pocket's database has them (SHARE_TABLES). */
  records: z.partialRecord(z.enum(SHARE_TABLE_NAMES as [string, ...string[]]), z.array(z.record(z.string().max(63), z.unknown())).max(MAX_SHARE_ROWS)),
  /** Every entry in the books, whatever its date: its key and hashes (shareEntries, entryHash, figuresHash). */
  entries: z.array(z.object({ key: z.string().min(1).max(200), hash, figures: hash })).max(MAX_SHARE_ROWS),
  /** Since the last share sent, as the phone counts it (Shap counts its own). */
  changes: z.object({ added: z.number().int().nonnegative(), changed: z.number().int().nonnegative(), removed: z.number().int().nonnegative() }),
});
export type PocketShare = z.infer<typeof pocketShareSchema>;

/* ---------------------------------------------------------------- entries */

/** An entry: what one thing in the books posted on one day (an invoice, a cost, a journal…), by account code. */
export interface ShareEntry {
  key: string;
  date: string;
  source: string;
  reference: string;
  description: string;
  /** Debit positive, by account code. */
  lines: { code: string; cents: number; memo: string }[];
}

type Query = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<readonly Record<string, unknown>[]>;

/**
 * Every posting in the books (to `through`, if given), as entries: one for each thing posted (and
 * each day, for what posts on more than one day). Pocket and Shap run the same query on the same
 * records, so the same books give the same entries in both. Nothing in the ledger depends on the
 * day it's read (an asset's depreciation is there for its whole life), so a share's entries are all
 * of them, and Shap checks every one.
 */
export async function shareEntries(db: Query, through = '9999-12-31'): Promise<ShareEntry[]> {
  const rows = (await db`
    select l.date::text as date, l.source, l.source_id::text as source_id, coalesce(l.memo, '') as memo, l.amount_cents, a.code, coalesce(d.number, rd.number) as doc_number
    from ledger l join accounts a on a.id = l.account_id
    left join documents d on d.id = l.source_id and l.source in ('invoice', 'credit_note', 'write_off')
    left join receipts r on r.id = l.source_id and l.source = 'receipt'
    left join documents rd on rd.id = r.invoice_id
    where l.date <= ${through}::date and l.amount_cents <> 0
    order by l.date, l.source, l.source_id, a.code, coalesce(l.memo, ''), l.amount_cents`) as unknown as { date: string; source: string; sourceId: string | null; memo: string; amountCents: number | string; code: string; docNumber: string | null }[];
  const by = new Map<string, ShareEntry>();
  for (const r of rows) {
    const key = `${r.source}:${r.sourceId ?? 'none'}:${r.date}`;
    let t = by.get(key);
    if (!t) {
      t = { key, date: r.date, source: r.source, reference: (r.docNumber ?? '').slice(0, 120), description: r.memo.slice(0, 300), lines: [] };
      by.set(key, t);
    }
    const memo = r.memo.slice(0, 300);
    const same = t.lines.find((l) => l.code === r.code && l.memo === memo);
    if (same) same.cents += Number(r.amountCents);
    else t.lines.push({ code: r.code, cents: Number(r.amountCents), memo });
  }
  return [...by.values()].map((t) => ({ ...t, lines: t.lines.filter((l) => l.cents !== 0) })).filter((t) => t.lines.length > 0);
}

const sorted = (lines: ShareEntry['lines']) => [...lines].sort((a, b) => (a.code === b.code ? (a.memo === b.memo ? a.cents - b.cents : a.memo < b.memo ? -1 : 1) : a.code < b.code ? -1 : 1));

/** An entry as it is, wording and all: what "changed" counts. */
export const entryHash = (t: ShareEntry): string => sha256Hex(JSON.stringify([t.date, t.reference, t.description, sorted(t.lines).map((l) => [l.code, l.cents, l.memo])]));

/** Only its figures: its date and what it moved on each account (a changed name or memo doesn't count). */
export function figuresHash(t: ShareEntry): string {
  const per = new Map<string, number>();
  for (const l of t.lines) per.set(l.code, (per.get(l.code) ?? 0) + l.cents);
  return sha256Hex(JSON.stringify([t.date, [...per.entries()].filter(([, c]) => c !== 0).sort((a, b) => (a[0] < b[0] ? -1 : 1))]));
}

/** What an entry is about, whatever day it's on: its source and id (the key without its date). */
export const entryThing = (key: string) => key.replace(/:\d{4}-\d{2}-\d{2}$/, '');

/**
 * What changed between two shares' entries (key → hash): an entry whose date moved is one changed
 * entry (its old key gone, its new one there), not one removed and one added.
 */
export function shareDiff(before: Record<string, string>, after: Record<string, string>): { added: string[]; changed: string[]; removed: string[] } {
  const added = Object.keys(after).filter((k) => !(k in before));
  const removed = Object.keys(before).filter((k) => !(k in after));
  const changed = Object.keys(after).filter((k) => k in before && before[k] !== after[k]);
  const goneThings = new Map<string, string[]>();
  for (const k of removed) goneThings.set(entryThing(k), [...(goneThings.get(entryThing(k)) ?? []), k]);
  const moved = new Set<string>();
  const stillAdded: string[] = [];
  for (const k of added) {
    const gone = goneThings.get(entryThing(k));
    if (gone?.length) {
      moved.add(gone.shift()!);
      changed.push(k);
    } else stillAdded.push(k);
  }
  return { added: stillAdded, changed, removed: removed.filter((k) => !moved.has(k)) };
}

/* ---------------------------------------------------------------- words */

/** On Pocket's share panel: what goes in the file, and where. (Shap's disclaimer and privacy page say the same.) */
export const SHARE_WHAT_GOES =
  'One file of the whole of your books as at today, for your accountant’s Shap. In it: every invoice, cost, asset, pay run, journal, logbook trip and the rest, whatever its date, with its references, descriptions and notes, which can name your customers, suppliers, workers, employees, partners and shareholders and what you paid them (and, for payroll, your employees’ age bands and medical aid members); each trip’s date, kilometres and reason, and the logbook’s odometer readings; your accounts; and your business’s details: its name, its registration, VAT, PAYE, UIF and income tax numbers (a sole proprietor’s income tax number is their own), its year end and invoice terms, and what you’ve filled in for its financial statements, such as directors, addresses, secretary and bankers. Left out: photos of your slips; your employees’ ID, tax and bank numbers; your customers’, workers’ and jobs’ contact details, addresses and notes; the address, phone, email and bank details in your settings and on your trading names; where your trips went from and to, and your vehicle’s name; and the tax estimates you’ve saved (with any income from elsewhere). Nothing goes until you choose where to send or save it, and then only there: OpenWorks never gets it, and once it’s sent Pocket can’t take it back. Each share is numbered and says what’s new, changed or gone since the last one you shared.';

/** The share sheet's message with the file. */
export function pocketShareMessage(s: { number: number; through: string; previous: number | null; changes: number }, formatDate: (d: string) => string): string {
  const whole = `Share ${s.number}: the whole of the books as at ${formatDate(s.through)}`;
  return s.previous ? `${whole}, with ${s.changes} ${s.changes === 1 ? 'change' : 'changes'} since share ${s.previous}.` : `${whole}.`;
}

/* ---------------------------------------------------------------- limits */

/** Any one value in a record: no real one is longer or bigger. */
export const MAX_SHARE_TEXT = 50_000;
export const MAX_SHARE_FIGURE = 1e13;

/** A value's length as text, the longer of its JSON and its String() (Infinity: it can't be written). */
function textLength(v: unknown): number {
  try {
    return Math.max(JSON.stringify(v)?.length ?? 0, String(v).length);
  } catch {
    return Infinity;
  }
}

/**
 * What's wrong with a share, past its schema, if anything: the limits Shap holds a file to when it
 * reads one, and Pocket checks before it offers one (so a file Shap would refuse is never offered).
 */
export function shareProblem(s: PocketShare): { kind: 'column' | 'too_big' | 'rows' | 'settings' | 'twice' | 'long_journal'; table?: string } | null {
  let rows = 0;
  for (const [table, list] of Object.entries(s.records)) {
    if (!list) continue;
    rows += list.length;
    for (const row of list)
      for (const [col, v] of Object.entries(row)) {
        if (!/^[a-z_][a-z0-9_]*$/.test(col)) return { kind: 'column', table };
        if ((typeof v === 'string' && v.length > MAX_SHARE_TEXT) || (typeof v === 'number' && (!Number.isFinite(v) || Math.abs(v) > MAX_SHARE_FIGURE))) return { kind: 'too_big', table };
        // An array or object goes in as its text (JSON, or as the driver writes it): measured so,
        // and one that can't be written as text at all is too big.
        if (v !== null && typeof v === 'object' && textLength(v) > MAX_SHARE_TEXT) return { kind: 'too_big', table };
      }
  }
  if (rows > MAX_SHARE_ROWS) return { kind: 'rows' };
  if ((s.records.settings ?? []).length !== 1) return { kind: 'settings' };
  const keys = new Set<string>();
  for (const e of s.entries) {
    if (keys.has(e.key)) return { kind: 'twice' };
    keys.add(e.key);
  }
  // A journal takes up to 1 000 lines (journalInput): one from before the cap, or a file made so,
  // would cost the receiving Shap the square of its length to check, line by line.
  // Counted by the id as the database reads it: a uuid in either case, with or without braces or
  // hyphens, is the same journal.
  const perJournal = new Map<unknown, number>();
  for (const l of s.records.journal_lines ?? []) {
    // (As the driver sends it: an array or anything else becomes its text.)
    let id: string | null;
    try {
      id = l.journal_id == null ? null : String(l.journal_id).toLowerCase().replace(/[{}-]/g, '');
    } catch {
      return { kind: 'too_big', table: 'journal_lines' };
    }
    const n = (perJournal.get(id) ?? 0) + 1;
    if (n > MAX_JOURNAL_LINES) return { kind: 'long_journal', table: 'journal_lines' };
    perJournal.set(id, n);
  }
  return null;
}

/**
 * Which of `theirs` (a share's entries) the books' own entries `ours` don't match, and how many of
 * ours the share hasn't got: by key, in one pass each (a share can carry many thousands).
 */
export function entriesOff(theirs: { key: string; hash: string }[], ours: ShareEntry[]): number {
  const want = new Map(theirs.map((e) => [e.key, e.hash]));
  let off = 0;
  for (const e of ours) {
    if (want.get(e.key) !== entryHash(e)) off++;
    want.delete(e.key);
  }
  return off + want.size;
}
