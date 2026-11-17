/**
 * A Shap Pocket share (docs/ACCOUNTANT.md, "A Shap Pocket share"): a one-person business's books
 * from their phone, stamped, that they send their accountant. Here: the file read and checked (it
 * comes from outside), and brought into the practice's copy of the books (a client of kind 'pocket').
 *
 * A share carries Pocket's records themselves (packages/shared pocket-share.ts, SHARE_TABLES), and
 * Pocket's tables are Shap's (the same accounting code), so each share replaces the copy's records
 * with the phone's: the copy then works out its VAT201s, payroll, statements and checks from what
 * Pocket does. Shap checks it reads the records into the same entries Pocket did (every entry's
 * hash), and that nothing moves in a year the practice compiled or approved here. One share at a
 * time; a share of other books is refused.
 */
import { BUSINESS_TYPES, entity, entryHash, figuresHash, formatDate, MAX_SHARE_ROWS, POCKET_SHARE_FORMAT, pocketShareSchema, sha256Hex, SHARE_TABLES, SHARE_USER_COLUMNS, shareDiff, shareEntries, VAT_CATEGORIES, type PocketShare, type ShareEntry } from '@shap/shared';
import type { Db } from '../../db/index.js';
import { badRequest } from '../../lib/errors.js';
import { freshTotals } from '../../lib/books.js';

export { POCKET_SHARE_FORMAT, pocketShareSchema, type PocketShare } from '@shap/shared';

/** Is this file a Pocket share? (A JSON file that says so.) */
export const looksLikePocketShare = (bytes: Buffer) => bytes.subarray(0, 200).toString('utf8').includes(POCKET_SHARE_FORMAT);

const FAULT = 'If a new share says the same, please let us know: tap Feedback, then Bug found.';
/** Any one value in a record: no real one is longer or bigger. */
const MAX_TEXT = 50_000;
const MAX_NUMBER = 1e13;

/** The file, read and checked: a share in the format, within its limits. */
export function readPocketShare(name: string, bytes: Buffer): PocketShare & { fileHash: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw badRequest(`“${name}” isn’t a Shap Pocket share: ask them to share their books again.`);
  }
  const r = pocketShareSchema.safeParse(raw);
  if (!r.success)
    throw badRequest(`“${name}” isn’t a share this Shap can read. If they’ve updated Shap Pocket, this Shap may need updating too (whoever runs the server); otherwise ask them to share their books again.`);
  const s = r.data;
  let rows = 0;
  for (const [table, list] of Object.entries(s.records)) {
    rows += list.length;
    for (const row of list)
      for (const [col, v] of Object.entries(row)) {
        if (!/^[a-z_][a-z0-9_]*$/.test(col)) throw badRequest(`“${name}” has a column Shap doesn’t know in ${table}. ${FAULT}`);
        if ((typeof v === 'string' && v.length > MAX_TEXT) || (typeof v === 'number' && (!Number.isFinite(v) || Math.abs(v) > MAX_NUMBER)))
          throw badRequest(`“${name}” has a figure or text in ${table} bigger than any Shap keeps. ${FAULT}`);
      }
  }
  if (rows > MAX_SHARE_ROWS) throw badRequest(`“${name}” has more records than Shap brings in at once (${MAX_SHARE_ROWS.toLocaleString('en-ZA')}).`);
  if ((s.records.settings ?? []).length !== 1) throw badRequest(`“${name}” has no business details in it. ${FAULT}`);
  const keys = new Set<string>();
  for (const e of s.entries) {
    if (keys.has(e.key)) throw badRequest(`“${name}” has the same entry twice. ${FAULT}`);
    keys.add(e.key);
  }
  return { ...s, fileHash: sha256Hex(bytes.toString('latin1')) };
}

export interface ShareChange {
  key: string;
  date: string;
  description: string;
  cents: number;
}
export interface ShareResult {
  number: number;
  through: string;
  first: boolean;
  restored: boolean;
  changes: { added: number; changed: number; removed: number; list: { added: ShareChange[]; changed: ShareChange[]; removed: ShareChange[] } };
}

