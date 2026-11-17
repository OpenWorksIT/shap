/**
 * The Shap Pocket share (Shap's docs/ACCOUNTANT.md, "A Shap Pocket share"): a one-person business's
 * books from their phone, stamped, for their accountant's Shap. Pocket makes it (its engine,
 * modules/share.ts); Shap brings it into the practice's copy of the books
 * (apps/server/src/modules/import/pocket-share.ts). This file is the same in both apps.
 *
 * A share carries Pocket's records themselves (its invoices, costs, assets, pay runs, journals and
 * the rest: SHARE_TABLES), not only their postings, so Shap's copy works out the VAT201s, the
 * payroll returns, the statements and the checks from what Pocket does. Left out: who signs in,
 * photos of slips, people's ID, tax and bank numbers and contact details, and Pocket's own
 * statements and approvals (the practice's are in Shap). With it, every entry's key and hash, so
 * Shap checks it reads the records into the same postings Pocket did, and says what changed.
 */
import { z } from 'zod';
import { sha256Hex } from './sha256.js';

export const POCKET_SHARE_FORMAT = 'shap-pocket-share/1' as const;

/** A share number: one a phone could reach, so a doctored one can't lock out every later share. */
export const MAX_SHARE_NUMBER = 1_000_000;
/** Rows a share may carry, all tables together (a one-person business's books are far fewer). */
export const MAX_SHARE_ROWS = 400_000;

/**
 * The tables a share carries, in the order they're put back (each after those it refers to).
 * `leaveOut`: columns that never leave the phone (or that mean nothing in Shap's copy). `later`:
 * columns that point at a row put back after it, set once every row is in.
 */
export const SHARE_TABLES: { table: string; leaveOut?: string[]; later?: string[] }[] = [
  { table: 'accounts' },
  { table: 'payment_sources' },
  { table: 'cost_categories' },
  { table: 'brands', leaveOut: ['logo_id', 'email', 'phone', 'bank_details'] },
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
  { table: 'dividends' },
  { table: 'sars_payments' },
  { table: 'partners' },
  { table: 'profit_shares' },
  { table: 'year_ends' },
  { table: 'year_end_figures' },
  { table: 'sbc_years' },
  { table: 'tax_estimates' },
  { table: 'trips' },
  { table: 'logbook_years' },
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
  /** Every entry in the books to `through`: its key and hashes (shareEntries, entryHash, figuresHash). */
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
 * Every posting in the books to `through`, as entries: one for each thing posted (and each day, for
 * what posts on more than one day). Pocket and Shap run the same query on the same records, so the
 * same books give the same entries in both.
 */
export async function shareEntries(db: Query, through: string): Promise<ShareEntry[]> {
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
  'One file of your books to today, for your accountant’s Shap: your invoices, costs, assets, pay runs, journals and the rest, every one dated up to today (later ones go in a later share), with their dates, references and descriptions, which can name your customers, suppliers, workers, employees and shareholders and what you paid them; your accounts; and your business’s name, VAT number and year end. Left out: photos of your slips, people’s ID, tax and bank numbers, and contact details. Nothing goes until you choose where on the share sheet, and then only there: OpenWorks never gets it, and once it’s sent Pocket can’t take it back. Each share is numbered and says what’s new, changed or gone since the last one you shared.';

/** The share sheet's message with the file. */
export function pocketShareMessage(s: { number: number; through: string; previous: number | null; changes: number }, formatDate: (d: string) => string): string {
  const whole = `Share ${s.number}: the whole of the books to ${formatDate(s.through)}`;
  return s.previous ? `${whole}, ${s.changes} ${s.changes === 1 ? 'change' : 'changes'} since share ${s.previous}.` : `${whole}.`;
}
