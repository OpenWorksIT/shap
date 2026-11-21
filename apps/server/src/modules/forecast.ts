import type { FastifyInstance } from 'fastify';
import { addDays, addMonths, emp201Due, featureOn, formatDate, monthEnd, vat201Due, vatPeriod } from '@shap/shared';
import { requireAccess } from '../auth.js';
import type { Ctx } from '../context.js';
import { freshTotals, getSettings, today } from '../lib/books.js';
import { bills } from './bills.js';
import { cashPosition } from './dashboard.js';
import { payrollAttention } from './payroll.js';
import { findRecurring } from './recurring.js';

type Db = Ctx['sql'];

export const FORECAST_WEEKS = 13;
/** Invoices further overdue than this aren't counted as coming in: they're shown apart. */
export const LONG_OVERDUE_DAYS = 90;

export interface ForecastItem {
  /** The week it falls in (0 is this week) and the day. */
  week: number;
  date: string;
  label: string;
  /** Money in positive, money out negative. */
  cents: number;
  kind: 'invoice' | 'overdue_invoice' | 'bill' | 'overdue_bill' | 'booked' | 'payroll' | 'emp201' | 'dwt' | 'wages_owed' | 'dividends' | 'day_wages' | 'vat' | 'monthly_cost';
}

export interface Forecast {
  asOf: string;
  /** Cash and cash equivalents today, as the statements have them (the cash and overdraft lines). */
  openingCents: number;
  /** What the business's cards owe today: not in the weeks (when they're paid off is yours to say). */
  cardsOweCents: number;
  weeks: { start: string; end: string; inCents: number; outCents: number; closingCents: number }[];
  items: ForecastItem[];
  lowest: { week: number; closingCents: number } | null;
  /** Invoices more than LONG_OVERDUE_DAYS overdue: not counted as coming in. */
  longOverdue: { count: number; cents: number; days: number };
}

/** A month (YYYY-MM) as words: "December 2026". */
const monthWords = (ym: string) => formatDate(`${ym}-01`, 'long').replace(/^1 /, '');
/** The `day`th of the month `m` (YYYY-MM-..), or its last day when it's shorter. */
const dayOf = (m: string, day: number) => `${m.slice(0, 8)}${String(Math.min(day, Number(monthEnd(m).slice(8, 10)))).padStart(2, '0')}`;

/**
 * A 13-week cash-flow forecast from what's in the books: the cash now (as the statements count it),
 * then each week's money in (invoices, on their due dates) and out (supplier bills on theirs, what's
 * already in the books for a day to come, salaries on the usual pay day and the EMP201 after them,
 * dividends tax and wages owed, casual workers' day wages at their recent weekly average, the VAT on
 * its VAT201, and the monthly costs that come every month). It's an estimate: clients pay late,
 * sales not made yet and costs not in the books aren't in it, and provisional and turnover tax,
 * card and loan repayments aren't either. Overdue invoices and bills are put in this week, as if
 * settled now, except invoices more than 90 days overdue, which are shown apart.
 */