const query = (db: Db) => db as unknown as Parameters<typeof shareEntries>[0];
const asChange = (e: ShareEntry): ShareChange => ({ key: e.key, date: e.date, description: e.description, cents: e.lines.reduce((x, l) => x + Math.max(l.cents, 0), 0) });

/** Each table's columns in this database, and which are JSON (passed as text) or arrays. */
async function columnsOf(tx: Db) {
  const rows = await tx<{ tableName: string; columnName: string; dataType: string }[]>`
    select table_name, column_name, data_type from information_schema.columns where table_schema = 'public'`;
  const out = new Map<string, Map<string, string>>();
  for (const r of rows) {
    const t = out.get(r.tableName) ?? new Map<string, string>();
    t.set(r.columnName, r.dataType);
    out.set(r.tableName, t);
  }
  return out;
}

/** The settings that the statements of a year are drawn on: a share can't change them under a compiled one. */
const DRAWN_ON = ['business_type', 'fy_end_month', 'vat_registered', 'vat_category'] as const;
const DRAWN_ON_WORDS: Record<(typeof DRAWN_ON)[number], string> = { business_type: 'the kind of business', fy_end_month: 'the year end', vat_registered: 'VAT registration', vat_category: 'the VAT category' };

/**
 * Into the copy (in one transaction, the caller's). `closed`: the last year end the practice compiled
 * or approved here, if any: nothing on or before it may change, by its figures (a renamed worker or a
 * changed memo is fine).
 */
