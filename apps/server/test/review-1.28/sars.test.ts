/**
 * The SARS and tax review of 1.28.0 (CPDAUDIT.md): what books brought in from another package do to
 * Shap's tax figures and screens. Each test fails on the code the review was of. Made-up books and
 * figures throughout; each suite ends with the books audit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditBooks } from '../../src/audit/books.js';
import { healthOf } from '../../src/lib/practice.js';
import { taxPack } from '../../src/modules/tax-pack.js';
import { balance, expectCleanAudit, login, setup, type TestEnv } from '../helpers.js';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const file = (name: string, text: string, asAt?: string) => ({ name, dataBase64: b64(text), ...(asAt ? { asAt } : {}) });

let n = 0;
async function client(env: TestEnv) {
  const me = await login(env.app, 'owner@example.co.za');
  const call = (url: string, payload: unknown) => me.call({ method: 'POST', url, payload: payload as never, remoteAddress: `10.93.${(++n >> 8) & 255}.${n & 255}` });
  const post = async <T = any>(url: string, payload: unknown): Promise<T> => {
    const r = await call(url, payload);
    if (r.statusCode >= 400) throw new Error(`POST ${url} → ${r.statusCode} ${r.body}`);
    return r.json() as T;
  };
  const acc = async (key: string) => (await env.sql<{ id: string }[]>`select id from accounts where system_key = ${key}`)[0]!.id;
  const mappingFor = (accounts: { code: string; name: string; accountId: string | null; type: string | null }[], chosen: Record<string, string>) =>
    accounts.map((a) => ({ code: a.code, name: a.name, accountId: chosen[a.name] ?? a.accountId, newType: chosen[a.name] || a.accountId ? null : (a.type ?? 'expense') }));
  const bringIn = async (files: ReturnType<typeof file>[], chosen: Record<string, string>, extra: Record<string, unknown> = {}) => {
    const { accounts } = await post('/api/books-import/read', { files });
    return call('/api/books-import/apply', { files, mapping: mappingFor(accounts, chosen), ...extra });
  };
  return { me, post, acc, bringIn, mappingFor, call };
}

const TB_AUG = `Trial Balance
Made-up Imported Spark (Pty) Ltd
As at 31 August 2026
Account,Account Code,Account Type,Debit,Credit,YTD Debit,YTD Credit
Business Bank Account,090,Bank,,,"1,000,000.00",
Sales,200,Revenue,,,,"1,300,000.00"
Wages and Salaries,477,Expense,,,"400,000.00",
Income Tax Expense,505,Expense,,,"100,000.00",
VAT Control,820,Current Liability,,,,"150,000.00"
Retained Earnings,960,Equity,,,,"50,000.00"
`;

const QBO = `Made-up Spark Electrical (Pty) Ltd
Journal
September 1 - October 31, 2026
Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit
03/09/2026,Invoice,1001,Made-up Dental,Rewiring,Accounts Receivable (A/R),"11,500.00",
,,,,Rewiring,Sales,,"10,000.00"
,,,,VAT,VAT Control,,"1,500.00"
,,,,,,"11,500.00","11,500.00"
25/10/2026,Payroll,PR-10,,October pay,Wages and Salaries,"20,000.00",
,,,,PAYE,PAYE Payable,,"2,400.00"
,,,,UIF,UIF Payable,,600.00
,,,,Net pay,Business Bank Account,,"17,200.00"
,,,,UIF employer,Wages and Salaries,200.00,
,,,,,,"20,200.00","20,200.00"
`;

describe('a VAT-registered company brought in from another package', () => {
  let env: TestEnv;
  let c: Awaited<ReturnType<typeof client>>;
  beforeAll(async () => {
    env = await setup();
    await env.sql`update settings set business_type = 'company', fy_end_month = 2, vat_registered = true, vat_category = 'B', vat_number = '4123456789', paye_ref = '7123456789'`;
    c = await client(env);
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('4: suggests Shap’s own tax accounts for the package’s VAT, income tax, PAYE and interest accounts', async () => {
    const { accounts } = await c.post('/api/books-import/read', { files: [file('TB.csv', TB_AUG), file('Journal.csv', QBO)] });
    const to = (name: string) => accounts.find((a: { name: string }) => a.name === name)?.accountId;
    expect(to('Income Tax Expense')).toBe(await c.acc('income_tax'));
    expect(to('VAT Control')).toBe(await c.acc('vat'));
    expect(to('PAYE Payable')).toBe(await c.acc('paye_payable'));
    const i = await c.post('/api/books-import/read', { files: [file('TB.csv', 'Trial Balance\nAs at 31 August 2026\nAccount,Account Code,Account Type,Debit,Credit,YTD Debit,YTD Credit\nInterest Income,270,Revenue,,,,"50.00"\nBank,090,Bank,,,"50.00",\n')] });
    expect(i.accounts.find((a: { name: string }) => a.name === 'Interest Income').accountId).toBe(await c.acc('interest_income'));
  });

  it('4: with the suggestions taken, the IRP6 and the tax pack leave out the income tax the package booked', async () => {
    const r = await c.bringIn([file('TB.csv', TB_AUG)], { 'Business Bank Account': await c.acc('bank'), 'VAT Control': await c.acc('vat'), 'Retained Earnings': await c.acc('retained_earnings') });
    expect(r.statusCode, r.body).toBe(200);
    const p = await c.me.get('/api/reports/provisional-tax?fyEnd=2027-02-28&asAt=2026-08-31');
    expect(p.lines.map((l: { name: string }) => l.name)).not.toContain('Income Tax Expense');
    expect((await taxPack(env.sql, '2027-02-28')).profitBeforeTax).toBe(90_000_000);
  });

  it('3: the IRP6 projects from the last day brought in, not the last month end', async () => {
    const p = await c.me.get('/api/reports/provisional-tax?fyEnd=2027-02-28');
    expect([p.asAt, p.months]).toEqual(['2026-08-31', 6]);
  });

  it('2: the VAT201, the tax pack and the books audit say the VAT and PAYE are the other package’s', async () => {
    const r = await c.bringIn([file('Journal.csv', QBO), file('TB.csv', TB_AUG)], {
      'Accounts Receivable (A/R)': await c.acc('receivables'),
      'VAT Control': await c.acc('vat'),
      'Business Bank Account': await c.acc('bank'),
      'PAYE Payable': await c.acc('paye_payable'),
      'UIF Payable': await c.acc('uif_payable'),
      'Retained Earnings': await c.acc('retained_earnings'),
    });
    // (The August trial balance is under the ledger: brought in again with it.)
    expect(r.statusCode, r.body).toBe(200);
    const v = await c.me.get('/api/vat/return?on=2026-10-31');
    // The VAT account moved R1 500 in journals brought in: the VAT201 isn't Shap's to work out.
    expect(v.importedVatCents).toBe(150_000);
    // The tax pack says that period's VAT came from the package (its PDF: "From another package").
    const pack = await taxPack(env.sql, '2027-02-28');
    expect(pack.vat.find((p) => p.start <= '2026-10-31' && p.end >= '2026-09-01' && p.brought)?.brought).toBe(150_000);
    const items = await auditBooks(env.sql, '2026-11-30');
    const vat = items.find((i) => /VAT201/.test(i.text))!;
    expect(vat.text).toMatch(/came in from another package, so that return is the package’s, not Shap’s to work out or check/);
    const paye = items.find((i) => /PAYE, UIF and SDL/.test(i.text))!;
    expect(paye.text).not.toMatch(/journals by hand/);
  });

  it('1: agreeing the year keeps the books brought in', async () => {
    const before = await balance(env.sql, 'bank', '2026-10-31');
    const tax = await c.acc('income_tax');
    const r = await c.me.call({ method: 'PUT', url: '/api/year-ends', payload: { fyEnd: '2027-02-28', note: 'Agreed', lock: false, figures: [{ accountId: tax, amountCents: 25_000_000 }] } });
    expect(r.statusCode, r.body).toBe(200);
    expect(await balance(env.sql, 'bank', '2026-10-31')).toBe(before);
    expect((await env.sql`select 1 from journals where ledger_import_id is not null`).length).toBeGreaterThan(0);
  });
});

describe('turnover tax for a sole proprietor brought in from another package', () => {
  let env: TestEnv;
  let c: Awaited<ReturnType<typeof client>>;
  beforeAll(async () => {
    env = await setup();
    await env.sql`update settings set business_type = 'sole_prop', fy_end_month = 2, turnover_tax = true`;
    c = await client(env);
    const tb = `Trial Balance
Made-up Thandi Sparks
As at 31 August 2026
Account,Account Code,Account Type,Debit,Credit,YTD Debit,YTD Credit
Business Bank Account,090,Bank,,,"1,000,000.00",
Sales,200,Revenue,,,,"1,250,000.00"
Interest Income,270,Revenue,,,,"50,000.00"
Wages and Salaries,477,Expense,,,"300,000.00",
`;
    const r = await c.bringIn([file('TB.csv', tb)], { 'Business Bank Account': await c.acc('bank') });
    expect(r.statusCode, r.body).toBe(200);
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('3: projects six months brought in to a year: over the micro business limit', async () => {
    const t = await c.me.get('/api/reports/turnover-tax?fyEnd=2027-02-28');
    expect([t.asAt, t.months]).toEqual(['2026-08-31', 6]);
    expect(t.overLimit).toBe(true);
  });
});

describe('a trust brought in from another package', () => {
  let env: TestEnv;
  let c: Awaited<ReturnType<typeof client>>;
  beforeAll(async () => {
    env = await setup();
    await env.sql`update settings set business_type = 'trust', fy_end_month = 2`;
    c = await client(env);
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('5: refuses a trial balance whose year to date isn’t the year of assessment', async () => {
    const tb = `Trial Balance
Made-up Sparky Trading Trust
As at 30 June 2026
Account,Account Code,Account Type,Debit,Credit,YTD Debit,YTD Credit
Business Bank Account,090,Bank,,,"700,000.00",
Sales,200,Revenue,,,,"1,200,000.00"
Wages and Salaries,477,Expense,,,"500,000.00",
`;
    const read = await c.post('/api/books-import/read', { files: [file('TB.csv', tb)] });
    // The preview says which year its income and expenses are taken to be for.
    expect(read.files[0].yearFrom).toBe('2026-03-01');
    // A title that says the package's year started on 1 July 2025: not a trust's year of assessment.
    const titled = tb.replace('As at 30 June 2026', 'For the period 1 July 2025 to 30 June 2026');
    const r = await c.bringIn([file('TB.csv', titled)], { 'Business Bank Account': await c.acc('bank') });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/these books’ year runs from 1 Mar 2026/);
  });

  it('6: says what the trust’s books brought in distributed, rather than taking R0 off', async () => {
    const tb = `Trial Balance
Made-up Sparky Trading Trust
As at 31 August 2026
Account,Account Code,Account Type,Debit,Credit,YTD Debit,YTD Credit
Business Bank Account,090,Bank,,,"200,000.00",
Sales,200,Revenue,,,,"600,000.00"
Wages and Salaries,477,Expense,,,"100,000.00",
Distributions to beneficiaries,970,Equity,,,"300,000.00",
`;
    const r = await c.bringIn([file('TB2.csv', tb)], { 'Business Bank Account': await c.acc('bank'), 'Distributions to beneficiaries': await c.acc('dividends') });
    expect(r.statusCode, r.body).toBe(200);
    const p = await c.me.get('/api/reports/provisional-tax?fyEnd=2027-02-28&asAt=2026-08-31');
    expect(p.distributedBroughtInCents).toBe(30_000_000);
    // Not taken off: Shap can't tell which part is this year's income to residents (s25B).
    expect(p.distributedCents).toBe(0);
  });
});

describe('dividends in a ledger brought in, on the practice list (SARS 7)', () => {
  let env: TestEnv;
  let c: Awaited<ReturnType<typeof client>>;
  beforeAll(async () => {
    env = await setup();
    await env.sql`update settings set business_type = 'company', fy_end_month = 2`;
    c = await client(env);
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('lists the dividends tax return for a dividend the package declared', async () => {
    const GL = `Journal Report\nMade-up Ibis Solar (Pty) Ltd\nFor the period 1 October 2026 to 31 October 2026\nDate,Account,Account Code,Description,Reference,Debit,Credit\n15 Oct 2026,Dividends,950,Made-up dividend,DIV-1,"10000.00",\n15 Oct 2026,Bank,090,Made-up dividend,DIV-1,,"10000.00"\n`;
    const r = await c.bringIn([file('GL.csv', GL)], { Bank: await c.acc('bank'), Dividends: await c.acc('dividends') });
    expect(r.statusCode, r.body).toBe(200);
    const h = await healthOf(env.sql, '2026-11-17');
    expect(h.deadlineInputs?.dividendsPaid).toContain('2026-10-15');
  });
});
