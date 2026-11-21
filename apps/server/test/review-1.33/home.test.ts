import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, financialYear, monthEnd } from '@shap/shared';
import { today } from '../../src/lib/books.js';
import { buildStatements } from '../../src/statements/build.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

// The IFRS, accounting and words reviews of 1.33: Home's money on hand is the statements' cash (not
// picked by payment source), its days are measured against invoices and bills, and its gross margin
// is the income statement's gross profit. Made-up business, made-up figures.

const WEB = join(__dirname, '..', '..', '..', 'web', 'src');

describe('Home’s money figures, as the statements have them', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  const day = addDays(today(), -10);

  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    const bankAccount = await r.acc('bank');
    const client = await owner.post('/api/clients', { name: 'Made-up Client' });
    const invoice = async (cents: number) => {
      const inv = await owner.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: day, lines: [{ category: 'labour', description: 'Work', qty: 1, unitPriceCents: cents }] });
      await owner.post(`/api/documents/${inv.id}/issue`);
      return inv;
    };
    const paid = await invoice(1_000_000);
    await owner.post(`/api/documents/${paid.id}/receipts`, { date: day, amountCents: 1_000_000, method: 'eft', sourceId: bank });
    await invoice(500_000);
    // R6 000 of parts for the job: cost of sales.
    await owner.post('/api/costs', { date: day, description: 'Made-up parts', supplier: 'Made-up Supplies', amountCents: 600_000, categoryId: await r.cat('Parts'), sourceId: bank });
    // Interest received: income, but not revenue, and not invoiced.
    await owner.post('/api/journals', { date: day, description: 'Interest (made up)', lines: [{ accountId: bankAccount, debitCents: 500_000 }, { accountId: await r.acc('interest_income'), creditCents: 500_000 }] });
    // A call deposit on the cash line with no payment source, the owner's money put in.
    const [call] = await env.sql<{ id: string }[]>`insert into accounts (code, name, type, statement_line) values ('1060', 'Made-up call deposit', 'asset', 'cash') returning id`;
    await owner.post('/api/journals', { date: day, description: 'Owner’s money in (made up)', lines: [{ accountId: call!.id, debitCents: 2_000_000 }, { accountId: await r.acc('owner_loan'), creditCents: 2_000_000 }] });
    // A debit card on the business bank account: a way of paying, not another account.
    await owner.post('/api/sources', { name: 'Made-up debit card', kind: 'card', accountId: bankAccount });
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('counts the money in the bank and till as the statements’ cash, whatever the payment sources', async () => {
    const d = await owner.get('/api/dashboard');
    // R10 000 in, R6 000 out, R5 000 interest, and R20 000 in the call deposit.
    expect(d.cash).toEqual({ inBankCents: 2_900_000, cardsOweCents: 0 });
    const { settings } = await owner.get('/api/reference');
    const s = await buildStatements(env.sql, financialYear(today(), settings.fyEndMonth).end);
    expect(s.sfp.assets.find((b) => b.key === 'current_assets')!.lines.find((l) => l.key === 'cash')!.current).toBe(d.cash.inBankCents);
  });

  it('measures the gross margin as the income statement’s gross profit: revenue less cost of sales', async () => {
    const d = await owner.get('/api/dashboard');
    expect(d.yearToDate.revenueCents).toBe(1_500_000);
    expect(d.yearToDate.grossProfitCents).toBe(1_500_000 - 600_000);
    const month = d.months.find((m: { key: string }) => m.key === day.slice(0, 7));
    expect(month).toMatchObject({ revenueCents: 1_500_000, grossCostCents: 600_000 });
    const home = readFileSync(join(WEB, 'pages', 'Home.tsx'), 'utf8');
    expect(home).toMatch(/<MarginChart data=\{data\.months\.map\(\(m\) => \(\{ key: m\.key, label: m\.label, incomeCents: m\.revenueCents, costOfSalesCents: m\.grossCostCents \}\)\)\} \/>/);
    expect(home).toMatch(/`\$\{formatPercent\(ytdMargin\)\} of revenue, as the financial statements count it`/);
  });

  it('measures debtor days against invoices (not interest), over the days since the first', async () => {
    const d = await owner.get('/api/dashboard');
    // R5 000 owed on R15 000 invoiced over 11 days.
    expect(d.debtorDays).toBe(Math.round((500_000 / 1_500_000) * 11));
  });
});

