import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, financialYear } from '@shap/shared';
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
    expect(home).toMatch(/`\$\{formatPercent\(ytdMargin\)\} of revenue`/);
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
