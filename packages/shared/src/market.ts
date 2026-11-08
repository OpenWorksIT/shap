/**
 * Anonymous market rates: what work typically costs, gathered from businesses that choose to
 * share (Settings, off unless switched on).
 *
 * What's shared is deliberately small. Once a month, for last month's issued invoices, only the
 * lines that are one of the standard items of the business's trade (the ones Shap offers, like
 * "Tiling" per m² for a builder), and for each such item only one number: the business's average
 * unit price, excluding VAT. Never a description someone typed, a client, an invoice,
 * a total, how many lines there were, or the business's name. The collector checks every item
 * against the same standard list, so nothing else can get in.
 *
 * On arrival each price is added into a national tally for its trade, item and month (prices in
 * 5% bands) and only the tallies are kept: there are no records of one business's prices to
 * look up. Ranges are only ever worked out where enough different businesses have shared.
 * What it's for: one day, published ranges of what work costs in South Africa, so clients and
 * trades can both see what's fair. Never advertising or marketing.
 */
import { industryProfile } from './industry.js';
import { INDUSTRIES } from './setup.js';

export interface MarketRate {
  /** The standard item, exactly as Shap names it for the trade. */
  item: string;
  unit: string;
  /** The business's average unit price for it that month, excluding VAT. */
  cents: number;
}

export interface MarketContribution {
  app: 'shap' | 'pocket';
  version: string;
  installId: string;
  /** The month the invoices are from: YYYY-MM. */
  month: string;
  industry: string;
  rates: MarketRate[];
}

/** Trades whose standard items are specific enough to compare ("Something else" isn't). */
export const MARKET_INDUSTRIES: string[] = INDUSTRIES.map((i) => i.key).filter((k) => k !== 'other');

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** The standard items of a trade that can be shared, keyed by name and unit. */
export function marketItems(industry: string): Map<string, { item: string; unit: string }> {
  const out = new Map<string, { item: string; unit: string }>();
  if (!MARKET_INDUSTRIES.includes(industry)) return out;
  for (const i of industryProfile(industry).items) {
    if (!i.unit) continue;
    out.set(`${norm(i.d)}|${norm(i.unit)}`, { item: i.d, unit: i.unit });
  }
  return out;
}

/** Is this item one of the trade's standard ones (what the collector accepts)? */
export function isMarketItem(industry: string, item: string, unit: string): boolean {
  const found = marketItems(industry).get(`${norm(item)}|${norm(unit)}`);
  return Boolean(found && found.item === item && found.unit === unit);
}

const average = (xs: number[]) => Math.round(xs.reduce((t, x) => t + x, 0) / xs.length);

/** One month's share: the average unit price of each standard item on the given invoice lines. */
export function marketRates(industry: string, lines: { description: string; unit: string; unitPriceCents: number; qty: number }[]): MarketRate[] {
  const items = marketItems(industry);
  const prices = new Map<string, number[]>();
  for (const l of lines) {
    if (!(l.unitPriceCents > 0) || !(l.qty > 0)) continue;
    const key = `${norm(l.description)}|${norm(l.unit)}`;
    if (!items.has(key)) continue;
    prices.set(key, [...(prices.get(key) ?? []), l.unitPriceCents]);
  }
  return [...prices.entries()]
    .map(([key, ps]) => ({ ...items.get(key)!, cents: average(ps) }))
    .sort((a, b) => a.item.localeCompare(b.item));
}

/** The month before `today` (YYYY-MM-DD), as YYYY-MM: the last whole month. */
export function lastWholeMonth(today: string): string {
  const [y, m] = today.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** The first and last day of a YYYY-MM month. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

/** Prices are kept in 5% bands: a band's number, and the price at its middle. */
export const MARKET_BAND = 1.05;
export const marketBand = (cents: number) => Math.round(Math.log(cents) / Math.log(MARKET_BAND));
export const bandCents = (band: number) => Math.round(MARKET_BAND ** band);
