/**
 * The accounting and arithmetic review of 1.28.0 (CPDAUDIT.md): reading the packages' exports and
 * bringing them in. Each test fails on the code the review was of. Every file made up, laid out as
 * the package exports it; the suites that build books end with the books audit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv } from '../../src/modules/clients.js';
import { readLedger, transactionsOf } from '../../src/modules/import/ledger.js';
import { trialBalance } from '../../src/modules/reports.js';
import { balance, expectCleanAudit, login, setup, type TestEnv } from '../helpers.js';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const file = (name: string, text: string, asAt?: string) => ({ name, dataBase64: b64(text), ...(asAt ? { asAt } : {}) });

describe('rows that are accounts and transactions, not totals or opening rows', () => {
  // QuickBooks Online makes "Opening Balance Equity" in every company that's had opening balances.
  const QBO_TB = `Made-up Spark Electrical (Pty) Ltd
Trial Balance
As of October 31, 2026
,Debit,Credit
Business Bank Account,"18,400.00",
Opening Balance Equity,,"5,000.00"
Sales,,"36,000.00"
Wages and Salaries,"22,600.00",
TOTAL,"41,000.00","41,000.00"
`;
  it('QuickBooks trial balance: the Opening Balance Equity account is kept (accounting 3)', () => {
    const f = readLedger('TB.csv', parseCsv(QBO_TB));
    expect(f.kind).toBe('trialBalance');
    expect(f.tb.map((l) => l.name)).toContain('Opening Balance Equity');
  });

  // QuickBooks Online's General Ledger: heading-less first column with each account's name, then its lines.
  const QBO_GL = `Made-up Spark Electrical (Pty) Ltd
General Ledger
November 1-30, 2026
,Date,Transaction Type,Num,Name,Memo/Description,Split,Debit,Credit
Business Bank Account
,01/11/2026,Deposit,,,Owner's starting capital,Opening Balance Equity,"5,000.00",
Total for Business Bank Account,,,,,,,"5,000.00",
Opening Balance Equity
,01/11/2026,Deposit,,,Owner's starting capital,Business Bank Account,,"5,000.00"
Total for Opening Balance Equity,,,,,,,,"5,000.00"
`;
  it('QuickBooks general ledger: lines under Opening Balance Equity land on it, not the account above (accounting 3)', () => {
    const f = readLedger('GL.csv', parseCsv(QBO_GL));
    expect(f.lines.map((l) => [l.name, l.cents])).toEqual([
      ['Business Bank Account', 500_000],
      ['Opening Balance Equity', -500_000],
    ]);
  });

  // QuickBooks Online's Journal report: QuickBooks writes "Opening Balance" as the memo of the
  // entries it makes for an account's opening balance.
  const QBO_JOURNAL = `Made-up Spark Electrical (Pty) Ltd
Journal
November 1-30, 2026
Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit
01/11/2026,Deposit,,,Opening Balance,Business Bank Account,"5,000.00",
,,,,Opening Balance,Opening Balance Equity,,"5,000.00"
,,,,,,"5,000.00","5,000.00"
`;
  it('QuickBooks journal: a transaction whose memo is "Opening Balance" is kept (accounting 3)', () => {
    const f = readLedger('Journal.csv', parseCsv(QBO_JOURNAL));
    expect(f.lines).toHaveLength(2);
  });

  // Xero's Account Transactions: a fuel slip from a made-up "Total Walmer" garage.
  const XERO_AT = `Account Transactions
Made-up Spark Electrical (Pty) Ltd
For the period 1 December 2026 to 31 December 2026
Date,Source,Description,Reference,Debit,Credit,Running Balance
Business Bank Account (090)
04 Dec 2026,Spend Money,Total Walmer - fuel,SP-10,,862.50,
05 Dec 2026,Spend Money,Made-up Hardware,SP-11,,"1,150.00",
Total Business Bank Account (090),,,,,"2,012.50",
Motor Vehicle Expenses (449)
04 Dec 2026,Spend Money,Total Walmer - fuel,SP-10,862.50,,
Total Motor Vehicle Expenses (449),,,,862.50,,
Wages and Salaries (477)
05 Dec 2026,Spend Money,Made-up Hardware,SP-11,"1,150.00",,
Total Wages and Salaries (477),,,,"1,150.00",,
`;
  it('Xero ledger: a transaction whose description starts with "Total" is kept (accounting 3)', () => {
    const f = readLedger('AT.csv', parseCsv(XERO_AT));
    expect(f.lines.reduce((s, l) => s + Math.max(l.cents, 0), 0)).toBe(201_250);
  });
});

describe('which columns a trial balance is read from', () => {
  it('a Debit and Credit beside an opening balance are the period’s movements: refused, not read as balances', () => {
    const f = readLedger('TB.csv', parseCsv(`Trial Balance\nAs at 31 October 2026\nAccount,Opening Balance,Debit,Credit\nMade-up Bank,"17,200.00","1,200.00",\nMade-up Sales,"-17,200.00",,"1,200.00"\n`));
    expect(f.kind).toBe('unknown');
    expect(f.skipped[0]).toMatch(/period’s movements/);
  });
  it('opening, debit, credit and closing that don’t add up are refused', () => {
    const f = readLedger('TB.csv', parseCsv(`Trial Balance\n1 October 2026 to 31 October 2026\nAccount,Opening Balance,Debit,Credit,Closing Balance\nMade-up Bank,"17,200.00","1,200.00",,"18,500.00"\nMade-up Sales,"-17,200.00",,"1,200.00","-18,500.00"\n`));
    expect(f.kind).toBe('unknown');
    expect(f.skipped[0]).toMatch(/don’t add up/);
  });

  // Xero's General Ledger Summary (used as a trial balance): Opening Balance, the period's Debit and
  // Credit, Net Movement, and the YTD Balance.
  const XERO_GLS = `General Ledger Summary
Made-up Spark Electrical (Pty) Ltd
For the period 1 October 2026 to 31 October 2026
Account,Opening Balance,Debit,Credit,Net Movement,YTD Balance
Business Bank Account (090),"17,200.00","1,200.00",,"1,200.00","18,400.00"
Sales (200),"-38,000.00",,"3,000.00","-3,000.00","-41,000.00"
Wages and Salaries (477),"20,800.00","1,800.00",,"1,800.00","22,600.00"
`;
  it('Xero General Ledger Summary: the balances, not the month’s movement (accounting 4)', () => {
    const f = readLedger('GLS.csv', parseCsv(XERO_GLS));
    expect(f.kind).toBe('trialBalance');
    expect(f.tb.map((l) => [l.code, l.cents])).toEqual([
      ['090', 1_840_000],
      ['200', -4_100_000],
      ['477', 2_260_000],
    ]);
  });

  // Sage Accounting's trial balance with "Show opening & closing balances".
  const SAGE_TB = `Made-up Spark Electrical (Pty) Ltd
Trial Balance
1 October 2026 to 31 October 2026
Account,Opening Balance,Debit,Credit,Closing Balance
Business Bank Account,"17,200.00","1,200.00",,"18,400.00"
Sales,"-38,000.00",,"3,000.00","-41,000.00"
Wages and Salaries,"20,800.00","1,800.00",,"22,600.00"
`;
  it('Sage Accounting trial balance with opening and closing columns: the closing balances (accounting 4)', () => {
    const f = readLedger('TB.csv', parseCsv(SAGE_TB));
    expect(f.tb.map((l) => l.cents)).toEqual([1_840_000, -4_100_000, 2_260_000]);
  });
});

describe('dates', () => {
  // QuickBooks Online with US dates (month first): every day in the file is 12 or less.
  const US_JOURNAL = `Made-up Spark Electrical (Pty) Ltd
Journal
November 1-30, 2026
Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit
11/03/2026,Invoice,1001,Made-up Dental,Rewiring,Accounts Receivable (A/R),"5,750.00",
,,,,Rewiring,Sales,,"5,000.00"
,,,,VAT,VAT Control,,750.00
11/10/2026,Payment,,Made-up Dental,,Business Bank Account,"5,750.00",
,,,,,Accounts Receivable (A/R),,"5,750.00"
`;
  it('the day order is the one that puts every line inside the title’s period (accounting 2)', () => {
    const f = readLedger('Journal.csv', parseCsv(US_JOURNAL));
    expect([f.from, f.to]).toEqual(['2026-11-01', '2026-11-30']);
    const outside = f.lines.filter((l) => l.date < f.from! || l.date > f.to!).map((l) => l.date);
    expect(outside).toEqual([]);
  });
});

describe('grouping', () => {
  it('per-day fallback keeps every line (sanity)', () => {
    const f = readLedger('x.csv', parseCsv(`Date,Account,Description,Debit,Credit
2026-11-03,Bank,a,100.00,
2026-11-03,Sales,b,,100.00
2026-11-03,Bank,c,50.00,
2026-11-03,Sales,d,,50.00
`));
    const t = transactionsOf(f.lines);
    expect(t.flatMap((x) => x.lines)).toHaveLength(4);
  });
});

// Xero's trial balance (Account Code, Account, Account Type, the month's and the year's columns).
const tb = (asAt: string, rows: [code: string, name: string, type: string, ytd: number][]) => {
  const lines = rows.map(([c, n, t, v]) => `${c},${n},${t},,,${v > 0 ? v.toFixed(2) : ''},${v < 0 ? (-v).toFixed(2) : ''}`);
  return `Trial Balance\nMade-up Coastal Wiring (Pty) Ltd\nAs at ${asAt}\nAccount Code,Account,Account Type,Debit,Credit,YTD Debit,YTD Credit\n${lines.join('\n')}\n`;
};

describe('bringing books in (accounting 1, 2, 5, 6, 9, 10)', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let acc: (key: string) => Promise<string>;
  let n = 0;
  const post = async <T = any>(url: string, payload: unknown, method: 'POST' | 'PUT' = 'POST'): Promise<T> => {
    const r = await me.call({ method, url, payload: payload as never, remoteAddress: `10.91.${(++n >> 8) & 255}.${n & 255}` });
    if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
    return r.json() as T;
  };
  const del = async (id: string) => {
    const r = await me.call({ method: 'DELETE', url: `/api/books-import/${id}`, remoteAddress: `10.92.${(++n >> 8) & 255}.${n & 255}` });
    return r;
  };
  /** Read, then apply with the suggestions, the given choices by name, and the file's own types for new ones. */
  const bring = async (files: ReturnType<typeof file>[], chosen: Record<string, string> = {}) => {
    const { accounts } = await post('/api/books-import/read', { files });
    const mapping = accounts.map((a: any) => ({ code: a.code, name: a.name, accountId: chosen[a.name] ?? a.accountId, newType: chosen[a.name] ? null : a.type }));
    return post('/api/books-import/apply', { files, mapping });
  };
  const tbMap = async (date: string) => new Map((await trialBalance(env.sql, date)).rows.map((r) => [r.name, r.balanceCents]));

  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    acc = async (key: string) => (await env.sql<{ id: string }[]>`select id from accounts where system_key = ${key}`)[0]!.id;
    // A company, year end February (the default).
    await env.sql`update settings set business_type = 'company'`;
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  const BASE = async () => ({ 'Business Bank Account': await acc('bank'), 'Retained Earnings': await acc('retained_earnings'), Dividends: await acc('dividends'), 'Share Capital': await acc('share_capital') });

  it('dividends: after a trial balance, these books’ own trial balance on that date is the file’s (accounting 6)', async () => {
    const chosen = await BASE();
    // Year to 28 Feb 2026: profit 50 000, dividend 10 000 declared.
    await bring([file('TB-2026.csv', tb('28 February 2026', [
      ['090', 'Business Bank Account', 'Bank', 40_100],
      ['200', 'Sales', 'Revenue', -80_000],
      ['477', 'Wages and Salaries', 'Expense', 30_000],
      ['960', 'Dividends', 'Equity', 10_000],
      ['970', 'Share Capital', 'Equity', -100],
    ]))], chosen);
    // 31 Oct 2026: the dividend closed to retained earnings in the package (40 000 left of the 50 000).
    const OCT = tb('31 October 2026', [
      ['090', 'Business Bank Account', 'Bank', 52_100],
      ['200', 'Sales', 'Revenue', -30_000],
      ['477', 'Wages and Salaries', 'Expense', 18_000],
      ['980', 'Retained Earnings', 'Equity', -40_000],
      ['970', 'Share Capital', 'Equity', -100],
    ]);
    await bring([file('TB-2026-10.csv', OCT)], chosen);
    const shap = await tbMap('2026-10-31');
    expect(shap.get('Dividends declared') ?? 0).toBe(0);
    expect(shap.get('Retained earnings')).toBe(-4_000_000);
  });

  it('taking out a trial balance that a later one was worked out on top of is refused (accounting 5)', async () => {
    const before = await balance(env.sql, 'bank', '2026-10-31');
    expect(before).toBe(5_210_000);
    const { imports } = await me.get('/api/books-import');
    const feb = imports.find((i: any) => i.dateTo === '2026-02-28');
    const r = await del(feb.id);
    expect(r.statusCode).toBe(400);
    expect(await balance(env.sql, 'bank', '2026-10-31')).toBe(before);
  });

  it('agreeing a year keeps the client’s ledger that was brought in (accounting 1)', async () => {
    const chosen = await BASE();
    // A ledger for November 2026 (Xero's Account Transactions).
    const GL = `Account Transactions
Made-up Coastal Wiring (Pty) Ltd
For the period 1 November 2026 to 30 November 2026
Date,Source,Description,Reference,Debit,Credit,Running Balance
Business Bank Account (090)
04 Nov 2026,Receive Money,Made-up Dental,RM-1,"2,300.00",,
Total Business Bank Account (090),,,,"2,300.00",,
Sales (200)
04 Nov 2026,Receive Money,Made-up Dental,RM-1,,"2,300.00",
Total Sales (200),,,,,"2,300.00",
`;
    await bring([file('GL-Nov.csv', GL)], chosen);
    const bank = await balance(env.sql, 'bank', '2026-11-30');
    // The accountant agrees the year to Feb 2027 with one figure (Reports → Year end).
    await post('/api/year-ends', { fyEnd: '2027-02-28', note: 'Agreed', lock: false, figures: [{ accountId: await acc('share_capital'), amountCents: 10_000 }] }, 'PUT');
    const [j] = await env.sql<{ n: number }[]>`select count(*)::int as n from journals j join ledger_imports i on i.id = j.ledger_import_id where i.kind = 'ledger'`;
    const listed = (await me.get('/api/books-import')).imports.map((i: any) => `${i.kind} ${i.dateFrom}..${i.dateTo}`);
    const after = await balance(env.sql, 'bank', '2026-11-30');
    expect(listed).toContain('ledger 2026-11-01..2026-11-30');
    expect(j!.n).toBe(1);
    expect(after).toBe(bank);
    await env.sql`delete from year_ends where fy_end = '2027-02-28'`;
  });

  it('the "already" count is of entries, not ledger rows (accounting 10)', async () => {
    // One journal of these books' own, in December, with two lines.
    const [j] = await env.sql<{ id: string }[]>`insert into journals (date, description, reference, kind) values ('2026-12-04', 'Made-up own entry', 'J1', 'manual') returning id`;
    await env.sql`insert into journal_lines (journal_id, account_id, debit_cents, credit_cents) values (${j!.id}, ${await acc('bank')}, 1000, 0), (${j!.id}, ${await acc('suspense')}, 0, 1000)`;
    const GL = `Date,Account,Description,Reference,Debit,Credit
2026-12-04,Business Bank Account,Made-up,R2,100.00,
2026-12-04,Sales,Made-up,R2,,100.00
`;
    const r = await post('/api/books-import/read', { files: [file('GL-Dec.csv', GL)] });
    expect(r.files[0].already).toBe(1);
    await env.sql`delete from journals where id = ${j!.id}`;
  });

  it('an account remembered, then made inactive: the preview says new, and new it is (accounting 9)', async () => {
    const GL = `Date,Account Code,Account,Description,Reference,Debit,Credit
2027-01-05,090,Business Bank Account,Made-up,R3,50.00,
2027-01-05,455,Made-up Old Fuel,Made-up,R3,,50.00
`;
    const { accounts } = await post('/api/books-import/read', { files: [file('GL-Jan.csv', GL)] });
    const fuel = accounts.find((a: any) => a.name === 'Made-up Old Fuel');
    const map1 = accounts.map((a: any) => ({ code: a.code, name: a.name, accountId: a.accountId, newType: a.accountId ? null : 'expense' }));
    await post('/api/books-import/apply', { files: [file('GL-Jan.csv', GL)], mapping: map1 });
    const [first] = await env.sql<{ id: string }[]>`select account_id as id from ledger_import_accounts where source_name = 'Made-up Old Fuel'`;
    await env.sql`update accounts set active = false where id = ${first!.id}`;
    const again = await post('/api/books-import/read', { files: [file('GL-Jan.csv', GL)] });
    expect(again.accounts.find((a: any) => a.name === 'Made-up Old Fuel').how).toBe('new');
    const map2 = again.accounts.map((a: any) => ({ code: a.code, name: a.name, accountId: a.accountId, newType: a.accountId ? null : 'expense' }));
    await post('/api/books-import/apply', { files: [file('GL-Jan.csv', GL)], mapping: map2 });
    const [posted] = await env.sql<{ active: boolean }[]>`select a.active from journal_lines jl join journals j on j.id = jl.journal_id join accounts a on a.id = jl.account_id where j.date = '2027-01-05' and jl.credit_cents = 5000`;
    expect(fuel).toBeTruthy();
    expect(posted!.active).toBe(true);
  });

  it('a line outside the title’s period is refused; month-first dates are read by the title, past the lock (accounting 2)', async () => {
    await env.sql`update settings set lock_date = '2026-06-30'`;
    const chosen = await BASE();
    // QuickBooks set to month first: every day is 12 or less, so only the title says which way round.
    const US = `Made-up Coastal Wiring (Pty) Ltd
Journal
November 1-30, 2026
Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit
11/03/2026,Invoice,1001,Made-up Dental,Rewiring,Business Bank Account,"575.00",
,,,,Rewiring,Sales,,"575.00"
`;
    const r = await bring([file('Journal-US.csv', US)], chosen);
    const [imp] = await env.sql<{ id: string }[]>`select id from ledger_imports where filename = 'Journal-US.csv'`;
    expect(r.results[0].importId).toBe(imp!.id);
    expect((await env.sql<{ date: string }[]>`select date::text as date from journals where ledger_import_id = ${imp!.id}`).map((j) => j.date)).toEqual(['2026-11-03']);
    // A line dated outside its own period (in the closed months) doesn't come in at all.
    const OUT = `Made-up Coastal Wiring (Pty) Ltd
Journal
For the period 1 December 2026 to 31 December 2026
Date,Account,Description,Reference,Debit,Credit
2026-12-04,Business Bank Account,Made-up,R9,100.00,
2026-12-04,Sales,Made-up,R9,,100.00
2026-03-11,Business Bank Account,Made-up,R10,50.00,
2026-03-11,Sales,Made-up,R10,,50.00
`;
    await expect(bring([file('Journal-out.csv', OUT)], chosen)).rejects.toThrow(/fall outside its period/);
    expect(await env.sql`select 1 from ledger_imports where filename = 'Journal-out.csv'`).toHaveLength(0);
    await env.sql`update settings set lock_date = null`;
    // Taken out again, for the tests after it.
    await del(imp!.id);
  });

  it('ledger_totals agree with the ledger after an import is taken out', async () => {
    const { imports } = await me.get('/api/books-import');
    for (const i of imports.filter((x: any) => x.kind === 'ledger')) await del(i.id);
    await env.sql`select fresh_ledger_totals()`;
    const [a] = await env.sql<{ t: number }[]>`select coalesce(sum(amount_cents), 0)::bigint as t from ledger where account_id = ${await acc('bank')}`;
    const [b] = await env.sql<{ t: number }[]>`select coalesce(sum(amount_cents), 0)::bigint as t from ledger_totals where account_id = ${await acc('bank')}`;
    expect(Number(b!.t)).toBe(Number(a!.t));
  });
});

