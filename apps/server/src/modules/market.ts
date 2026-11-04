/**
 * Anonymous market rates (see packages/shared/src/market.ts for what is shared and why).
 *
 * Sending: once a month, unless the owner switched it off in Settings (and only once they've
 * been told about it), the median price of each of
 * the trade's standard items on last month's issued invoices goes to OpenWorks' collector.
 *
 * Collecting (COLLECT=true, OpenWorks' own server): each price is added into a national tally
 * for its trade, item, unit and month, in 5% bands, and only the tallies are kept, in files
 * under FEEDBACK_DIR/market, apart from any company's books. There is no record of what one
 * business charged: a business is remembered only as a keyed hash per item (so it's counted
 * once a month, and so ranges are only ever worked out where enough different businesses have
 * shared), and those hashes differ from item to item, so they can't be joined into one
 * business's price list. Nothing here publishes anything.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { isMarketItem, lastMonths, lastWholeMonth, MARKET_INDUSTRIES, MARKET_MIN_BUSINESSES, marketBand, marketItems, marketRates, monthRange, rangeFromBands, type MarketContribution, type MarketRange } from '@shap/shared';
import { requireRole } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Db } from '../db/index.js';
import { getSettings, today } from '../lib/books.js';
import { HttpError } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { appVersion } from './system.js';

const INSTALL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const marketInput = z
  .object({
    app: z.enum(['shap', 'pocket']),
    version: z.string().max(40).default(''),
    installId: z.string().regex(INSTALL_RE),
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    industry: z.string().max(40),
    rates: z.array(z.object({ item: z.string().max(120), unit: z.string().max(20), cents: z.number().int().min(1).max(100_000_000_00) })).max(60),
  })
  // Only the trade's standard items get in: nothing typed by a person ever reaches the collector.
  .refine((c) => c.rates.every((r) => isMarketItem(c.industry, r.item, r.unit)), 'Only the standard items of a trade can be shared')
  .refine((c) => new Set(c.rates.map((r) => `${r.item}|${r.unit}`)).size === c.rates.length, 'Each item once');

/** Last month's issued invoices: the median price of each of the trade's standard items. */
export async function monthRates(db: Db, industry: string, month: string) {
  if (!marketItems(industry).size) return [];
  const { from, to } = monthRange(month);
  const lines = await db<{ description: string; unit: string; unitPriceCents: number; qty: number }[]>`
    select l.description, l.unit, l.unit_price_cents, l.qty
    from document_lines l join documents d on d.id = l.document_id
    where d.kind = 'invoice' and d.status = 'issued' and d.issue_date between ${from}::date and ${to}::date`;
  return marketRates(industry, lines.map((l) => ({ ...l, qty: Number(l.qty), unitPriceCents: Number(l.unitPriceCents) })));
}

