/** Is a business that isn't registered for VAT getting near the point where it must? */
import { addMonths, monthEnd, monthStart, vatWatch } from '@shap/shared';
import type { App as FastifyInstance } from '../http.js';
import { requireRole } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Db } from '../db/index.js';
import { getSettings, today } from '../lib/books.js';

/**
 * Taxable supplies, roughly: income in the books over the last 12 months (VAT excluded),
 * leaving out profit on selling the business's own assets, which doesn't count toward the
 * threshold. Exempt income (interest, residential rent) isn't told apart, so this errs high.
 */
export async function vatStatus(db: Db, on = today()) {
  const settings = await getSettings(db);
  const from = addMonths(on, -12);
  const lastFull = monthEnd(addMonths(on, -1));
  const paceFrom = monthStart(addMonths(lastFull, -2));
  const [r] = await db<{ last12: number; last3: number }[]>`
    select
      coalesce(-sum(l.amount_cents) filter (where l.date > ${from}::date and l.date <= ${on}::date), 0)::bigint as last12,
      coalesce(-sum(l.amount_cents) filter (where l.date between ${paceFrom}::date and ${lastFull}::date), 0)::bigint as last3
    from ledger l join accounts a on a.id = l.account_id
    where a.type = 'income' and coalesce(a.system_key, '') <> 'disposal_gain_loss'`;
  const last12Cents = Number(r!.last12);
  const pace12Cents = Number(r!.last3) * 4;
  const w = vatWatch(last12Cents, pace12Cents, on);
  return { registered: settings.vatRegistered, last12Cents, pace12Cents, ...w, state: settings.vatRegistered ? null : w.state };
}

export function registerVatRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/vat/threshold', { preHandler: requireRole('owner', 'accountant') }, async () => vatStatus(ctx.sql));
}
