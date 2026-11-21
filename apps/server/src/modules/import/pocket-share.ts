/**
 * A Shap Pocket share (docs/ACCOUNTANT.md, "A Shap Pocket share"): a one-person business's books
 * from their phone, stamped, that they send their accountant. Here: the file read and checked (it
 * comes from outside), and brought into the practice's copy of the books (a client of kind 'pocket').
 *
 * A share carries Pocket's records themselves (packages/shared pocket-share.ts, SHARE_TABLES), and
 * Pocket's tables are Shap's (the same accounting code), so each share replaces the copy's records
 * with the phone's: the copy then works out its VAT201s, payroll, statements and checks from what
 * Pocket does. Shap checks it reads the records into the same entries Pocket did (every entry's
 * hash, whatever its date), and that nothing moves in a year the practice compiled or approved here:
 * neither its entries nor what its statements show. One share at a time; a share of other books is
 * refused. Shap's own accounts keep their ids in the copy whatever a share has.
 */
import { BUSINESS_TYPES, entity, entriesOff, entryHash, figuresHash, formatDate, MAX_SHARE_ROWS, POCKET_SHARE_FORMAT, pocketShareSchema, sha256Hex, SHARE_TABLES, SHARE_USER_COLUMNS, shareDiff, shareEntries, shareProblem, VAT_CATEGORIES, type PocketShare, type ShareEntry } from '@shap/shared';
import type { Db } from '../../db/index.js';
import { badRequest } from '../../lib/errors.js';
import { freshTotals } from '../../lib/books.js';
import { stillSigned } from '../financial-statements.js';
import { buildStatements, type Statements } from '../../statements/build.js';

export { POCKET_SHARE_FORMAT, pocketShareSchema, type PocketShare } from '@shap/shared';

/** Is this file a Pocket share? (A JSON file that says so.) */
export const looksLikePocketShare = (bytes: Buffer) => bytes.subarray(0, 200).toString('utf8').includes(POCKET_SHARE_FORMAT);

const FAULT = 'If a new share says the same, please let us know: tap Feedback, then Bug found.';

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
  // The limits Pocket checks before it offers a file (packages/shared pocket-share.ts).
  const p = shareProblem(s);
  if (p?.kind === 'column') throw badRequest(`“${name}” has a column Shap doesn’t know in ${p.table}. ${FAULT}`);
  if (p?.kind === 'too_big') throw badRequest(`“${name}” has a figure or text in ${p.table} bigger than any Shap keeps. ${FAULT}`);
  if (p?.kind === 'rows') throw badRequest(`“${name}” has more records than Shap brings in at once (${MAX_SHARE_ROWS.toLocaleString('en-ZA')}).`);
  if (p?.kind === 'settings') throw badRequest(`“${name}” has no business details in it. ${FAULT}`);
  if (p?.kind === 'twice') throw badRequest(`“${name}” has the same entry twice. ${FAULT}`);
  if (p?.kind === 'long_journal') throw badRequest(`“${name}” has a journal of more than 1 000 lines, more than Shap takes: ask them to split it into journals that each balance in Shap Pocket, then share their books again.`);
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

  // The copy's entries before: what changed, and what a compiled year had; and what each year
  // compiled or approved here shows, figure by figure, drawn the same way after.
  await freshTotals(tx);
  const before = await shareEntries(query(tx));
  const beforeBy = new Map(before.map((e) => [e.key, e]));
  const signed = await tx<{ fyEnd: string; snapshot: Statements; snapshotHash: string | null }[]>`
    select fy_end::text as fy_end, snapshot, snapshot_hash from financial_statements where status in ('compiled', 'approved') and snapshot is not null order by fy_end`;
  const shownBefore = new Map<string, string>();
  for (const r of signed) shownBefore.set(r.fyEnd, figuresShown(await buildStatements(tx, r.fyEnd, r.snapshot.details)));

  // Out with the copy's records (theirs from the last share), then in with the share's, in order.
  // Stock records and refunds are otherwise never changed or deleted (migration 049): here they're
  // the phone's, replaced as a whole, in this transaction only.
  await tx.unsafe(`set local shap.pocket_share = 'on'`);
  const cols = await columnsOf(tx);
  await tx`update settings set default_receipt_source_id = null, default_wage_source_id = null, default_cost_source_id = null, default_brand_id = null where id`;
  // What points forward (a counter sale at its receipt, a credit note at its invoice) is let go
  // first, as it's set last when they go back in.
  for (const t of SHARE_TABLES) {
    const forward = (t.later ?? []).filter((c) => cols.get(t.table)?.has(c));
    if (forward.length) await tx.unsafe(`update ${t.table} set ${forward.map((c) => `${c} = null`).join(', ')} where ${forward.map((c) => `${c} is not null`).join(' or ')}`);
  }
  for (const t of [...SHARE_TABLES].reverse()) {
    if (t.table === 'settings' || t.table === 'statement_details' || t.table === 'accounts' || !cols.has(t.table)) continue;
    await tx.unsafe(`delete from ${t.table}`);
  }
  // The accounts keep the copy's own ids (matched by their system key, or their code): the ledger
  // finds Shap's own accounts through sys_account(), whose answer the database keeps in its plans,
  // so a system account here never changes its id. Everything that names an account is pointed at
  // the copy's. Their names, kinds and statement lines come from the phone.
  const idOf = await replaceAccounts(tx, share.records.accounts ?? [], cols.get('accounts')!);
  const accountRefs = await referencesTo(tx, 'accounts');
  const later: { table: string; id: unknown; values: Record<string, unknown> }[] = [];
  for (const t of SHARE_TABLES) {
    const here = cols.get(t.table);
    if (!here || t.table === 'settings' || t.table === 'accounts') continue;
    const refs = accountRefs.get(t.table) ?? [];
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
        else if (refs.includes(k) && typeof v === 'string') out[k] = idOf.get(v) ?? v;
        // (JSON columns take the value as it is: the database driver writes it as JSON.)
        else out[k] = v;
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
      .map(([k, v]) => [k, v]),
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

  // The same entries Pocket had, whatever their dates: every one, hash for hash.
  const afterAll = await shareEntries(query(tx));
  const off = entriesOff(share.entries, afterAll);
  if (off)
    throw badRequest(
      `Shap reads share ${st.number} into ${off} ${off === 1 ? 'entry' : 'entries'} other than the Shap Pocket that made it${st.version ? ` (${st.version})` : ''} did, so nothing came in. If they’ve updated Shap Pocket, this Shap may need updating too (whoever runs the server). ${FAULT}`,
    );
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

  // And every year compiled or approved here still gives the figures signed, and shows them as it
  // did: its accounts' kinds, names and statement lines too (a share brings the phone's chart, and
  // the statements place some accounts by name), not only its entries.
  const unsigned: string[] = [];
  for (const r of signed) {
    const now = await buildStatements(tx, r.fyEnd, r.snapshot.details);
    if (!stillSigned(r, now) || figuresShown(now) !== shownBefore.get(r.fyEnd)) unsigned.push(r.fyEnd);
  }
  if (unsigned.length)
    throw badRequest(
      `Share ${st.number} changes what the statements to ${unsigned.map((d) => formatDate(d)).join(' and ')} show, where they were compiled here: an account’s kind, name or the line it’s shown on, or what the statements are drawn from. Ask the client what they changed in their accounts; reopen those statements first (Accounts → Financial statements) if it should come in.`,
    );

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

/** Which columns of which tables point at `table`'s id, in this database. */
async function referencesTo(tx: Db, table: string): Promise<Map<string, string[]>> {
  const rows = await tx<{ t: string; c: string }[]>`
    select kcu.table_name as t, kcu.column_name as c
    from information_schema.referential_constraints rc
    join information_schema.key_column_usage kcu on kcu.constraint_name = rc.constraint_name
    join information_schema.constraint_column_usage ccu on ccu.constraint_name = rc.unique_constraint_name
    where ccu.table_name = ${table} and ccu.column_name = 'id'`;
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.t, [...(out.get(r.t) ?? []), r.c]);
  return out;
}