describe('where each of their accounts is suggested to go', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  // Sage Accounting's detailed general ledger: date, reference, the transaction's type, debit/credit.
  const SAGE_GL = `Made-up Coastal Wiring (Pty) Ltd
  Detailed General Ledger
  1 November 2026 to 30 November 2026
  Date,Reference,Type,Description,Debit,Credit,Balance
  Sales
  03/11/2026,INV0001,Tax Invoice,Made-up Dental,,"5,000.00","-5,000.00"
  Trade Receivables
  03/11/2026,INV0001,Tax Invoice,Made-up Dental,"5,000.00",,"5,000.00"
  `;
  it('a ledger’s Type column is the transaction’s, not the account’s (accounting 7)', () => {
    const f = readLedger('GL.csv', parseCsv(SAGE_GL));
    const sales = f.lines.find((l) => l.name === 'Sales')!;
    expect(sales.type === null || sales.type === 'income').toBe(true);
  });

  // QuickBooks Online's trial balance with account numbers switched on (no types in the file).
  const QBO_TB = `Made-up Coastal Wiring (Pty) Ltd
  Trial Balance
  As of October 31, 2026
  ,Debit,Credit
  1000 Business Cheque Account,"18,400.00",
  1200 Accounts Receivable (A/R),"5,000.00",
  4000 Sales,,"46,000.00"
  6000 Rent Expense,"22,600.00",
  `;
  it('a code that happens to be Shap’s, with another name, isn’t suggested as the same account (accounting 8)', async () => {
    const me = await login(env.app, 'owner@example.co.za');
    const r = await me.post('/api/books-import/read', { files: [{ name: 'TB.csv', dataBase64: b64(QBO_TB) }] });
    const ours = new Map(r.ours.map((o: any) => [o.id, `${o.code} ${o.name}`]));
    const got = Object.fromEntries(r.accounts.map((a: any) => [`${a.code} ${a.name}`, a.accountId ? ours.get(a.accountId) : 'new']));
    expect(got['1200 Accounts Receivable (A/R)']).not.toBe('1200 Work in progress (jobs not yet invoiced)');
    expect(got['6000 Rent Expense']).not.toBe('6000 Accounting & admin');
  });
});

