/**
 * Monthly costs: the ones that come every month (insurance, bank fees, subscriptions, rent),
 * found from what you've captured, and a warning when one doesn't show up.
 *
 * A pattern is a cost type plus supplier (by its first word) that appeared in at least three
 * months running, in the last half year. It's missing from the month after the last one it
 * appeared in until it shows again, for up to three months (after that it has stopped: no more
 * warnings). This month counts once its usual day is a few days past. Only running costs
 * (overheads) are watched: job materials come and go with the work.
 */
import type { FastifyInstance } from 'fastify';
import { addMonths, todayIso } from '@shap/shared';
import { z } from 'zod';
import { requireRole, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { parse } from '../lib/validate.js';
import { similar, tokens } from './bank/match.js';

/** Days after the usual day before this month's is called missing. */
const GRACE_DAYS = 5;
const ym = (iso: string) => iso.slice(0, 7);
const monthBack = (m: string, n: number) => ym(addMonths(`${m}-01`, -n));
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : 0;
};
const mostCommon = (xs: string[]) => {
  const n = new Map<string, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
};

export interface Recurring {
  key: string;
  label: string;
  supplier: string;
  description: string;
  categoryId: string;
  categoryName: string;
  sourceId: string | null;
  usualCents: number;
  usualDay: number;
  lastSeen: string;
  /** The last six months and this one, oldest first: what was captured in each. */
  months: { month: string; cents: number; skipped: boolean }[];
  status: 'ok' | 'due' | 'missing' | 'stopped';
  missingMonths: string[];
  /** Not captured, but there's a statement line that looks like it. */
  onStatement: { lineId: string; sourceId: string; date: string; description: string; amountCents: number } | null;
}

