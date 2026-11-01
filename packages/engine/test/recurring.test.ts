/** Monthly costs: learnt from what's captured, and missed when one doesn't come. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findRecurring } from '../src/modules/recurring.js';
import { login, ref, setup, type TestEnv } from './helpers.js';

const TODAY = '2026-10-21';

describe('monthly costs', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  let cats: Record<"insurance" | "bank" | "parts" | "software", string>;
  let bank: string;
  const cost = (date: string, description: string, amountCents: number, supplier: string, categoryId: string) =>
    owner.post('/api/costs', { date, description, amountCents, supplier, categoryId, sourceId: bank });
  const find = async (label: string) => (await findRecurring(env.sql, TODAY)).find((r) => r.label === label);

  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    bank = await r.src('Business bank');
    cats = { insurance: await r.cat('Insurance'), bank: await r.cat('Bank'), parts: await r.cat('Parts'), software: await r.cat('Software & subscriptions') };
    for (const m of ['06', '07', '08', '09']) await cost(`2026-${m}-01`, 'Business cover', 84550, 'Santam', cats.insurance);
    for (const m of ['06', '07', '08', '09', '10']) await cost(`2026-${m}-03`, 'Monthly fee', 6900, 'FNB', cats.bank);
    for (const m of ['07', '08', '09']) await cost(`2026-${m}-25`, 'AI subscription', 40000, 'Anthropic', cats.software);
    // Stopped in May: long gone, nothing to warn about.
    for (const m of ['02', '03', '04', '05']) await cost(`2026-${m}-10`, 'Old tracker', 19900, 'Netstar', cats.insurance);
    // Parts every month aren't a running cost.
    for (const m of ['06', '07', '08', '09']) await cost(`2026-${m}-12`, 'Cement', 30000, 'Cashbuild', cats.parts);
  });
  afterAll(() => env.close());

  it('learns the monthly ones, and says which didn’t come this month', async () => {
    const all = await findRecurring(env.sql, TODAY);
    expect(all.map((r) => [r.label, r.status])).toEqual([
      ['Santam', 'missing'],
      ['Anthropic', 'due'],
      ['FNB', 'ok'],
    ]);
    expect(await find('Santam')).toMatchObject({ usualCents: 84550, usualDay: 1, missingMonths: ['2026-10'], lastSeen: '2026-09' });
  });

  it('points at a statement line that looks like the missing one', async () => {
    await owner.post('/api/bank/statements', { sourceId: bank, csv: ['Date,Amount,Balance,Description', '2026/10/01,-845.50,,DEBIT ORDER SANTAM 99887766'].join('\n') });
    expect((await find('Santam'))!.onStatement).toMatchObject({ description: 'DEBIT ORDER SANTAM 99887766', amountCents: -84550 });
  });

  it('skips a month, or stops watching one you cancelled', async () => {
    const s = (await find('Santam'))!;
    await owner.post('/api/costs/recurring/mark', { key: s.key, month: '2026-10' });
    expect((await find('Santam'))!.status).toBe('ok');
    await owner.post('/api/costs/recurring/unmark', { key: s.key, month: '2026-10' });
    await owner.post('/api/costs/recurring/mark', { key: s.key });
    expect((await find('Santam'))!.status).toBe('stopped');
    await owner.post('/api/costs/recurring/unmark', { key: s.key });
    expect((await find('Santam'))!.status).toBe('missing');
  });

  it('keeps warning while it’s missing, for up to three months', async () => {
    expect((await findRecurring(env.sql, '2026-12-20')).find((r) => r.label === 'Santam')).toMatchObject({ status: 'missing', missingMonths: ['2026-10', '2026-11', '2026-12'] });
    expect((await findRecurring(env.sql, '2027-01-20')).find((r) => r.label === 'Santam')).toBeUndefined();
  });

  it('shows on Home', async () => {
    const d = await owner.get('/api/dashboard');
    expect(Array.isArray(d.recurringMissing)).toBe(true);
  });
});
