import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addMonths, financialYear } from '@shap/shared';
import { today } from '../src/lib/books.js';
import { cashForecast, FORECAST_WEEKS } from '../src/modules/forecast.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from './helpers.js';

// The 13-week cash-flow forecast and budgets against actual. Made-up business, made-up figures.

const monthDay = (iso: string, day: number) => `${iso.slice(0, 8)}${String(day).padStart(2, '0')}`;

describe('the 13-week cash-flow forecast', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  const now = today();

  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    const client = await owner.post('/api/clients', { name: 'Made-up Client' });
    const invoice = async (issueDate: string, dueDate: string, cents: number) => {
      const inv = await owner.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate, dueDate, lines: [{ category: 'labour', description: 'Work', qty: 1, unitPriceCents: cents }] });
      await owner.post(`/api/documents/${inv.id}/issue`);
      return inv;
    };
    // Overdue: due ten days ago, nothing paid.
    await invoice(addDays(now, -40), addDays(now, -10), 200_000);
    // Due in twenty days, R10 000 of R13 000 paid already.
    const b = await invoice(addDays(now, -2), addDays(now, 20), 1_300_000);
    await owner.post(`/api/documents/${b.id}/receipts`, { date: addDays(now, -1), amountCents: 1_000_000, method: 'eft', sourceId: bank });
    // Insurance from the bank on the 5th of each of the last three months: a monthly cost.
    for (let i = 1; i <= 3; i++) await owner.post('/api/costs', { date: monthDay(addMonths(now, -i), 5), description: 'Cover', amountCents: 150_000, supplier: 'Made-up Insurer', categoryId: await r.cat('Insurance'), sourceId: bank });
    // A business card, with a monthly subscription on it: in the card's balance, not the bank's weeks.
    const [acc] = await env.sql<{ id: string }[]>`insert into accounts (code, name, type) values ('2310', 'Business credit card (made-up)', 'liability') returning id`;
    const card = await owner.post('/api/sources', { name: 'Made-up business card', kind: 'card', accountId: acc!.id });
    for (let i = 1; i <= 3; i++) await owner.post('/api/costs', { date: monthDay(addMonths(now, -i), 12), description: 'Subscription', amountCents: 30_000, supplier: 'Made-up Software', categoryId: await r.cat('Advertising'), sourceId: card.id });
    // A supplier bill due in thirty days.
    const { settings: s } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...s, features: { ...s.features, bills: true } }, 'PUT');
    const [bills] = await env.sql<{ id: string }[]>`select id from payment_sources where role = 'bills'`;
    await owner.post('/api/costs', { date: addDays(now, -1), description: 'Parts', amountCents: 250_000, supplier: 'Made-up Supplier', categoryId: await r.cat('Sundry'), sourceId: bills!.id, billNumber: 'MADE-UP-7', dueDate: addDays(now, 30) });
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('starts from the bank and till, with what the cards owe beside it', async () => {
    const f = await cashForecast(env.sql, now);
    // R10 000 received, R4 500 of insurance paid out of the bank.
    expect(f.openingCents).toBe(1_000_000 - 450_000);
    expect(f.cardsOweCents).toBe(90_000);
    expect(f.weeks).toHaveLength(FORECAST_WEEKS);
    expect(f.weeks[0]!.start).toBe(now);
    expect(f.weeks[FORECAST_WEEKS - 1]!.end).toBe(addDays(now, FORECAST_WEEKS * 7 - 1));
  });

  it('puts invoices on their due dates (overdue ones this week) and bills on theirs', async () => {
    const f = await cashForecast(env.sql, now);
    const overdue = f.items.find((x) => x.kind === 'overdue_invoice');
    expect(overdue).toMatchObject({ week: 0, date: now, cents: 200_000 });
    expect(overdue!.label).toMatch(/^Overdue: invoice .+ \(Made-up Client\)$/);
    expect(f.items.find((x) => x.kind === 'invoice')).toMatchObject({ week: 2, date: addDays(now, 20), cents: 300_000 });
    expect(f.items.find((x) => x.kind === 'bill')).toMatchObject({ week: 4, date: addDays(now, 30), cents: -250_000, label: 'Made-up Supplier (bill MADE-UP-7)' });
  });

  it('carries the monthly costs paid from the bank forward, but not the ones on a card', async () => {
    const f = await cashForecast(env.sql, now);
    const monthly = f.items.filter((x) => x.kind === 'monthly_cost');
    expect(monthly.length).toBeGreaterThanOrEqual(3);
    for (const m of monthly) expect(m).toMatchObject({ cents: -150_000, label: 'Made-up Insurer (usually monthly)' });
    // On the 5th, or this week when this month's isn't in the books yet.
    for (const m of monthly) expect(m.date === now || m.date.endsWith('-05')).toBe(true);
    expect(f.items.some((x) => x.label.includes('Made-up Software'))).toBe(false);
  });

  it('adds up: each week closes on the one before plus its money in less its money out', async () => {
    const f = await cashForecast(env.sql, now);
    let running = f.openingCents;
    f.weeks.forEach((w, i) => {
      const these = f.items.filter((x) => x.week === i);
      expect(w.inCents).toBe(these.filter((x) => x.cents > 0).reduce((t, x) => t + x.cents, 0));
      expect(w.outCents).toBe(-these.filter((x) => x.cents < 0).reduce((t, x) => t + x.cents, 0));
      running += w.inCents - w.outCents;
      expect(w.closingCents).toBe(running);
    });
    expect(f.lowest!.closingCents).toBe(Math.min(...f.weeks.map((w) => w.closingCents)));
    // Without supplier bills, the bill isn't counted.
    const { settings: s } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...s, features: { ...s.features, bills: false } }, 'PUT');
    expect((await cashForecast(env.sql, now)).items.some((x) => x.kind === 'bill')).toBe(false);
    await owner.post('/api/settings', { ...s, features: { ...s.features, bills: true } }, 'PUT');
  });

  it('is for someone who reads the books only', async () => {
    expect((await owner.get('/api/forecast')).weeks).toHaveLength(FORECAST_WEEKS);
    const { createUser } = await import('../src/auth.js');
    await createUser(env.sql, { name: 'Made-up Site Hand', email: 'site-forecast@example.co.za', password: 'test-password-1', role: 'staff', accessAdd: [] });
    const staff = await login(env.app, 'site-forecast@example.co.za');
    expect((await staff.call({ method: 'GET', url: '/api/forecast' })).statusCode).toBe(403);
  });

  it('says on screen that it’s an estimate, not advice', () => {
    const page = readFileSync(join(__dirname, '..', '..', 'web', 'src', 'pages', 'Forecast.tsx'), 'utf8');
    expect(page).toMatch(/An estimate from what’s in your books today/);
    expect(page).toMatch(/nor are provisional or turnover tax, drawings, or card and loan repayments/);
    expect(page).toMatch(/An aid to plan with, not advice/);
    expect(page).toMatch(/<p className="xs muted">\{FORECAST_NOTE\}<\/p>/);
  });
});