describe('Home’s words (words review of 1.33)', () => {
  it('names whose return each reminder is, and says the figures are rough guides', () => {
    const home = readFileSync(join(WEB, 'pages', 'Home.tsx'), 'utf8');
    expect(home).not.toMatch(/<strong>SARS: \{t\.label\}<\/strong>/);
    expect(home).toMatch(/<strong>\{t\.body === 'SARS' \? `SARS: \$\{t\.label\}` : t\.label\}<\/strong>/);
    expect(home).toMatch(/Shap files nothing with CIPC: you or your accountant file it/);
    expect(home).toMatch(/Shap files nothing with the Fund: you or your accountant file it/);
    expect(home).toMatch(/Rough guides to plan with, not advice\./);
    expect(home).toMatch(/label="Clients take to pay"/);
    expect(home).toMatch(/label="You take to pay bills"/);
    const chart = readFileSync(join(WEB, 'components', 'MarginChart.tsx'), 'utf8');
    expect(chart).toMatch(/const average = known\.length && revenue > 0 \?/);
  });
});

// Second round (IFRS): Home's tiles add up, revenue first; and a second bank account is cash.
describe('Home’s tiles, and a second bank account', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  const day = addDays(today(), -5);
  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    const bankAccount = await r.acc('bank');
    const client = await owner.post('/api/clients', { name: 'Made-up Client' });
    const inv = await owner.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: day, lines: [{ category: 'labour', description: 'Work', qty: 1, unitPriceCents: 1_000_000 }] });
    await owner.post(`/api/documents/${inv.id}/issue`);
    await owner.post('/api/costs', { date: day, description: 'Made-up parts', supplier: 'Made-up Supplies', amountCents: 300_000, categoryId: await r.cat('Parts'), sourceId: bank });
    await owner.post('/api/costs', { date: day, description: 'Made-up cover', supplier: 'Made-up Insurer', amountCents: 200_000, categoryId: await r.cat('Insurance'), sourceId: bank });
    await owner.post('/api/journals', { date: day, description: 'Interest (made up)', lines: [{ accountId: bankAccount, debitCents: 500_000 }, { accountId: await r.acc('interest_income'), creditCents: 500_000 }] });
    // Interest paid (a finance cost) and income tax booked: below running costs, as the statements have them.
    await owner.post('/api/costs', { date: day, description: 'Made-up interest', supplier: 'Made-up Bank', amountCents: 20_000, categoryId: await r.cat('Interest'), sourceId: bank });
    await owner.post('/api/journals', { date: day, description: 'Income tax (made up)', lines: [{ accountId: await r.acc('income_tax'), debitCents: 10_000 }, { accountId: bankAccount, creditCents: 10_000 }] });
    // A cost dated later this month (when there's a later day): not "to date" yet.
    const monthLast = monthEnd(today());
    if (monthLast > today()) await owner.post('/api/costs', { date: monthLast, description: 'Made-up later', supplier: 'Made-up Insurer', amountCents: 70_000, categoryId: await r.cat('Insurance'), sourceId: bank });
    // A savings account added in Settings, with a bank payment source on it, and R4 000 moved in.
    const acc = await owner.post<{ id: string }>('/api/accounts', { code: '1070', name: 'Made-up Savings', type: 'asset', active: true });
    await owner.post('/api/sources', { name: 'Made-up savings', kind: 'bank', accountId: acc.id });
    await owner.post('/api/journals', { date: day, description: 'To savings (made up)', lines: [{ accountId: acc.id, debitCents: 400_000 }, { accountId: bankAccount, creditCents: 400_000 }] });
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('shows revenue first, and gross profit, other income and running costs come to net profit', async () => {
    const d = await owner.get('/api/dashboard');
    const y = d.yearToDate;
    expect(y.revenueCents).toBe(1_000_000);
    expect(y.grossProfitCents).toBe(700_000);
    expect(y.otherIncomeCents).toBe(500_000);
    expect(y.runningCostsCents).toBe(200_000);
    expect(y.financeCostsCents).toBe(20_000);
    expect(y.incomeTaxCents).toBe(10_000);
    expect(y.grossProfitCents + y.otherIncomeCents - y.runningCostsCents - y.financeCostsCents - y.incomeTaxCents).toBe(y.profitCents);
    const home = readFileSync(join(WEB, 'pages', 'Home.tsx'), 'utf8');
    expect(home).toMatch(/label=\{`Revenue \$\{data\.financialYear\.label\} to date`\}/);
    expect(home).not.toMatch(/`Invoiced \$\{data\.financialYear\.label\} to date`/);
  });

  it('puts a new bank account behind a payment source on the cash line, so Home counts it', async () => {
    const [line] = await env.sql<{ statementLine: string }[]>`select statement_line from accounts where code = '1070'`;
    expect(line!.statementLine).toBe('cash');
    const [logged] = await env.sql<{ n: number }[]>`select count(*)::int as n from audit_log where action = 'account_to_cash_line'`;
    expect(logged!.n).toBe(1);
    const d = await owner.get('/api/dashboard');
    // R10 000 owed by the client isn't cash: R5 000 interest − R3 000 − R2 000 in the bank, R4 000 moved to savings.
    // A cost dated later this month isn't in the bank today.
    expect(d.cash.inBankCents).toBe(500_000 - 300_000 - 200_000 - 20_000 - 10_000);
  });

  it('leaves the line of an account with anything in it, and a rename moves nothing back', async () => {
    // The owner puts the savings account back on Other current assets: renaming its source keeps it there.
    await env.sql`update accounts set statement_line = 'other_current_assets' where code = '1070'`;
    const [src] = await env.sql<{ id: string; accountId: string }[]>`select id, account_id from payment_sources where name = 'Made-up savings'`;
    await owner.post(`/api/sources/${src!.id}`, { name: 'Made-up savings (renamed)', kind: 'bank', accountId: src!.accountId }, 'PUT');
    expect((await env.sql<{ l: string }[]>`select statement_line as l from accounts where code = '1070'`)[0]!.l).toBe('other_current_assets');
    // A new source on an account with entries in it: its line stays.
    await owner.post('/api/sources', { name: 'Made-up savings card', kind: 'bank', accountId: src!.accountId });
    expect((await env.sql<{ l: string }[]>`select statement_line as l from accounts where code = '1070'`)[0]!.l).toBe('other_current_assets');
    // A new, empty liability with a bank source: the bank overdraft line.
    const od = await owner.post<{ id: string }>('/api/accounts', { code: '2320', name: 'Made-up overdraft', type: 'liability', active: true });
    await owner.post('/api/sources', { name: 'Made-up overdraft', kind: 'bank', accountId: od.id });
    expect((await env.sql<{ l: string }[]>`select statement_line as l from accounts where code = '2320'`)[0]!.l).toBe('bank_overdraft');
    await env.sql`update accounts set statement_line = 'cash' where code = '1070'`;
  });

  it('points out an older one that isn’t, in the books audit', async () => {
    const [acc] = await env.sql<{ id: string }[]>`insert into accounts (code, name, type, statement_line) values ('1080', 'Made-up Old Savings', 'asset', 'other_current_assets') returning id`;
    await env.sql`insert into payment_sources (name, kind, account_id, sort) values ('Made-up old savings', 'bank', ${acc!.id}, 99)`;
    const items = await expectCleanAudit(env.sql);
    expect(items.some((i) => i.level === 'warn' && /Made-up Old Savings is a bank or cash account you pay from, but not on the statements' cash or bank overdraft line/.test(i.text) && /check it with your accountant before changing its line/.test(i.text))).toBe(true);
    await env.sql`delete from payment_sources where account_id = ${acc!.id}`;
  });
});
