import type { FastifyInstance } from 'fastify';
import { addDays, addMonths, emp201Due, featureOn, formatDate, monthEnd, payoutWord, vat201Due, vatPeriod } from '@shap/shared';
import { can, requireAccess, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import { freshTotals, getSettings, today } from '../lib/books.js';
import { bills } from './bills.js';
import { cashPosition, type CashPosition } from './dashboard.js';
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
  /** Bank or cash accounts paid from that the statements don't count as cash: not in the opening figure. */
  offCash: CashPosition['offCash'];
  weeks: { start: string; end: string; inCents: number; outCents: number; closingCents: number }[];
  items: ForecastItem[];
  lowest: { week: number; closingCents: number } | null;
  /** Invoices more than LONG_OVERDUE_DAYS overdue: not counted as coming in. */
  longOverdue: { count: number; cents: number; days: number };
  /** Whether leaving dates still to come are counted in the salaries: only for someone who sees payroll. */
  leavingAhead: boolean;
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
export async function cashForecast(db: Db, now = today(), opts: { people?: boolean } = {}): Promise<Forecast> {
  // Leaving dates still to come are for those who see payroll: for anyone else the salaries go on
  // as if no one leaves who hasn't yet (a month's total dropping would say who's going, and when).
  const leavingAhead = opts.people !== false;
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
  const { inBankCents: openingCents, cardsOweCents, offCash } = await cashPosition(db, now);
  const balanceOf = async (key: string, upTo = now) => {
    const [b] = await db<{ b: number }[]>`
      select coalesce(sum(l.amount_cents), 0)::bigint as b from ledger_totals l join accounts a on a.id = l.account_id where a.system_key = ${key} and l.date <= ${upTo}::date`;
    return Number(b!.b);
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

  // Owed now: casual workers' wages earned and not paid (each worker's, less what's booked to pay
  // them beyond what they'll earn ahead), and dividends (a CC's or trust's distributions) declared
  // by today and not paid by the forecast's end, in full this week, as if paid now. And what the
  // books owe on those accounts beyond Shap's own records of them (a journal by hand, balances
  // brought in, a year-end adjustment), less what's booked to pay it ahead, signed: what's owed
  // beyond goes out this week too (less workers' advances, which may have paid it); a journal that
  // paid what Shap's records still show owed comes off them (never below nothing).
  const beyond = async (rows: Promise<{ owed: number; paidAhead: number }[]>) => {
    const [b] = await rows;
    return Number(b!.owed) - Number(b!.paidAhead);
  };
  {
    const [w] = await db<{ owed: number; advances: number }[]>`
      select coalesce(sum(greatest(0, owed - greatest(0, paid_ahead - earned_ahead))), 0)::bigint as owed,
        coalesce(sum(greatest(0, -owed)), 0)::bigint as advances from (
        select w.id,
          coalesce((select sum(wage_cents + allowance_cents) from labour_entries where worker_id = w.id and date <= ${now}::date), 0)
            - coalesce((select sum(amount_cents) from wage_payments where worker_id = w.id and date <= ${now}::date), 0) as owed,
          coalesce((select sum(amount_cents) from wage_payments where worker_id = w.id and date > ${now}::date and date <= ${end}::date), 0) as paid_ahead,
          coalesce((select sum(wage_cents + allowance_cents) from labour_entries where worker_id = w.id and date > ${now}::date and date <= ${end}::date), 0) as earned_ahead
        from workers w) x`;
    const other = await beyond(db<{ owed: number; paidAhead: number }[]>`
      select coalesce(-sum(l.amount_cents) filter (where l.date <= ${now}::date), 0)::bigint as owed,
        coalesce(sum(l.amount_cents) filter (where l.date > ${now}::date and l.date <= ${end}::date and l.amount_cents > 0), 0)::bigint as paid_ahead
      from ledger l join accounts a on a.id = l.account_id
      where a.system_key = 'wages_payable' and l.source not in ('labour', 'wage_payment')`);
    const own = other < 0 ? Math.max(0, Number(w!.owed) + other) : Number(w!.owed);
    if (own > 0) add(now, 'Wages owed to casual workers now', -own, 'wages_owed');
    const otherOut = Math.max(0, other - Number(w!.advances));
    if (otherOut > 0) add(now, 'Other amounts owed on the wages account (from a journal or balances brought in, which may include PAYE or UIF), as if paid now', -otherOut, 'wages_owed');
  }
  const [dv] = await db<{ owed: number }[]>`
    select coalesce(sum(gross_cents), 0)::bigint as owed from dividends
    where declared_on <= ${now}::date and (paid_on is null or paid_on > ${end}::date)`;
  const unpaid = Number(dv!.owed);
  // One paid after the forecast's end isn't in its weeks at all.
  const [later] = await db<{ owed: number }[]>`select coalesce(sum(gross_cents), 0)::bigint as owed from dividends where declared_on <= ${now}::date and paid_on > ${end}::date`;
  const dividendsOwed = unpaid - Number(later!.owed);
  const Payouts = payoutWord(settings.businessType) === 'dividend' ? 'Dividends' : 'Distributions';
  const otherDividends = await beyond(db<{ owed: number; paidAhead: number }[]>`
    select coalesce(-sum(l.amount_cents) filter (where l.date <= ${now}::date), 0)::bigint as owed,
      coalesce(sum(l.amount_cents) filter (where l.date > ${now}::date and l.date <= ${end}::date and l.amount_cents > 0), 0)::bigint as paid_ahead
    from ledger l join accounts a on a.id = l.account_id
    left join journals j on l.source = 'journal' and j.id = l.source_id
    where a.system_key = 'dividends_payable' and (j.id is null or j.kind <> 'dividend')`);
  const ownDividends = otherDividends < 0 ? Math.max(0, dividendsOwed + otherDividends) : dividendsOwed;
  if (ownDividends > 0) add(now, `${Payouts} declared and not paid yet (as if paid in full now)`, -ownDividends, 'dividends');
  if (otherDividends > 0) add(now, `Other ${Payouts.toLowerCase()} owed in the books (a journal, or balances brought in), as if paid in full now`, -otherDividends, 'dividends');

  // SARS: each EMP201 and DTR01 owed, on its due date (or this week, when it's past).
  const owed = await payrollAttention(db, now);
  // PAYE, UIF and SDL as the books have them, against the EMP201s Shap's pay runs leave owing:
  // owed beyond them (brought in when moving in, or a journal by hand) goes out this week, as if
  // paid now; less owed (an EMP201 paid by a journal, or a refund SARS set off against it) comes
  // off them, oldest first, as the wages and dividends owed do.
  const [sarsPayroll] = await db<{ owed: number }[]>`select coalesce(-sum(l.amount_cents), 0)::bigint as owed from ledger_totals l join accounts a on a.id = l.account_id where a.system_key in ('paye_payable', 'uif_payable', 'sdl_payable')`;
  const listed = owed.filter((d) => d.kind === 'emp201').reduce((s, d) => s + Number(d.owingCents), 0);
  const beyondRuns = Number(sarsPayroll!.owed) - listed;
  let paidByHand = Math.max(0, -beyondRuns);
  for (const d of [...owed].sort((a, b) => a.period.localeCompare(b.period))) {
    let cents = Number(d.owingCents);
    if (d.kind === 'emp201' && paidByHand > 0) {
      const off = Math.min(paidByHand, cents);
      cents -= off;
      paidByHand -= off;
    }
    if (cents > 0) add(d.dueOn, d.kind === 'emp201' ? `EMP201 for ${monthWords(d.period)}` : `Dividends tax (DTR01) for ${monthWords(d.period)}`, -cents, d.kind === 'emp201' ? 'emp201' : 'dwt');
  }
  if (beyondRuns > 0) add(now, 'Other PAYE, UIF and SDL owed in the books (a journal, or balances brought in), as if paid now', -beyondRuns, 'emp201');

  // Salaries: each employee in the last pay run at the middle of their last three pay lines (so a
  // bonus month isn't repeated, and someone new counts in full), while a run for the month would
  // still take them (active, started, not left), for each month after the last
  // run's period, paid as many days into the month as the recent runs were (a December run paid on
  // 2 January isn't January's), and their PAYE, UIF and SDL on the EMP201 for the month it's paid
  // in (SARS goes by the month paid). The last run itself is in the books (its payment dated on
  // its pay day, above), and its EMP201 is among those owed.
  if (on('payroll')) {
    const runs = await db<{ id: string; period: string; payDate: string }[]>`
      select id, period, pay_date::text from pay_runs where status = 'final' order by period desc limit 3`;
    const last = runs[0];
    if (last && last.payDate >= addMonths(now, -2)) {
      const lines = await db<{ employeeId: string; runId: string; net: number; sars: number }[]>`
        select employee_id, run_id, net_cents::bigint as net, (paye_cents + uif_employee_cents + uif_employer_cents + sdl_cents)::bigint as sars
        from pay_lines where run_id = any(${runs.map((r) => r.id)})`;
      const middle = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] ?? 0;
      const ids = [...new Set(lines.filter((l) => l.runId === last.id).map((l) => l.employeeId))];
      const usualPay = new Map(
        ids.map((e) => {
          const mine = lines.filter((l) => l.employeeId === e);
          return [e, { net: middle(mine.map((l) => Number(l.net))), sars: middle(mine.map((l) => Number(l.sars))) }];
        }),
      );
      // Only those a pay run for the month would take (as POST /api/pay-runs does): someone who has
      // left, or isn't active, isn't paid again.
      const emps = await db<{ id: string; active: boolean; startDate: string; endDate: string | null }[]>`
        select id, active, start_date::text, end_date::text from employees where id = any(${ids})`;
      const paidFor = (m: string) => {
        const taken = emps.filter((e) => e.active && e.startDate <= monthEnd(m) && (!e.endDate || e.endDate >= m || (!leavingAhead && e.endDate > now)));
        return { net: taken.reduce((t, e) => t + usualPay.get(e.id)!.net, 0), sars: taken.reduce((t, e) => t + usualPay.get(e.id)!.sars, 0) };
      };
      // When in relation to its month a run is paid, as the middle of the recent runs had it: the
      // months between the period and the pay day, and the day of the month.
      const usual = [...runs].sort((a, b) => Date.parse(a.payDate) - Date.parse(`${a.period}-01`) - (Date.parse(b.payDate) - Date.parse(`${b.period}-01`)))[Math.floor((runs.length - 1) / 2)]!;
      const monthsAfter = (Number(usual.payDate.slice(0, 4)) - Number(usual.period.slice(0, 4))) * 12 + Number(usual.payDate.slice(5, 7)) - Number(usual.period.slice(5, 7));
      const day = Number(usual.payDate.slice(8, 10));
      for (let m = addMonths(`${last.period}-01`, 1); m <= end; m = addMonths(m, 1)) {
        const payDay = dayOf(addMonths(m, monthsAfter), day);
        if (payDay > end) break;
        const { net, sars } = paidFor(m);
        if (net) add(payDay, `Salaries (${monthWords(m.slice(0, 7))}, as your recent pay runs)`, -net, 'payroll');
        if (sars) add(emp201Due(payDay.slice(0, 7)), `EMP201 for ${monthWords(payDay.slice(0, 7))} (PAYE, UIF and SDL, as your recent pay runs)`, -sars, 'emp201');
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

  // VAT, as invoiced (Shap's VAT201s are on the invoice basis). A period's VAT is everything that
  // moves the VAT account in it (invoices, costs and assets however they were paid, journals with an
  // income or cost line), except payments and refunds (entries of VAT against money: the bank, cash,
  // an overdraft, or the owner paying personally, with at most SARS's interest or a penalty beside
  // it, smaller than the VAT) and balances brought in (opening balances, a trial balance). What's
  // owed for periods that have ended, less payments already booked ahead: the last period's own on
  // its VAT201 (this week, when that's past), anything older this week. A payment beyond them comes
  // off this period's, up to what was paid since it began (one made ahead for it); a refund SARS
  // owes doesn't (SARS pays refunds after its checks, and sets them off itself). This period's (as
  // far as the books go) on its own VAT201. Which period a payment was for is SARS's (by its
  // reference, which Shap doesn't keep): an estimate. A business no longer registered still owes
  // its last returns.
  const vatOwedNow = -(await balanceOf('vat'));
  if (settings.vatRegistered || vatOwedNow !== 0) {
    const current = vatPeriod(now, settings.vatCategory, settings.fyEndMonth);
    const last = vatPeriod(addMonths(current.start, -1), settings.vatCategory, settings.fyEndMonth);
    // Each entry's VAT, and whether it's a payment or refund (VAT and money: the bank, cash, a card
    // or any account paid from, or the owner's; with nothing else in it but expense or income
    // smaller than the VAT: SARS's interest or a penalty paid with it, or interest on a refund). One pass over the books from the last period's start to whichever is later, this period's
    // end or the forecast's: each VAT line, with what else its entry has on that day (one scan of
    // the ledger, however many lines: no look-up per line, nothing the planner can turn into one).
    const upTo = current.end > end ? current.end : end;
    const entries = await db<{ t: number; date: string; payment: boolean }[]>`
      select x.t, x.date::text, (x.money and not x.other and x.expense < abs(x.t)) as payment
      from (
        select l.source, l.source_id, l.date, l.amount_cents::bigint as t, a.system_key,
          bool_or(m.is_money) over w as money,
          bool_or(a.type not in ('expense', 'income') and coalesce(a.system_key, '') <> 'vat' and not m.is_money) over w as other,
          coalesce(sum(abs(l.amount_cents)) filter (where a.type in ('expense', 'income') and not m.is_money) over w, 0) as expense
        from ledger l join accounts a on a.id = l.account_id
        cross join lateral (select coalesce(a.statement_line, '') in ('cash', 'bank_overdraft') or coalesce(a.system_key, '') in ('owner_loan', 'paye_payable', 'uif_payable', 'sdl_payable', 'income_tax_payable', 'dwt_payable')
          or exists (select 1 from payment_sources ps where ps.account_id = a.id and ps.kind in ('bank', 'cash', 'card', 'owner')) as is_money) m
        where l.date between ${last.start}::date and ${upTo}::date and l.source_id is not null and l.source <> 'year_end'
        window w as (partition by l.source, l.source_id, l.date)
      ) x
      left join journals j on x.source = 'journal' and j.id = x.source_id
      where x.system_key = 'vat'
        and (j.id is null or (j.kind <> 'opening'
          and not (j.kind = 'import' and (j.ledger_import_id is null or exists (select 1 from ledger_imports li where li.id = j.ledger_import_id and li.kind = 'trialBalance')))))`;
    const within = (from: string, to: string) => entries.filter((e) => e.date >= from && e.date <= to);
    const accrued = async (from: string, to: string) => -within(from, to).filter((e) => !e.payment).reduce((t, e) => t + Number(e.t), 0);
    const paidAhead = within(addDays(now, 1), end).filter((e) => e.payment).reduce((t, e) => t + Number(e.t), 0);
    const toNow = await accrued(current.start, now);
    let thisPeriod = toNow + (await accrued(addDays(now, 1), current.end));
    // A refund SARS still owes for an ended period isn't netted off what's owed for another (SARS
    // sets off only an authorised refund, against a debt already overdue: TAA ss190(2), 191).
    const atLastStart = -(await balanceOf('vat', addDays(last.start, -1)));
    const refundsIn = -within(last.start, end).filter((e) => e.payment && Number(e.t) < 0).reduce((t, e) => t + Number(e.t), 0);
    const lastNet = await accrued(last.start, last.end);
    const refundsDue = Math.max(0, -atLastStart) + Math.max(0, -lastNet);
    // SARS must set a refund off against VAT already overdue before it pays the rest (TAA
    // s191(1)): once one has come in, VAT overdue for an ended period (older periods', last
    // period's once its VAT201 is past due) is taken as cleared by it, up to the refund still owed.
    const overdue = Math.max(0, atLastStart) + (vat201Due(last.end) < now ? Math.max(0, lastNet) : 0);
    const setOff = refundsIn > 0 ? Math.min(Math.max(0, refundsDue - refundsIn), overdue) : 0;
    const refundsOwed = Math.max(0, refundsDue - refundsIn - setOff);
    // A refund received (booked ahead) beyond what the ended periods were owed is this period's own,
    // when this period is a refund: not owed for an ended one.
    const thisRefundIn = Math.min(Math.max(0, refundsIn - refundsDue), Math.max(0, -thisPeriod));
    let ended = vatOwedNow - toNow - paidAhead + refundsOwed - thisRefundIn;
    if (ended < 0) {
      // Paid to SARS since this period began (payments, not refunds received), beyond what the
      // ended periods owed when it began (a refund owed counted as nothing): what was paid ahead
      // for this one. Paying last period's on time doesn't let a refund SARS owes come off it.
      const paidSince = within(current.start, end).filter((e) => e.payment && Number(e.t) > 0).reduce((t, e) => t + Number(e.t), 0);
      const lastRaw = await accrued(last.start, last.end);
      // Owed before the last period began (a refund owed as nothing), less what was paid to SARS
      // during it; what was paid beyond that was paid ahead for the last period's own.
      const olderAtLastStart = Math.max(0, -(await balanceOf('vat', addDays(last.start, -1))));
      const paidInLast = within(last.start, last.end).filter((e) => e.payment && Number(e.t) > 0).reduce((t, e) => t + Number(e.t), 0);
      const owedAtStart = Math.max(0, olderAtLastStart - paidInLast) + Math.max(0, Math.max(0, lastRaw) - Math.max(0, paidInLast - olderAtLastStart));
      thisPeriod = Math.max(0, thisPeriod - Math.min(-ended, Math.max(0, paidSince - owedAtStart)));
      ended = 0;
    }
    const lastOwn = Math.max(0, await accrued(last.start, last.end));
    const forLast = Math.min(ended, lastOwn);
    const older = ended - forLast;
    // A trial balance brought in since the last period began: its VAT is a balance on its date,
    // which Shap can't put in a SARS period, so it's said, and taken as due now.
    const [tb] = await db<{ n: number }[]>`
      select count(*)::int as n from ledger l join accounts a on a.id = l.account_id
      join journals j on l.source = 'journal' and j.id = l.source_id join ledger_imports li on li.id = j.ledger_import_id
      where a.system_key = 'vat' and li.kind = 'trialBalance' and l.date between ${last.start}::date and ${now}::date`;
    if (older > 0)
      add(now, `VAT owing for periods before ${formatDate(last.start)}${tb!.n ? ', or brought in with a trial balance' : ''} (VAT201, an estimate, as if paid now)`, -older, 'vat');
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
  // The running costs it's worked out from (as findRecurring reads them: no refunds).
  const dated = await db<{ categoryId: string; supplier: string; description: string; date: string; dueDate: string | null; sourceId: string | null }[]>`
    select c.category_id, c.supplier, c.description, c.date::text, c.due_date::text, c.source_id from costs c join cost_categories k on k.id = c.category_id
    where k.kind = 'overhead' and c.amount_cents > 0 and c.date > ${addDays(now, -280)}::date and c.date <= ${end}::date`;
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
  return { asOf: now, openingCents, cardsOweCents, offCash, weeks, items, lowest, longOverdue, leavingAhead };
}

export function registerForecastRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/forecast', { preHandler: requireAccess('reports.view') }, async (req) => cashForecast(ctx.sql, today(), { people: can(userOrThrow(req), 'payroll.view') }));
}
