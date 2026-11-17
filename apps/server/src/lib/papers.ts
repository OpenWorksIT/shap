/**
 * What the practice's list says of each client's engagement letters and its latest ended year's
 * working papers (modules/working-papers.ts): checks, not locks.
 */
import { addDays, financialYear, SIGNOFFS, type Signoff } from '@shap/shared';
import type { Sql } from '../db/index.js';

/** The latest year end that has passed, for a year-end month, on a day. */
export function lastEnded(fyEndMonth: number, on: string): string {
  return financialYear(addDays(financialYear(on, fyEndMonth).start, -1), fyEndMonth).end;
}

/** What the practice's list says of a client's letters and its latest ended year's papers. */
export async function papersFor(real: Sql, clientIds: string[], fyEndOf: (id: string) => string | null) {
  if (!clientIds.length) return new Map<string, Papers>();
  const letters = await real<{ id: string; clientId: string; status: string; services: string[]; fromYearEnd: string }[]>`
    select id, client_id, status, services, from_year_end::text as from_year_end from practice_letters where client_id = any(${clientIds}::uuid[])`;
  const years = await real<{ letterId: string; fyEnd: string }[]>`select letter_id, fy_end::text as fy_end from practice_letter_years where letter_id = any(${letters.map((l) => l.id)}::uuid[])`;
  const notes = await real<{ clientId: string; fyEnd: string; n: number }[]>`
    select client_id, fy_end::text as fy_end, count(*)::int as n from practice_notes where client_id = any(${clientIds}::uuid[]) and cleared_by is null group by 1, 2`;
  const signs = await real<{ clientId: string; fyEnd: string; role: Signoff }[]>`
    select client_id, fy_end::text as fy_end, role from practice_signoffs where client_id = any(${clientIds}::uuid[])`;
  const out = new Map<string, Papers>();
  for (const id of clientIds) {
    const fyEnd = fyEndOf(id);
    const mine = letters.filter((l) => l.clientId === id);
    const live = mine.filter((l) => l.status === 'accepted' && (!fyEnd || l.fromYearEnd <= fyEnd));
    out.set(id, {
      fyEnd,
      letter: mine.some((l) => l.status === 'accepted') ? 'accepted' : mine.some((l) => l.status === 'sent') ? 'sent' : mine.some((l) => l.status === 'draft') ? 'draft' : 'none',
      compiling: live.some((l) => l.services.includes('compile')),
      termsLooked: live.length > 0 && live.every((l) => l.fromYearEnd === fyEnd || years.some((y) => y.letterId === l.id && y.fyEnd === fyEnd)),
      openNotes: fyEnd ? (notes.find((n) => n.clientId === id && n.fyEnd === fyEnd)?.n ?? 0) : 0,
      signed: Object.fromEntries(SIGNOFFS.map((r) => [r, signs.some((s) => s.clientId === id && s.fyEnd === fyEnd && s.role === r)])) as Record<Signoff, boolean>,
    });
  }
  return out;
}

export interface Papers {
  /** The latest year of theirs that has ended. */
  fyEnd: string | null;
  letter: 'none' | 'draft' | 'sent' | 'accepted';
  /** An accepted letter covering compiling that year. */
  compiling: boolean;
  /** Its terms looked at again for that year (or it's the letter's first). */
  termsLooked: boolean;
  openNotes: number;
  signed: Record<Signoff, boolean>;
}