export async function findRecurring(db: Db, todayDate = todayIso('Africa/Johannesburg')): Promise<Recurring[]> {
  const M = ym(todayDate);
  const from = `${monthBack(M, 9)}-01`;
  type Row = { date: string; amountCents: number; supplier: string; description: string; categoryId: string; categoryName: string; sourceId: string | null };
  const rows: Row[] = await db<Row[]>`
    select c.date::text, c.amount_cents, c.supplier, c.description, c.category_id, k.name as category_name, c.source_id
    from costs c join cost_categories k on k.id = c.category_id
    where k.kind = 'overhead' and c.amount_cents > 0 and c.date >= ${from}::date and c.date <= ${todayDate}::date`;
  const marks = await db<{ key: string; month: string; kind: string }[]>`select key, month, kind from recurring_marks`;
  const stopped = new Set(marks.filter((m) => m.kind === 'stopped').map((m) => m.key));
  const skipped = new Set(marks.filter((m) => m.kind === 'skipped').map((m) => `${m.key}|${m.month}`));

  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const word = tokens(r.supplier || r.description)[0] ?? '';
    const key = `${r.categoryId}|${word}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  const out: Recurring[] = [];
  for (const [key, list] of groups) {
    const byMonth = new Map<string, { cents: number; days: number[] }>();
    for (const r of list) {
      const m = byMonth.get(ym(r.date)) ?? { cents: 0, days: [] };
      m.cents += Number(r.amountCents);
      m.days.push(Number(r.date.slice(8, 10)));
      byMonth.set(ym(r.date), m);
    }
    const has = (m: string) => byMonth.has(m) || skipped.has(`${key}|${m}`);
    // The latest run of three months in a row, ending within the last six full months.
    let runEnd: string | null = null;
    for (let i = 0; i <= 9 && !runEnd; i++) {
      const m = monthBack(M, i);
      if (byMonth.has(m) && byMonth.has(monthBack(m, 1)) && byMonth.has(monthBack(m, 2))) runEnd = m;
    }
    if (!runEnd) continue;
    const present = [...byMonth.keys()].sort();
    const lastSeen = present[present.length - 1]!;
    const recent = present.slice(-3).map((m) => byMonth.get(m)!);
    const usualCents = median(recent.map((x) => x.cents));
    const usualDay = median(recent.flatMap((x) => x.days));
    // Months it should have appeared in since it was last seen.
    const missing: string[] = [];
    for (let m = ym(addMonths(`${lastSeen}-01`, 1)); m <= M; m = ym(addMonths(`${m}-01`, 1))) {
      const thisMonth = m === M;
      if (thisMonth && Number(todayDate.slice(8, 10)) <= usualDay + GRACE_DAYS) break;
      if (!has(m)) missing.push(m);
    }
    // Gone for more than three months: it has stopped, nothing to warn about any more.
    const lapsed = missing.length > 3;
    if (lapsed && !stopped.has(key)) continue;
    const status: Recurring['status'] = stopped.has(key) ? 'stopped' : missing.length ? 'missing' : has(M) ? 'ok' : 'due';
    const months = Array.from({ length: 7 }, (_, i) => monthBack(M, 6 - i)).map((m) => ({ month: m, cents: byMonth.get(m)?.cents ?? 0, skipped: skipped.has(`${key}|${m}`) }));
    const last = list.filter((r) => ym(r.date) === lastSeen).sort((a, b) => b.date.localeCompare(a.date))[0]!;
    const supplier = mostCommon(list.map((r) => r.supplier).filter(Boolean));
    out.push({
      key,
      label: supplier || mostCommon(list.map((r) => r.description)),
      supplier,
      description: last.description,
      categoryId: last.categoryId,
      categoryName: last.categoryName,
      sourceId: mostCommon(list.map((r) => r.sourceId ?? '')) || null,
      usualCents,
      usualDay,
      lastSeen,
      months,
      status,
      missingMonths: status === 'missing' ? missing : [],
      onStatement: null,
    });
  }

  // A missing one may already be on a bank statement, just not captured yet.
  const missingOnes = out.filter((r) => r.status === 'missing');
  if (missingOnes.length) {
    const lines = await db<{ id: string; sourceId: string; date: string; description: string; amountCents: number }[]>`
      select l.id, l.source_id, l.date::text, l.description, l.amount_cents from bank_lines l
      where l.amount_cents < 0 and not l.ignored and l.date >= ${from}::date
        and not exists (select 1 from bank_matches m where m.bank_line_id = l.id)`;
    for (const r of missingOnes) {
      const hit = lines.find(
        (l) =>
          r.missingMonths.includes(ym(l.date)) &&
          -l.amountCents >= r.usualCents * 0.65 &&
          -l.amountCents <= r.usualCents * 1.35 &&
          (similar(l.description, r.label) || similar(l.description, r.description)),
      );
      if (hit) r.onStatement = { lineId: hit.id, sourceId: hit.sourceId, date: hit.date, description: hit.description, amountCents: Number(hit.amountCents) };
    }
  }
  const order = { missing: 0, due: 1, ok: 2, stopped: 3 };
  return out.sort((a, b) => order[a.status] - order[b.status] || b.usualCents - a.usualCents);
}

export function registerRecurringRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;
  const mark = z.object({ key: z.string().min(3).max(200), month: z.string().regex(/^\d{4}-\d{2}$/).optional() });

  app.get('/api/costs/recurring', { preHandler: requireRole('owner', 'accountant') }, async () => findRecurring(sql));

  /** "Stopped on purpose" (no month) or "skip this month" (a month). */
  app.post('/api/costs/recurring/mark', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { key, month } = parse(mark, req.body);
    await sql`insert into recurring_marks (key, month, kind, user_id) values (${key}, ${month ?? ''}, ${month ? 'skipped' : 'stopped'}, ${user.id})
      on conflict (key, month) do nothing`;
    await audit(sql, { userId: user.id, action: month ? 'skip_recurring' : 'stop_recurring', entity: 'cost', ip: req.ip, details: { key, month } });
    return { ok: true };
  });

  /** Watch it again (no month), or un-skip a month. */
  app.post('/api/costs/recurring/unmark', { preHandler: requireRole('owner') }, async (req) => {
    const { key, month } = parse(mark, req.body);
    await sql`delete from recurring_marks where key = ${key} and month = ${month ?? ''}`;
    return { ok: true };
  });
}
