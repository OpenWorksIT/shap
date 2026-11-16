/**
 * A Shap Pocket share (docs/ACCOUNTANT.md, "A Shap Pocket share"): the whole of a one-person
 * business's books from their phone, stamped, that they send their accountant. Here: the file read
 * and checked (it comes from outside: every field limited), and brought into a practice's client's
 * books as a read-only copy. Each share replaces the last one brought in (it's the whole of the
 * books, not a period), and what changed since the last share Shap holds is worked out here, from
 * what it holds, whatever the phone says.
 */
import { POCKET_SHARE_FORMAT, pocketShareSchema, sha256Hex, type PocketShare } from '@shap/shared';
import type { Db } from '../../db/index.js';
import { badRequest } from '../../lib/errors.js';
import { effectiveLock, freshTotals } from '../../lib/books.js';

export { POCKET_SHARE_FORMAT, pocketShareSchema, type PocketShare } from '@shap/shared';

/** Is this file a Pocket share? (A JSON file that says so.) */
export const looksLikePocketShare = (bytes: Buffer) => bytes.subarray(0, 200).toString('utf8').includes(POCKET_SHARE_FORMAT);

/** The file, read and checked: it must be a whole, balanced share. */
export function readPocketShare(name: string, bytes: Buffer): PocketShare {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw badRequest(`“${name}” isn’t a Shap Pocket share Shap can read: ask for the share again.`);
  }
  const r = pocketShareSchema.safeParse(raw);
  if (!r.success) throw badRequest(`“${name}” isn’t a Shap Pocket share Shap can read (from a newer Pocket, or changed after it was made): ask for the share again.`);
  const s = r.data;
  const codes = new Set(s.accounts.map((a) => a.code));
  const keys = new Set<string>();
  for (const t of s.transactions) {
    if (keys.has(t.key)) throw badRequest(`“${name}” has the same entry twice: ask for the share again.`);
    keys.add(t.key);
    if (t.date > s.stamp.through) throw badRequest(`“${name}” has an entry after the day it was shared: ask for the share again.`);
    if (t.lines.reduce((x, l) => x + l.cents, 0) !== 0) throw badRequest(`An entry on ${t.date} in “${name}” doesn’t balance: ask for the share again.`);
    for (const l of t.lines) if (!codes.has(l.code)) throw badRequest(`“${name}” posts to an account it doesn’t list (${l.code}): ask for the share again.`);
  }
  return s;
}

const hashOf = (t: PocketShare['transactions'][number]) => sha256Hex(JSON.stringify([t.date, t.reference, t.description, t.lines.map((l) => [l.code, l.cents, l.memo])]));

export interface ShareChange {
  key: string;
  date: string;
  description: string;
  cents: number;
}
export interface ShareChanges {
  added: ShareChange[];
  changed: ShareChange[];
  removed: ShareChange[];
}

/**
 * Into the client's books (in one transaction, the caller's): the settings the books are read by,
 * the accounts (by code; one of another kind under the same code gets a new code), and the entries:
 * each one kept as it is when the share has it the same, replaced when it changed, added when it's
 * new, taken out when it's gone. Nothing changes on or before a closed period or an approved year's
 * end: a share that would is refused. The share's stamp is kept with what changed since the last
 * share brought in.
 */