describe('budgets against actual', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  let fy: ReturnType<typeof financialYear>;
  let month: number;
  let bank: string;

  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    bank = await r.src('Business bank');
    const { settings } = await owner.get('/api/reference');
    fy = financialYear(today(), settings.fyEndMonth);
    month = (Number(today().slice(0, 4)) - Number(fy.start.slice(0, 4))) * 12 + Number(today().slice(5, 7)) - Number(fy.start.slice(5, 7));
    const yearAgo = addMonths(today(), -12);
    const client = await owner.post('/api/clients', { name: 'Made-up Client' });
    const inv = await owner.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: today(), lines: [{ category: 'labour', description: 'Work', qty: 1, unitPriceCents: 500_000 }] });
    await owner.post(`/api/documents/${inv.id}/issue`);
    await owner.post('/api/costs', { date: today(), description: 'Cover', amountCents: 100_000, supplier: 'Made-up Insurer', categoryId: await r.cat('Insurance'), sourceId: bank });
    // A year ago: the same month of last year.
    await owner.post('/api/costs', { date: yearAgo, description: 'Cover', amountCents: 200_000, supplier: 'Made-up Insurer', categoryId: await r.cat('Insurance'), sourceId: bank });
    await owner.post('/api/costs', { date: yearAgo, description: 'Fuel', amountCents: 80_000, supplier: 'Made-up Garage', categoryId: await r.cat('Petrol'), sourceId: bank });
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  const line = async (code: string) => ((await owner.get(`/api/budgets?fyEnd=${fy.end}`)).lines as { id: string; code: string; budget: number[] | null; actual: number[]; lastYear: number[] }[]).find((l) => l.code === code)!;

  it('shows the books’ figures for the income statement’s accounts, income and costs both as positive amounts', async () => {
    const r = await owner.get('/api/budgets');
    expect(r.fy).toEqual(fy);
    expect(r.months).toHaveLength(12);
    expect(r.months[0]).toBe(fy.start.slice(0, 7));
    // The months that have ended: this one isn't yet.
    expect(r.monthsDone).toBe(month);
    expect(r.years).toContain(fy.end);
    const types = new Set((r.lines as { type: string }[]).map((l) => l.type));
    expect([...types].sort()).toEqual(['cost_of_sales', 'expense', 'income']);
    const insurance = await line('6040');
    expect(insurance.actual[month]).toBe(100_000);
    expect(insurance.lastYear[month]).toBe(200_000);
    expect(insurance.budget).toBeNull();
    const income = (r.lines as { type: string; actual: number[] }[]).filter((l) => l.type === 'income').reduce((t, l) => t + l.actual[month]!, 0);
    expect(income).toBe(500_000);
  });

  it('refuses a date that isn’t a financial year’s end, an account off the income statement, and anything but twelve months', async () => {
    const insurance = await line('6040');
    const months = Array(12).fill(10_000);
    const bad = async (payload: unknown) => (await owner.call({ method: 'PUT', url: '/api/budgets', payload: payload as never })).statusCode;
    expect(await bad({ fyEnd: addDays(fy.end, -1), lines: [{ accountId: insurance.id, months }] })).toBe(400);
    const [bankAccount] = await env.sql<{ accountId: string }[]>`select account_id from payment_sources where id = ${bank}`;
    expect(await bad({ fyEnd: fy.end, lines: [{ accountId: bankAccount!.accountId, months }] })).toBe(400);
    expect(await bad({ fyEnd: fy.end, lines: [{ accountId: insurance.id, months: months.slice(1) }] })).toBe(400);
    expect(await bad({ fyEnd: fy.end, lines: [{ accountId: insurance.id, months: months.map(() => 0.5) }] })).toBe(400);
    expect((await owner.call({ method: 'GET', url: `/api/budgets?fyEnd=${addDays(fy.end, -1)}` })).statusCode).toBe(400);
    expect((await line('6040')).budget).toBeNull();
  });

  it('saves the owner’s budget, and clears it with every month at nothing', async () => {
    const insurance = await line('6040');
    const months = Array.from({ length: 12 }, (_, i) => 100_000 + i);
    expect(await owner.post('/api/budgets', { fyEnd: fy.end, lines: [{ accountId: insurance.id, months }] }, 'PUT')).toEqual({ saved: 1, cleared: 0 });
    expect((await line('6040')).budget).toEqual(months);
    const [a] = await env.sql<{ details: { saved: number } }[]>`select details from audit_log where action = 'save_budget' order by at desc limit 1`;
    expect(a!.details.saved).toBe(1);
    expect(await owner.post('/api/budgets', { fyEnd: fy.end, lines: [{ accountId: insurance.id, months: Array(12).fill(0) }] }, 'PUT')).toEqual({ saved: 0, cleared: 1 });
    expect((await line('6040')).budget).toBeNull();
  });

  it('starts from last year’s figures, changed by a percentage, filling only accounts without a budget', async () => {
    const insurance = await line('6040');
    const kept = Array(12).fill(123_400);
    await owner.post('/api/budgets', { fyEnd: fy.end, lines: [{ accountId: insurance.id, months: kept }] }, 'PUT');
    expect(await owner.post('/api/budgets/from-last-year', { fyEnd: fy.end, percent: 10 })).toEqual({ filled: 1 });
    // The fuel, 10% up, in the same month; the insurance budget left as it was.
    const fuel = await line('6060');
    expect(fuel.budget![month]).toBe(88_000);
    expect(fuel.budget!.reduce((t, x) => t + x, 0)).toBe(88_000);
    expect((await line('6040')).budget).toEqual(kept);
    // Again: nothing left to fill.
    expect(await owner.post('/api/budgets/from-last-year', { fyEnd: fy.end, percent: 10 })).toEqual({ filled: 0 });
    expect((await owner.call({ method: 'POST', url: '/api/budgets/from-last-year', payload: { fyEnd: fy.end, percent: -95 } })).statusCode).toBe(400);
  });

  it('lets someone who reads the books see the budget; only the owner sets it', async () => {
    const { createUser } = await import('../src/auth.js');
    await createUser(env.sql, { name: 'Made-up Bookkeeper', email: 'books-budget@example.co.za', password: 'test-password-1', role: 'staff', accessAdd: ['reports.view'] });
    await createUser(env.sql, { name: 'Made-up Site Hand', email: 'site-budget@example.co.za', password: 'test-password-1', role: 'staff', accessAdd: [] });
    const reader = await login(env.app, 'books-budget@example.co.za');
    const hand = await login(env.app, 'site-budget@example.co.za');
    expect((await reader.get(`/api/budgets?fyEnd=${fy.end}`)).fy.end).toBe(fy.end);
    const insurance = await line('6040');
    expect((await reader.call({ method: 'PUT', url: '/api/budgets', payload: { fyEnd: fy.end, lines: [{ accountId: insurance.id, months: Array(12).fill(1) }] } })).statusCode).toBe(403);
    expect((await reader.call({ method: 'POST', url: '/api/budgets/from-last-year', payload: { fyEnd: fy.end } })).statusCode).toBe(403);
    expect((await hand.call({ method: 'GET', url: '/api/budgets' })).statusCode).toBe(403);
  });

  it('is on the Accounts screen beside the forecast, and says it’s a plan, not the books', () => {
    const accounts = readFileSync(join(__dirname, '..', '..', 'web', 'src', 'pages', 'Accounts.tsx'), 'utf8');
    expect(accounts).toMatch(/\{ value: 'forecast', label: 'Cash-flow forecast' \},\s+\{ value: 'budgets', label: 'Budgets' \}/);
    const page = readFileSync(join(__dirname, '..', '..', 'web', 'src', 'pages', 'Budgets.tsx'), 'utf8');
    expect(page).toMatch(/A plan for you, not the books: nothing is posted from it\./);
  });
});