describe('two people bringing the same ledger in at once', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });
  const RACE_GL = `Date,Account,Description,Reference,Debit,Credit
  2026-11-04,Business Bank Account,Made-up Dental,R1,"2,300.00",
  2026-11-04,Sales,Made-up Dental,R1,,"2,300.00"
  `;

  it('the same period applied three times at the same moment is in the books once', async () => {
    const me = await login(env.app, 'owner@example.co.za');
    const bank = (await env.sql<{ id: string }[]>`select id from accounts where system_key = 'bank'`)[0]!.id;
    const files = [{ name: 'GL.csv', dataBase64: b64(RACE_GL) }];
    const mapping = [
      { code: '', name: 'Business Bank Account', accountId: bank, newType: null },
      { code: '', name: 'Sales', accountId: null, newType: 'income' },
    ];
    const go = (i: number) => me.call({ method: 'POST', url: '/api/books-import/apply', payload: { files, mapping } as never, remoteAddress: `10.93.0.${i}` });
    const rs = await Promise.all([go(1), go(2), go(3)]);
    expect(rs.map((r) => r.statusCode).filter((s) => s === 200).length).toBeGreaterThan(0);
    expect(await balance(env.sql, 'bank', '2026-11-30')).toBe(230_000);
    expect(await env.sql`select 1 from ledger_imports`).toHaveLength(1);
  });
});
