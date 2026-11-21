import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addMonths, monthEnd, vat201Due } from '@shap/shared';
import { today } from '../../src/lib/books.js';
import { cashForecast } from '../../src/modules/forecast.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

// The third round of 1.33's reviews (IFRS, SARS, accounting): a cost's VAT is its period's however
// it was paid, only VAT against money is a payment, a payment ahead beyond what's owed comes off
// this period, dividends and wages paid ahead don't cancel older ones, a refund doesn't cancel a
// month's cost, and someone new on the payroll counts in full. Made-up business, made-up figures.

const now = today();
const thisMonth = `${now.slice(0, 8)}01`;
const out = (items: { cents: number }[]) => -items.reduce((t, x) => t + Math.min(0, x.cents), 0);

describe('VAT, however it was paid', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  let r: Awaited<ReturnType<typeof ref>>;
  let bank: string;
  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
    r = await ref(env.sql);
    bank = await r.src('Business bank');
    const { settings } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4000000002', vatCategory: 'C' }, 'PUT');
    const client = await owner.post('/api/clients', { name: 'Made-up Client', address: '1 Made-up Street, Fictional Town' });
    // This month: R10 000 invoiced (R1 500 VAT), R5 750 of parts paid from the bank (R750 VAT).
    const inv = await owner.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: thisMonth, dueDate: addDays(now, 60), lines: [{ category: 'labour', description: 'Work', qty: 1, unitPriceCents: 1_000_000 }] });
    await owner.post(`/api/documents/${inv.id}/issue`);
    await owner.post('/api/costs', { date: thisMonth, description: 'Made-up parts', supplier: 'Made-up Supplies', amountCents: 575_000, vatCents: 75_000, categoryId: await r.cat('Parts'), sourceId: bank });
    // A cash sale by journal this month: R1 000 and R150 VAT into the bank.
    await owner.post('/api/journals', { date: thisMonth, description: 'Made-up cash sale', lines: [{ accountId: await r.acc('bank'), debitCents: 115_000 }, { accountId: await r.acc('revenue_other'), creditCents: 100_000 }, { accountId: await r.acc('vat'), creditCents: 15_000 }] });
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('counts input VAT on a cost paid from the bank, and a cash sale’s VAT, in this period', async () => {
    const f = await cashForecast(env.sql, now);
    expect(f.items.filter((x) => x.kind === 'vat')).toEqual([expect.objectContaining({ date: vat201Due(monthEnd(thisMonth)), cents: -(150_000 - 75_000 + 15_000) })]);
  });

  it('takes a payment to SARS booked ahead beyond what’s owed for ended periods off this period’s', async () => {
    // R500 paid to SARS by journal, dated in three days.
    const j = await owner.post('/api/journals', { date: addDays(now, 3), description: 'Made-up VAT paid', lines: [{ accountId: await r.acc('vat'), debitCents: 50_000 }, { accountId: await r.acc('bank'), creditCents: 50_000 }] });
    const f = await cashForecast(env.sql, now);
    expect(out(f.items.filter((x) => x.kind === 'vat'))).toBe(90_000 - 50_000);
    expect(out(f.items.filter((x) => x.kind === 'booked'))).toBe(50_000);
    await owner.call({ method: 'DELETE', url: `/api/journals/${j.id}` });
  });

  it('counts VAT paid by the owner personally as a payment, not a period’s VAT', async () => {
    const j = await owner.post('/api/journals', { date: now, description: 'Made-up VAT paid by the owner', lines: [{ accountId: await r.acc('vat'), debitCents: 40_000 }, { accountId: await r.acc('owner_loan'), creditCents: 40_000 }] });
    const f = await cashForecast(env.sql, now);
    expect(out(f.items.filter((x) => x.kind === 'vat'))).toBe(90_000 - 40_000);
    await owner.call({ method: 'DELETE', url: `/api/journals/${j.id}` });
  });
});

