import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addDays, addMonths, financialYear, monthEnd } from '@shap/shared';
import { requireAccess, requireRole, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import { audit } from '../lib/audit.js';
import { freshTotals, getSettings, today } from '../lib/books.js';
import { badRequest } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

type Db = Ctx['sql'];

/** The accounts a budget is for: the income statement's. */
const BUDGET_TYPES = ['income', 'cost_of_sales', 'expense'] as const;
const MAX_CENTS = 1_000_000_000_000; // R10 billion a month: more than any small business's

export interface BudgetLine {
  id: string;
  code: string;
  name: string;
  type: (typeof BUDGET_TYPES)[number];
  /** The year's twelve months, first month first, or null when there's no budget for it. */
  budget: number[] | null;
  /** What the books show for each month (income and costs both as positive amounts). */
  actual: number[];
  /** The year before's, month by month: where a budget usually starts. */
  lastYear: number[];
}

/** Each income statement account's twelve months in a year, as the books have them. */
async function actuals(db: Db, start: string, end: string): Promise<Map<string, number[]>> {
  await freshTotals(db);
  const rows = await db<{ accountId: string; month: string; type: string; total: number }[]>`
    select l.account_id, to_char(l.date, 'YYYY-MM') as month, a.type, sum(l.amount_cents)::bigint as total
    from ledger_totals l join accounts a on a.id = l.account_id
    where l.date between ${start}::date and ${end}::date and a.type in ('income', 'cost_of_sales', 'expense')
    group by 1, 2, 3`;
  const out = new Map<string, number[]>();
  for (const r of rows) {
    const i = (Number(r.month.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + Number(r.month.slice(5, 7)) - Number(start.slice(5, 7));
    if (i < 0 || i > 11) continue;
    const m = out.get(r.accountId) ?? Array(12).fill(0);
    // Income is a credit in the books: as an amount earned, it's the other way round.
    m[i] = r.type === 'income' ? -Number(r.total) : Number(r.total);
    out.set(r.accountId, m);
  }
  return out;
}

/**
 * The financial year ending on `fyEnd`: one under the year end in Settings, or one a budget was set
 * for before the year end changed (twelve months, as it was budgeted). Budgets are for twelve
 * months: a year of another length (a first year, or one a change of year end makes longer or
 * shorter) is the accountant's to plan.
 */
async function budgetYear(db: Db, fyEndMonth: number, fyEnd?: string) {
  const fy = financialYear(fyEnd ?? today(), fyEndMonth);
  if (!fyEnd || fy.end === fyEnd) return fy;
  const [kept] = await db<{ n: number }[]>`select count(*)::int as n from budgets where fy_end = ${fyEnd}::date`;
  if (!kept!.n || monthEnd(fyEnd) !== fyEnd) throw badRequest('That isn’t the last day of a financial year');
  const start = addDays(monthEnd(addMonths(fyEnd, -12)), 1);
  return { start, end: fyEnd, label: `year to ${fyEnd}` };
}

/** A financial year's budget against what the books show, account by account. */
export async function budgetReport(db: Db, fyEnd?: string) {
  const settings = await getSettings(db);
  const fy = await budgetYear(db, settings.fyEndMonth, fyEnd);
  const before = financialYear(addMonths(fy.start, -1), settings.fyEndMonth);
  const [now, prev] = await Promise.all([actuals(db, fy.start, fy.end), actuals(db, before.start, before.end)]);
  const budgets = await db<{ accountId: string; months: string[] }[]>`select account_id, months::text[] as months from budgets where fy_end = ${fy.end}::date`;
  const byAccount = new Map(budgets.map((b) => [b.accountId, b.months.map(Number)]));
  const accounts = await db<{ id: string; code: string; name: string; type: BudgetLine['type']; active: boolean }[]>`
    select id, code, name, type, active from accounts where type in ('income', 'cost_of_sales', 'expense') order by code`;
  const zero = () => Array(12).fill(0) as number[];
  const lines: BudgetLine[] = accounts
    .filter((a) => a.active || now.has(a.id) || prev.has(a.id) || byAccount.has(a.id))
    .map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type, budget: byAccount.get(a.id) ?? null, actual: now.get(a.id) ?? zero(), lastYear: prev.get(a.id) ?? zero() }));
  // The months that have ended (all twelve for a year gone by, none for one to come): budget and
  // actual are compared over whole months, not a month part-way through.
  const t = today();
  const monthsDone = t > fy.end ? 12 : t < fy.start ? 0 : (Number(t.slice(0, 4)) - Number(fy.start.slice(0, 4))) * 12 + Number(t.slice(5, 7)) - Number(fy.start.slice(5, 7));
  const months = Array.from({ length: 12 }, (_, i) => addMonths(fy.start, i).slice(0, 7));
  const others = await db<{ fyEnd: string }[]>`select distinct fy_end::text from budgets order by 1`;
  const next = financialYear(addMonths(fy.end, 1), settings.fyEndMonth).end;
  const current = financialYear(t, settings.fyEndMonth).end;
  return { fy, months, monthsDone, lines, years: [...new Set([...others.map((o) => o.fyEnd), current, financialYear(addMonths(current, 1), settings.fyEndMonth).end, fy.end, next])].sort() };
}

const fyEndParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const monthsInput = z.array(z.number().int().min(-MAX_CENTS).max(MAX_CENTS)).length(12);

export function registerBudgetRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;

  app.get('/api/budgets', { preHandler: requireAccess('reports.view') }, async (req) => {
    const { fyEnd } = parse(z.object({ fyEnd: fyEndParam.optional() }), req.query);
    return budgetReport(sql, fyEnd);
  });

  /** Set (or clear, with all twelve months at nothing) the budget for some accounts in a year. */
  app.put('/api/budgets', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const input = parse(z.object({ fyEnd: fyEndParam, lines: z.array(z.object({ accountId: z.string().uuid(), months: monthsInput })).min(1).max(500) }), req.body);
    const settings = await getSettings(sql);
    await budgetYear(sql, settings.fyEndMonth, input.fyEnd);
    const ids = [...new Set(input.lines.map((l) => l.accountId))];
    const ok = await sql<{ id: string }[]>`select id from accounts where id = any(${ids}) and type in ('income', 'cost_of_sales', 'expense')`;
    if (ok.length !== ids.length) throw badRequest('A budget is for income and cost accounts (the income statement’s)');
    let saved = 0;
    let cleared = 0;
    await sql.begin(async (tx) => {
      for (const l of input.lines) {
        if (l.months.every((m) => m === 0)) {
          cleared += (await tx`delete from budgets where account_id = ${l.accountId} and fy_end = ${input.fyEnd}::date`).count;
          continue;
        }
        await tx`
          insert into budgets (account_id, fy_end, months, updated_by) values (${l.accountId}, ${input.fyEnd}::date, ${l.months.map(String)}::bigint[], ${user.id})
          on conflict (account_id, fy_end) do update set months = excluded.months, updated_by = excluded.updated_by, updated_at = now()`;
        saved++;
      }
      await audit(tx, { userId: user.id, action: 'save_budget', entity: 'budget', ip: req.ip, details: { fyEnd: input.fyEnd, saved, cleared, accounts: ids.slice(0, 100) } });
    });
    return { saved, cleared };
  });

  /**
   * Start a year's budget from the year before's figures, month by month, up or down by a
   * percentage. Only accounts without a budget for the year yet are filled: a budget you've
   * set is left as it is.
   */
  app.post('/api/budgets/from-last-year', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const input = parse(z.object({ fyEnd: fyEndParam, percent: z.number().int().min(-90).max(500).default(0) }), req.body);
    const report = await budgetReport(sql, input.fyEnd);
    let filled = 0;
    await sql.begin(async (tx) => {
      for (const l of report.lines) {
        if (l.budget || l.lastYear.every((m) => m === 0)) continue;
        // In whole cents, a half cent away from nothing (up for income and costs alike).
        const months = l.lastYear.map((m) => {
          const q = m * (100 + input.percent);
          return Math.sign(q) * Math.floor((Math.abs(q) + 50) / 100);
        });
        await tx`insert into budgets (account_id, fy_end, months, updated_by) values (${l.id}, ${input.fyEnd}::date, ${months.map(String)}::bigint[], ${user.id}) on conflict do nothing`;
        filled++;
      }
      await audit(tx, { userId: user.id, action: 'start_budget', entity: 'budget', ip: req.ip, details: { fyEnd: input.fyEnd, percent: input.percent, filled } });
    });
    return { filled };
  });
}
