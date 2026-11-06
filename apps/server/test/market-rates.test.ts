/**
 * Market-rate ranges (market-rates branch): the middle half of what businesses charged, and
 * only where at least five different businesses have shared that item.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lastWholeMonth, marketBand, rangeForLine, rangeFromBands } from '@shap/shared';
import { today } from '../src/lib/books.js';
import { login, setup, type TestEnv } from './helpers.js';

const install = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('ranges from the tallies', () => {
  it('takes the quarter, middle and three-quarter prices', () => {
    const bands: Record<string, number> = {};
    for (const c of [40000, 45000, 50000, 55000, 60000, 65000, 70000, 75000]) bands[marketBand(c)] = (bands[marketBand(c)] ?? 0) + 1;
    const r = rangeFromBands(bands)!;
    expect(r.low).toBeGreaterThan(42000);
    expect(r.low).toBeLessThan(48000);
    expect(r.high).toBeGreaterThan(62000);
    expect(r.high).toBeLessThan(68000);
    expect(rangeFromBands({})).toBeNull();
    expect(rangeForLine([{ item: 'Install plug point', unit: 'point', lowCents: 1, midCents: 2, highCents: 3, businesses: 5 }], ' install plug POINT', 'Point')?.businesses).toBe(5);
  });
});

describe('publishing ranges', () => {
  let env: TestEnv;
  const month = lastWholeMonth(today());
  const share = (n: number, cents: number) =>
    env.app.inject({ method: 'POST', url: '/collect/market', headers: { 'x-forwarded-for': `198.51.100.${n}` }, payload: { app: 'pocket', installId: install(n), month, industry: 'electrician', rates: [{ item: 'Install plug point', unit: 'point', cents }, { item: 'Fault finding', unit: 'hour', cents: 50000 }] } });

  beforeAll(async () => {
    env = await setup({ env: { FEEDBACK_DIR: mkdtempSync(join(tmpdir(), 'shap-rates-')), COLLECT: 'true', TRUST_PROXY: 'true' } });
    await env.sql`update settings set industry = 'electrician' where id`;
  });
  afterAll(() => env.close());

  it('shows nothing until five different businesses have shared an item', async () => {
    for (let n = 1; n <= 4; n++) expect((await share(n, 50000 + n * 5000)).statusCode).toBe(201);
    expect((await env.app.inject({ method: 'GET', url: '/collect/market/rates?industry=electrician' })).json().items).toEqual([]);
    // The same business again doesn't make five.
    await share(4, 99000);
    expect((await env.app.inject({ method: 'GET', url: '/collect/market/rates?industry=electrician' })).json().items).toEqual([]);
  });

  it('then the middle half of what they charged, to anyone and to the quote screen', async () => {
    await share(5, 75000);
    const r = await env.app.inject({ method: 'GET', url: '/collect/market/rates?industry=electrician' });
    expect(r.headers['access-control-allow-origin']).toBe('*');
    const plug = r.json().items.find((i: { item: string }) => i.item === 'Install plug point');
    expect(plug).toMatchObject({ unit: 'point', businesses: 5 });
    expect(plug.lowCents).toBeLessThan(plug.midCents);
    expect(plug.midCents).toBeLessThan(plug.highCents);
    expect(plug.lowCents).toBeGreaterThan(50000);
    expect(plug.highCents).toBeLessThan(80000);
    const owner = await login(env.app, 'owner@example.co.za');
    // Not until the owner has been told about sharing (and hasn't switched it off).
    expect((await owner.get('/api/market/rates')).items).toEqual([]);
    await env.sql`update settings set market_notice_seen = true where id`;
    expect((await owner.get('/api/market/rates')).items.map((i: { item: string }) => i.item)).toEqual(['Fault finding', 'Install plug point']);
    await env.sql`update settings set market_consent = false where id`;
    expect((await owner.get('/api/market/rates')).items).toEqual([]);
    // Site staff don't get it (they don't quote).
    const site = await login(env.app, 'site@example.co.za');
    expect((await site.call({ method: 'GET', url: '/api/market/rates' })).statusCode).toBe(403);
  });
});

describe('a count that can’t be gamed', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup({ env: { FEEDBACK_DIR: mkdtempSync(join(tmpdir(), 'shap-rates-')), COLLECT: 'true', TRUST_PROXY: 'true' } });
  });
  afterAll(() => env.close());

  it('counts the businesses in the same twelve months as the prices', async () => {
    const { collectMarket, marketRanges } = await import('../src/modules/market.js');
    const { addMonths } = await import('@shap/shared');
    const old = addMonths(`${lastWholeMonth(today())}-01`, -14).slice(0, 7);
    // Four businesses long ago (outside the window), one last month.
    for (let n = 1; n <= 4; n++) await collectMarket(env.ctx, { app: 'pocket', version: '0', installId: install(n), month: old, industry: 'electrician', rates: [{ item: 'Install plug point', unit: 'point', cents: 50000 }] });
    await collectMarket(env.ctx, { app: 'pocket', version: '0', installId: install(9), month: lastWholeMonth(today()), industry: 'electrician', rates: [{ item: 'Install plug point', unit: 'point', cents: 123400 }] });
    expect(await marketRanges(env.ctx, 'electrician')).toEqual([]);
  });
});
