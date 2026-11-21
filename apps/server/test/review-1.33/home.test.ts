import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, financialYear, formatZar, noIncomeTaxWords, offCashNote } from '@shap/shared';
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
    expect(d.cash).toEqual({ inBankCents: 2_900_000, cardsOweCents: 0, offCash: [] });
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
    expect(home).toMatch(/`\$\{formatPercent\(ytdMargin\)\} of revenue \(revenue less cost of sales, as the income statement sets them out\)`/);
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
    // Fourth round (IFRS): the income tax is as captured, and a profit with none captured says it's before tax.
    expect(home).toMatch(/income tax as captured in the books`/);
    expect(home).not.toMatch(/income tax as booked/);
    expect(home).toMatch(/\(data\.yearToDate\.incomeTaxCents \? '' : noIncomeTaxWords\(settings\)\)/);
    // By who pays it (words review, fifth round): no "yet" for a sole proprietor or partners.
    expect(noIncomeTaxWords({ businessType: 'company' })).toBe('; before income tax (none captured in the books)');
    expect(noIncomeTaxWords({ businessType: 'sole_prop' })).toBe('; the owner’s income tax is their own, not the business’s');
    expect(noIncomeTaxWords({ businessType: 'partnership' })).toBe('; the partners’ income tax is their own, not the business’s');
    expect(noIncomeTaxWords({ businessType: 'company', turnoverTax: true })).toBe('; turnover tax is in it only as far as it’s captured in the books');
    expect(noIncomeTaxWords({ businessType: 'npc', approvedPbo: true })).toBe('; before any income tax on trading beyond the PBO exemption (none captured in the books)');
    for (const t of ['company', 'sole_prop', 'partnership', 'cc', 'trust', 'npc', 'coop', 'inc']) expect(noIncomeTaxWords({ businessType: t })).not.toMatch(/yet/);
    const chart = readFileSync(join(WEB, 'components', 'MarginChart.tsx'), 'utf8');
    expect(chart).toMatch(/const average = known\.length && revenue > 0 \?/);
  });
});

// Second round (IFRS): Home's tiles add up, revenue first. Fourth round: a second bank account keeps
// the line it was given (whether it's cash is a judgement Shap doesn't make), and Home says what's in it.
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
    // A cost dated tomorrow: not "to date" yet, whatever day of the month it is.
    await owner.post('/api/costs', { date: addDays(today(), 1), description: 'Made-up later', supplier: 'Made-up Insurer', amountCents: 70_000, categoryId: await r.cat('Insurance'), sourceId: bank });
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

  it('leaves a new bank account on the line it was given, and Home and the forecast say what’s in it', async () => {
    const [line] = await env.sql<{ statementLine: string }[]>`select statement_line from accounts where code = '1070'`;
    expect(line!.statementLine).toBe('other_current_assets');
    const [logged] = await env.sql<{ n: number }[]>`select count(*)::int as n from audit_log where action = 'account_to_cash_line'`;
    expect(logged!.n).toBe(0);
    const d = await owner.get('/api/dashboard');
    // R10 000 owed by the client isn't cash: R5 000 interest − R3 000 − R2 000 − R200 − R100 in the
    // bank, less R4 000 moved to savings. The cost dated tomorrow isn't in the bank today.
    expect(d.cash.inBankCents).toBe(500_000 - 300_000 - 200_000 - 20_000 - 10_000 - 400_000);
    expect(d.cash.offCash).toEqual([{ name: 'Made-up Savings', cents: 400_000 }]);
    const f = await owner.get('/api/forecast');
    expect(f.openingCents).toBe(d.cash.inBankCents);
    expect(f.offCash).toEqual(d.cash.offCash);
    const note = offCashNote(d.cash.offCash, (c) => formatZar(c, { cents: false }))!;
    expect(note).toMatch(/^Not counted here: R\s?4 000 in Made-up Savings, as the statements don’t count that account as cash \(by its line in the chart of accounts\)\. Whether it is cash is for you and your accountant to judge: the books audit \(Settings → Updates & backups\) says more\.$/);
    const home = readFileSync(join(WEB, 'pages', 'Home.tsx'), 'utf8');
    expect(home).toMatch(/\{data\.cash && offCashNote\(data\.cash\.offCash, whole\) && <p className="xs warn-text">\{offCashNote\(data\.cash\.offCash, whole, \{ owner: user\.role === 'owner' \}\)\}<\/p>\}/);
    const forecast = readFileSync(join(WEB, 'pages', 'Forecast.tsx'), 'utf8');
    expect(forecast).toMatch(/offCashNote\(data\.offCash,/);
  });

  it('keeps a line chosen on purpose, a renamed source’s, and a liability’s; the audit names the judgement', async () => {
    // A made-up six-month deposit, put on Other current assets on purpose, with a bank source.
    const dep = await owner.post<{ id: string }>('/api/accounts', { code: '1075', name: 'Made-up Deposit', type: 'asset', statementLine: 'other_current_assets', active: true });
    await owner.post('/api/sources', { name: 'Made-up deposit', kind: 'bank', accountId: dep.id });
    const lineOf = async (code: string) => (await env.sql<{ l: string }[]>`select statement_line as l from accounts where code = ${code}`)[0]!.l;
    expect(await lineOf('1075')).toBe('other_current_assets');
    // Renaming its source, or putting it on another empty account, moves no line.
    const [src] = await env.sql<{ id: string }[]>`select id from payment_sources where name = 'Made-up deposit'`;
    await owner.post(`/api/sources/${src!.id}`, { name: 'Made-up deposit (renamed)', kind: 'bank', accountId: dep.id }, 'PUT');
    expect(await lineOf('1075')).toBe('other_current_assets');
    const other = await owner.post<{ id: string }>('/api/accounts', { code: '1076', name: 'Made-up Deposit Two', type: 'asset', active: true });
    await owner.post(`/api/sources/${src!.id}`, { name: 'Made-up deposit (renamed)', kind: 'bank', accountId: other.id }, 'PUT');
    expect(await lineOf('1076')).toBe('other_current_assets');
    // A new liability with a bank source: an overdraft is cash only by judgement, so it stays put.
    const od = await owner.post<{ id: string }>('/api/accounts', { code: '2320', name: 'Made-up Facility', type: 'liability', active: true });
    await owner.post('/api/sources', { name: 'Made-up facility', kind: 'bank', accountId: od.id });
    expect(await lineOf('2320')).toBe('trade_payables');
    const items = await expectCleanAudit(env.sql);
    const warned = items.filter((i) => i.level === 'warn').map((i) => i.text);
    // Several named: each, them, their lines (words review, fifth round).
    expect(warned.some((t) => /^Made-up Deposit Two and Made-up Savings are bank or cash accounts you pay \(or paid\) from, but not on the statements’ cash line\. Whether each is cash is a judgement \(money you can draw on demand is; a deposit fixed \(or on notice\) for about three months or less when it was made, for a known amount with its interest and little risk of its value changing, kept to pay what’s coming, usually counts too; one fixed for longer, or whose value goes up and down \(shares, most unit trusts\), usually doesn’t\): Home, the forecast and the cash flow statement leave them out of cash\. Check each with your accountant before changing their lines/.test(t))).toBe(true);
    // One named: it, its line.
    expect(warned.some((t) => /^Made-up Facility is a liability you pay \(or paid\) from as a bank or cash account, but not on the statements’ cash or bank overdraft line\. A bank overdraft counts as cash only when it’s repayable on demand and part of day-to-day cash management \(otherwise it’s borrowing, as a loan is\): Home, the forecast and the cash flow statement leave it out of cash\. Check it with your accountant before changing its line/.test(t))).toBe(true);
    await env.sql`delete from payment_sources where account_id in (${dep.id}, ${other.id}, ${od.id})`;
  });

  it('points out an older one that isn’t, in the books audit', async () => {
    const [acc] = await env.sql<{ id: string }[]>`insert into accounts (code, name, type, statement_line) values ('1080', 'Made-up Old Savings', 'asset', 'other_current_assets') returning id`;
    await env.sql`insert into payment_sources (name, kind, account_id, sort) values ('Made-up old savings', 'bank', ${acc!.id}, 99)`;
    const items = await expectCleanAudit(env.sql);
    expect(items.some((i) => i.level === 'warn' && /Made-up Old Savings and Made-up Savings are bank or cash accounts you pay \(or paid\) from, but not on the statements’ cash line/.test(i.text) && /Check each with your accountant before changing their lines/.test(i.text))).toBe(true);
    await env.sql`delete from payment_sources where account_id = ${acc!.id}`;
  });

  it('still points out one closed this year that held money at last year end', async () => {
    const { settings } = await owner.get('/api/reference');
    const fy = financialYear(today(), settings.fyEndMonth);
    const bankAccount = await (await ref(env.sql)).acc('bank');
    const closed = async (code: string, name: string, into: string, out: string) => {
      const [acc] = await env.sql<{ id: string }[]>`insert into accounts (code, name, type, statement_line) values (${code}, ${name}, 'asset', 'other_current_assets') returning id`;
      await env.sql`insert into payment_sources (name, kind, account_id, sort, active) values (${name.toLowerCase()}, 'bank', ${acc!.id}, 98, false)`;
      await owner.post('/api/journals', { date: into, description: 'To savings (made up)', lines: [{ accountId: acc!.id, debitCents: 500_000 }, { accountId: bankAccount, creditCents: 500_000 }] });
      await owner.post('/api/journals', { date: out, description: 'Savings closed (made up)', lines: [{ accountId: bankAccount, debitCents: 500_000 }, { accountId: acc!.id, creditCents: 500_000 }] });
    };
    // R5 000 in it at last year end, emptied this year: last year's cash rests on it.
    await closed('1085', 'Made-up Closed Savings', addDays(fy.start, -20), fy.start);
    // Emptied before last year began: nothing in either year's figures.
    const lastYearStart = financialYear(addDays(fy.start, -1), settings.fyEndMonth).start;
    await closed('1086', 'Made-up Long Gone', addDays(lastYearStart, -20), addDays(lastYearStart, -10));
    // Switched off, nothing in it since before last year, but money still in it: Home counts it out, so the audit says so.
    const [notice] = await env.sql<{ id: string }[]>`insert into accounts (code, name, type, statement_line) values ('1087', 'Made-up Notice Deposit', 'asset', 'other_current_assets') returning id`;
    await env.sql`insert into payment_sources (name, kind, account_id, sort, active) values ('made-up notice deposit', 'bank', ${notice!.id}, 97, false)`;
    await owner.post('/api/journals', { date: addDays(lastYearStart, -30), description: 'To notice deposit (made up)', lines: [{ accountId: notice!.id, debitCents: 800_000 }, { accountId: bankAccount, creditCents: 800_000 }] });
    const warned = (await expectCleanAudit(env.sql)).filter((i) => i.level === 'warn').map((i) => i.text).join(' ');
    expect(warned).toMatch(/Made-up Closed Savings/);
    expect(warned).not.toMatch(/Made-up Long Gone/);
    expect(warned).toMatch(/Made-up Notice Deposit/);
    expect((await owner.get('/api/dashboard')).cash.offCash).toEqual(expect.arrayContaining([{ name: 'Made-up Notice Deposit', cents: 800_000 }]));
  });
});

// Fifth round (IFRS): moving a used payment account onto another account takes its history with it;
// not on or off the statements' cash line by the way. And a change of line or account is logged.
describe('moving a used payment account', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('won’t take its history off the cash line, and logs the line and the move', async () => {
    const owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    await owner.post('/api/costs', { date: addDays(today(), -3), description: 'Made-up fuel', supplier: 'Made-up Garage', amountCents: 50_000, categoryId: await r.cat('Petrol'), sourceId: bank });
    const cashBefore = (await owner.get('/api/dashboard')).cash.inBankCents;
    const acc = await owner.post<{ id: string }>('/api/accounts', { code: '1078', name: 'Made-up New Bank', type: 'asset', active: true });
    const move = () => owner.call({ method: 'PUT', url: `/api/sources/${bank}`, payload: { name: 'Business bank', kind: 'bank', accountId: acc.id } });
    const refused = await move();
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe('What’s already captured with this would move on or off the statements’ cash line with it. If the account it’s on now is on the wrong line, change that account’s line instead (Settings → Lists → Chart of accounts: that moves everything in it, last year’s figures too), after checking with your accountant; if the new account has nothing in it yet, put it on the same line first; otherwise add a new one under Paid from / into for what’s coming.');
    expect((await env.sql<{ accountId: string }[]>`select account_id from payment_sources where id = ${bank}`)[0]!.accountId).not.toBe(acc.id);
    // On the cash line first: then it moves, and Home's cash is as it was.
    await owner.post(`/api/accounts/${acc.id}`, { code: '1078', name: 'Made-up New Bank', type: 'asset', statementLine: 'cash', active: true }, 'PUT');
    expect((await move()).statusCode).toBe(200);
    expect((await owner.get('/api/dashboard')).cash.inBankCents).toBe(cashBefore);
    const log = await env.sql<{ action: string; details: { name: string; from: unknown; to: unknown } }[]>`select action, details from audit_log where action in ('account_line_changed', 'moved_to_account') order by id`;
    expect(log.map((l) => l.action)).toEqual(['account_line_changed', 'moved_to_account']);
    expect(log[0]!.details).toEqual({ name: 'Made-up New Bank', from: { type: 'asset', line: 'other_current_assets' }, to: { type: 'asset', line: 'cash' } });
    expect(log[1]!.details).toMatchObject({ name: 'Business bank', from: { code: '1000', line: 'cash' }, to: { id: acc.id, code: '1078', name: 'Made-up New Bank', line: 'cash' } });
  });
});