describe('owed now, and what’s paid ahead', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
    const owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    const { settings: s } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...s, businessType: 'company', features: { ...s.features, workers: true } }, 'PUT');
    // R5 000 declared ten days ago and not paid; R10 000 declared tomorrow and paid in five days.
    await owner.post('/api/dividends', { declaredOn: addDays(now, -10), shareholder: 'Made-up Shareholder', grossCents: 500_000 });
    await owner.post('/api/dividends', { declaredOn: addDays(now, 1), paidOn: addDays(now, 5), shareholder: 'Made-up Shareholder', grossCents: 1_000_000, sourceId: bank });
    // A day owed for yesterday, a day earned tomorrow, and one day's pay the day after.
    const worker = await owner.post('/api/workers', { name: 'Made-up Worker', dayRateCents: 40_000, allowanceCents: 5_000 });
    for (const d of [addDays(now, -1), addDays(now, 1)]) await owner.post('/api/labour', { date: d, entries: [{ workerId: worker.id, days: 1, wageCents: 40_000, allowanceCents: 5_000 }] });
    await owner.post('/api/wage-payments', { date: addDays(now, 2), workerId: worker.id, amountCents: 45_000, sourceId: bank });
    // Insurance from the bank on the 1st for three months, and a refund from the insurer next month.
    for (const i of [-3, -2, -1]) await owner.post('/api/costs', { date: addMonths(thisMonth, i), description: 'Cover', amountCents: 1_000_000, supplier: 'Made-up Insurer', categoryId: await r.cat('Insurance'), sourceId: bank });
    await owner.post('/api/costs', { date: addDays(addMonths(thisMonth, 1), 1), description: 'Refund', amountCents: -50_000, supplier: 'Made-up Insurer', categoryId: await r.cat('Insurance'), sourceId: bank });
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('keeps a dividend owed now when a later one is paid ahead', async () => {
    const f = await cashForecast(env.sql, now);
    expect(f.items.filter((x) => x.kind === 'dividends').map((x) => x.cents)).toEqual([-500_000]);
  });

  it('keeps wages owed now when the pay ahead is for work ahead', async () => {
    const f = await cashForecast(env.sql, now);
    expect(f.items.filter((x) => x.kind === 'wages_owed').map((x) => x.cents)).toEqual([-45_000]);
  });

  it('doesn’t let a refund captured ahead cancel a month’s cost', async () => {
    const f = await cashForecast(env.sql, now);
    const next = addMonths(thisMonth, 1).slice(0, 7);
    expect(f.items.filter((x) => x.kind === 'monthly_cost' && x.label.startsWith('Made-up Insurer') && x.date.startsWith(next)).map((x) => x.cents)).toEqual([-1_000_000]);
  });
});

describe('salaries, someone new on the payroll', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
    const owner = await login(env.app, 'owner@example.co.za');
    const bank = await (await ref(env.sql)).src('Business bank');
    const { settings: s } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...s, features: { ...s.features, payroll: true } }, 'PUT');
    await owner.post('/api/employees', { name: 'Made-up First', salaryCents: 2_000_000, startDate: addMonths(thisMonth, -10) });
    for (const i of [-2, -1]) {
      const run = await owner.post('/api/pay-runs', { period: addMonths(thisMonth, i).slice(0, 7), payDate: addDays(addMonths(thisMonth, i), 24), sourceId: bank });
      await owner.post(`/api/pay-runs/${run.id}/finalise`);
    }
    await owner.post('/api/employees', { name: 'Made-up Second', salaryCents: 2_000_000, startDate: thisMonth });
    const run = await owner.post('/api/pay-runs', { period: thisMonth.slice(0, 7), payDate: addDays(thisMonth, 24), sourceId: bank });
    await owner.post(`/api/pay-runs/${run.id}/finalise`);
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('projects everyone in the last run at their own usual pay', async () => {
    const [last] = await env.sql<{ net: number }[]>`select sum(l.net_cents)::bigint as net from pay_lines l join pay_runs r on r.id = l.run_id where r.period = ${thisMonth.slice(0, 7)}`;
    const f = await cashForecast(env.sql, now);
    const pay = f.items.filter((x) => x.kind === 'payroll');
    expect(pay[0]!.cents).toBe(-Number(last!.net));
    expect(pay[0]!.date).toBe(addDays(addMonths(thisMonth, 1), 24));
  });
});
