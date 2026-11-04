/**
 * Anonymous market rates, as Shap's server does them (see @shap/shared market.ts for what is
 * shared and why). On the phone the books can't reach the internet themselves, so the app asks
 * here for last month's share, sends it to OpenWorks' collector when it's online, and says
 * when it went.
 */
import type { App as FastifyInstance } from '../http.js';
import { lastWholeMonth, marketItems, marketRates, monthRange, type MarketRate } from '@shap/shared';
import { z } from 'zod';
import { requireRole } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Db } from '../db/index.js';
import { getSettings, today } from '../lib/books.js';
import { parse } from '../lib/validate.js';

/** Last month's issued invoices: the median price of each of the trade's standard items. */
export async function monthRates(db: Db, industry: string, month: string): Promise<MarketRate[]> {
  if (!marketItems(industry).size) return [];
  const { from, to } = monthRange(month);
  const lines = await db<{ description: string; unit: string; unitPriceCents: number; qty: number }[]>`
    select l.description, l.unit, l.unit_price_cents, l.qty
    from document_lines l join documents d on d.id = l.document_id
    where d.kind = 'invoice' and d.status = 'issued' and d.issue_date between ${from}::date and ${to}::date`;
  return marketRates(industry, lines.map((l) => ({ ...l, qty: Number(l.qty), unitPriceCents: Number(l.unitPriceCents) })));
}

export function registerMarketRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;
  const owner = requireRole('owner');

  /**
   * What to share now, if anything: null when it's switched off, the owner hasn't been told yet,
   * or last month has gone already. `rates` can be empty (a month with none of the standard items).
   */
  app.get('/api/market/share', { preHandler: owner }, async () => {
    const s = await getSettings(sql);
    const month = lastWholeMonth(today());
    if (!s.marketConsent || !s.marketNoticeSeen || !s.setupDone || s.marketSentMonth >= month) return { share: null };
    return { share: { month, installId: s.installId, industry: s.industry, rates: await monthRates(sql, s.industry, month) } };
  });

  /** That month has gone (or had nothing to send). */
  app.post('/api/market/sent', { preHandler: owner }, async (req) => {
    const { month } = parse(z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }), req.body);
    await sql`update settings set market_sent_month = greatest(market_sent_month, ${month}) where id`;
    return { ok: true };
  });
}
