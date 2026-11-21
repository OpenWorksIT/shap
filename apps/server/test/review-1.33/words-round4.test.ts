import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseStatementOfx, parseStatementQif } from '../../src/modules/bank/parse.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

// The fourth round of 1.33's reviews (words, accounting): what a statement file's preview says was
// left out is true for each kind of file (and a QIF's opening balance is a balance, not money in),
// a rule says why it isn't applied, the docs promise no update, and the smaller words. Made-up.

const root = join(__dirname, '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('a statement file’s preview', () => {
  it('names balance lines only for the kinds of file that have them left out', () => {
    const bank = read('apps/web/src/pages/Bank.tsx');
    const leftOut = (kind: string) => new RegExp(`\\n  ${kind}: '([^']+)'`).exec(bank)![1]!;
    expect(leftOut('csv')).toMatch(/balance lines/);
    expect(leftOut('ofx')).not.toMatch(/balance/);
    expect(leftOut('ofx')).toMatch(/one the bank listed twice/);
    expect(leftOut('qif')).toMatch(/a balance line/);
    expect(bank).toMatch(/left out \(\$\{LEFT_OUT\[preview\.format\] \?\? LEFT_OUT\.csv\}\)\. Check these totals against your statement\./);
    expect(bank).not.toMatch(/Check the totals above against your statement/);
  });

  it('leaves out a QIF’s opening balance, as a CSV’s balance lines are', () => {
    // Quicken's start of an account: its balance, as a transfer to the account itself.
    const qif = '!Type:Bank\nD01/04/2026\nT1,000.00\nPOpening Balance\nL[Made-up Cheque]\n^\nD03/04/2026\nT-10.00\nPMADE-UP SHOP\n^\nD04/04/2026\nT-20.00\nPMADE-UP FUEL\nMOpening balance\nL[Made-up Cheque]\n^\n';
    const p = parseStatementQif(qif);
    expect(p.rows.map((r) => r.amountCents)).toEqual([-1_000]);
    expect(p.skipped).toBe(2);
    // An OFX file's lines are transactions: nothing is left out as a balance.
    const ofx = '<OFX><STMTRS><BANKTRANLIST><STMTTRN><DTPOSTED>20260403<TRNAMT>-1.00<FITID>1<NAME>OPENING BALANCE</STMTTRN></BANKTRANLIST></STMTRS></OFX>';
    expect(parseStatementOfx(ofx).rows).toHaveLength(1);
  });
});

describe('a rule that isn’t applied', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('says why: switched off, a stock type now, or no longer income', async () => {
    const owner = await login(env.app, 'owner@example.co.za');
    const { settings: s } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...s, features: { ...s.features, bank: true } }, 'PUT');
    const r = await ref(env.sql);
    const petrol = await r.cat('Petrol');
    const [inc] = await env.sql<{ id: string }[]>`insert into accounts (code, name, type, statement_line) values ('4096', 'Made-up rent received', 'income', 'other_income') returning id`;
    await owner.post('/api/bank/rules', { matchText: 'MADE-UP GARAGE', direction: 'out', categoryId: petrol });
    await owner.post('/api/bank/rules', { matchText: 'MADE-UP TENANT', direction: 'in', incomeAccountId: inc!.id });
    const why = async () => Object.fromEntries((await owner.get<{ matchText: string; whyNot: string | null }[]>('/api/bank/rules')).map((x) => [x.matchText, x.whyNot]));
    expect(await why()).toEqual({ 'MADE-UP GARAGE': null, 'MADE-UP TENANT': null });
    await env.sql`update cost_categories set kind = 'stock' where id = ${petrol}`;
    await env.sql`update accounts set type = 'liability', statement_line = 'trade_payables' where id = ${inc!.id}`;
    expect(await why()).toEqual({ 'MADE-UP GARAGE': 'stock', 'MADE-UP TENANT': 'not_income' });
    await env.sql`update cost_categories set kind = 'overhead', active = false where id = ${petrol}`;
    expect((await why())['MADE-UP GARAGE']).toBe('off');
    await env.sql`update cost_categories set active = true where id = ${petrol}`;
    await env.sql`update accounts set type = 'income', statement_line = 'other_income' where id = ${inc!.id}`;
    const bank = read('apps/web/src/pages/Bank.tsx');
    expect(bank).toMatch(/why === 'stock'\n    \? 'is a stock type now: stock comes in under Inventory, so change the rule’s cost type or take the rule away'/);
    expect(bank).toMatch(/: why === 'not_income'\n      \? 'isn’t an income account now: change the rule or take it away'/);
  });
});