export async function cashForecast(db: Db, now = today()): Promise<Forecast> {
  const settings = await getSettings(db);
  const on = (k: Parameters<typeof featureOn>[1]) => featureOn(settings.features, k);
  const end = addDays(now, FORECAST_WEEKS * 7 - 1);
  const weekOf = (d: string) => Math.max(0, Math.floor((Date.parse(d) - Date.parse(now)) / (7 * 86_400_000)));
  const items: ForecastItem[] = [];
  const add = (date: string, label: string, cents: number, kind: ForecastItem['kind']) => {
    if (!cents) return;
    const d = date < now ? now : date;
    if (d > end) return;
    items.push({ week: weekOf(d), date: d, label, cents, kind });
  };

  await freshTotals(db);
  const { inBankCents: openingCents, cardsOweCents } = await cashPosition(db, now);
  const balanceOf = async (key: string, upTo = now) => {
    const [b] = await db<{ b: number }[]>`
      select coalesce(sum(l.amount_cents), 0)::bigint as b from ledger_totals l join accounts a on a.id = l.account_id where a.system_key = ${key} and l.date <= ${upTo}::date`;
    return Number(b!.b);
  };

  // Already in the books for a day to come (a pay run paid on its pay day, a cost or a payment
  // dated ahead): the cash accounts' movements after today, as they're booked.
  const SOURCE_WORDS: Record<string, string> = { pay_run: 'pay run', cost: 'costs', receipt: 'payments received', wage_payment: 'wages paid', journal: 'journals', bill_payment: 'bills paid' };
  const ahead = await db<{ date: string; source: string; cents: number }[]>`
    select l.date::text, l.source, sum(l.amount_cents)::bigint as cents from ledger_totals l join accounts a on a.id = l.account_id
    where a.statement_line in ('cash', 'bank_overdraft') and l.date > ${now}::date and l.date <= ${end}::date
    group by 1, 2 order by 1, 2`;
  for (const b of ahead) add(b.date, `In the books for that day: ${SOURCE_WORDS[b.source] ?? b.source.replace(/_/g, ' ')}`, Number(b.cents), 'booked');

  // Money in: what clients owe, on each invoice's due date (or today, when it's past). Long overdue
  // ones aren't counted: they're shown apart.
  const owing = await db<{ number: string; dueDate: string | null; issueDate: string; owing: number; clientName: string | null }[]>`
    select d.number, d.due_date::text, d.issue_date::text, (d.total_cents - coalesce(r.paid, 0))::bigint as owing, c.name as client_name
    from documents d left join lateral (select sum(amount_cents) as paid from receipts where invoice_id = d.id) r on true
    left join clients c on c.id = d.client_id
    where d.kind = 'invoice' and d.status = 'issued' and d.written_off_on is null and d.total_cents - coalesce(r.paid, 0) > 0`;
  const longOverdue = { count: 0, cents: 0, days: LONG_OVERDUE_DAYS };
  for (const i of owing) {
    const due = i.dueDate ?? i.issueDate;
    if (due < addDays(now, -LONG_OVERDUE_DAYS)) {
      longOverdue.count++;
      longOverdue.cents += Number(i.owing);
      continue;
    }
    const late = due < now;
    add(due, `${late ? 'Overdue: ' : ''}invoice ${i.number}${i.clientName ? ` (${i.clientName})` : ''}`, Number(i.owing), late ? 'overdue_invoice' : 'invoice');
  }

  // Money out: supplier bills, on their due dates.
  if (on('bills'))
    for (const b of await bills(db, 'open')) {
      const due = b.dueDate ?? b.date;
      add(due, `${due < now ? 'Overdue: ' : ''}${b.supplier || b.description}${b.billNumber ? ` (bill ${b.billNumber})` : ''}`, -Number(b.owingCents), due < now ? 'overdue_bill' : 'bill');
    }

  // Owed now: casual workers' wages earned and not paid, and dividends declared and not paid.
  const wagesOwed = -(await balanceOf('wages_payable'));
  if (wagesOwed > 0) add(now, 'Wages owed to casual workers now', -wagesOwed, 'wages_owed');
  const dividendsOwed = -(await balanceOf('dividends_payable'));
  if (dividendsOwed > 0) add(now, 'Dividends declared and not paid yet', -dividendsOwed, 'dividends');

  // SARS: each EMP201 and DTR01 owed, on its due date (or this week, when it's past).
  const owed = await payrollAttention(db, now);
  for (const d of owed) add(d.dueOn, d.kind === 'emp201' ? `EMP201 for ${monthWords(d.period)}` : `Dividends tax (DTR01) for ${monthWords(d.period)}`, -Number(d.owingCents), d.kind === 'emp201' ? 'emp201' : 'dwt');

  // Salaries: the last pay run's net pay, on the same day each month after its pay day, and its PAYE,
  // UIF and SDL on the EMP201 for that pay month (SARS goes by the month paid). The last run itself
  // is already in the books (its bank payment dated on its pay day, above).
  if (on('payroll')) {
    const known = new Set(owed.filter((d) => d.kind === 'emp201').map((d) => d.period));
    const [last] = await db<{ payDate: string; net: number; sars: number }[]>`
      select r.pay_date::text, sum(l.net_cents)::bigint as net, sum(l.paye_cents + l.uif_employee_cents + l.uif_employer_cents + l.sdl_cents)::bigint as sars
      from pay_runs r join pay_lines l on l.run_id = r.id where r.status = 'final' group by r.id order by r.pay_date desc limit 1`;
    if (last && last.payDate >= addMonths(now, -2)) {
      const day = Number(last.payDate.slice(8, 10));
      for (let m = addMonths(`${last.payDate.slice(0, 7)}-01`, 1); m <= end; m = addMonths(m, 1)) {
        const month = m.slice(0, 7);
        add(dayOf(m, day), `Salaries (${monthWords(month)}, as the last pay run)`, -Number(last.net), 'payroll');
        if (!known.has(month)) add(emp201Due(month), `EMP201 for ${monthWords(month)} (PAYE, UIF and SDL, as the last pay run)`, -Number(last.sars), 'emp201');
      }
    }
  }

  // Casual workers: the last eight weeks' day wages and allowances, a week at a time.
  if (on('workers')) {
    const [w] = await db<{ total: number }[]>`
      select coalesce(sum(wage_cents + allowance_cents), 0)::bigint as total from labour_entries where date > ${addDays(now, -56)}::date and date <= ${now}::date`;
    const weekly = Math.round(Number(w!.total) / 8);
    for (let i = 0; i < FORECAST_WEEKS; i++) add(addDays(now, i * 7 + 6), 'Day wages (the last eight weeks’ average)', -weekly, 'day_wages');
  }

  // VAT, as invoiced (Shap's VAT201s are on the invoice basis): what's owed for periods that have
  // ended, on the last one's VAT201 (this week, when that's past); and what this period has come to
  // so far, on its own.
  if (settings.vatRegistered) {
    const current = vatPeriod(now, settings.vatCategory, settings.fyEndMonth);
    const last = vatPeriod(addMonths(current.start, -1), settings.vatCategory, settings.fyEndMonth);
    const owedNow = -(await balanceOf('vat'));
    const [mv] = await db<{ t: number }[]>`
      select coalesce(sum(l.amount_cents), 0)::bigint as t from ledger_totals l join accounts a on a.id = l.account_id
      where a.system_key = 'vat' and l.source in ('invoice', 'credit_note', 'cost', 'asset', 'disposal', 'write_off')
        and l.date between ${current.start}::date and ${now}::date`;
    const thisPeriod = -Number(mv!.t);
    const ended = owedNow - thisPeriod;
    if (ended > 0) add(vat201Due(last.end), `VAT owing for periods to ${formatDate(last.end)} (VAT201)`, -ended, 'vat');
    if (thisPeriod > 0) add(vat201Due(current.end), `VAT on this period so far, to ${formatDate(current.end)} (VAT201)`, -thisPeriod, 'vat');
  }

  // The costs that come every month (insurance, rent, subscriptions…), on their usual day, when
  // they were last paid from the bank or till: paid personally or on a card they don't come out of
  // the cash here (a card's repayment isn't in the forecast). One that comes as a supplier bill is
  // paid on the bill's terms, from the month after the last bill.
  const fromCash = new Set(
    (await db<{ id: string }[]>`select ps.id from payment_sources ps join accounts a on a.id = ps.account_id where a.statement_line in ('cash', 'bank_overdraft')`).map((r) => r.id),
  );
  const [billSource] = await db<{ id: string }[]>`select id from payment_sources where role = 'bills'`;
  for (const r of await findRecurring(db, now)) {
    if (r.status === 'stopped' || !r.sourceId) continue;
    if (billSource && r.sourceId === billSource.id) {
      if (!on('bills')) continue;
      const [t] = await db<{ terms: number | null; last: string | null }[]>`
        select percentile_cont(0.5) within group (order by (c.due_date - c.date))::int as terms, max(c.date)::text as last
        from costs c where c.source_id = ${billSource.id} and c.category_id = ${r.categoryId} and c.supplier = ${r.supplier} and c.date >= ${addDays(now, -280)}::date`;
      const terms = Math.max(0, t?.terms ?? 0);
      const after = t?.last ? addMonths(`${t.last.slice(0, 7)}-01`, 1) : `${now.slice(0, 7)}-01`;
      for (let m = after; m <= end; m = addMonths(m, 1)) add(addDays(dayOf(m, r.usualDay), terms), `${r.label} (usually monthly, as a bill)`, -Number(r.usualCents), 'monthly_cost');
      continue;
    }
    if (!fromCash.has(r.sourceId)) continue;
    for (let m = `${now.slice(0, 7)}-01`; m <= end; m = addMonths(m, 1)) {
      // This month's, once it's in the books, is already in the bank balance.
      if (m.slice(0, 7) === now.slice(0, 7) && r.status === 'ok') continue;
      const date = dayOf(m, r.usualDay);
      if (date < now && m.slice(0, 7) !== now.slice(0, 7)) continue;
      add(date, `${r.label} (usually monthly)`, -Number(r.usualCents), 'monthly_cost');
    }
  }

  items.sort((a, b) => a.date.localeCompare(b.date) || b.cents - a.cents);
  let running = openingCents;
  const weeks = Array.from({ length: FORECAST_WEEKS }, (_, i) => {
    const these = items.filter((x) => x.week === i);
    const inCents = these.filter((x) => x.cents > 0).reduce((t, x) => t + x.cents, 0);
    const outCents = -these.filter((x) => x.cents < 0).reduce((t, x) => t + x.cents, 0);
    running += inCents - outCents;
    return { start: addDays(now, i * 7), end: addDays(now, i * 7 + 6), inCents, outCents, closingCents: running };
  });
  const lowest = weeks.reduce<{ week: number; closingCents: number } | null>((lo, w, i) => (!lo || w.closingCents < lo.closingCents ? { week: i, closingCents: w.closingCents } : lo), null);
  return { asOf: now, openingCents, cardsOweCents, weeks, items, lowest, longOverdue };
}

export function registerForecastRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/forecast', { preHandler: requireAccess('reports.view') }, async () => cashForecast(ctx.sql));
}
