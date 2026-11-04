/**
 * Anonymous market rates: only the trade's standard items, one median each, nothing shared
 * until the owner has been told, once a month, and the collector keeping national tallies only.
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bandCents, isMarketItem, lastWholeMonth, marketBand, marketRates } from '@shap/shared';
import { today } from '../src/lib/books.js';
import { shareMarketRates } from '../src/modules/market.js';
import { login, setup, type TestEnv } from './helpers.js';

const INSTALL = '3f2a9c1e-5b7d-4e8a-9c0f-1a2b3c4d5e6f';

describe('what a business shares', () => {
  it('takes only the trade’s standard items, the median of each, and nothing typed', () => {
    const rates = marketRates('builder', [
      { description: 'Tiling', unit: 'm²', unitPriceCents: 40000, qty: 30 },
      { description: '  tiling ', unit: 'M²', unitPriceCents: 50000, qty: 12 },
      { description: 'Tiling', unit: 'm²', unitPriceCents: 45000, qty: 5 },
      // Typed by hand, a different unit, free, or a credit: not shared.
      { description: 'Tiling for Mrs Naidoo at 12 Oak St', unit: 'm²', unitPriceCents: 99000, qty: 1 },
      { description: 'Tiling', unit: 'day', unitPriceCents: 150000, qty: 1 },
      { description: 'Plastering', unit: 'm²', unitPriceCents: 0, qty: 10 },
      { description: 'Bricklaying', unit: 'm²', unitPriceCents: 30000, qty: -2 },
    ]);
    expect(rates).toEqual([{ item: 'Tiling', unit: 'm²', cents: 45000 }]);
    // "Something else" isn't a trade to compare; a typed item isn't a standard one.
    expect(marketRates('other', [{ description: 'Labour', unit: 'hour', unitPriceCents: 40000, qty: 1 }])).toEqual([]);
    expect(isMarketItem('builder', 'Tiling', 'm²')).toBe(true);
    expect(isMarketItem('builder', 'Tiling at 12 Oak St', 'm²')).toBe(false);
    expect(lastWholeMonth('2026-01-15')).toBe('2025-12');
    expect(Math.abs(bandCents(marketBand(45000)) - 45000) / 45000).toBeLessThan(0.03);
  });
});

describe('sharing and collecting', () => {
  let env: TestEnv;
  let dir: string;
  const month = lastWholeMonth(today());
  const day = `${month}-10`;
  const marketFiles = () => {
    const d = join(dir, 'market');
    return readdirSync(d).map((f) => readFileSync(join(d, f), 'utf8')).join('\n');
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'shap-market-'));
    env = await setup({ env: { FEEDBACK_DIR: dir, COLLECT: 'true' } });
    await env.sql`update settings set industry = 'builder', setup_done = true, install_id = ${INSTALL} where id`;
    const owner = await login(env.app, 'owner@example.co.za');
    for (const price of [40000, 46000]) {
      const doc = await owner.post('/api/documents', { kind: 'invoice', issueDate: day, lines: [{ description: 'Tiling', unit: 'm²', qty: 20, unitPriceCents: price }, { description: 'Tiles for the Naidoo bathroom', unit: 'item', qty: 1, unitPriceCents: 120000 }] });
      await env.sql`update documents set status = 'issued' where id = ${doc.id}`;
    }
    // A draft doesn't count.
    const draft = await owner.post('/api/documents', { kind: 'invoice', issueDate: day, lines: [{ description: 'Tiling', unit: 'm²', qty: 1, unitPriceCents: 900000 }] });
    const [d] = await env.sql<{ status: string }[]>`select status from documents where id = ${draft.id}`;
    expect(d!.status).toBe('draft');
  });
  afterAll(() => env.close());

  it('is on, but shares nothing until the owner has been told', async () => {
    const [s] = await env.sql<{ marketConsent: boolean; marketNoticeSeen: boolean }[]>`select market_consent, market_notice_seen from settings where id`;
    expect(s).toEqual({ marketConsent: true, marketNoticeSeen: false });
    expect(await shareMarketRates(env.ctx, env.sql, console)).toBe('off');
  });

  it('shares last month once, as tallies with no business in them', async () => {
    await env.sql`update settings set market_notice_seen = true where id`;
    expect(await shareMarketRates(env.ctx, env.sql, console)).toBe('sent');
    expect(await shareMarketRates(env.ctx, env.sql, console)).toBe('done');
    const tally = JSON.parse(readFileSync(join(dir, 'market', `${month}.json`), 'utf8'));
    // One business, one price (the median of R400 and R460), in its 5% band.
    expect(tally.cells['builder|Tiling|m²']).toEqual({ [String(marketBand(43000))]: 1 });
    expect(Object.keys(tally.cells)).toEqual(['builder|Tiling|m²']);
    const all = marketFiles();
    expect(all).not.toContain(INSTALL);
    expect(all).not.toMatch(/Naidoo|Tiles for/);
  });

  it('shares nothing once switched off', async () => {
    await env.sql`update settings set market_consent = false, market_sent_month = '' where id`;
    expect(await shareMarketRates(env.ctx, env.sql, console)).toBe('off');
    await env.sql`update settings set market_consent = true, market_sent_month = ${month} where id`;
  });

  it('collects from phones: standard items only, past months only, counted once', async () => {
    const send = (body: Record<string, unknown>) =>
      env.app.inject({ method: 'POST', url: '/collect/market', payload: { app: 'pocket', version: '0.7.4', installId: '9b1c2d3e-4f5a-4b6c-8d7e-0f1a2b3c4d5e', month, industry: 'electrician', rates: [{ item: 'Install plug point', unit: 'point', cents: 65000 }], ...body } });
    const first = await send({});
    expect(first.statusCode).toBe(201);
    expect(first.headers['access-control-allow-origin']).toBe('*');
    expect(first.json().counted).toBe(1);
    // The same phone again for the same month: not counted twice.
    expect((await send({})).json().counted).toBe(0);
    // Typed text, another trade's item, or a month that isn't over: refused.
    expect((await send({ rates: [{ item: 'Plug point for Mr Botha', unit: 'point', cents: 65000 }] })).statusCode).toBe(400);
    expect((await send({ rates: [{ item: 'Tiling', unit: 'm²', cents: 40000 }] })).statusCode).toBe(400);
    expect((await send({ month: today().slice(0, 7) })).statusCode).toBe(400);
    expect(marketFiles()).not.toContain('9b1c2d3e');
  });
});
