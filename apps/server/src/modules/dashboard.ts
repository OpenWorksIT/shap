import type { FastifyInstance } from 'fastify';
import { addMonths, financialYear, monthEnd, monthLabel, monthStart, monthsBetween } from '@shap/shared';
import { requireRole, seesMoney, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import { getSettings, today } from '../lib/books.js';
import { paymentStateSql } from './documents.js';
import { missingStatements } from './statements.js';
import { findDuplicates } from './duplicates.js';
import { findRecurring } from './recurring.js';
import { projectSummarySql, totals, type ProjectSummary } from './projects.js';

export function registerDashboardRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;

  app.get('/api/dashboard', { preHandler: requireRole() }, async (req) => {
    const user = userOrThrow(req);
    const now = today();
    if (!seesMoney(user)) {
      const recent = await sql`
        select e.date, w.name as worker_name, coalesce(p.name, wt.name, 'Not allocated') as job, e.days
        from labour_entries e join workers w on w.id = e.worker_id left join projects p on p.id = e.project_id
        left join work_types wt on wt.id = e.work_type_id where e.created_by = ${user.id} order by e.created_at desc limit 20`;
      return { role: user.role, recentLabour: recent };
    }
    const settings = await getSettings(sql);
    const fy = financialYear(now, settings.fyEndMonth);
    const firstMonth = monthStart(addMonths(now, -11));

    const [series, owing, workers, unallocated, materialsNoJob, balances, projects, uncaptured] = await Promise.all([
      // Last 12 months: invoiced, cost of sales, running costs
      sql<{ month: string; income: number; cos: number; expenses: number }[]>`
        select to_char(l.date, 'YYYY-MM') as month,
          (-sum(l.amount_cents) filter (where a.type = 'income'))::bigint as income,
          (sum(l.amount_cents) filter (where a.type = 'cost_of_sales'))::bigint as cos,
          (sum(l.amount_cents) filter (where a.type = 'expense'))::bigint as expenses
        from ledger l join accounts a on a.id = l.account_id
        where l.date between ${firstMonth}::date and ${monthEnd(now)}::date and a.type in ('income', 'cost_of_sales', 'expense')
        group by 1 order by 1`,
      sql.unsafe(`
        select d.id, d.number, d.issue_date, d.due_date, d.total_cents, coalesce(r.paid, 0)::bigint as paid_cents,
          c.name as client_name, p.name as project_name, ${paymentStateSql} as payment_state
        from documents d left join lateral (select sum(amount_cents) as paid from receipts where invoice_id = d.id) r on true
        left join clients c on c.id = d.client_id left join projects p on p.id = d.project_id
        where d.kind = 'invoice' and d.status = 'issued' and d.written_off_on is null and d.total_cents - coalesce(r.paid, 0) <> 0
        order by d.issue_date`),
      sql<{ id: string; name: string; balanceCents: number }[]>`
        select w.id, w.name,
          (coalesce((select sum(wage_cents + allowance_cents) from labour_entries where worker_id = w.id), 0)
           - coalesce((select sum(amount_cents) from wage_payments where worker_id = w.id), 0))::bigint as balance_cents
        from workers w where w.active order by w.name`,
      sql<{ n: number; cost: number; days: number }[]>`
        select count(*)::int as n, coalesce(sum(wage_cents + allowance_cents), 0)::bigint as cost, coalesce(sum(days), 0)::float as days
        from labour_entries where project_id is null and work_type_id is null`,
      sql<{ n: number; total: number }[]>`
        select count(*)::int as n, coalesce(sum(c.amount_cents), 0)::bigint as total from costs c join cost_categories k on k.id = c.category_id
        where k.kind = 'materials' and c.project_id is null and not c.no_job and c.date >= ${fy.start}::date`,
      sql<{ key: string; balance: number }[]>`
        select a.system_key as key, coalesce(sum(l.amount_cents), 0)::bigint as balance from accounts a
        left join ledger l on l.account_id = a.id and l.date <= ${now}::date
        where a.system_key in ('bank', 'owner_loan', 'receivables', 'wages_payable') group by a.system_key`,
      sql.unsafe(`
        select p.id, p.number, p.name, p.status, c.name as client_name, s.*
        from projects p left join clients c on c.id = p.client_id join (${projectSummarySql}) s on s.id = p.id
        where p.status in ('active', 'invoiced', 'quoted') order by p.number desc limit 12`),
      sql<{ n: number; total: number }[]>`select count(*)::int as n, coalesce(sum(amount_cents), 0)::bigint as total from costs where source_id is null`,
    ]);

    const months = monthsBetween(firstMonth, now).map((m) => {
      const r = series.find((x) => x.month === m);
      const income = r?.income ?? 0;
      const cos = r?.cos ?? 0;
      const expenses = r?.expenses ?? 0;
      return { key: m, label: monthLabel(m), incomeCents: income, costOfSalesCents: cos, expensesCents: expenses, profitCents: income - cos - expenses };
    });
    const fyMonths = months.filter((m) => `${m.key}-01` >= fy.start);
    const sumOf = (xs: typeof months, k: 'incomeCents' | 'costOfSalesCents' | 'expensesCents' | 'profitCents') => xs.reduce((s, m) => s + m[k], 0);
    const bal = (k: string) => balances.find((b) => b.key === k)?.balance ?? 0;
    const thisMonth = months[months.length - 1]!;

    return {
      role: user.role,
      today: now,
      financialYear: fy,
      thisMonth,
      yearToDate: {
        incomeCents: sumOf(fyMonths, 'incomeCents'),
        grossProfitCents: sumOf(fyMonths, 'incomeCents') - sumOf(fyMonths, 'costOfSalesCents'),
        expensesCents: sumOf(fyMonths, 'expensesCents'),
        profitCents: sumOf(fyMonths, 'profitCents'),
      },
      months,
      owing: {
        totalCents: owing.reduce((s, r) => s + Number(r.totalCents) - Number(r.paidCents), 0),
        overdue: owing.filter((r) => r.paymentState === 'overdue').length,
        invoices: owing.slice(-8).reverse(),
      },
      workers: workers.filter((w) => w.balanceCents !== 0),
      owedToWorkersCents: -bal('wages_payable'),
      unallocatedLabour: unallocated[0],
      materialsWithoutJob: materialsNoJob[0],
      uncapturedCosts: uncaptured[0],
      statementsMissing: await missingStatements(sql),
      duplicateCosts: (await findDuplicates(sql)).length,
      // Monthly costs that didn't show up (insurance, bank fees…).
      recurringMissing: (await findRecurring(sql))
        .filter((r) => r.status === 'missing')
        .map((r) => ({ key: r.key, label: r.label, months: r.missingMonths, usualCents: r.usualCents, onStatement: Boolean(r.onStatement) })),
      bankCents: bal('bank'),
      ownerLoanCents: -bal('owner_loan'),
      projects: projects.map((p) => ({ ...p, ...totals(p as unknown as ProjectSummary) })),
    };
  });
}
