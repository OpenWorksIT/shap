import type { FastifyInstance } from 'fastify';
import { addDays, addMonths, cipcAnnualReturns, cipcKind, featureOn, financialYear, lastBusinessDay, monthEnd, monthLabel, monthStart, monthsBetween, ROE_SEASONS, vat201Due, vat201Label, vatPeriod, SARS_CHECKED_TO, taxYearEnd, type BusinessType, type VatCategory } from '@shap/shared';
import { can, requireRole, seesBooks, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import { getSettings, today, freshTotals } from '../lib/books.js';
import { paymentStateSql } from './documents.js';
import { lockState } from './periods.js';
import { missingStatements } from './statements.js';
import { findDuplicates } from './duplicates.js';
import { findRecurring } from './recurring.js';
import { vatStatus } from './vat.js';
import { payrollAttention, sdlLine } from './payroll.js';
import { bills } from './bills.js';
import { monthlyAttention } from './monthly.js';
import { projectSummarySql, totals, type ProjectSummary } from './projects.js';

/**
 * Debtor or creditor days: what's owed now against what was invoiced (or billed) over `over` days,
 * in days. 0 only when nothing is owed (a little owed is at least a day); null when something's
 * owed but there's nothing in the period to measure it against.
 */
export const daysOf = (owed: number, total: number, over = 365): number | null => (owed <= 0 ? 0 : total > 0 ? Math.max(1, Math.round((owed / total) * over)) : null);

/**
 * The money on hand: cash and cash equivalents as the statements have them (the accounts on the
 * cash and bank overdraft lines, IFRS for SMEs 7.2), and what the business's cards owe (the card
 * sources' accounts that aren't on those lines: a liability, negative when something's owed). The
 * owner's loan, a card in the owner's own name, isn't the business's.
 */
export async function cashPosition(db: Ctx['sql'], now: string): Promise<{ inBankCents: number; cardsOweCents: number }> {
  const [c] = await db<{ cash: number }[]>`
    select coalesce(sum(l.amount_cents), 0)::bigint as cash from ledger_totals l join accounts a on a.id = l.account_id
    where a.statement_line in ('cash', 'bank_overdraft') and l.date <= ${now}::date`;
  const [k] = await db<{ owed: number }[]>`
    select coalesce(sum(l.amount_cents), 0)::bigint as owed from ledger_totals l
    where l.date <= ${now}::date and l.account_id in (
      select ps.account_id from payment_sources ps join accounts a on a.id = ps.account_id
      where ps.kind = 'card' and a.statement_line not in ('cash', 'bank_overdraft') and a.system_key is distinct from 'owner_loan')`;
  return { inBankCents: Number(c!.cash), cardsOweCents: -Number(k!.owed) };
}

/**
 * What was invoiced (less credit notes; counter sales are paid there and then, so aren't counted)
 * and billed by suppliers, with their VAT, over the last 12 months, and over how many days: a
 * business younger than a year is measured over the days since its first invoice (or bill).
 */
async function creditTurnover(db: Ctx['sql'], now: string) {
  const from = addDays(now, -364);
  const [i] = await db<{ total: number; first: string | null }[]>`
    select coalesce(sum(case when kind = 'invoice' then total_cents else -total_cents end) filter (where issue_date >= ${from}::date and issue_date <= ${now}::date), 0)::bigint as total,
      min(issue_date) filter (where kind = 'invoice')::text as first
    from documents where status = 'issued' and ((kind = 'invoice' and not counter) or kind = 'credit_note')`;
  const [b] = await db<{ total: number; first: string | null }[]>`
    select coalesce(sum(c.amount_cents) filter (where c.date >= ${from}::date and c.date <= ${now}::date), 0)::bigint as total, min(c.date)::text as first
    from costs c join payment_sources s on s.id = c.source_id and s.role = 'bills'`;
  const over = (first: string | null) => (first ? Math.min(365, Math.max(1, Math.round((Date.parse(now) - Date.parse(first)) / 86_400_000) + 1)) : 365);
  return { invoicedCents: Number(i!.total), invoiceDays: over(i!.first), billedCents: Number(b!.total), billDays: over(b!.first) };
}

export function registerDashboardRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;

  app.get('/api/dashboard', { preHandler: requireRole() }, async (req) => {
    const user = userOrThrow(req);
    const now = today();
    // Home's figures are the books': staff who don't read the reports see what they've logged.
    if (!seesBooks(user)) {
      const recent = await sql`
        select e.date, w.name as worker_name, coalesce(p.name, wt.name, 'Not allocated') as job, e.days
        from labour_entries e join workers w on w.id = e.worker_id left join projects p on p.id = e.project_id
        left join work_types wt on wt.id = e.work_type_id where e.created_by = ${user.id} order by e.created_at desc limit 20`;
      return { role: user.role, limited: true, recentLabour: recent };
    }
    const settings = await getSettings(sql);
    const fy = financialYear(now, settings.fyEndMonth);
    const firstMonth = monthStart(addMonths(now, -11));
    // Parts of the app that are switched off aren't asked about.
    const on = (k: Parameters<typeof featureOn>[1]) => featureOn(settings.features, k);
    const none = Promise.resolve([] as never[]);

    await freshTotals(sql);
    const [series, owing, workers, unallocated, materialsNoJob, balances, projects, uncaptured] = await Promise.all([
      // Last 12 months: invoiced, cost of sales, running costs
      sql<{ month: string; income: number; cos: number; expenses: number; revenue: number; cosLine: number; fin: number; tax: number }[]>`
        select to_char(l.date, 'YYYY-MM') as month,
          (-sum(l.amount_cents) filter (where a.type = 'income'))::bigint as income,
          (sum(l.amount_cents) filter (where a.type = 'cost_of_sales'))::bigint as cos,
          (sum(l.amount_cents) filter (where a.type = 'expense'))::bigint as expenses,
          -- Revenue and cost of sales as the statements have them (their lines, not the accounts'
          -- types): the gross margin, as the income statement's gross profit.
          (-sum(l.amount_cents) filter (where a.statement_line = 'revenue'))::bigint as revenue,
          (sum(l.amount_cents) filter (where a.statement_line = 'cost_of_sales'))::bigint as cos_line,
          (sum(l.amount_cents) filter (where a.statement_line = 'finance_costs'))::bigint as fin,
          (sum(l.amount_cents) filter (where a.statement_line = 'income_tax'))::bigint as tax
        from ledger_totals l join accounts a on a.id = l.account_id
        -- To today: "to date" (an entry dated later this month isn't in yet).
        where l.date between ${firstMonth}::date and ${now}::date and a.type in ('income', 'cost_of_sales', 'expense')
        group by 1 order by 1`,
      sql.unsafe(`
        select d.id, d.number, d.issue_date, d.due_date, d.total_cents, coalesce(r.paid, 0)::bigint as paid_cents,
          c.name as client_name, c.phone as client_phone, c.email as client_email, d.reminded_at, d.reminders, d.pay_link,
          p.name as project_name, ${paymentStateSql} as payment_state
        from documents d left join lateral (select sum(amount_cents) as paid from receipts where invoice_id = d.id) r on true
        left join clients c on c.id = d.client_id left join projects p on p.id = d.project_id
        where d.kind = 'invoice' and d.status = 'issued' and d.written_off_on is null and d.total_cents - coalesce(r.paid, 0) <> 0
        order by d.issue_date`),
      !on('workers') ? none : sql<{ id: string; name: string; balanceCents: number }[]>`
        select w.id, w.name,
          (coalesce((select sum(wage_cents + allowance_cents) from labour_entries where worker_id = w.id), 0)
           - coalesce((select sum(amount_cents) from wage_payments where worker_id = w.id), 0))::bigint as balance_cents
        from workers w where w.active order by w.name`,
      !on('workers') ? Promise.resolve([{ n: 0, cost: 0, days: 0 }]) : sql<{ n: number; cost: number; days: number }[]>`
        select count(*)::int as n, coalesce(sum(wage_cents + allowance_cents), 0)::bigint as cost, coalesce(sum(days), 0)::float as days
        from labour_entries where project_id is null and work_type_id is null`,
      !on('jobs') ? Promise.resolve([{ n: 0, total: 0 }]) : sql<{ n: number; total: number }[]>`
        select count(*)::int as n, coalesce(sum(c.amount_cents), 0)::bigint as total from costs c join cost_categories k on k.id = c.category_id
        where k.kind = 'materials' and c.project_id is null and not c.no_job and c.date >= ${fy.start}::date`,
      sql<{ key: string; balance: number }[]>`
        select a.system_key as key, coalesce(sum(l.amount_cents), 0)::bigint as balance from accounts a
        left join ledger_totals l on l.account_id = a.id and l.date <= ${now}::date
        where a.system_key in ('bank', 'owner_loan', 'receivables', 'wages_payable', 'payables') group by a.system_key`,
      !on('jobs') ? none : sql.unsafe(`
        select p.id, p.number, p.name, p.status, c.name as client_name, s.*
        from projects p left join clients c on c.id = p.client_id join (${projectSummarySql}) s on s.id = p.id
        where p.status in ('active', 'invoiced', 'quoted') order by p.number desc limit 12`),
      sql<{ n: number; total: number }[]>`select count(*)::int as n, coalesce(sum(amount_cents), 0)::bigint as total from costs where source_id is null`,
    ]);
    const cash = await cashPosition(sql, now);
    const turnover = await creditTurnover(sql, now);

    const months = monthsBetween(firstMonth, now).map((m) => {
      const r = series.find((x) => x.month === m);
      const income = r?.income ?? 0;
      const cos = r?.cos ?? 0;
      const expenses = r?.expenses ?? 0;
      return { key: m, label: monthLabel(m), incomeCents: income, costOfSalesCents: cos, expensesCents: expenses, profitCents: income - cos - expenses, revenueCents: Number(r?.revenue ?? 0), grossCostCents: Number(r?.cosLine ?? 0), financeCents: Number(r?.fin ?? 0), taxCents: Number(r?.tax ?? 0) };
    });
    const fyMonths = months.filter((m) => `${m.key}-01` >= fy.start);
    const sumOf = (xs: typeof months, k: 'incomeCents' | 'costOfSalesCents' | 'expensesCents' | 'profitCents' | 'revenueCents' | 'grossCostCents' | 'financeCents' | 'taxCents') => xs.reduce((s, m) => s + m[k], 0);
    const bal = (k: string) => balances.find((b) => b.key === k)?.balance ?? 0;
    const thisMonth = months[months.length - 1]!;

    return {
      role: user.role,
      today: now,
      financialYear: fy,
      thisMonth,
      yearToDate: {
        incomeCents: sumOf(fyMonths, 'incomeCents'),
        // Revenue less cost of sales, as the income statement's gross profit.
        revenueCents: sumOf(fyMonths, 'revenueCents'),
        grossProfitCents: sumOf(fyMonths, 'revenueCents') - sumOf(fyMonths, 'grossCostCents'),
        expensesCents: sumOf(fyMonths, 'expensesCents'),
        profitCents: sumOf(fyMonths, 'profitCents'),
        // Below gross profit, so the tiles add up, as the statements set them out: income that
        // isn't revenue (interest, other income), running costs, finance costs and income tax.
        // Gross profit + other income − running costs − finance costs − income tax = profit.
        otherIncomeCents: sumOf(fyMonths, 'incomeCents') - sumOf(fyMonths, 'revenueCents'),
        financeCostsCents: sumOf(fyMonths, 'financeCents'),
        incomeTaxCents: sumOf(fyMonths, 'taxCents'),
        runningCostsCents:
          sumOf(fyMonths, 'revenueCents') - sumOf(fyMonths, 'grossCostCents') + (sumOf(fyMonths, 'incomeCents') - sumOf(fyMonths, 'revenueCents')) - sumOf(fyMonths, 'profitCents') - sumOf(fyMonths, 'financeCents') - sumOf(fyMonths, 'taxCents'),
      },
      months,
      owing: {
        totalCents: owing.reduce((s, r) => s + Number(r.totalCents) - Number(r.paidCents), 0),
        overdue: owing.filter((r) => r.dueDate && String(r.dueDate) < now && Number(r.totalCents) > Number(r.paidCents)).length,
        invoices: owing.slice(-8).reverse(),
      },
      // Supplier bills due within a week (or overdue), when bills are switched on.
      billsDue: on('bills') ? (await bills(sql, 'open')).filter((b) => (b.dueDate ?? b.date) <= addDays(now, 7)) : [],
      // Overdue invoices to remind (oldest first), when payment reminders are switched on.
      // Part-paid ones past their due date too: the rest is just as late.
      overdue: on('reminders') ? owing.filter((r) => r.dueDate && String(r.dueDate) < now && Number(r.totalCents) > Number(r.paidCents)).slice(0, 30) : [],
      workers: workers.filter((w) => w.balanceCents !== 0),
      owedToWorkersCents: -bal('wages_payable'),
      unallocatedLabour: unallocated[0],
      materialsWithoutJob: materialsNoJob[0],
      uncapturedCosts: uncaptured[0],
      statementsMissing: on('bank') ? await missingStatements(sql) : [],
      duplicateCosts: (await findDuplicates(sql)).length,
      monthlyInvoices: await monthlyAttention(sql),
      vat: await vatStatus(sql, now),
      sarsDue: await payrollAttention(sql, now),
      // Monthly costs that didn't show up (insurance, bank fees…).
      recurringMissing: (await findRecurring(sql))
        .filter((r) => r.status === 'missing')
        .map((r) => ({ key: r.key, label: r.label, months: r.missingMonths, usualCents: r.usualCents, onStatement: Boolean(r.onStatement) })),
      // The time tracker's clock, if one is running.
      timer: on('timeTracker')
        ? ((await sql`select t.id, t.started_at, t.project_id, t.note, p.name as project_name from time_entries t left join projects p on p.id = t.project_id where t.ended_at is null and t.user_id is not distinct from ${user.id}`)[0] ?? null)
        : null,
      taxDue: taxDue(settings, now),
      // This version's SARS tables were checked up to SARS_CHECKED_TO: a later tax year needs an update.
      sarsCheckedTo: taxYearEnd(now) > SARS_CHECKED_TO ? SARS_CHECKED_TO : null,
      // SDL off, but salaries and day wages over the last 12 months passed R500 000.
      sdlLine: can(user, 'payroll.view') && can(user, 'labour.view') ? await sdlLine(sql, settings.sdl, now) : null,
      // Month end due (last month still open) or the books reopened: for whoever may lock them.
      periods: can(user, 'books.lock') ? await (async () => { const p = await lockState(sql); return { monthDue: p.monthDue, closes: p.closes, reopened: p.reopened, lockDate: p.lockDate, next: p.monthEnd.next }; })() : null,
      bankCents: bal('bank'),
      cash,
      // How long clients take to pay, and the business takes to pay its supplier bills, on average:
      // what's owed now against the invoices (or bills) of the last 12 months, or of the days since
      // the first, with their VAT. Rough by nature (a year's average, today's balance): "about".
      debtorDays: daysOf(bal('receivables'), turnover.invoicedCents, turnover.invoiceDays),
      // Supplier bills are what puts anything in creditors: without them, there's nothing to say.
      creditorDays: on('bills') ? daysOf(-bal('payables'), turnover.billedCents, turnover.billDays) : null,
      ownerLoanCents: -bal('owner_loan'),
      projects: projects.map((p) => ({ ...p, ...totals(p as unknown as ProjectSummary) })),
    };
  });
}

