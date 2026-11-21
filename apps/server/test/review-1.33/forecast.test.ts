import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addMonths, emp201Due, formatDate, monthEnd, vat201Due } from '@shap/shared';
import { today } from '../../src/lib/books.js';
import { cashForecast, LONG_OVERDUE_DAYS } from '../../src/modules/forecast.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

// The SARS, accounting, IFRS and words reviews of 1.33: the forecast's payroll goes by the pay date,
// its VAT by period, a monthly cost by how it was last paid (and a bill's by its terms), invoices
// long overdue aren't counted, and what's owed now is in it. Made-up business, made-up figures.

const now = today();
const thisMonth = `${now.slice(0, 8)}01`;
const lastMonth = addMonths(thisMonth, -1);
const words = (ym: string) => formatDate(`${ym}-01`, 'long').replace(/^1 /, '');
const md = (iso: string, d: number) => `${iso.slice(0, 8)}${String(d).padStart(2, '0')}`;

describe('VAT by period, and salaries by the month they’re paid', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    const { settings } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4000000002', vatCategory: 'C', features: { ...settings.features, payroll: true } }, 'PUT');
    const client = await owner.post('/api/clients', { name: 'Made-up Client' });
    // R4 000 (R600 VAT) invoiced last month, R2 000 (R300 VAT) this month.
    for (const [d, c] of [[md(lastMonth, 15), 400_000], [thisMonth, 200_000]] as const) {
      const inv = await owner.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: d, dueDate: d, lines: [{ category: 'labour', description: 'Work', qty: 1, unitPriceCents: c }] });
      await owner.post(`/api/documents/${inv.id}/issue`);
    }
    // Last month's salaries, paid on the 1st of this month.
    await owner.post('/api/employees', { name: 'Made-up Employee', salaryCents: 3_000_000, startDate: addMonths(thisMonth, -10) });
    const run = await owner.post('/api/pay-runs', { period: lastMonth.slice(0, 7), payDate: thisMonth, sourceId: bank });
    await owner.post(`/api/pay-runs/${run.id}/finalise`);
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('puts the VAT of periods that have ended on their VAT201, and this period’s on its own', async () => {
    const f = await cashForecast(env.sql, now);
    const vat = f.items.filter((x) => x.kind === 'vat');
    const lastDue = vat201Due(monthEnd(lastMonth));
    expect(vat).toEqual([
      expect.objectContaining({ date: lastDue < now ? now : lastDue, cents: -60_000 }),
      expect.objectContaining({ date: vat201Due(monthEnd(thisMonth)), cents: -30_000 }),
    ]);
  });

  it('counts a run paid in the month after its period once, by the month it was paid', async () => {
    const f = await cashForecast(env.sql, now);
    // One EMP201 for this month (when it was paid), not two.
    expect(f.items.filter((x) => x.kind === 'emp201' && x.label.startsWith(`EMP201 for ${words(thisMonth.slice(0, 7))}`))).toHaveLength(1);
    // The next salaries are next month's, on the 1st: none again this month.
    const pay = f.items.filter((x) => x.kind === 'payroll');
    expect(pay[0]!.date).toBe(addMonths(thisMonth, 1));
    expect(pay.every((x) => x.date >= addMonths(thisMonth, 1))).toBe(true);
    // Next month's EMP201 comes with them.
    expect(f.items.some((x) => x.kind === 'emp201' && x.date === emp201Due(addMonths(thisMonth, 1).slice(0, 7)))).toBe(true);
  });
});