/**
 * The phone's chart into the copy's, keeping the copy's ids: each of the phone's accounts matched to
 * one here by its system key (Shap's own accounts), else by its code; the rest added as they are;
 * the copy's other accounts the phone no longer has taken out (nothing refers to them by now).
 * Shap's own accounts are never taken out, nor their ids changed (sys_account()'s answer is kept in
 * the database's plans): one the share hasn't got stays as it is. A share with one of Pocket's own
 * that this Shap doesn't know is refused. Returns the phone's id → the copy's.
 */
async function replaceAccounts(tx: Db, theirs: Record<string, unknown>[], here: Map<string, string>): Promise<Map<string, string>> {
  const ours = await tx<{ id: string; code: string; systemKey: string | null }[]>`select id, code, system_key from accounts`;
  const bySystem = new Map(ours.filter((a) => a.systemKey).map((a) => [a.systemKey!, a.id]));
  const byCode = new Map(ours.filter((a) => !a.systemKey).map((a) => [a.code, a.id]));
  if (theirs.some((a) => a.system_key && !bySystem.has(String(a.system_key))))
    throw badRequest(`The share has an account Shap Pocket keeps itself that this Shap doesn’t know. If they’ve updated Shap Pocket, this Shap may need updating too (whoever runs the server). ${FAULT}`);
  const idOf = new Map<string, string>();
  const taken = new Set<string>();
  for (const a of theirs) {
    const key = a.system_key ? String(a.system_key) : null;
    const mine = key ? bySystem.get(key) : byCode.get(String(a.code));
    if (mine && !taken.has(mine)) {
      idOf.set(String(a.id), mine);
      taken.add(mine);
    }
  }
  // Codes out of the way first, so two accounts can swap theirs.
  await tx`update accounts set code = 'was-' || id::text`;
  await tx`delete from accounts where system_key is null and not (id = any(${[...taken]}::uuid[]))`;
  const fields = (a: Record<string, unknown>) => Object.fromEntries(Object.entries(a).filter(([k]) => here.has(k) && k !== 'id').map(([k, v]) => [k, v]));
  for (const a of theirs) {
    const mine = idOf.get(String(a.id));
    try {
      if (mine) await tx`update accounts set ${tx(fields(a))} where id = ${mine}`;
      else await tx`insert into accounts ${tx({ id: a.id, ...fields(a) } as never)}`;
    } catch (err) {
      throw badRequest(`Shap couldn’t take in the share’s accounts (${String((err as Error).message).slice(0, 160)}). ${FAULT}`);
    }
  }
  // Shap's own accounts the share hasn't got: their codes back, unless the phone uses one for another.
  for (const a of ours.filter((x) => x.systemKey && !taken.has(x.id))) {
    const [clash] = await tx`select 1 from accounts where code = ${a.code}`;
    if (clash) throw badRequest(`Shap couldn’t take in the share’s accounts (account ${a.code} is one Shap keeps itself). ${FAULT}`);
    await tx`update accounts set code = ${a.code} where id = ${a.id}`;
  }
  return idOf;
}

/** A year's four statements, line by line and figure by figure (their words left out). */
const figuresShown = (s: Statements) => JSON.stringify({ sfp: s.sfp, sci: s.sci, soce: s.soce.rows.map((r) => r.values), scf: s.scf }, (k, v: unknown) => (k === 'label' ? undefined : v));

const camel = (k: string) => k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