export async function applyPocketShare(tx: Db, share: PocketShare, filename: string, userId: string | null): Promise<{ number: number; changes: ShareChanges; first: boolean }> {
  const [last] = await tx<{ number: number }[]>`select number from pocket_shares order by imported_at desc limit 1`;
  if (last && share.stamp.number <= last.number) throw badRequest(`Share ${share.stamp.number} is older than share ${last.number}, already brought in: ask for the latest one.`);
  const held = new Map(
    (await tx<{ key: string; hash: string; date: string; description: string; cents: number; journalId: string }[]>`
      select key, hash, date::text as date, description, cents, journal_id from pocket_share_entries`).map((r) => [r.key, r]),
  );
  const incoming = share.transactions.map((t) => ({ t, hash: hashOf(t), cents: t.lines.reduce((x, l) => x + Math.max(l.cents, 0), 0) }));
  const seen = new Set(incoming.map((x) => x.t.key));
  const as = (x: (typeof incoming)[number]): ShareChange => ({ key: x.t.key, date: x.t.date, description: x.t.description, cents: x.cents });
  const changes: ShareChanges = {
    added: incoming.filter((x) => !held.has(x.t.key)).map(as),
    changed: incoming.filter((x) => held.has(x.t.key) && held.get(x.t.key)!.hash !== x.hash).map(as),
    removed: [...held.values()].filter((h) => !seen.has(h.key)).map((h) => ({ key: h.key, date: h.date, description: h.description, cents: Number(h.cents) })),
  };
  // Nothing moves in a closed period or an approved year: those books stay as they were checked.
  const lock = await effectiveLock(tx);
  const [approved] = await tx<{ d: string | null }[]>`select max(fy_end)::text as d from financial_statements where status = 'approved'`;
  const closed = [lock, approved?.d ?? null].filter((d): d is string => Boolean(d)).sort().at(-1) ?? null;
  if (closed) {
    // An entry changed counts where it was and where it is now.
    const inside = [...changes.added, ...changes.changed, ...changes.removed].filter((c) => c.date <= closed || (held.get(c.key)?.date ?? c.date) <= closed).length;
    if (inside)
      throw badRequest(
        `Share ${share.stamp.number} changes ${inside} ${inside === 1 ? 'entry' : 'entries'} on or before ${closed}, where these books are closed${approved?.d && approved.d >= (lock ?? '') ? ' (their statements are approved)' : ''}. Ask the client what changed there; reopen the period first if it should change.`,
      );
  }

  const b = share.business;
  await tx`update settings set company_name = ${b.companyName || 'A Shap Pocket business'}, trading_name = ${b.tradingName}, business_type = ${b.businessType}, fy_end_month = ${b.fyEndMonth},
    vat_registered = ${b.vatRegistered}, vat_category = ${b.vatCategory}, vat_number = ${b.vatNumber}, turnover_tax = ${b.turnoverTax}, approved_pbo = ${b.approvedPbo},
    setup_done = true, usage_consent = false, market_consent = false where id`;

  // Accounts by code: Pocket's chart starts as Shap's, so most are the same.
  const ours = new Map((await tx<{ id: string; code: string; type: string }[]>`select id, code, type from accounts`).map((a) => [a.code, a]));
  const kept = new Map((await tx<{ pocketCode: string; accountId: string }[]>`select pocket_code, account_id from pocket_share_accounts`).map((r) => [r.pocketCode, r.accountId]));
  const idOf = new Map<string, string>();
  for (const a of share.accounts) {
    const before = kept.get(a.code);
    const same = ours.get(a.code);
    if (before) idOf.set(a.code, before);
    else if (same && same.type === a.type) idOf.set(a.code, same.id);
    else {
      let code = a.code;
      for (let n = 1; ours.has(code); n++) code = `${a.code.slice(0, 24)}-p${n}`;
      const [row] = await tx<{ id: string }[]>`insert into accounts (code, name, type) values (${code}, ${a.name}, ${a.type}) returning id`;
      ours.set(code, { id: row!.id, code, type: a.type });
      idOf.set(a.code, row!.id);
    }
    await tx`insert into pocket_share_accounts (pocket_code, account_id) values (${a.code}, ${idOf.get(a.code)!}) on conflict (pocket_code) do nothing`;
  }

  // One import holds the share's entries; it's brought up to this share.
  const dates = share.transactions.map((t) => t.date).sort();
  let [imp] = await tx<{ id: string }[]>`select id from ledger_imports where source = 'Shap Pocket' limit 1`;
  if (!imp) [imp] = await tx<{ id: string }[]>`insert into ledger_imports (kind, source, filename, date_from, date_to, lines, created_by) values ('ledger', 'Shap Pocket', ${filename}, ${dates[0] ?? share.stamp.through}, ${share.stamp.through}, 0, ${userId}) returning id`;
  const out = [...changes.changed, ...changes.removed].map((c) => held.get(c.key)!.journalId);
  if (out.length) await tx`delete from journals where id = any(${out}::uuid[])`;
  await tx`delete from pocket_share_entries where key = any(${[...changes.changed, ...changes.removed].map((c) => c.key)}::text[])`;
  const fresh = new Set([...changes.added, ...changes.changed].map((c) => c.key));
  for (const x of incoming.filter((i) => fresh.has(i.t.key))) {
    const t = x.t;
    const [j] = await tx<{ id: string }[]>`
      insert into journals (date, description, reference, kind, created_by, ledger_import_id)
      values (${t.date}, ${(t.description || t.source).slice(0, 300)}, ${t.reference || t.source}, 'import', ${userId}, ${imp!.id}) returning id`;
    const per = new Map<string, { cents: number; memo: string }>();
    for (const l of t.lines) {
      const id = idOf.get(l.code)!;
      const p = per.get(id) ?? { cents: 0, memo: l.memo };
      p.cents += l.cents;
      per.set(id, p);
    }
    for (const [accountId, p] of per)
      if (p.cents !== 0)
        await tx`insert into journal_lines (journal_id, account_id, debit_cents, credit_cents, memo)
                 values (${j!.id}, ${accountId}, ${p.cents > 0 ? p.cents : 0}, ${p.cents < 0 ? -p.cents : 0}, ${p.memo})`;
    await tx`insert into pocket_share_entries (key, hash, date, description, cents, journal_id) values (${t.key}, ${x.hash}, ${t.date}::date, ${t.description}, ${x.cents}, ${j!.id})`;
  }
  await tx`update ledger_imports set filename = ${filename}, date_from = ${dates[0] ?? share.stamp.through}, date_to = ${share.stamp.through},
    lines = ${share.transactions.reduce((x, t) => x + t.lines.length, 0)} where id = ${imp!.id}`;
  await tx`insert into pocket_shares (number, made_at, through, previous_number, changes, filename, imported_by)
    values (${share.stamp.number}, ${share.stamp.madeAt}, ${share.stamp.through}::date, ${share.stamp.previous?.number ?? null}, ${tx.json(changes as never)}, ${filename}, ${userId})`;
  await freshTotals(tx);
  return { number: share.stamp.number, changes: last ? changes : { added: [], changed: [], removed: [] }, first: !last };
}