async function send(url: string, body: unknown): Promise<boolean> {
  if (!url || url === 'off') return false;
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/market`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Shares last month's rates, once, if the owner said yes. Called from the half-hourly timer, so
 * a month that couldn't be sent (no internet) goes on a later try. A month with none of the
 * standard items is marked done with nothing sent.
 */
export async function shareMarketRates(ctx: Ctx, db: Db, log: { warn: (o: object, m: string) => void }): Promise<'off' | 'done' | 'sent' | 'nothing' | 'failed'> {
  const s = await getSettings(db);
  // On unless switched off, but nothing goes until the owner has been told (setup, or Home's note).
  if (!s.marketConsent || !s.marketNoticeSeen || !s.setupDone) return 'off';
  const month = lastWholeMonth(today());
  if (s.marketSentMonth >= month) return 'done';
  const rates = await monthRates(db, s.industry, month);
  if (rates.length) {
    const c: MarketContribution = { app: 'shap', version: appVersion(), installId: s.installId, month, industry: s.industry, rates };
    const ok = ctx.config.COLLECT ? (await collectMarket(ctx, c), true) : await send(ctx.config.COLLECTOR_URL, c);
    if (!ok) {
      log.warn({ month }, 'market rates: collector unreachable, will try again');
      return 'failed';
    }
  }
  await db`update settings set market_sent_month = ${month} where id`;
  return rates.length ? 'sent' : 'nothing';
}

// ---------------------------------------------------------------- the collector's tallies

interface MonthTally {
  /** "industry|item|unit" → price band → how many businesses. */
  cells: Record<string, Record<string, number>>;
  /** Keyed hashes of (business, item, month) already counted, so a resend doesn't count twice. */
  seen: Record<string, 1>;
}
/** "industry|item|unit" → keyed hashes of the businesses that ever shared it (for the minimum count). */
type Contributors = Record<string, Record<string, 1>>;

const marketDir = (ctx: Ctx) => join(resolve(ctx.config.FEEDBACK_DIR), 'market');
async function readJson<T>(file: string, empty: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return empty;
  }
}
async function writeJson(file: string, value: unknown) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(value), { mode: 0o640 });
  await rename(tmp, file);
}

// One write at a time, so two contributions arriving together don't lose each other's counts.
let queue: Promise<unknown> = Promise.resolve();

/** Adds one business's month into the national tallies. Returns how many prices were counted. */
export function collectMarket(ctx: Ctx, c: MarketContribution): Promise<number> {
  const run = queue.then(async () => {
    const dir = marketDir(ctx);
    await mkdir(dir, { recursive: true, mode: 0o750 });
    const monthFile = join(dir, `${c.month}.json`);
    const peopleFile = join(dir, 'contributors.json');
    const tally = await readJson<MonthTally>(monthFile, { cells: {}, seen: {} });
    const people = await readJson<Contributors>(peopleFile, {});
    let counted = 0;
    for (const r of c.rates) {
      const cell = `${c.industry}|${r.item}|${r.unit}`;
      const once = ctx.secrets.hash(`market|${c.installId}|${cell}|${c.month}`);
      if (tally.seen[once]) continue;
      tally.seen[once] = 1;
      const band = String(marketBand(r.cents));
      const bands = (tally.cells[cell] ??= {});
      bands[band] = (bands[band] ?? 0) + 1;
      (people[cell] ??= {})[ctx.secrets.hash(`market|${c.installId}|${cell}`)] = 1;
      counted++;
    }
    if (counted) {
      await writeJson(monthFile, tally);
      await writeJson(peopleFile, people);
    }
    return counted;
  });
  queue = run.catch(() => undefined);
  return run;
}

/**
 * The ranges for a trade, from the last 12 months' tallies: only items at least
 * MARKET_MIN_BUSINESSES different businesses have shared, as the middle half of what they charged.
 */
export async function marketRanges(ctx: Ctx, industry: string): Promise<MarketRange[]> {
  if (!MARKET_INDUSTRIES.includes(industry)) return [];
  const dir = marketDir(ctx);
  const people = await readJson<Contributors>(join(dir, 'contributors.json'), {});
  const merged = new Map<string, Record<string, number>>();
  for (const month of lastMonths(today())) {
    const tally = await readJson<MonthTally>(join(dir, `${month}.json`), { cells: {}, seen: {} });
    for (const [cell, bands] of Object.entries(tally.cells)) {
      if (!cell.startsWith(`${industry}|`)) continue;
      const into = merged.get(cell) ?? {};
      for (const [b, n] of Object.entries(bands)) into[b] = (into[b] ?? 0) + n;
      merged.set(cell, into);
    }
  }
  const out: MarketRange[] = [];
  for (const [cell, bands] of merged) {
    const businesses = Object.keys(people[cell] ?? {}).length;
    if (businesses < MARKET_MIN_BUSINESSES) continue;
    const r = rangeFromBands(bands);
    const [, item, unit] = cell.split('|') as [string, string, string];
    if (r) out.push({ item, unit, lowCents: r.low, midCents: r.mid, highCents: r.high, businesses });
  }
  return out.sort((a, b) => a.item.localeCompare(b.item));
}

// A server that isn't the collector asks it, at most twice a day per trade.
const fetched = new Map<string, { at: number; ranges: MarketRange[] }>();
async function rangesFromCollector(ctx: Ctx, industry: string): Promise<MarketRange[]> {
  const url = ctx.config.COLLECTOR_URL;
  if (!url || url === 'off' || !MARKET_INDUSTRIES.includes(industry)) return [];
  const hit = fetched.get(industry);
  if (hit && Date.now() - hit.at < 12 * 3600_000) return hit.ranges;
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/market/rates?industry=${encodeURIComponent(industry)}`, { signal: AbortSignal.timeout(8000) });
    const ranges = r.ok ? ((await r.json()) as { items: MarketRange[] }).items : (hit?.ranges ?? []);
    fetched.set(industry, { at: Date.now(), ranges });
    return ranges;
  } catch {
    return hit?.ranges ?? [];
  }
}

/** From outside: Shap Pocket on phones, and other Shap servers. */
const PER_DAY = 5000;
const PER_ADDRESS = 30;
const today_ = { day: '', count: 0, byAddress: new Map<string, number>() };

export function registerMarketRoutes(app: FastifyInstance, ctx: Ctx): void {
  // What the trade's standard items typically cost, for the quote and invoice screens.
  app.get('/api/market/rates', { preHandler: requireRole('owner', 'accountant') }, async () => {
    const { industry } = await getSettings(ctx.sql);
    return { industry, items: ctx.config.COLLECT ? await marketRanges(ctx, industry) : await rangesFromCollector(ctx, industry) };
  });

  if (!ctx.config.COLLECT) return;
  const open = (reply: FastifyReply) => {
    // Pocket has no account: anyone may send, and no cookies are read or set here.
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-allow-methods', 'POST, OPTIONS');
    reply.header('access-control-allow-headers', 'content-type');
    reply.header('access-control-max-age', '86400');
  };
  app.get('/collect/market/rates', { config: { rateLimit: { max: 60, timeWindow: '10 minutes' } } }, async (req, reply) => {
    reply.header('access-control-allow-origin', '*');
    reply.header('cache-control', 'public, max-age=3600');
    const { industry } = parse(z.object({ industry: z.string().max(40) }), req.query);
    return { industry, months: 12, minimumBusinesses: MARKET_MIN_BUSINESSES, items: await marketRanges(ctx, industry) };
  });
  app.post('/collect/market', { bodyLimit: 32 * 1024, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    open(reply);
    const day = new Date().toISOString().slice(0, 10);
    if (today_.day !== day) Object.assign(today_, { day, count: 0, byAddress: new Map() });
    if (today_.count >= PER_DAY || (today_.byAddress.get(req.ip) ?? 0) >= PER_ADDRESS) throw new HttpError(429, 'Thanks: please try again tomorrow.', 'rate_limited');
    const c = parse(marketInput, req.body);
    // Only a month that's over (and not years old): no prices for the future.
    if (c.month >= today().slice(0, 7) || c.month < lastWholeMonth(`${Number(today().slice(0, 4)) - 2}${today().slice(4)}`)) throw new HttpError(400, 'That month can’t be shared', 'bad_month');
    const counted = await collectMarket(ctx, c);
    today_.count++;
    today_.byAddress.set(req.ip, (today_.byAddress.get(req.ip) ?? 0) + 1);
    reply.code(201);
    return { counted };
  });
}