describe('what’s already booked, monthly costs, long overdue invoices and what’s owed now', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  let payDate: string;
  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    const { settings: s } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...s, features: { ...s.features, payroll: true, bills: true, workers: true } }, 'PUT');
    // A pay run finalised before its pay day: its payment is in the books for that day.
    payDate = addDays(now, 3);
    await owner.post('/api/employees', { name: 'Made-up Employee', salaryCents: 2_000_000, startDate: addMonths(thisMonth, -10) });
    const run = await owner.post('/api/pay-runs', { period: payDate.slice(0, 7), payDate, sourceId: bank });
    await owner.post(`/api/pay-runs/${run.id}/finalise`);
    // Rent as supplier bills on the 1st, each due 30 days later, for the last three months.
    const [bills] = await env.sql<{ id: string }[]>`select id from payment_sources where role = 'bills'`;
    for (let i = 2; i >= 0; i--) {
      const d = addMonths(thisMonth, -i);
      await owner.post('/api/costs', { date: d, description: 'Rent', amountCents: 1_000_000, supplier: 'Made-up Landlord', categoryId: await r.cat('Insurance'), sourceId: bills!.id, billNumber: `MADE-UP-R${i}`, dueDate: addDays(d, 30) });
    }
    // A subscription moved from a card to the bank, and a contract moved from the bank to the card.
    const [cardAcc] = await env.sql<{ id: string }[]>`insert into accounts (code, name, type) values ('2310', 'Business card (made-up)', 'liability') returning id`;
    const card = await owner.post('/api/sources', { name: 'Made-up card', kind: 'card', accountId: cardAcc!.id });
    for (let i = 6; i >= 1; i--) {
      const m = addMonths(thisMonth, -i);
      await owner.post('/api/costs', { date: md(m, 12), description: 'Subscription', amountCents: 50_000, supplier: 'Made-up Software', categoryId: await r.cat('Advertising'), sourceId: i > 3 ? card.id : bank });
      await owner.post('/api/costs', { date: md(m, 3), description: 'Contract', amountCents: 70_000, supplier: 'Made-up Telco', categoryId: await r.cat('Cellphone'), sourceId: i > 3 ? bank : card.id });
    }
    // An invoice long overdue, and one only a little.
    const client = await owner.post('/api/clients', { name: 'Made-up Client' });
    for (const [due, cents] of [[addDays(now, -(LONG_OVERDUE_DAYS + 30)), 700_000], [addDays(now, -5), 100_000]] as const) {
      const inv = await owner.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: addDays(due, -30), dueDate: due, lines: [{ category: 'labour', description: 'Work', qty: 1, unitPriceCents: cents }] });
      await owner.post(`/api/documents/${inv.id}/issue`);
    }
    // A casual worker's day, not paid yet.
    const worker = await owner.post('/api/workers', { name: 'Made-up Worker', dayRateCents: 40_000, allowanceCents: 5_000 });
    await owner.post('/api/labour', { date: addDays(now, -1), entries: [{ workerId: worker.id, days: 1, wageCents: 40_000, allowanceCents: 5_000 }] });
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('puts a pay run’s payment, booked for a day to come, on that day', async () => {
    const [net] = await env.sql<{ n: number }[]>`select sum(net_cents)::bigint as n from pay_lines`;
    const f = await cashForecast(env.sql, now);
    const booked = f.items.filter((x) => x.kind === 'booked' && x.date === payDate);
    expect(booked.reduce((t, x) => t + x.cents, 0)).toBe(-Number(net!.n));
    // Not again as a projected month: the next salaries are a month after the pay day.
    expect(f.items.filter((x) => x.kind === 'payroll').every((x) => x.date.slice(0, 7) > payDate.slice(0, 7))).toBe(true);
  });

  it('pays a monthly cost that comes as a bill on the bill’s terms, from the month after the last bill', async () => {
    const f = await cashForecast(env.sql, now);
    const rent = f.items.filter((x) => x.kind === 'monthly_cost' && x.label.startsWith('Made-up Landlord'));
    expect(rent.length).toBeGreaterThan(0);
    for (const x of rent) expect(x.date).toBe(addDays(`${addDays(x.date, -30).slice(0, 8)}01`, 30));
    // The first is next month's bill, 30 days after its 1st; this month's is an open bill already.
    expect(rent[0]!.date).toBe(addDays(addMonths(thisMonth, 1), 30));
    // The three bills captured are open bills, the two past due this week.
    expect(f.items.filter((x) => (x.kind === 'bill' || x.kind === 'overdue_bill') && x.label.includes('Made-up Landlord'))).toHaveLength(3);
  });

  it('takes a monthly cost from the bank only when it was last paid from the bank', async () => {
    const f = await cashForecast(env.sql, now);
    expect(f.items.some((x) => x.kind === 'monthly_cost' && x.label.startsWith('Made-up Software'))).toBe(true);
    expect(f.items.some((x) => x.label.startsWith('Made-up Telco'))).toBe(false);
  });

  it('shows invoices long overdue apart, not as money coming in', async () => {
    const f = await cashForecast(env.sql, now);
    expect(f.longOverdue).toEqual({ count: 1, cents: 700_000, days: LONG_OVERDUE_DAYS });
    expect(f.items.filter((x) => x.kind === 'overdue_invoice').map((x) => x.cents)).toEqual([100_000]);
  });

  it('counts the wages owed to casual workers now', async () => {
    const f = await cashForecast(env.sql, now);
    expect(f.items.find((x) => x.kind === 'wages_owed')).toMatchObject({ week: 0, cents: -45_000 });
  });
});

describe('the forecast’s words (words and SARS reviews of 1.33)', () => {
  it('says what isn’t in it, who OpenWorks IT are, and that its tax figures are estimates', () => {
    const page = readFileSync(join(__dirname, '..', '..', '..', 'web', 'src', 'pages', 'Forecast.tsx'), 'utf8');
    expect(page).toMatch(/Sales you haven’t made or invoiced yet aren’t in it/);
    expect(page).toMatch(/VAT as invoiced \(the invoice basis\)/);
    expect(page).toMatch(/the employment tax incentive isn’t taken off/);
    expect(page).toMatch(/OpenWorks IT, who make Shap, aren’t accountants or tax practitioners/);
    expect(page).toMatch(/if clients pay what they owe now and costs run as usual/);
    expect(page).toMatch(/more than \{data\.longOverdue\.days\} days overdue/);
  });
});
