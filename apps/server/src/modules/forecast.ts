import type { FastifyInstance } from 'fastify';
import { addDays, addMonths, emp201Due, featureOn, monthEnd, vat201Due, vatPeriod } from '@shap/shared';
import { requireAccess } from '../auth.js';
import type { Ctx } from '../context.js';
import { freshTotals, getSettings, today } from '../lib/books.js';
import { bills } from './bills.js';
import { payrollAttention } from './payroll.js';
import { findRecurring } from './recurring.js';

type Db = Ctx['sql'];

export const FORECAST_WEEKS = 13;

export interface ForecastItem {
  /** The week it falls in (0 is this week) and the day. */
  week: number;
  date: string;
  label: string;
  /** Money in positive, money out negative. */
  cents: number;
  kind: 'invoice' | 'overdue_invoice' | 'bill' | 'overdue_bill' | 'payroll' | 'emp201' | 'day_wages' | 'vat' | 'monthly_cost';
}

export interface Forecast {
  asOf: string;
  /** The bank and cash accounts the business pays from, today. */
  openingCents: number;
  /** What the business's cards owe today: not in the weeks (when they're paid off is yours to say). */
  cardsOweCents: number;
  weeks: { start: string; end: string; inCents: number; outCents: number; closingCents: number }[];
  items: ForecastItem[];
  lowest: { week: number; closingCents: number } | null;
}

/**
 * A 13-week cash-flow forecast from what's in the books: the bank and cash now, then each week's
 * money in (invoices, on their due dates) and out (supplier bills on theirs, salaries on the usual
 * pay day and the EMP201 after them, casual workers' day wages at their recent weekly average, the
 * VAT owing on the next VAT201, and the monthly costs that come every month). It's an estimate:
 * clients pay late, costs come that aren't in the books yet, and provisional tax, card and loan
 * repayments aren't in it. Overdue invoices and bills are put in this week, as if settled now.
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
  const cash = await db<{ kind: string; balance: number }[]>`
    select s.kind, coalesce(sum(l.amount_cents), 0)::bigint as balance
    from (select distinct on (ps.account_id) ps.account_id, ps.kind from payment_sources ps join accounts a on a.id = ps.account_id
          where ps.active and ps.kind in ('bank', 'cash', 'card') and a.system_key is distinct from 'owner_loan' and a.type in ('asset', 'liability')
          order by ps.account_id, ps.sort) s
    left join ledger_totals l on l.account_id = s.account_id and l.date <= ${now}::date
    group by s.kind`;
  const openingCents = cash.filter((r) => r.kind !== 'card').reduce((t, r) => t + Number(r.balance), 0);
  const cardsOweCents = -cash.filter((r) => r.kind === 'card').reduce((t, r) => t + Number(r.balance), 0);

  // Money in: what clients owe, on each invoice's due date (or today, when it's past).
  const owing = await db<{ number: string; dueDate: string | null; issueDate: string; owing: number; clientName: string | null }[]>`
    select d.number, d.due_date::text, d.issue_date::text, (d.total_cents - coalesce(r.paid, 0))::bigint as owing, c.name as client_name
    from documents d left join lateral (select sum(amount_cents) as paid from receipts where invoice_id = d.id) r on true
    left join clients c on c.id = d.client_id
    where d.kind = 'invoice' and d.status = 'issued' and d.written_off_on is null and d.total_cents - coalesce(r.paid, 0) > 0`;
  for (const i of owing) {
    const due = i.dueDate ?? i.issueDate;
    const late = due < now;
    add(due, `${late ? 'Overdue: ' : ''}invoice ${i.number}${i.clientName ? ` (${i.clientName})` : ''}`, Number(i.owing), late ? 'overdue_invoice' : 'invoice');
  }

  // Money out: supplier bills, on their due dates.
  if (on('bills'))
    for (const b of await bills(db, 'open')) {
      const due = b.dueDate ?? b.date;
      add(due, `${due < now ? 'Overdue: ' : ''}${b.supplier || b.description}${b.billNumber ? ` (bill ${b.billNumber})` : ''}`, -Number(b.owingCents), due < now ? 'overdue_bill' : 'bill');
    }

  // Salaries: the last pay run's net pay, on the same day each month; its PAYE, UIF and SDL on the
  // EMP201 the month after. What's owed to SARS already is on its own due date.
  if (on('payroll')) {
    for (const d of await payrollAttention(db, now)) if (d.kind === 'emp201') add(d.dueOn, `EMP201 for ${d.period}`, -Number(d.owingCents), 'emp201');
    const [last] = await db<{ period: string; payDate: string; net: number; sars: number }[]>`
      select r.period, r.pay_date::text, sum(l.net_cents)::bigint as net, sum(l.paye_cents + l.uif_employee_cents + l.uif_employer_cents + l.sdl_cents)::bigint as sars
      from pay_runs r join pay_lines l on l.run_id = r.id where r.status = 'final' group by r.id order by r.period desc limit 1`;
    if (last && last.period >= addMonths(now, -2).slice(0, 7)) {
      const day = Number(last.payDate.slice(8, 10));
      for (let m = addMonths(`${last.period}-01`, 1); m <= end; m = addMonths(m, 1)) {
        const pay = `${m.slice(0, 8)}${String(Math.min(day, Number(monthEnd(m).slice(8, 10)))).padStart(2, '0')}`;
        add(pay, `Salaries (${m.slice(0, 7)}, as last month)`, -Number(last.net), 'payroll');
        add(emp201Due(m.slice(0, 7)), `EMP201 for ${m.slice(0, 7)} (PAYE, UIF and SDL, as last month)`, -Number(last.sars), 'emp201');
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

  // VAT owing now, on the next VAT201's due date.
  if (settings.vatRegistered) {
    const [v] = await db<{ balance: number }[]>`
      select coalesce(sum(l.amount_cents), 0)::bigint as balance from ledger_totals l join accounts a on a.id = l.account_id where a.system_key = 'vat' and l.date <= ${now}::date`;
    const owed = -Number(v!.balance);
    if (owed > 0) {
      const current = vatPeriod(now, settings.vatCategory, settings.fyEndMonth);
      const last = vatPeriod(addMonths(current.start, -1), settings.vatCategory, settings.fyEndMonth);
      const due = [vat201Due(last.end), vat201Due(current.end)].find((d) => d >= now);
      if (due) add(due, 'VAT owing now (the next VAT201)', -owed, 'vat');
    }
  }

  // The costs that come every month (insurance, rent, subscriptions…), on their usual day. Paid
  // personally they don't touch the business's cash, and paid on a card they come out of the bank
  // with the card's repayment, which isn't in the forecast.
  const offCash = new Set((await db<{ id: string }[]>`select id from payment_sources where kind in ('owner', 'card')`).map((r) => r.id));
  for (const r of await findRecurring(db, now)) {
    if (r.status === 'stopped' || (r.sourceId && offCash.has(r.sourceId))) continue;
    for (let m = `${now.slice(0, 7)}-01`; m <= end; m = addMonths(m, 1)) {
      // This month's, once it's in the books, is already in the bank balance.
      if (m.slice(0, 7) === now.slice(0, 7) && r.status === 'ok') continue;
      const date = `${m.slice(0, 8)}${String(Math.min(r.usualDay, Number(monthEnd(m).slice(8, 10)))).padStart(2, '0')}`;
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
  return { asOf: now, openingCents, cardsOweCents, weeks, items, lowest };
}

export function registerForecastRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/forecast', { preHandler: requireAccess('reports.view') }, async () => cashForecast(ctx.sql));
}
