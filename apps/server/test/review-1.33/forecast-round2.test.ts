import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addMonths, dwtDue, formatDate, monthEnd, vat201Due } from '@shap/shared';
import { today } from '../../src/lib/books.js';
import { cashForecast } from '../../src/modules/forecast.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

// The second round of 1.33's reviews (IFRS, SARS, accounting): what's paid by an entry dated ahead
// isn't counted again as owed, a monthly cost captured ahead isn't projected again, a bill's
// monthly cost is found however its supplier is spelt and months gone by aren't put in this week,
// salaries paid early aren't repeated, a VAT journal is its period's, an older VAT201 is this
// week's, and a business that deregisters still owes its last VAT. Made-up business, made-up figures.

const now = today();
const thisMonth = `${now.slice(0, 8)}01`;
const md = (iso: string, d: number) => `${iso.slice(0, 8)}${String(d).padStart(2, '0')}`;
const out = (items: { cents: number }[]) => -items.reduce((t, x) => t + Math.min(0, x.cents), 0);

describe('payments booked ahead, counted once', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    const { settings: s } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...s, businessType: 'company', features: { ...s.features, workers: true } }, 'PUT');
    // A day's wages owed, paid in two days.
    const worker = await owner.post('/api/workers', { name: 'Made-up Worker', dayRateCents: 40_000, allowanceCents: 5_000 });
    await owner.post('/api/labour', { date: addDays(now, -1), entries: [{ workerId: worker.id, days: 1, wageCents: 40_000, allowanceCents: 5_000 }] });
    await owner.post('/api/wage-payments', { date: addDays(now, 2), workerId: worker.id, amountCents: 45_000, sourceId: bank });
    // A dividend declared today and paid in five days.
    await owner.post('/api/dividends', { declaredOn: now, paidOn: addDays(now, 5), shareholder: 'Made-up Shareholder', grossCents: 1_000_000, sourceId: bank });
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('takes a wage paid ahead off what’s owed now', async () => {
    const f = await cashForecast(env.sql, now);
    expect(f.items.filter((x) => x.kind === 'wages_owed')).toEqual([]);
    expect(out(f.items.filter((x) => x.kind === 'booked' && x.date === addDays(now, 2)))).toBe(45_000);
  });

  it('pays a dividend paid ahead once: the amount paid on its day, the dividends tax on its own', async () => {
    const f = await cashForecast(env.sql, now);
    expect(f.items.filter((x) => x.kind === 'dividends')).toEqual([]);
    const paid = out(f.items.filter((x) => x.kind === 'booked' && x.date === addDays(now, 5)));
    const dwt = f.items.filter((x) => x.kind === 'dwt');
    // The shareholder's 80% on the day, the 20% dividends tax by the DTR01's date.
    expect(paid).toBe(800_000);
    expect(dwt.map((x) => [x.cents, x.date])).toEqual([[-200_000, dwtDue(addDays(now, 5))]]);
  });
});

describe('monthly costs captured ahead, and as bills', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    const { settings: s } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...s, features: { ...s.features, bills: true } }, 'PUT');
    const [bills] = await env.sql<{ id: string }[]>`select id from payment_sources where role = 'bills'`;
    // Insurance from the bank on the 1st: the last three months, and next month's captured ahead.
    for (const i of [-3, -2, -1, 1]) await owner.post('/api/costs', { date: addMonths(thisMonth, i), description: 'Cover', amountCents: 1_000_000, supplier: 'Made-up Insurer', categoryId: await r.cat('Insurance'), sourceId: bank });
    // Rent as bills, the supplier's name written two ways; the last this month.
    for (const [i, name] of [[-2, 'Made-up Landlord'], [-1, 'Made-up Landlord'], [0, 'Made-up Landlord (Pty) Ltd']] as const)
      await owner.post('/api/costs', { date: addMonths(thisMonth, i), description: 'Rent', amountCents: 2_000_000, supplier: name, categoryId: await r.cat('Sundry'), sourceId: bills!.id, billNumber: `MADE-UP-${i + 3}`, dueDate: addDays(addMonths(thisMonth, i), 24) });
    // Advertising billed four, three and two months ago, and none since.
    for (const i of [-4, -3, -2]) await owner.post('/api/costs', { date: addMonths(thisMonth, i), description: 'Ads', amountCents: 300_000, supplier: 'Made-up Media', categoryId: await r.cat('Advertising'), sourceId: bills!.id, billNumber: `MADE-UP-A${-i}`, dueDate: addDays(addMonths(thisMonth, i), 10) });
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('doesn’t project a month whose cost is already captured, dated ahead', async () => {
    const f = await cashForecast(env.sql, now);
    const next = addMonths(thisMonth, 1);
    expect(f.items.filter((x) => x.kind === 'monthly_cost' && x.label.startsWith('Made-up Insurer') && x.date.startsWith(next.slice(0, 7)))).toEqual([]);
    expect(out(f.items.filter((x) => x.kind === 'booked' && x.date === next))).toBe(1_000_000);
  });

  it('finds the last bill however the supplier is spelt, and puts no gone-by month in this week', async () => {
    const f = await cashForecast(env.sql, now);
    const rent = f.items.filter((x) => x.kind === 'monthly_cost' && x.label.includes('Landlord'));
    // From next month's bill on, 24 days after the 1st.
    expect(rent[0]!.date).toBe(addDays(addMonths(thisMonth, 1), 24));
    // The two months gone by without a bill aren't put in this week: at most this month's is.
    const ads = f.items.filter((x) => x.kind === 'monthly_cost' && x.label.includes('Made-up Media'));
    expect(out(ads.filter((x) => x.week === 0))).toBeLessThanOrEqual(300_000);
    expect(ads.every((x) => x.date >= addDays(thisMonth, 10) || x.date === now)).toBe(true);
  });
});

