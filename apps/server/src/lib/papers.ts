/**
 * What a client's engagement letters and working papers say of a year (modules/working-papers.ts,
 * the practice's list, and the compile form in the client's books): checks, not locks.
 */
import { createHash } from 'node:crypto';
import { addDays, financialYear, SIGNOFFS, type Signoff } from '@shap/shared';
import type { Db, Sql } from '../db/index.js';
import { trialBalance } from '../modules/reports.js';
import { yearStartOf } from '../statements/build.js';

/** The latest year end that has passed, for a year-end month, on a day. */
export function lastEnded(fyEndMonth: number, on: string): string {
  return financialYear(addDays(financialYear(on, fyEndMonth).start, -1), fyEndMonth).end;
}

/** The trial balance at a year end, as the working papers keep it: the twelve months to it (whatever the year-end month is now). */
export async function yearTb(books: Db, fyEnd: string) {
  const tb = await trialBalance(books, fyEnd, { from: yearStartOf(fyEnd) });
  return {
    rows: tb.rows.map((r) => ({ id: r.id, code: r.code, name: r.name, type: r.type, debitCents: Number(r.debitCents), creditCents: Number(r.creditCents), balanceCents: Number(r.balanceCents) })),
    totals: { debitCents: Number(tb.totals.debitCents), creditCents: Number(tb.totals.creditCents), differenceCents: Number(tb.totals.differenceCents) },
  };
}
export type YearTb = Awaited<ReturnType<typeof yearTb>>;

/**
 * The trial balance's fingerprint: each account (itself, not its code, so a new code isn't a change),
 * what kind of account it is (so moving one from expenses to assets is), and its balance.
 */
export const tbHash = (rows: { id: string; type: string; balanceCents: number }[]) =>
  createHash('sha256')
    .update(
      [...rows]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((r) => `${r.id}:${r.type}:${r.balanceCents}`)
        .join('\n'),
    )
    .digest('hex');

/** A letter as the year's standing needs it. */
export interface CoverLetter {
  id: string;
  status: string;
  services: string[];
  fromYearEnd: string;
  acceptedOn: string | null;
  lastYearEnd: string | null;
  createdAt?: Date | string;
}

/** A letter covers a year: accepted, from that year or before, and not ended before it. */
export const covers = (l: CoverLetter, y: string) =>
  l.acceptedOn !== null && l.fromYearEnd <= y && (l.status === 'accepted' || (l.status === 'ended' && l.lastYearEnd !== null && l.lastYearEnd >= y));

/**
 * What a year's letters say of it. The letter that governs it is the latest (by its first year) of
 * those covering it, for compiling where one covers compiling; its terms are looked at again for the
 * year (ISRS 4410 (Revised) para 26) unless it's that letter's first year. Earlier letters a later one
 * replaced aren't asked for it.
 */
export function letterStanding(letters: CoverLetter[], confirmed: { letterId: string; fyEnd: string }[], y: string) {
  const cover = letters.filter((l) => covers(l, y)).sort((a, b) => (a.fromYearEnd < b.fromYearEnd ? 1 : a.fromYearEnd > b.fromYearEnd ? -1 : String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))));
  const compiling = cover.filter((l) => l.services.includes('compile'));
  const governs = compiling[0] ?? cover[0] ?? null;
  return {
    accepted: cover.length > 0,
    compiling: compiling.length > 0,
    termsLooked: governs !== null && (governs.fromYearEnd === y || confirmed.some((c) => c.letterId === governs.id && c.fyEnd === y)),
  };
}

/** The letters' columns letterStanding needs (days as text). */
const coverCols = (sql: Sql) => sql`id, client_id, status, services, from_year_end::text as from_year_end, accepted_on::text as accepted_on, last_year_end::text as last_year_end, created_at`;

/**
 * What the practice's list (and the compile form) says of a client's letters and a year's papers.
 * `hashOf` gives a client's trial balance fingerprint for the year, and when it was taken, where the
 * books are here: now (`at` null: the compile form has them open), or at the client's last checks (the
 * list, with when by the database's clock, as the sign-offs' are). Each sign-off given before then says
 * if the books have changed since.
 */
export async function papersFor(real: Sql, clientIds: string[], fyEndOf: (id: string) => string | null, hashOf?: (id: string) => { hash: string; at: Date | string | null } | null) {
  if (!clientIds.length) return new Map<string, Papers>();
  const letters = await real<(CoverLetter & { clientId: string })[]>`select ${coverCols(real)} from practice_letters where client_id = any(${clientIds}::uuid[])`;
  const years = await real<{ letterId: string; fyEnd: string }[]>`select letter_id, fy_end::text as fy_end from practice_letter_years where letter_id = any(${letters.map((l) => l.id)}::uuid[])`;
  const notes = await real<{ clientId: string; fyEnd: string; n: number }[]>`
    select client_id, fy_end::text as fy_end, count(*)::int as n from practice_notes where client_id = any(${clientIds}::uuid[]) and cleared_by is null group by 1, 2`;
  const signs = await real<{ clientId: string; fyEnd: string; role: Signoff; tbHash: string | null; at: Date }[]>`
    select client_id, fy_end::text as fy_end, role, tb_hash, at from practice_signoffs where client_id = any(${clientIds}::uuid[])`;
  const out = new Map<string, Papers>();
  for (const id of clientIds) {
    const fyEnd = fyEndOf(id);
    const mine = letters.filter((l) => l.clientId === id);
    // No year known yet (a linked client's checks not run): an accepted letter is still accepted.
    const standing = fyEnd ? letterStanding(mine, years, fyEnd) : { accepted: mine.some((l) => l.status === 'accepted'), compiling: false, termsLooked: false };
    const hash = hashOf?.(id) ?? null;
    const signed = (r: Signoff) => signs.find((s) => s.clientId === id && s.fyEnd === fyEnd && s.role === r);
    out.set(id, {
      fyEnd,
      letter: standing.accepted ? 'accepted' : mine.some((l) => l.status === 'sent') ? 'sent' : mine.some((l) => l.status === 'draft') ? 'draft' : 'none',
      compiling: standing.compiling,
      termsLooked: standing.termsLooked,
      openNotes: fyEnd ? (notes.find((n) => n.clientId === id && n.fyEnd === fyEnd)?.n ?? 0) : 0,
      signed: Object.fromEntries(SIGNOFFS.map((r) => [r, Boolean(signed(r))])) as Record<Signoff, boolean>,
      // Only a fingerprint taken after the sign-off says anything of it (the list's is from the last checks).
      changed: Object.fromEntries(
        SIGNOFFS.map((r) => {
          const s = signed(r);
          return [r, Boolean(hash && s?.tbHash && s.tbHash !== hash.hash && (hash.at === null || new Date(s.at).getTime() <= new Date(hash.at).getTime()))];
        }),
      ) as Record<Signoff, boolean>,
    });
  }
  return out;
}

export interface Papers {
  /** The year the papers are for (the list: the latest of theirs that has ended). */
  fyEnd: string | null;
  /** An accepted letter covering that year (or, failing that, the furthest a letter has got). */
  letter: 'none' | 'draft' | 'sent' | 'accepted';
  /** An accepted letter covering compiling that year. */
  compiling: boolean;
  /** The governing letter's terms looked at again for that year (or it's that letter's first). */
  termsLooked: boolean;
  openNotes: number;
  signed: Record<Signoff, boolean>;
  /** Given, and the books' trial balance has changed since (the compile form: now; the list: at the client's last checks). */
  changed: Record<Signoff, boolean>;
}
