/**
 * Anonymous market rates (see packages/shared/src/market.ts for what is shared and why).
 *
 * Sending: once a month, unless the owner switched it off in Settings (and only once they've
 * been told about it), the average price of each of
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
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { addMonths, isMarketItem, lastWholeMonth, marketBand, marketItems, marketRates, monthRange, type MarketContribution } from '@shap/shared';
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

/** Last month's issued invoices: the average price of each of the trade's standard items. */
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
  /** "industry|item|unit" → keyed hashes of the businesses that shared it that month (for the minimum count). */
  people?: Record<string, Record<string, 1>>;
}

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

/** Months a contribution may be for: the last few that are over (a phone sends last month's). */
export const MARKET_MONTHS_BACK = 3;
/** New businesses one item can gain in a day: a flood of made-up ones can't swamp an item. */
const PER_CELL_PER_DAY = 25;
const cellsToday = { day: '', counts: new Map<string, number>() };
const short = (h: string) => h.slice(0, 32);

// One write at a time, so two contributions arriving together don't lose each other's counts.
let queue: Promise<unknown> = Promise.resolve();

/** Adds one business's month into the national tallies. Returns how many prices were counted. */
export function collectMarket(ctx: Ctx, c: MarketContribution): Promise<number> {
  const run = queue.then(async () => {
    const dir = marketDir(ctx);
    await mkdir(dir, { recursive: true, mode: 0o750 });
    const monthFile = join(dir, `${c.month}.json`);
    const tally = await readJson<MonthTally>(monthFile, { cells: {}, seen: {}, people: {} });
    const people = (tally.people ??= {});
    const day = new Date().toISOString().slice(0, 10);
    if (cellsToday.day !== day) Object.assign(cellsToday, { day, counts: new Map() });
    let counted = 0;
    for (const r of c.rates) {
      const cell = `${c.industry}|${r.item}|${r.unit}`;
      const once = short(ctx.secrets.hash(`market|${c.installId}|${cell}|${c.month}`));
      if (tally.seen[once]) continue;
      if ((cellsToday.counts.get(cell) ?? 0) >= PER_CELL_PER_DAY) continue;
      cellsToday.counts.set(cell, (cellsToday.counts.get(cell) ?? 0) + 1);
      tally.seen[once] = 1;
      const band = String(marketBand(r.cents));
      const bands = (tally.cells[cell] ??= {});
      bands[band] = (bands[band] ?? 0) + 1;
      (people[cell] ??= {})[short(ctx.secrets.hash(`market|${c.installId}|${cell}`))] = 1;
      counted++;
    }
    if (counted) await writeJson(monthFile, tally);
    return counted;
  });
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Who a request counts as for the per-address limits: the address, or for IPv6 its /64 (one
 * connection's whole block of addresses).
 */
export function addressKey(ip: string): string {
  if (!ip.includes(':') || ip.startsWith('::ffff:')) return ip.replace(/^::ffff:/, '');
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...h, ...Array(Math.max(8 - h.length - t.length, 0)).fill('0'), ...t] : h;
  return `${full.slice(0, 4).map((x) => x.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** From outside: Shap Pocket on phones, and other Shap servers. */
const PER_DAY = 5000;
const PER_ADDRESS = 30;
const today_ = { day: '', count: 0, byAddress: new Map<string, number>() };

export function registerMarketRoutes(app: FastifyInstance, ctx: Ctx): void {
  if (!ctx.config.COLLECT) return;
  const open = (reply: FastifyReply) => {
    // Pocket has no account: anyone may send, and no cookies are read or set here.
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-allow-methods', 'POST, OPTIONS');
    reply.header('access-control-allow-headers', 'content-type');
    reply.header('access-control-max-age', '86400');
  };
  app.post('/collect/market', { bodyLimit: 32 * 1024, config: { rateLimit: { max: 10, timeWindow: '10 minutes', keyGenerator: (req: FastifyRequest) => addressKey(req.ip) } } }, async (req, reply) => {
    open(reply);
    const day = new Date().toISOString().slice(0, 10);
    if (today_.day !== day) Object.assign(today_, { day, count: 0, byAddress: new Map() });
    const who = addressKey(req.ip);
    if (today_.count >= PER_DAY || (today_.byAddress.get(who) ?? 0) >= PER_ADDRESS) throw new HttpError(429, 'Thanks: please try again tomorrow.', 'rate_limited');
    const c = parse(marketInput, req.body);
    // Only one of the last few months that are over: no prices for the future, and no back-filling history.
    if (c.month >= today().slice(0, 7) || c.month < addMonths(`${lastWholeMonth(today())}-01`, -(MARKET_MONTHS_BACK - 1)).slice(0, 7)) throw new HttpError(400, 'That month can’t be shared', 'bad_month');
    const counted = await collectMarket(ctx, c);
    today_.count++;
    today_.byAddress.set(who, (today_.byAddress.get(who) ?? 0) + 1);
    reply.code(201);
    return { counted };
  });
}
