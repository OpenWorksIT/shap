/**
 * Shap Accountant, phase 2 (docs/ACCOUNTANT.md): another package's books brought in, from the
 * trial balance and general ledger exports Xero, QuickBooks and Sage write. Made-up files laid out
 * the way each package exports them; every figure made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { readLedger, sheetRows, splitAccount, transactionsOf, unpackedSize } from '../../src/modules/import/ledger.js';
import { parseCsv } from '../../src/modules/clients.js';
import { balance, expectCleanAudit, login, type TestEnv, setup } from '../helpers.js';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const file = (name: string, text: string, asAt?: string) => ({ name, dataBase64: b64(text), ...(asAt ? { asAt } : {}) });

// Xero's Trial Balance export: the month's Debit and Credit, then the year to date's.
const XERO_TB = `Trial Balance
Made-up Spark Electrical (Pty) Ltd
As at 31 October 2026
Account,Account Code,Account Type,Debit,Credit,YTD Debit,YTD Credit
Business Bank Account,090,Bank,"1,200.00",,"18,400.00",
Sales,200,Revenue,,"3,000.00",,"41,000.00"
Wages and Salaries,477,Expense,"1,800.00",,"22,600.00",
Total,,,"3,000.00","3,000.00","41,000.00","41,000.00"
`;
// QuickBooks Online's Journal report (South Africa: day first): a transaction's date, type and
// number on its first line only, then a line of its totals.
const QBO_JOURNAL = `Made-up Spark Electrical (Pty) Ltd
Journal
November 1-30, 2026
Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit
03/11/2026,Invoice,1001,Made-up Dental,Rewiring,Accounts Receivable (A/R),"5,750.00",
,,,,Rewiring,Sales,,"5,000.00"
,,,,VAT,VAT Control,,750.00
,,,,,,"5,750.00","5,750.00"
10/11/2026,Payment,,Made-up Dental,,Business Bank Account,"5,750.00",
,,,,,Accounts Receivable (A/R),,"5,750.00"
,,,,,,"5,750.00","5,750.00"
TOTAL,,,,,,"11,500.00","11,500.00"
`;
// Xero's General Ledger Detail: grouped under each account, with its opening and total rows.
const XERO_GL = `General Ledger Detail
Made-up Spark Electrical (Pty) Ltd
For the period 1 December 2026 to 31 December 2026
Date,Source,Description,Reference,Debit,Credit,Running Balance
Business Bank Account (090)
Opening Balance,,,,,,"24,150.00"
04 Dec 2026,Spend Money,Made-up Hardware,SP-9,,"1,150.00","23,000.00"
Total Business Bank Account (090),,,,,"1,150.00",
Wages and Salaries (477)
04 Dec 2026,Spend Money,Made-up Hardware,SP-9,"1,150.00",,
Total Wages and Salaries (477),,,,"1,150.00",,
`;
// Sage Pastel's trial balance: the account number in its own column, the name beside it, no date.
const PASTEL_TB = `Made-up Spark Electrical (Pty) Ltd
Trial Balance
Account,Description,Debit,Credit
8400/000,Business Bank Account,"18,400.00",
1000/000,Sales,,"41,000.00"
3600/000,Wages and Salaries,"22,600.00",
`;

describe('reading the packages’ exports', () => {
  it('reads Xero’s trial balance from the year-to-date columns, with its date from the title', () => {
    const f = readLedger('TB.csv', parseCsv(XERO_TB));
    expect([f.kind, f.source, f.asAt]).toEqual(['trialBalance', 'Xero', '2026-10-31']);
    expect(f.tb.map((l) => [l.code, l.name, l.type, l.cents])).toEqual([
      ['090', 'Business Bank Account', 'asset', 1_840_000],
      ['200', 'Sales', 'income', -4_100_000],
      ['477', 'Wages and Salaries', 'expense', 2_260_000],
    ]);
  });

  it('reads QuickBooks’ journal, each transaction from its first line down, its totals skipped', () => {
    const f = readLedger('Journal.csv', parseCsv(QBO_JOURNAL));
    expect([f.kind, f.source, f.from, f.to]).toEqual(['ledger', 'QuickBooks', '2026-11-01', '2026-11-30']);
    const txs = transactionsOf(f.lines);
    expect(txs.map((t) => [t.date, t.lines.length, t.lines.reduce((s, l) => s + l.cents, 0)])).toEqual([
      ['2026-11-03', 3, 0],
      ['2026-11-10', 2, 0],
    ]);
  });

  it('reads Xero’s general ledger grouped under each account', () => {
    const f = readLedger('GL.csv', parseCsv(XERO_GL));
    expect([f.kind, f.from, f.to]).toEqual(['ledger', '2026-12-01', '2026-12-31']);
    expect(f.lines.map((l) => [l.code, l.date, l.cents])).toEqual([
      ['090', '2026-12-04', -115_000],
      ['477', '2026-12-04', 115_000],
    ]);
  });

  it('reads Pastel’s account numbers with the names beside them', () => {
    const f = readLedger('TB.csv', parseCsv(PASTEL_TB));
    expect(f.kind).toBe('trialBalance');
    expect(f.asAt).toBeNull();
    expect(f.tb.map((l) => [l.code, l.name])).toEqual([
      ['8400/000', 'Business Bank Account'],
      ['1000/000', 'Sales'],
      ['3600/000', 'Wages and Salaries'],
    ]);
    expect(splitAccount('4000 · Sales')).toEqual({ code: '4000', name: 'Sales' });
    expect(splitAccount('1000/000')).toEqual({ code: '1000/000', name: '1000/000' });
  });

  it('reads an Excel export’s first sheet, and refuses a file that unpacks to far more than it is', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Trial Balance');
    for (const row of parseCsv(XERO_TB)) ws.addRow(row);
    const bytes = Buffer.from(await wb.xlsx.writeBuffer());
    expect(unpackedSize(bytes)).toBeGreaterThan(0);
    const f = readLedger('TB.xlsx', await sheetRows('TB.xlsx', bytes));
    expect([f.kind, f.asAt, f.tb.length]).toEqual(['trialBalance', '2026-10-31', 3]);
    // A made-up zip whose directory says one entry unpacks to 4 GB.
    const bomb = Buffer.alloc(46 + 22);
    bomb.writeUInt32LE(0x02014b50, 0);
    bomb.writeUInt32LE(0xfffffffe, 24);
    bomb.writeUInt32LE(0x06054b50, 46);
    bomb.writeUInt16LE(1, 46 + 10);
    bomb.writeUInt32LE(0, 46 + 16);
    await expect(sheetRows('big.xlsx', Buffer.concat([Buffer.from('PK'), bomb.subarray(2)]))).rejects.toThrow(/isn’t a spreadsheet Shap can read/);
  });

  it('says when a day’s lines don’t balance: the export is missing accounts', () => {
    const f = readLedger('Journal.csv', parseCsv(QBO_JOURNAL.replace(',,,,VAT,VAT Control,,750.00\n', '')));
    expect(() => transactionsOf(f.lines)).toThrow(/don’t balance/);
  });
});

describe('bringing another package’s books in', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let ids: { bank: string; receivables: string; vat: string };

  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    const acc = async (key: string) => (await env.sql<{ id: string }[]>`select id from accounts where system_key = ${key}`)[0]!.id;
    ids = { bank: await acc('bank'), receivables: await acc('receivables'), vat: await acc('vat') };
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  // Each from its own address: reading and bringing in are rate-limited.
  let n = 0;
  const post = async <T = any>(url: string, payload: unknown): Promise<T> => {
    const r = await me.call({ method: 'POST', url, payload: payload as never, remoteAddress: `10.47.${(++n >> 8) & 255}.${n & 255}` });
    if (r.statusCode >= 400) throw new Error(`POST ${url} → ${r.statusCode} ${r.body}`);
    return r.json() as T;
  };
  const attempt = (url: string, payload: unknown) => me.call({ method: 'POST', url, payload: payload as never, remoteAddress: `10.48.${(++n >> 8) & 255}.${n & 255}` });
  const map = (accounts: { code: string; name: string; accountId: string | null; type: string | null }[], chosen: Record<string, string> = {}) =>
    accounts.map((a) => ({ code: a.code, name: a.name, accountId: chosen[a.name] ?? a.accountId, newType: chosen[a.name] ? null : (a.type ?? null) }));

  it('previews a trial balance with where each account would go, saving nothing', async () => {
    const r = await post('/api/books-import/read', { files: [file('TB.csv', XERO_TB)] });
    expect(r.files[0]).toMatchObject({ kind: 'trialBalance', source: 'Xero', asAt: '2026-10-31', debits: 4_100_000, credits: 4_100_000 });
    expect(r.accounts.map((a: { name: string; how: string }) => [a.name, a.how])).toEqual([
      ['Business Bank Account', 'new'],
      ['Sales', 'new'],
      ['Wages and Salaries', 'new'],
    ]);
    expect(await env.sql`select 1 from ledger_imports`).toHaveLength(0);
  });

  it('brings the books to the trial balance on its date: balances to date, income and expenses for the year', async () => {
    const { accounts } = await post('/api/books-import/read', { files: [file('TB.csv', XERO_TB)] });
    const r = await post('/api/books-import/apply', { files: [file('TB.csv', XERO_TB)], mapping: map(accounts, { 'Business Bank Account': ids.bank }) });
    expect(r).toMatchObject({ created: 2, results: [{ kind: 'trialBalance', journals: 1 }] });
    expect(await balance(env.sql, 'bank', '2026-10-31')).toBe(1_840_000);
    const sales = (await env.sql<{ id: string }[]>`select id from accounts where code = '200'`)[0]!.id;
    const [s] = await env.sql<{ c: string }[]>`select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint as c from journal_lines jl where jl.account_id = ${sales}`;
    expect(Number(s!.c)).toBe(-4_100_000);
    // The same trial balance again: replaced, not doubled. And remembered: next time it maps itself.
    await post('/api/books-import/apply', { files: [file('TB.csv', XERO_TB)], mapping: map(accounts, { 'Business Bank Account': ids.bank }) });
    expect(await balance(env.sql, 'bank', '2026-10-31')).toBe(1_840_000);
    expect(await env.sql`select 1 from ledger_imports where kind = 'trialBalance'`).toHaveLength(1);
    const again = await post('/api/books-import/read', { files: [file('TB.csv', XERO_TB)] });
    expect(again.accounts.every((a: { how: string }) => a.how === 'as last time')).toBe(true);
  });

  it('brings a ledger in as its transactions, and the same period again replaces it', async () => {
    const { accounts, files } = await post('/api/books-import/read', { files: [file('Journal.csv', QBO_JOURNAL)] });
    expect(files[0]).toMatchObject({ kind: 'ledger', from: '2026-11-01', to: '2026-11-30', already: 0 });
    const chosen = { 'Accounts Receivable (A/R)': ids.receivables, 'VAT Control': ids.vat, 'Business Bank Account': ids.bank };
    // Sales maps by its name to the Sales the trial balance made.
    expect(accounts.find((a: { name: string }) => a.name === 'Sales').how).toBe('same name or code');
    const r = await post('/api/books-import/apply', { files: [file('Journal.csv', QBO_JOURNAL)], mapping: map(accounts, chosen) });
    expect(r.results).toMatchObject([{ name: 'Journal.csv', kind: 'ledger', journals: 2 }]);
    expect(await balance(env.sql, 'bank', '2026-11-30')).toBe(1_840_000 + 575_000);
    expect(await balance(env.sql, 'vat', '2026-11-30')).toBe(-75_000);
    await post('/api/books-import/apply', { files: [file('Journal.csv', QBO_JOURNAL)], mapping: map(accounts, chosen) });
    expect(await balance(env.sql, 'bank', '2026-11-30')).toBe(1_840_000 + 575_000);
    expect(await env.sql`select 1 from journals where ledger_import_id is not null and date between '2026-11-01' and '2026-11-30'`).toHaveLength(2);
  });

  it('refuses a ledger that overlaps an earlier one without covering it', async () => {
    const shifted = QBO_JOURNAL.replace('November 1-30, 2026', 'November 15 - December 15, 2026').replace('03/11/2026', '16/11/2026').replace('10/11/2026', '20/11/2026');
    const { accounts } = await post('/api/books-import/read', { files: [file('Journal.csv', shifted)] });
    const r = await attempt('/api/books-import/apply', { files: [file('Journal.csv', shifted)], mapping: map(accounts) });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/overlaps/);
  });

  it('won’t leave a trial balance wrong: a ledger under it comes in with it again', async () => {
    const october = QBO_JOURNAL.replace('November 1-30, 2026', 'October 1-31, 2026').replace('03/11/2026', '05/10/2026').replace('10/11/2026', '12/10/2026');
    const { accounts } = await post('/api/books-import/read', { files: [file('Journal.csv', october), file('TB.csv', XERO_TB)] });
    const chosen = { 'Accounts Receivable (A/R)': ids.receivables, 'VAT Control': ids.vat, 'Business Bank Account': ids.bank };
    const alone = await attempt('/api/books-import/apply', { files: [file('Journal.csv', october)], mapping: map(accounts, chosen) });
    expect(alone.statusCode).toBe(400);
    expect(alone.json().error).toMatch(/trial balance at 31 Oct 2026 was brought in before/);
    // Together: the ledger, then the trial balance on top, which still lands on its figures.
    await post('/api/books-import/apply', { files: [file('Journal.csv', october), file('TB.csv', XERO_TB)], mapping: map(accounts, chosen) });
    expect(await balance(env.sql, 'bank', '2026-10-31')).toBe(1_840_000);
  });

  it('asks for a trial balance’s date when its title doesn’t say, and takes it when given', async () => {
    const { accounts } = await post('/api/books-import/read', { files: [file('TB.csv', PASTEL_TB)] });
    const no = await attempt('/api/books-import/apply', { files: [file('TB.csv', PASTEL_TB)], mapping: map(accounts, { 'Business Bank Account': ids.bank }) });
    expect(no.json().error).toMatch(/Give the date of the trial balance/);
    // Its accounts by their names, its date as given: the year's figures at the year end.
    expect(accounts.filter((a: { name: string }) => a.name !== 'Business Bank Account').map((a: { how: string }) => a.how)).toEqual(['same name or code', 'same name or code']);
    await post('/api/books-import/apply', { files: [file('TB.csv', PASTEL_TB, '2027-02-28')], mapping: map(accounts, { 'Business Bank Account': ids.bank }) });
    expect(await balance(env.sql, 'bank', '2027-02-28')).toBe(1_840_000);
    expect(await env.sql`select 1 from accounts where name = 'Sales'`).toHaveLength(1);
    // Taken out again: it was worked out from the books as they were, and a later ledger would come under it.
    const { imports } = await me.get('/api/books-import');
    await me.post(`/api/books-import/${imports.find((i: { dateTo: string }) => i.dateTo === '2027-02-28').id}`, {}, 'DELETE');
  });

  it('brings in Xero’s grouped ledger, and takes an import out again', async () => {
    const { accounts } = await post('/api/books-import/read', { files: [file('GL.csv', XERO_GL)] });
    expect(accounts.map((a: { how: string }) => a.how)).toEqual(['as last time', 'as last time']);
    const before = await balance(env.sql, 'bank', '2026-12-31');
    await post('/api/books-import/apply', { files: [file('GL.csv', XERO_GL)], mapping: map(accounts) });
    expect(await balance(env.sql, 'bank', '2026-12-31')).toBe(before - 115_000);
    const { imports } = await me.get('/api/books-import');
    const dec = imports.find((i: { dateFrom: string }) => i.dateFrom === '2026-12-01');
    await me.post(`/api/books-import/${dec.id}`, {}, 'DELETE');
    expect(await balance(env.sql, 'bank', '2026-12-31')).toBe(before);
  });

  it('puts nothing into a closed period', async () => {
    await env.sql`update settings set lock_date = '2026-11-30'`;
    const { accounts } = await post('/api/books-import/read', { files: [file('Journal.csv', QBO_JOURNAL)] });
    const r = await attempt('/api/books-import/apply', { files: [file('Journal.csv', QBO_JOURNAL)], mapping: map(accounts) });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/closed up to/);
    await env.sql`update settings set lock_date = null`;
  });

  it('is for those who may post journals', async () => {
    const site = await login(env.app, 'site@example.co.za');
    expect((await site.call({ method: 'POST', url: '/api/books-import/read', payload: { files: [file('TB.csv', XERO_TB)] } })).statusCode).toBe(403);
  });
});

describe('another package’s books in a practice’s client', () => {
  let env: TestEnv;
  const drop = async () => {
    const pattern = `${env.ctx.clients.practiceDb.replace(/_/g, '\\_')}\\_\\_c\\_%`;
    for (const { datname } of await env.sql<{ datname: string }[]>`select datname from pg_database where datname like ${pattern}`) await env.sql.unsafe(`drop database if exists "${datname}" with (force)`);
  };
  beforeAll(async () => {
    env = await setup();
    await drop();
  });
  afterAll(async () => {
    await env.ctx.clients.end();
    await drop();
    await env.close();
  });

  it('adds a client whose books are in another package, and brings them into its own books only', async () => {
    const owner = await login(env.app, 'owner@example.co.za');
    const { settings } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...settings, features: { ...settings.features, practice: true } }, 'PUT');
    const { id } = await owner.post('/api/practice/clients', { name: 'Made-up Imported Electrical (Pty) Ltd', kind: 'imported' });
    const list = await owner.get('/api/practice');
    expect(list.clients.find((c: { id: string }) => c.id === id).kind).toBe('imported');
    const opened = await owner.call({ method: 'POST', url: `/api/practice/clients/${id}/open`, payload: {} });
    const cookies = Object.fromEntries(opened.cookies.filter((c) => c.value).map((c) => [c.name, c.value]));
    const [row] = await env.sql<{ dbName: string }[]>`select db_name from practice_clients where id = ${id}`;
    const db = env.ctx.clients.get(row!.dbName);
    await db`update settings set setup_done = true, business_type = 'company', fy_end_month = 2`;
    const bank = (await db<{ id: string }[]>`select id from accounts where system_key = 'bank'`)[0]!.id;
    const read = await owner.call({ method: 'POST', url: '/api/books-import/read', payload: { files: [file('TB.csv', XERO_TB)] }, cookies });
    const { accounts } = read.json();
    const mapping = accounts.map((a: { code: string; name: string; type: string }) => ({ code: a.code, name: a.name, accountId: a.name === 'Business Bank Account' ? bank : null, newType: a.name === 'Business Bank Account' ? null : a.type }));
    const applied = await owner.call({ method: 'POST', url: '/api/books-import/apply', payload: { files: [file('TB.csv', XERO_TB)], mapping }, cookies });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(await balance(db, 'bank', '2026-10-31')).toBe(1_840_000);
    expect(await env.sql`select 1 from ledger_imports`).toHaveLength(0);
    await expectCleanAudit(db);
  });
});
