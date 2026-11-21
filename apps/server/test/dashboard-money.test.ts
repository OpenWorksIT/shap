import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '@shap/shared';
import { today } from '../src/lib/books.js';
import { daysOf } from '../src/modules/dashboard.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from './helpers.js';

// Home's money figures: the cash on hand, how long clients take to pay, how long the business
// takes to pay its suppliers, and the gross margin month by month. Made-up business, made-up figures.
describe('Home: the money on hand, debtor and creditor days', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  let bank: string;
  const day = addDays(today(), -10);

  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    bank = await r.src('Business bank');
    const client = await owner.post('/api/clients', { name: 'Made-up Client' });
    const inv = await owner.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: day, lines: [{ category: 'labour', description: 'Work', qty: 1, unitPriceCents: 1_000_000 }] });
    await owner.post(`/api/documents/${inv.id}/issue`);
    await owner.post(`/api/documents/${inv.id}/receipts`, { date: day, amountCents: 500_000, method: 'eft', sourceId: bank });
    // A business credit card (a liability account of its own), with a cost paid from it.
    const [acc] = await env.sql<{ id: string }[]>`insert into accounts (code, name, type) values ('2310', 'Business credit card (made-up)', 'liability') returning id`;
    const card = await owner.post('/api/sources', { name: 'Made-up business card', kind: 'card', accountId: acc!.id });
    await owner.post('/api/costs', { date: day, description: 'Fuel', amountCents: 100_000, supplier: 'Made-up Garage', categoryId: await r.cat('Petrol'), sourceId: card.id });
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('shows the bank and till, what the cards owe, and how long clients take to pay', async () => {
    const d = await owner.get('/api/dashboard');
    expect(d.cash).toEqual({ inBankCents: 500_000, cardsOweCents: 100_000 });
    // R5 000 still owed on R10 000 invoiced over the 11 days since the first invoice.
    expect(d.debtorDays).toBe(Math.round((500_000 / 1_000_000) * 11));
    // No supplier bills: nothing to say about paying suppliers.
    expect(d.creditorDays).toBeNull();
  });

  it('with supplier bills on, says how long the business takes to pay them', async () => {
    const { settings: s } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...s, features: { ...s.features, bills: true } }, 'PUT');
    const [billsSource] = await env.sql<{ id: string }[]>`select id from payment_sources where role = 'bills'`;
    expect((await owner.get('/api/dashboard')).creditorDays).toBe(0);
    // A R2 000 bill from a supplier, not paid yet (a running cost, so off the job's cost of sales).
    await owner.post('/api/costs', { date: day, description: 'Insurance', amountCents: 200_000, supplier: 'Made-up Insurer', categoryId: await (await ref(env.sql)).cat('Insurance'), sourceId: billsSource!.id, billNumber: 'MADE-UP-1', dueDate: addDays(day, 30) });
    const d = await owner.get('/api/dashboard');
    // R2 000 owed against R2 000 of bills over the 11 days since the first (the fuel wasn't a bill).
    expect(d.creditorDays).toBe(11);
  });

  it('says a little owed is at least a day, so 0 days means nothing is owed', () => {
    expect(daysOf(100, 100_000_000)).toBe(1);
    expect(daysOf(0, 100_000_000)).toBe(0);
    expect(daysOf(50, 0)).toBeNull();
    expect(daysOf(500_000, 1_000_000)).toBe(183);
    expect(daysOf(500_000, 1_000_000, 11)).toBe(6);
  });

  it('gives only someone who reads the books these figures', async () => {
    const { createUser } = await import('../src/auth.js');
    await createUser(env.sql, { name: 'Made-up Site Hand', email: 'site-dash@example.co.za', password: 'test-password-1', role: 'staff', accessAdd: [] });
    const staff = await login(env.app, 'site-dash@example.co.za');
    const d = await staff.get('/api/dashboard');
    expect(d.limited).toBe(true);
    expect(d.cash).toBeUndefined();
    expect(d.debtorDays).toBeUndefined();
  });

  it('draws the gross margin month by month on Home', () => {
    const home = readFileSync(join(__dirname, '..', '..', 'web', 'src', 'pages', 'Home.tsx'), 'utf8');
    const chart = readFileSync(join(__dirname, '..', '..', 'web', 'src', 'components', 'MarginChart.tsx'), 'utf8');
    expect(home).toMatch(/<MarginChart data=\{data\.months\.map\(/);
    // Nothing owed says so, rather than "about 0 days".
    expect(home).toMatch(/data\.creditorDays === 0 \? 'Nothing owed now'/);
    expect(home).toMatch(/data\.debtorDays === 0 \? 'Nothing owed now'/);
    expect(chart).toMatch(/export const marginOf = \(m: MarginPoint\): number \| null => \(m\.incomeCents > 0 \? \(m\.incomeCents - m\.costOfSalesCents\) \/ m\.incomeCents : null\);/);
  });
});
