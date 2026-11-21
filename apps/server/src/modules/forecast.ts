import type { FastifyInstance } from 'fastify';
import { addDays, addMonths, emp201Due, featureOn, formatDate, monthEnd, payoutWord, vat201Due, vatPeriod } from '@shap/shared';
import { requireAccess } from '../auth.js';
import type { Ctx } from '../context.js';
import { freshTotals, getSettings, today } from '../lib/books.js';
import { bills } from './bills.js';
import { cashPosition } from './dashboard.js';
import { payrollAttention } from './payroll.js';
import { findRecurring, recurringKey } from './recurring.js';

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

  /**
   * What's been paid off an account (wages owed, dividends owed, VAT) by entries dated after today
   * that move the cash: those payments are in the weeks already (booked, below), so what's owed now
   * is less them, or they'd be counted twice.
   */
  const settledAhead = async (key: string) => {
    const [r] = await db<{ s: number }[]>`
      select coalesce(sum(l.amount_cents), 0)::bigint as s from ledger l join accounts a on a.id = l.account_id
      where a.system_key = ${key} and l.date > ${now}::date and l.date <= ${end}::date and l.source_id is not null
        and exists (select 1 from ledger c join accounts ca on ca.id = c.account_id
                    where c.source = l.source and c.source_id = l.source_id and ca.statement_line in ('cash', 'bank_overdraft'))`;
    return Number(r!.s);
  };

  // Already in the books for a day to come (a pay run paid on its pay day, a cost or a payment
  // dated ahead): the cash accounts' movements after today, day by day, as they're booked.
  const ahead = await db<{ date: string; cents: number }[]>`
    select l.date::text, sum(l.amount_cents)::bigint as cents from ledger_totals l join accounts a on a.id = l.account_id
    where a.statement_line in ('cash', 'bank_overdraft') and l.date > ${now}::date and l.date <= ${end}::date
    group by 1 order by 1`;
  for (const b of ahead) add(b.date, 'Already in the books for that day (payments, a pay run, costs dated ahead)', Number(b.cents), 'booked');

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

  // Owed now, less what's already booked to pay it: casual workers' wages earned and not paid, and
  // dividends (a CC's or trust's distributions) declared and not paid, in full this week.
  const wagesOwed = -(await balanceOf('wages_payable')) - (await settledAhead('wages_payable'));
  if (wagesOwed > 0) add(now, 'Wages owed to casual workers now', -wagesOwed, 'wages_owed');
  const dividendsOwed = -(await balanceOf('dividends_payable')) - (await settledAhead('dividends_payable'));
  if (dividendsOwed > 0) add(now, `${payoutWord(settings.businessType) === 'dividend' ? 'Dividends' : 'Distributions'} declared and not paid yet`, -dividendsOwed, 'dividends');

  // SARS: each EMP201 and DTR01 owed, on its due date (or this week, when it's past).
  const owed = await payrollAttention(db, now);
  for (const d of owed) add(d.dueOn, d.kind === 'emp201' ? `EMP201 for ${monthWords(d.period)}` : `Dividends tax (DTR01) for ${monthWords(d.period)}`, -Number(d.owingCents), d.kind === 'emp201' ? 'emp201' : 'dwt');

  // Salaries: the recent pay runs' net pay (the middle of the last three, so a bonus month isn't
  // repeated), on the same day each month after the last run's month (its pay month, or its period
  // when it was paid early), and their PAYE, UIF and SDL on the EMP201 for each month paid (SARS
  // goes by the month paid). The last run itself is in the books (its payment dated on its pay
  // day, above), and its EMP201 is among those owed.
  if (on('payroll')) {
    const runs = await db<{ period: string; payDate: string; net: number; sars: number }[]>`
      select r.period, r.pay_date::text, sum(l.net_cents)::bigint as net, sum(l.paye_cents + l.uif_employee_cents + l.uif_employer_cents + l.sdl_cents)::bigint as sars
      from pay_runs r join pay_lines l on l.run_id = r.id where r.status = 'final' group by r.id order by r.pay_date desc limit 3`;
    const last = runs[0];
    if (last && last.payDate >= addMonths(now, -2)) {
      const middle = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]!;
      const net = middle(runs.map((r) => Number(r.net)));
      const sars = middle(runs.map((r) => Number(r.sars)));
      const day = Number(last.payDate.slice(8, 10));
      const from = [last.payDate.slice(0, 7), last.period].sort().pop()!;
      for (let m = addMonths(`${from}-01`, 1); m <= end; m = addMonths(m, 1)) {
        const month = m.slice(0, 7);
        add(dayOf(m, day), `Salaries (${monthWords(month)}, as your recent pay runs)`, -net, 'payroll');
        add(emp201Due(month), `EMP201 for ${monthWords(month)} (PAYE, UIF and SDL, as your recent pay runs)`, -sars, 'emp201');
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

  // VAT, as invoiced (Shap's VAT201s are on the invoice basis). What's owed for periods that have
  // ended, less payments already booked: the last period's on its VAT201 (this week, when that's
  // past), anything older this week; and this period's (as far as the books go) on its own. A
  // business no longer registered still owes its last returns. Movements that are payments or
  // refunds (with a cash side) and opening balances aren't a period's VAT.
  const vatOwedNow = -(await balanceOf('vat'));
  if (settings.vatRegistered || vatOwedNow !== 0) {
    const current = vatPeriod(now, settings.vatCategory, settings.fyEndMonth);
    const last = vatPeriod(addMonths(current.start, -1), settings.vatCategory, settings.fyEndMonth);
    const accrued = async (from: string, to: string) => {
      const [m] = await db<{ t: number }[]>`
        select coalesce(sum(l.amount_cents), 0)::bigint as t from ledger l join accounts a on a.id = l.account_id
        left join journals j on l.source = 'journal' and j.id = l.source_id
        where a.system_key = 'vat' and l.date between ${from}::date and ${to}::date and l.source <> 'year_end' and j.kind is distinct from 'opening'
          and not exists (select 1 from ledger c join accounts ca on ca.id = c.account_id
                          where l.source_id is not null and c.source = l.source and c.source_id = l.source_id and ca.statement_line in ('cash', 'bank_overdraft'))`;
      return -Number(m!.t);
    };
    const toNow = await accrued(current.start, now);
    const thisPeriod = toNow + (await accrued(addDays(now, 1), current.end));
    const ended = vatOwedNow - toNow - (await settledAhead('vat'));
    const lastOwn = Math.max(0, await accrued(last.start, last.end));
    const forLast = Math.min(Math.max(0, ended), lastOwn);
    const older = Math.max(0, ended - lastOwn);
    if (older > 0) add(now, `VAT owing for periods before ${formatDate(last.start)} (VAT201)`, -older, 'vat');
    if (forLast > 0) add(vat201Due(last.end), `VAT for the period to ${formatDate(last.end)} (VAT201)`, -forLast, 'vat');
    if (thisPeriod > 0) add(vat201Due(current.end), `VAT so far on the period to ${formatDate(current.end)} (VAT201)`, -thisPeriod, 'vat');
  }

  // The costs that come every month (insurance, rent, subscriptions…), on their usual day, when
  // they were last paid from the bank or till: paid personally or on a card they don't come out of
  // the cash here (a card's repayment isn't in the forecast). One that comes as a supplier bill is
  // paid on the bill's terms, from the month after the last bill. A month whose cost is already in
  // the books, dated ahead, isn't counted again.
  const fromCash = new Set(
    (await db<{ id: string }[]>`select ps.id from payment_sources ps join accounts a on a.id = ps.account_id where a.statement_line in ('cash', 'bank_overdraft')`).map((r) => r.id),
  );
  const [billSource] = await db<{ id: string }[]>`select id from payment_sources where role = 'bills'`;
  const dated = await db<{ categoryId: string; supplier: string; description: string; date: string; dueDate: string | null; sourceId: string | null }[]>`
    select category_id, supplier, description, date::text, due_date::text, source_id from costs where date > ${addDays(now, -280)}::date and date <= ${end}::date`;
  const thisMonth = `${now.slice(0, 7)}-01`;
  for (const r of await findRecurring(db, now)) {
    if (r.status === 'stopped' || !r.sourceId) continue;
    const mine = dated.filter((c) => recurringKey(c) === r.key);
    const capturedAhead = new Set(mine.filter((c) => c.date > now).map((c) => c.date.slice(0, 7)));
    if (billSource && r.sourceId === billSource.id) {
      if (!on('bills')) continue;
      const billed = mine.filter((c) => c.sourceId === billSource.id);
      const terms = billed.map((c) => (c.dueDate ? Math.round((Date.parse(c.dueDate) - Date.parse(c.date)) / 86_400_000) : 0)).sort((a, b) => a - b);
      const usualTerms = Math.max(0, terms.length ? terms[Math.floor((terms.length - 1) / 2)]! : 0);
      const lastBill = billed.map((c) => c.date).sort().pop();
      const after = lastBill ? addMonths(`${lastBill.slice(0, 7)}-01`, 1) : thisMonth;
      // Months gone by without a bill aren't put in this week: only from this month on.
      for (let m = after < thisMonth ? thisMonth : after; m <= end; m = addMonths(m, 1)) {
        if (capturedAhead.has(m.slice(0, 7))) continue;
        add(addDays(dayOf(m, r.usualDay), usualTerms), `${r.label} (usually monthly, as a bill)`, -Number(r.usualCents), 'monthly_cost');
      }
      continue;
    }
    if (!fromCash.has(r.sourceId)) continue;
    for (let m = thisMonth; m <= end; m = addMonths(m, 1)) {
      // This month's, once it's in the books, is already in the bank balance; one dated ahead is booked.
      if (m === thisMonth && r.status === 'ok') continue;
      if (capturedAhead.has(m.slice(0, 7))) continue;
      const date = dayOf(m, r.usualDay);
      if (date < now && m !== thisMonth) continue;
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
