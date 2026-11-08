/** Is a business that isn't registered for VAT getting near the point where it must? */
import { addMonths, monthEnd, monthStart, vatWatch } from '@shap/shared';
import type { App as FastifyInstance } from '../http.js';
import { requireRole } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Db } from '../db/index.js';
import { getSettings, today, freshTotals } from '../lib/books.js';

/**
 * Taxable supplies, roughly: income in the books (VAT excluded), leaving out profit on selling
 * the business's own assets, which doesn't count toward the threshold. Exempt income (interest,
 * residential rent) isn't told apart, so this errs high.
 *
 * The line is crossed when supplies in ANY 12 months in a row pass it, not a financial or
 * calendar year (VAT Act s23). So besides the 12 months to today, every 12-month run ending on
 * a month end in the last two years is checked, and the highest counts.
 */
export async function vatStatus(db: Db, on = today()) {
  const settings = await getSettings(db);
  const from = addMonths(on, -12);
  const lastFull = monthEnd(addMonths(on, -1));
  const paceFrom = monthStart(addMonths(lastFull, -2));
  const since = monthStart(addMonths(on, -35));
  await freshTotals(db);
  const [r] = await db<{ last12: number; last3: number }[]>`
    select
      coalesce(-sum(l.amount_cents) filter (where l.date > ${from}::date and l.date <= ${on}::date), 0)::bigint as last12,
      coalesce(-sum(l.amount_cents) filter (where l.date between ${paceFrom}::date and ${lastFull}::date), 0)::bigint as last3
    from ledger_totals l join accounts a on a.id = l.account_id
    where a.type = 'income' and coalesce(a.system_key, '') <> 'disposal_gain_loss'`;
  const months = await db<{ month: string; cents: number }[]>`
    select to_char(date_trunc('month', l.date), 'YYYY-MM') as month, coalesce(-sum(l.amount_cents), 0)::bigint as cents
    from ledger_totals l join accounts a on a.id = l.account_id
    where a.type = 'income' and coalesce(a.system_key, '') <> 'disposal_gain_loss' and l.date >= ${since}::date and l.date <= ${on}::date
    group by 1`;
  const byMonth = new Map(months.map((m) => [m.month, Number(m.cents)]));
  const last12Cents = Number(r!.last12);
  // The highest 12 months in a row ending on a month end in the last two years (the earliest, if
  // several tie: that's when the line was crossed), or the 12 months to today if higher still.
  let peak12Cents = 0;
  let peakTo = on;
  for (let back = 24; back >= 1; back--) {
    const end = monthEnd(addMonths(on, -back));
    let t = 0;
    for (let k = 0; k < 12; k++) t += byMonth.get(addMonths(end, -k).slice(0, 7)) ?? 0;
    if (t > peak12Cents) {
      peak12Cents = t;
      peakTo = end;
    }
  }
  if (last12Cents > peak12Cents || peak12Cents === 0) {
    peak12Cents = last12Cents;
    peakTo = on;
  }
  const pace12Cents = Number(r!.last3) * 4;
  const w = vatWatch(peak12Cents, pace12Cents, on);
  return { registered: settings.vatRegistered, last12Cents, peak12Cents, peakTo, pace12Cents, ...w, state: settings.vatRegistered ? null : w.state };
}

export function registerVatRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/vat/threshold', { preHandler: requireRole('owner', 'accountant') }, async () => vatStatus(ctx.sql));
}