/**
 * Dates coming up in the next five weeks: the VAT201 for the period just ended and turnover tax's
 * interim payments (SARS), the CIPC annual return of a company or CC whose date of incorporation is
 * in Settings, and the Compensation Fund's return of earnings for an employer registered with it,
 * once the Fund has announced the season. (Payroll's EMP201 is in sarsDue.) Reminders: Shap files
 * nothing with SARS, CIPC or the Fund.
 */
/**
 * A return coming up, for Home: whose it is (SARS, CIPC or the Compensation Fund), what, when, and
 * where in Shap to look. `due` is null for a reminder with no date Shap knows (the Fund's season
 * not in Shap's tables yet); `past` for one whose date has gone by (Shap can't tell whether it was
 * filed).
 */
export interface TaxDue {
  key: string;
  body: 'SARS' | 'CIPC' | 'Compensation Fund';
  label: string;
  due: string | null;
  past?: boolean;
  to: string;
  action: string;
}

export function taxDue(
  settings: { vatRegistered: boolean; vatCategory: VatCategory; turnoverTax: boolean; fyEndMonth: number; businessType?: string; incorporatedOn?: string | null; coidaRegistered?: boolean | null; features?: Record<string, boolean> },
  now: string,
): TaxDue[] {
  const soon = addDays(now, 35);
  const out: TaxDue[] = [];
  if (settings.vatRegistered) {
    const current = vatPeriod(now, settings.vatCategory, settings.fyEndMonth);
    const last = vatPeriod(addMonths(current.start, -1), settings.vatCategory, settings.fyEndMonth);
    const due = vat201Due(last.end);
    if (due >= now && due <= soon) out.push({ key: `vat201-${last.end}`, body: 'SARS', label: vat201Label(last), due, to: '/accounts?tab=vat201', action: 'Figures' });
  }
  if (settings.turnoverTax) {
    const fy = financialYear(now, settings.fyEndMonth);
    const [y1, m1] = addMonths(fy.start, 5).split('-').map(Number) as [number, number];
    const [y2, m2] = fy.end.split('-').map(Number) as [number, number];
    for (const [label, due] of [['First turnover tax payment', lastBusinessDay(y1, m1)], ['Second turnover tax payment', lastBusinessDay(y2, m2)]] as const)
      if (due >= now && due <= soon) out.push({ key: `tt-${due}`, body: 'SARS', label, due, to: '/accounts?tab=tax', action: 'Figures' });
  }
  const cipc = settings.businessType ? cipcKind(settings.businessType as BusinessType) : null;
  // CIPC's annual return, from five weeks before it's due to a month after (not filing for long can
  // end in the company being deregistered: Companies Act s82(3)).
  if (cipc && settings.incorporatedOn)
    for (const d of cipcAnnualReturns(cipc, settings.incorporatedOn, addDays(now, -30), soon)) out.push({ ...d, body: 'CIPC', past: d.due < now, to: '/settings?tab=company', action: 'Settings' });
  if (settings.coidaRegistered) {
    const payroll = featureOn(settings.features ?? {}, 'payroll');
    const where = { to: payroll ? '/payroll' : '/workers', action: payroll ? 'Payroll' : 'Workers' };
    for (const d of ROE_SEASONS) if (d.due >= now && d.due <= soon) out.push({ key: d.key, body: 'Compensation Fund', label: d.label, due: d.due, ...where });
    // From April to July, the season for the assessment year just ended, if it isn't in Shap's
    // tables yet: said, so that no reminder isn't read as nothing due.
    const y = Number(now.slice(0, 4));
    const m = Number(now.slice(5, 7));
    if (m >= 4 && m <= 7 && !ROE_SEASONS.some((s) => s.opens.startsWith(String(y))))
      out.push({ key: `roe-${y - 1}-unknown`, body: 'Compensation Fund', label: `Return of earnings to the Compensation Fund (March ${y - 1} to February ${y}): its dates aren’t in this version of Shap. The season usually opens in April: watch for the Fund’s notice, or ask your accountant`, due: null, ...where });
  }
  return out;
}