export async function applyPocketShare(tx: Db, share: PocketShare & { fileHash: string }, filename: string, userId: string | null): Promise<ShareResult> {
  // One share at a time in these books.
  await tx`select pg_advisory_xact_lock(hashtext('shap pocket share'))`;
  const st = share.stamp;
  const [last] = await tx<{ number: number; madeAt: Date; booksId: string }[]>`select number, made_at, books_id from pocket_shares order by imported_at desc, number desc limit 1`;
  const theirName = String(share.records.settings![0]!.company_name ?? '').slice(0, 200) || 'another business';
  if (last && last.booksId !== st.books) throw badRequest(`This share is of other books (${theirName}), not these: bring it into that client.`);
  let restored = false;
  if (last && st.number <= last.number) {
    if (new Date(st.madeAt) <= new Date(last.madeAt)) {
      if (st.number === last.number) throw badRequest(`Shap already has share ${st.number} of these books: there’s nothing new to bring in.`);
      throw badRequest(`This is share ${st.number}, and Shap already has share ${last.number} of these books: ask them for their latest share.`);
    }
    // A lower number made later: the phone's books were restored or begun again.
    restored = true;
  }

  const [c] = await tx<{ d: string | null }[]>`select max(fy_end)::text as d from financial_statements where status in ('compiled', 'approved')`;
  const closed = c?.d ?? null;
  const settingsIn = share.records.settings![0]!;
  const [now] = await tx<Record<string, unknown>[]>`select business_type, fy_end_month, vat_registered, vat_category from settings where id`;
  // The business's details, held to what Shap's own settings take.
  const bt = String(settingsIn.business_type);
  if (!(BUSINESS_TYPES as readonly string[]).includes(bt)) throw badRequest(`“${filename}” has a kind of business Shap doesn’t know. ${FAULT}`);
  if (!(VAT_CATEGORIES as readonly string[]).includes(String(settingsIn.vat_category))) throw badRequest(`“${filename}” has a VAT category Shap doesn’t know. ${FAULT}`);
  const fyMonth = Number(settingsIn.fy_end_month);
  if (!Number.isInteger(fyMonth) || fyMonth < 1 || fyMonth > 12) throw badRequest(`“${filename}” has a year end Shap can’t read. ${FAULT}`);
  // A trust's, a sole proprietor's and a partnership's year is the year of assessment, to February.
  settingsIn.fy_end_month = entity(bt).febYearEnd ? 2 : fyMonth;
  if (closed) {
    const moved = DRAWN_ON.filter((k) => String(now![camel(k)]) !== String(settingsIn[k]));
    if (moved.length)
      throw badRequest(
        `Share ${st.number} changes ${moved.map((k) => DRAWN_ON_WORDS[k]).join(' and ')}, and the statements to ${formatDate(closed)} were drawn up on them here. Reopen those statements first (Accounts → Financial statements) if the change should come in.`,
      );
  }

  // The copy's entries before: what changed, and what a compiled year had.
  await freshTotals(tx);
  const before = await shareEntries(query(tx), '2100-12-31');
  const beforeBy = new Map(before.map((e) => [e.key, e]));

  // Out with the copy's records (theirs from the last share), then in with the share's, in order.
  const cols = await columnsOf(tx);
  await tx`update settings set default_receipt_source_id = null, default_wage_source_id = null, default_cost_source_id = null, default_brand_id = null where id`;
  for (const t of [...SHARE_TABLES].reverse()) {
    if (t.table === 'settings' || t.table === 'statement_details' || !cols.has(t.table)) continue;
    await tx.unsafe(`delete from ${t.table}`);
  }
  const later: { table: string; id: unknown; values: Record<string, unknown> }[] = [];
  for (const t of SHARE_TABLES) {
    const here = cols.get(t.table);
    if (!here || t.table === 'settings') continue;
    const rows = share.records[t.table] ?? [];
    if (t.table === 'statement_details') {
      // The practice's own details here stay theirs once there are some.
      const [held] = await tx<{ n: number }[]>`select count(*)::int as n from statement_details`;
      if (held!.n > 0) continue;
    }
    const usable = (row: Record<string, unknown>) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        const type = here.get(k);
        if (!type || (t.leaveOut ?? []).includes(k)) continue;
        if (SHARE_USER_COLUMNS.includes(k)) out[k] = null;
        else if ((t.later ?? []).includes(k)) out[k] = null;
        else out[k] = v !== null && (type === 'json' || type === 'jsonb') ? JSON.stringify(v) : v;
      }
      return out;
    };
    for (let i = 0; i < rows.length; i += 500) {
      const shaped = rows.slice(i, i + 500).map(usable);
      if (!shaped.length) continue;
      const names = [...new Set(shaped.flatMap((r) => Object.keys(r)))];
      const chunk = shaped.map((r) => Object.fromEntries(names.map((n) => [n, n in r ? r[n] : null])));
      try {
        await tx`insert into ${tx(t.table)} ${tx(chunk as never, names as never)}`;
      } catch (err) {
        throw badRequest(`Shap couldn’t take in share ${st.number}’s ${t.table.replace(/_/g, ' ')} (${String((err as Error).message).slice(0, 160)}). If they’ve updated Shap Pocket, this Shap may need updating too (whoever runs the server). ${FAULT}`);
      }
    }
    for (const row of rows) {
      const values = Object.fromEntries((t.later ?? []).filter((k) => row[k] != null && here.has(k)).map((k) => [k, row[k]]));
      if (Object.keys(values).length) later.push({ table: t.table, id: row.id, values });
    }
  }
  for (const l of later) await tx`update ${tx(l.table)} set ${tx(l.values)} where id = ${l.id as string}`;
  const settingsCols = cols.get('settings')!;
  const leaveOut = new Set(['id', ...(SHARE_TABLES.find((t) => t.table === 'settings')!.leaveOut ?? [])]);
  const set = Object.fromEntries(
    Object.entries(settingsIn)
      .filter(([k]) => settingsCols.has(k) && !leaveOut.has(k))
      .map(([k, v]) => [k, v !== null && (settingsCols.get(k) === 'json' || settingsCols.get(k) === 'jsonb') ? JSON.stringify(v) : v]),
  );
  try {
    await tx`update settings set ${tx(set)} where id`;
  } catch (err) {
    throw badRequest(`Shap couldn’t take in share ${st.number}’s business details (${String((err as Error).message).slice(0, 160)}). ${FAULT}`);
  }
  // The copy is the practice's to compile in: the statements on, nothing from it to OpenWorks.
  await tx`update settings set setup_done = true, usage_consent = false, market_consent = false,
    features = coalesce(features, '{}'::jsonb) || '{"statements": true}'::jsonb where id`;
  await freshTotals(tx);

  // The same entries Pocket had, to the day it was shared: every one, hash for hash.
  const after = await shareEntries(query(tx), st.through);
  const theirs = new Map(share.entries.map((e) => [e.key, e.hash]));
  const off = after.filter((e) => theirs.get(e.key) !== entryHash(e)).length + share.entries.filter((e) => !after.some((a) => a.key === e.key)).length;
  if (off)
    throw badRequest(
      `Shap reads share ${st.number} into ${off} ${off === 1 ? 'entry' : 'entries'} other than the Shap Pocket that made it${st.version ? ` (${st.version})` : ''} did, so nothing came in. If they’ve updated Shap Pocket, this Shap may need updating too (whoever runs the server). ${FAULT}`,
    );
  const afterAll = await shareEntries(query(tx), '2100-12-31');
  const afterBy = new Map(afterAll.map((e) => [e.key, e]));

  // Nothing moves on or before a year the practice compiled or approved here (by its figures).
  if (closed) {
    const inside = [...new Set([...beforeBy.keys(), ...afterBy.keys()])]
      .filter((k) => (beforeBy.get(k)?.date ?? '9999') <= closed || (afterBy.get(k)?.date ?? '9999') <= closed)
      .filter((k) => {
        const a = beforeBy.get(k);
        const b = afterBy.get(k);
        return !a || !b || figuresHash(a) !== figuresHash(b);
      });
    // An entry moved within the closed years is one entry, not two.
    const things = new Map<string, ShareEntry>();
    for (const k of inside) {
      const e = afterBy.get(k) ?? beforeBy.get(k)!;
      things.set(k.replace(/:\d{4}-\d{2}-\d{2}$/, ''), e);
    }
    if (things.size) {
      const few = [...things.values()].slice(0, 5).map((e) => `${formatDate(e.date)} · ${e.description || e.source}`);
      throw badRequest(
        `Share ${st.number} changes ${things.size} ${things.size === 1 ? 'entry' : 'entries'} on or before ${formatDate(closed)}, where the statements were compiled here: ${few.join('; ')}${things.size > 5 ? '; …' : ''}. Ask the client what changed there; reopen those statements first (Accounts → Financial statements) if it should come in.`,
      );
    }
  }

  const d = shareDiff(Object.fromEntries(before.map((e) => [e.key, entryHash(e)])), Object.fromEntries(afterAll.map((e) => [e.key, entryHash(e)])));
  const first = !last;
  const list = first
    ? { added: [], changed: [], removed: [] }
    : { added: d.added.slice(0, 50).map((k) => asChange(afterBy.get(k)!)), changed: d.changed.slice(0, 50).map((k) => asChange(afterBy.get(k)!)), removed: d.removed.slice(0, 50).map((k) => asChange(beforeBy.get(k)!)) };
  const counts = first ? { added: 0, changed: 0, removed: 0 } : { added: d.added.length, changed: d.changed.length, removed: d.removed.length };
  await tx`insert into pocket_shares (number, made_at, through, previous_number, books_id, file_hash, restored, changes, filename, imported_by)
    values (${st.number}, ${st.madeAt}, ${st.through}::date, ${st.previous?.number ?? null}, ${st.books}, ${share.fileHash}, ${restored}, ${tx.json(counts as never)}, ${filename.slice(0, 200)}, ${userId})`;
  return { number: st.number, through: st.through, first, restored, changes: { ...counts, list } };
}

const camel = (k: string) => k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
