/** Patents and software: intangible assets, amortised; software and hosting as their own costs. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balance, ledgerTotal, login, ref, setup, type TestEnv } from './helpers.js';

describe('intangible assets and IT costs', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  let bank: string;
  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
    bank = await ref(env.sql).then((r) => r.src('Business bank'));
  });
  afterAll(() => env.close());

  it('puts an attorney’s patent fee on the balance sheet and amortises it', async () => {
    const admin = await ref(env.sql).then((r) => r.cat('Accounting & admin').catch(() => r.cat('Sundry')));
    const fee = await owner.post('/api/costs', { date: '2026-03-10', description: 'Patent application – Avi', amountCents: 1200000, supplier: 'Attorneys Inc', categoryId: admin, sourceId: bank });
    await owner.post('/api/assets', { name: 'Avi patent', category: 'patents', purchaseDate: '2026-03-10', costCents: 1200000, costId: fee.id, lifeMonths: 120 });
    expect(await balance(env.sql, 'intangible_patents', '2026-03-31')).toBe(1200000);
    // R12,000 over 120 months: R100 a month, as amortisation (not depreciation).
    expect(await balance(env.sql, 'amortisation', '2026-05-31')).toBe(30000);
    expect(await balance(env.sql, 'accumulated_amortisation', '2026-05-31')).toBe(-30000);
    expect(await balance(env.sql, 'depreciation', '2026-05-31')).toBe(0);
    const [reg] = (await owner.get('/api/assets?date=2026-05-31')).filter((a: { name: string }) => a.name === 'Avi patent');
    expect(reg).toMatchObject({ intangible: true, accumulatedCents: 30000 });
    const bs = await owner.get('/api/reports/balance-sheet?date=2026-05-31');
    expect(bs.assets.intangible.map((i: { name: string }) => i.name)).toEqual(['Patents & trade marks at cost', 'Accumulated amortisation']);
    expect(bs.assets.nonCurrent.some((i: { name: string }) => /Patents/.test(i.name))).toBe(false);
    expect(bs.differenceCents).toBe(0);
    expect(await ledgerTotal(env.sql)).toBe(0);
  });

  it('takes it off the books when it lapses', async () => {
    const [a] = (await owner.get('/api/assets')).filter((x: { name: string }) => x.name === 'Avi patent');
    await owner.post(`/api/assets/${a.id}`, { name: 'Avi patent', category: 'patents', purchaseDate: '2026-03-10', costCents: 1200000, costId: a.costId, lifeMonths: 120, disposedOn: '2026-07-15', disposalProceedsCents: 0 }, 'PUT');
    expect(await balance(env.sql, 'intangible_patents', '2026-08-01')).toBe(0);
    expect(await balance(env.sql, 'accumulated_amortisation', '2026-08-01')).toBe(0);
    expect(await ledgerTotal(env.sql)).toBe(0);
  });

  it('has cost types for software subscriptions and hosting', async () => {
    const r = await ref(env.sql);
    const sw = await r.cat('Software & subscriptions');
    const host = await r.cat('Hosting, servers & domains');
    await owner.post('/api/costs', { date: '2026-04-01', description: 'AI subscription', amountCents: 40000, supplier: 'Anthropic', categoryId: sw, sourceId: bank });
    await owner.post('/api/costs', { date: '2026-04-01', description: 'VPS', amountCents: 25000, supplier: 'Rackzar', categoryId: host, sourceId: bank });
    expect(await balance(env.sql, 'software', '2026-04-30')).toBe(40000);
    expect(await balance(env.sql, 'hosting', '2026-04-30')).toBe(25000);
  });
});