describe('the smaller words', () => {
  it('the docs promise no update for the Fund’s season', () => {
    for (const doc of ['docs/SARS.md', 'docs/GOALPOSTS.md']) expect(read(doc)).not.toMatch(/Each\s+standard update adds|season added each year|isn't in Shap's tables yet/);
    expect(read('docs/SARS.md')).toMatch(/no date is promised/);
  });

  it('the forecast says a dividend’s tax is in it, the budgets what they count, and a pay date what’s wrong', () => {
    expect(read('apps/web/src/pages/Forecast.tsx')).toMatch(/all this week, as if paid in full now \(any dividends tax on them included\); dividends tax already withheld/);
    expect(read('apps/web/src/pages/Budgets.tsx')).toMatch(/figures to the end of \{monthWords\(data\.months\[done - 1\]!\)\} and no budget/);
    expect(read('apps/web/src/pages/Budgets.tsx')).not.toMatch(/figures in the books this year and no budget/);
    expect(read('apps/server/src/modules/payroll.ts')).not.toMatch(/looks like a slip of the year/);
  });
});

describe('a run paid late (SARS, fourth round)', () => {
  it('says which EMP201, and across 1 March which tables, are the accountant’s to check', async () => {
    const { latePayNote } = await import('@shap/shared');
    expect(latePayNote('2026-10', '2026-10-25')).toBeNull();
    expect(latePayNote('2026-10', '2026-11-30')).toBeNull();
    expect(latePayNote('2026-10', '2026-12-01')).toBe('The pay date is more than a month after October 2026. Employees’ tax arises when the business pays the salary, or becomes liable to pay it, so which EMP201 this goes on is for your accountant to check: Shap puts it on the EMP201 for the month it’s paid.');
    expect(latePayNote('2027-01', '2027-04-25')).toMatch(/so which EMP201 this goes on and which tax year’s tables apply are for your accountant to check/);
    // A February run paid in March: the next tax year, though within the month (fifth round), said
    // plainly (sixth); a March run paid in February: the year before.
    expect(latePayNote('2027-02', '2027-03-05')).toBe('The pay date is in the next tax year (from 1 March 2027). Employees’ tax arises when the business pays the salary, or becomes liable to pay it, so which EMP201 this goes on and which tax year’s tables apply are for your accountant to check: Shap puts it on the EMP201 for the month it’s paid.');
    expect(latePayNote('2027-03', '2027-02-26')).toMatch(/^The pay date is in the previous tax year \(to 28 February 2027\)\. .* which tax year’s tables apply are for your accountant/);
    expect(latePayNote('2028-03', '2028-02-28')).toMatch(/\(to 29 February 2028\)/);
    expect(latePayNote('2027-04', '2027-03-28')).toBeNull();
    expect(latePayNote('2027-02', '2027-02-25')).toBeNull();
    expect(read('apps/web/src/pages/Payroll.tsx')).toMatch(/<Field label="Pay date" hint=\{latePayNote\(run\.period, run\.payDate\) \?\? undefined\}>/);
  });
});

describe('moving in: SARS’s payroll taxes on their own accounts (accounting, fifth round)', () => {
  it('guesses PAYE, UIF and SDL owed as SARS’s, and VAT payable or receivable as VAT, not wages or a supplier', async () => {
    const { suggestAccount } = await import('../../src/modules/movein.js');
    const acc = (systemKey: string, type: 'asset' | 'liability' | 'expense' = 'liability') => ({ id: systemKey, code: '', name: `Made-up ${systemKey}`, type, systemKey });
    const accounts = ['paye_payable', 'uif_payable', 'sdl_payable', 'wages_payable', 'payables', 'vat', 'income_tax_payable'].map((k) => acc(k)).concat([acc('receivables', 'asset'), acc('general_labour', 'expense')]);
    const guess = (name: string) => suggestAccount({ code: '', name, cents: 0 } as never, accounts);
    expect(guess('PAYE payable')).toBe('paye_payable');
    expect(guess('UIF control')).toBe('uif_payable');
    expect(guess('SDL payable')).toBe('sdl_payable');
    expect(guess('Accrued wages')).toBe('wages_payable');
    expect(guess('Salaries payable')).toBe('wages_payable');
    expect(guess('VAT payable')).toBe('vat');
    expect(guess('VAT receivable')).toBe('vat');
    expect(guess('Income tax payable')).toBe('income_tax_payable');
    expect(guess('Trade payables')).toBe('payables');
    expect(guess('Trade receivables')).toBe('receivables');
  });
});