describe('salaries paid early, VAT journals and older returns, and a business no longer registered', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  let bank: string;
  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    bank = await r.src('Business bank');
    const { settings } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4000000002', vatCategory: 'C', features: { ...settings.features, payroll: true } }, 'PUT');
    const client = await owner.post('/api/clients', { name: 'Made-up Client' });
    // R4 000 two months ago (R600 VAT) and R2 000 last month (R300), not paid to SARS.
    for (const [d, c] of [[md(addMonths(thisMonth, -2), 10), 400_000], [md(addMonths(thisMonth, -1), 10), 200_000]] as const) {
      const inv = await owner.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: d, dueDate: d, lines: [{ category: 'labour', description: 'Work', qty: 1, unitPriceCents: c }] });
      await owner.post(`/api/documents/${inv.id}/issue`);
    }
    // A VAT adjustment by journal this month: R150 more output VAT.
    await owner.post('/api/journals', { date: thisMonth, description: 'Made-up VAT adjustment', lines: [{ accountId: (await env.sql<{ id: string }[]>`select id from accounts where code = '6900'`)[0]!.id, debitCents: 15_000 }, { accountId: await r.acc('vat'), creditCents: 15_000 }] });
    // Next month's salaries paid early, this month.
    await owner.post('/api/employees', { name: 'Made-up Employee', salaryCents: 2_000_000, startDate: addMonths(thisMonth, -10) });
    const run = await owner.post('/api/pay-runs', { period: addMonths(thisMonth, 1).slice(0, 7), payDate: thisMonth, sourceId: bank });
    await owner.post(`/api/pay-runs/${run.id}/finalise`);
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('doesn’t pay a month’s salaries again when its run was paid early', async () => {
    const f = await cashForecast(env.sql, now);
    const pay = f.items.filter((x) => x.kind === 'payroll');
    // Next month's were paid on the 1st of this month: the month after's come next, a month ahead
    // as these were, and next month's aren't paid again.
    const words = (d: string) => formatDate(d, 'long').replace(/^1 /, '');
    expect(pay.some((x) => x.label.startsWith(`Salaries (${words(addMonths(thisMonth, 1))},`))).toBe(false);
    expect(pay[0]!.label).toMatch(new RegExp(`^Salaries \\(${words(addMonths(thisMonth, 2))},`));
    expect(pay[0]!.date).toBe(addMonths(thisMonth, 1));
  });

  it('refuses a pay date a year off its month, takes one paid late, and says a final run is final', async () => {
    const r = await owner.call({ method: 'POST', url: '/api/pay-runs', payload: { period: addMonths(thisMonth, 2).slice(0, 7), payDate: addMonths(thisMonth, -10), sourceId: bank } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/isn’t, so it may be a slip of the year or month\. For pay that really was that early or late, ask your accountant how to record it\./);
    expect(r.json().error).not.toMatch(/\d{4}-\d{2}:/);
    // A month paid four months late is taken (and goes on the EMP201 of the month it was paid in).
    const late = await owner.call({ method: 'POST', url: '/api/pay-runs', payload: { period: addMonths(thisMonth, -6).slice(0, 7), payDate: addMonths(thisMonth, -2), sourceId: bank } });
    expect(late.statusCode).toBe(200);
    // Moved a year off while a draft: refused; a final run says it's final, whatever the date.
    expect((await owner.call({ method: 'PUT', url: `/api/pay-runs/${late.json().id}`, payload: { payDate: addMonths(thisMonth, 10), sourceId: bank } })).statusCode).toBe(400);
    const [fin] = await env.sql<{ id: string }[]>`select id from pay_runs where status = 'final' limit 1`;
    const put = await owner.call({ method: 'PUT', url: `/api/pay-runs/${fin!.id}`, payload: { payDate: addMonths(thisMonth, -20), sourceId: bank } });
    expect(put.statusCode).toBe(400);
    expect(put.json().error).not.toMatch(/slip of the year/);
    expect(put.json().error).toMatch(/^This pay run is final\. Reopen it to change it\.$/);
    await owner.call({ method: 'DELETE', url: `/api/pay-runs/${late.json().id}` });
  });

  it('puts the older VAT201 this week, the last on its date, and a journal in its own period', async () => {
    const f = await cashForecast(env.sql, now);
    const vat = f.items.filter((x) => x.kind === 'vat');
    const lastEnd = monthEnd(addMonths(thisMonth, -1));
    const lastDue = vat201Due(lastEnd);
    expect(vat).toEqual([
      expect.objectContaining({ date: now, cents: -60_000, label: `VAT owing for periods before ${formatDate(addMonths(thisMonth, -1))} (VAT201, an estimate, as if paid now)` }),
      expect.objectContaining({ date: lastDue < now ? now : lastDue, cents: -30_000 }),
      expect.objectContaining({ date: vat201Due(monthEnd(thisMonth)), cents: -15_000, label: `VAT so far on the period to ${formatDate(monthEnd(thisMonth))} (VAT201)` }),
    ]);
  });

  it('still forecasts the VAT owed once the business is no longer registered', async () => {
    const { settings } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...settings, vatRegistered: false }, 'PUT');
    const f = await cashForecast(env.sql, now);
    expect(out(f.items.filter((x) => x.kind === 'vat'))).toBe(60_000 + 30_000 + 15_000);
    await owner.post('/api/settings', { ...settings }, 'PUT');
  });
});
