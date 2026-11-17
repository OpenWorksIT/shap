/**
 * The security and privacy review of 1.28.0 (CPDAUDIT.md): what reading another package's files can
 * do to the server, who may add accounts through an import, and what an imported account's name and
 * code can do elsewhere. Each test fails on the code the review was of. Every figure and name made up.
 */
import { Readable } from 'node:stream';
import { createDeflateRaw } from 'node:zlib';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { trailButtonName, trailFieldName } from '@shap/shared';
import { createUser } from '../../src/auth.js';
import { MAX_NEW_ACCOUNTS } from '../../src/modules/books-import.js';
import { MAX_CSV_COLUMNS, parseCsv } from '../../src/modules/clients.js';
import { readLedger, sheetRows, unpackedSize } from '../../src/modules/import/ledger.js';
import { parseMoney } from '../../src/modules/movein.js';
import { expectCleanAudit, login, setup, type TestEnv } from '../helpers.js';

const timed = async (f: () => Promise<unknown>) => {
  const t = Date.now();
  let error = '';
  try {
    await f();
  } catch (e) {
    error = (e as Error).message;
  }
  return { ms: Date.now() - t, error };
};

/** A flat ledger (Xero's Journal report layout) of n made-up two-line transactions. */
async function ledgerXlsx(n: number): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Journal');
  ws.addRow(['Made-up Trading (Pty) Ltd']);
  ws.addRow(['For the period 1 March 2026 to 31 October 2026']);
  ws.addRow(['Date', 'Account Code', 'Account', 'Description', 'Reference', 'Debit', 'Credit']);
  for (let i = 0; i < n; i++) {
    const d = `2026-${String(3 + (i % 8)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`;
    ws.addRow([d, '200', 'Sales', `Made-up sale ${i}`, `INV-${i}`, '', 100]);
    ws.addRow([d, '090', 'Business Bank', `Made-up sale ${i}`, `INV-${i}`, 100, '']);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Three cells, the last one far off: about 6 KB, a sheet "of" rows × 200 columns. */
async function farCellXlsx(row: number): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('TB');
  ws.getCell('A1').value = 'Account';
  ws.getCell('B1').value = 'Debit';
  ws.getCell(`GR${row}`).value = 1;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function deflatedSpaces(mb: number): Promise<Buffer> {
  const one = Buffer.alloc(1 << 20, 0x20);
  const out: Buffer[] = [];
  for await (const c of Readable.from((function* () {
    for (let i = 0; i < mb; i++) yield one;
  })()).pipe(createDeflateRaw({ level: 9 }))) out.push(c as Buffer);
  return Buffer.concat(out);
}

/** The .xlsx with one more entry that unpacks to `mb` megabytes while the zip's own directory says it's `lie` bytes. */
async function lyingXlsx(xlsx: Buffer, mb: number, lie = 1000): Promise<Buffer> {
  const data = await deflatedSpaces(mb);
  let e = xlsx.length - 22;
  while (xlsx.readUInt32LE(e) !== 0x06054b50) e--;
  const entries = xlsx.readUInt16LE(e + 10);
  const cdSize = xlsx.readUInt32LE(e + 12);
  const cdOffset = xlsx.readUInt32LE(e + 16);
  const name = Buffer.from('xl/junk.xml');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(lie, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(lie, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(cdOffset, 42);
  const localPart = Buffer.concat([local, name, data]);
  const cd = Buffer.concat([xlsx.subarray(cdOffset, cdOffset + cdSize), central, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries + 1, 8);
  eocd.writeUInt16LE(entries + 1, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdOffset + localPart.length, 16);
  return Buffer.concat([xlsx.subarray(0, cdOffset), localPart, cd, eocd]);
}

const peakMb = () => Math.round(process.resourceUsage().maxRSS / 1024);

describe('reading a spreadsheet costs what the file holds (security 1, 2 and 7)', () => {
  it('reads a ledger of 10,000 rows in seconds (it took 33 s, and blocked every request meanwhile)', async () => {
    const bytes = await ledgerXlsx(5000);
    let f: ReturnType<typeof readLedger> | null = null;
    const r = await timed(async () => (f = readLedger('GL.xlsx', await sheetRows('GL.xlsx', bytes))));
    expect(r.error).toBe('');
    expect(r.ms).toBeLessThan(3000);
    expect(f!.lines).toHaveLength(10_000);
  });

  it('a 6 KB sheet with one cell far off is read at once (GR1000 hadn’t finished after 200 s)', async () => {
    const bytes = await farCellXlsx(1000);
    expect(bytes.length).toBeLessThan(10_000);
    const r = await timed(() => sheetRows('TB.xlsx', bytes));
    expect(r.ms).toBeLessThan(1000);
  });

  it('a cell beyond the 200th column is refused, not read into millions of cells', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('TB');
    ws.getCell('A1').value = 'Account';
    ws.getCell('XFD1').value = 1;
    const r = await timed(async () => sheetRows('TB.xlsx', Buffer.from(await wb.xlsx.writeBuffer())));
    expect(r.error).toMatch(/too big to read/);
    expect(r.ms).toBeLessThan(1000);
  });

  it('a file whose directory understates what it unpacks to is refused while it’s counted, not after', async () => {
    const plain = await farCellXlsx(2);
    const bytes = await lyingXlsx(plain, 400);
    expect(bytes.length).toBeLessThan(1_000_000);
    // What it really unpacks to is counted, not taken from the directory.
    expect(await unpackedSize(bytes, 10 * 1024 * 1024)).toBe(10 * 1024 * 1024 + 1);
    const before = peakMb();
    const r = await timed(() => sheetRows('TB.xlsx', bytes));
    expect(r.error).toMatch(/too big to read|isn’t a spreadsheet Shap can read/);
    expect(peakMb() - before).toBeLessThan(100);
    // One that lies by a little (its entry says 1,000 bytes, it's 1 MB) doesn't get through either.
    expect(await unpackedSize(await lyingXlsx(plain, 1))).toBeNull();
    // An honest one is counted as it is.
    expect(await unpackedSize(plain)).toBeGreaterThan(1000);
  });

  it('a CSV millions of columns wide is refused as it’s read (it took 7 s and 684 MB)', async () => {
    const row = (first: string) => first + ','.repeat(5_000_000) + '\n';
    const bytes = Buffer.from(row('Account,Debit,Credit') + row('Made-up Bank,1,'));
    const r = await timed(async () => readLedger('TB.csv', await sheetRows('TB.csv', bytes)));
    expect(r.error).toMatch(/too many columns/);
    expect(r.ms).toBeLessThan(1500);
    expect(() => parseCsv(`a${','.repeat(MAX_CSV_COLUMNS)}`)).toThrow(/too many columns/);
    expect(parseCsv(`a${','.repeat(MAX_CSV_COLUMNS - 1)}`)[0]).toHaveLength(MAX_CSV_COLUMNS);
  });
});

describe('amounts as the packages write them (accounting 11)', () => {
  it('reads a currency before brackets, and Dr and Cr, with their signs', () => {
    expect(parseMoney('R (1 234.56)')).toBe(-123_456);
    expect(parseMoney('1 234.56 Cr')).toBe(-123_456);
    expect(parseMoney('1 234.56Cr')).toBe(-123_456);
    expect(parseMoney('1 234.56 Dr')).toBe(123_456);
    expect(parseMoney('Cr 500.00')).toBe(-50_000);
    // Still as before.
    expect(parseMoney('(1 234.56)')).toBe(-123_456);
    expect(parseMoney('R -1 234.50')).toBe(-123_450);
    expect(parseMoney('R 1 234.50')).toBe(123_450);
    expect(parseMoney('1,234.56-')).toBe(-123_456);
  });

  it('an Excel number with three decimals is read to its cents, not as thousands', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('TB');
    ws.addRow(['Trial Balance']);
    ws.addRow(['As at 31 October 2026']);
    ws.addRow(['Account Code', 'Account', 'Debit', 'Credit']);
    ws.addRow(['090', 'Made-up Bank', 1234.567, '']);
    ws.addRow(['200', 'Made-up Sales', '', 1234.567]);
    const f = readLedger('TB.xlsx', await sheetRows('TB.xlsx', Buffer.from(await wb.xlsx.writeBuffer())));
    expect(f.tb.map((l) => l.cents)).toEqual([123_457, -123_457]);
  });
});

describe('the feedback trail keeps account and people’s names out (security 8, POPIA)', () => {
  it('names a field or a button in a list or among private details only by where it was', () => {
    expect(trailFieldName('Where Loan – J Smith goes', { private: true, inList: true })).toBe('a field in a list');
    expect(trailFieldName('Where Loan – J Smith goes', { private: true, inList: false })).toBe('a field among private details');
    expect(trailFieldName('VAT rate', { private: false, inList: false })).toBe('VAT rate');
    expect(trailFieldName('Phone 082 555 0100', { private: false, inList: false })).not.toMatch(/555/);
    expect(trailButtonName('button', 'Remove Made-up Smith', { private: true, inList: false })).toBe('button among private details');
    expect(trailButtonName('button', 'Save', { private: false, inList: false })).toBe('button “Save”');
  });
});

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const file = (name: string, text: string) => ({ name, dataBase64: b64(text) });
const tb = (date: string, rows: string) => `Trial Balance\nMade-up Spark Electrical (Pty) Ltd\nAs at ${date}\nAccount,Account Code,Account Type,Debit,Credit\n${rows}`;

describe('what an import may add to the chart, and what its accounts can do elsewhere (security 3, 4, 6)', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  let bank: string;
  let n = 0;
  type Who = Awaited<ReturnType<typeof login>>;
  const as = (who: Who, method: string, url: string, payload?: unknown) => who.call({ method: method as never, url, payload: payload as never, remoteAddress: `10.78.${(++n >> 8) & 255}.${n & 255}` });
  const mappingOf = async (who: Who, files: { name: string; dataBase64: string }[], chosen: Record<string, string> = {}) => {
    const read = await as(who, 'POST', '/api/books-import/read', { files });
    expect(read.statusCode, read.body).toBe(200);
    return read.json().accounts.map((a: { code: string; name: string; accountId: string | null; type: string | null }) => ({ code: a.code, name: a.name, accountId: chosen[a.name] ?? a.accountId, newType: chosen[a.name] ? null : a.type }));
  };

  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
    bank = (await env.sql<{ id: string }[]>`select id from accounts where system_key = 'bank'`)[0]!.id;
    await createUser(env.sql, { name: 'Made-up Bookkeeper', email: 'bookkeeper@example.co.za', password: 'test-password-1', role: 'staff', accessAdd: ['books.adjust', 'reports.view'] });
  });
  afterAll(async () => env.close());

  it('staff who may post journals can’t add accounts through an import (the chart is the owner’s); they can choose ours', async () => {
    const staff = await login(env.app, 'bookkeeper@example.co.za');
    expect((await as(staff, 'POST', '/api/accounts', { code: '4100', name: 'Made-up Consulting', type: 'income' })).statusCode).toBe(403);
    const files = [file('TB.csv', tb('31 October 2026', 'Business Bank Account,090,Bank,"500.00",\nMade-up Consulting Fees,201,Revenue,,"500.00"\n'))];
    const before = (await env.sql`select 1 from accounts`).length;
    const r = await as(staff, 'POST', '/api/books-import/apply', { files, mapping: await mappingOf(staff, files, { 'Business Bank Account': bank }) });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatch(/only the owner adds accounts/);
    // The check (run, then undone) says the same.
    expect((await as(staff, 'POST', '/api/books-import/check', { files, mapping: await mappingOf(staff, files, { 'Business Bank Account': bank }) })).statusCode).toBe(403);
    expect((await env.sql`select 1 from accounts`).length).toBe(before);
    // Choosing one of ours for each of theirs, it comes in.
    const [sales] = await env.sql<{ id: string }[]>`select id from accounts where type = 'income' and active order by code limit 1`;
    const ok = await as(staff, 'POST', '/api/books-import/apply', { files, mapping: await mappingOf(staff, files, { 'Business Bank Account': bank, 'Made-up Consulting Fees': sales!.id }) });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await env.sql`select 1 from accounts`).length).toBe(before);
    await env.sql`delete from ledger_imports`;
  });

  it('one import adds at most so many accounts to the chart', async () => {
    const rows = Array.from({ length: MAX_NEW_ACCOUNTS + 1 }, (_, i) => `Made-up expense ${i},${7000 + i},Expense,"1.00",`).join('\n');
    const files = [file('TB.csv', tb('31 October 2026', `${rows}\nBusiness Bank Account,090,Bank,,"${MAX_NEW_ACCOUNTS + 1}.00"\n`))];
    const before = (await env.sql`select 1 from accounts`).length;
    const r = await as(owner, 'POST', '/api/books-import/apply', { files, mapping: await mappingOf(owner, files, { 'Business Bank Account': bank }) });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(new RegExp(`more than ${MAX_NEW_ACCOUNTS} accounts`));
    expect((await env.sql`select 1 from accounts`).length).toBe(before);
  });

  it('a very long account name is cut to fit, not a server error', async () => {
    const long = `Made-up ${'very '.repeat(600)}long account`;
    const files = [file('Long.csv', tb('31 October 2026', `Business Bank Account,090,Bank,"10.00",\n${long},998,Revenue,,"10.00"\n`))];
    const mapping = await mappingOf(owner, files, { 'Business Bank Account': bank });
    expect(mapping.every((m: { name: string }) => m.name.length <= 200)).toBe(true);
    const r = await as(owner, 'POST', '/api/books-import/apply', { files, mapping });
    expect(r.statusCode, r.body).toBe(200);
    const [a] = await env.sql<{ code: string; name: string }[]>`select code, name from accounts where name like 'Made-up very%'`;
    expect(a!.name.length).toBeLessThanOrEqual(120);
    await env.sql`delete from ledger_imports`;
  });

  it('an account brought in without a code (QuickBooks) gets one that fits the chart, and its ledger downloads', async () => {
    const files = [file('TB.csv', `Trial Balance\nAs at 31 October 2026\nAccount,Account Type,Debit,Credit\nBusiness Bank Account,Bank,"10.00",\nCafé – Sales,Revenue,,"10.00"\n`)];
    const r = await as(owner, 'POST', '/api/books-import/apply', { files, mapping: await mappingOf(owner, files, { 'Business Bank Account': bank }) });
    expect(r.statusCode, r.body).toBe(200);
    const [acc] = await env.sql<{ id: string; code: string }[]>`select id, code from accounts where name = 'Café – Sales'`;
    expect(acc!.code).toMatch(/^IMP-\d+$/);
    expect(acc!.code.length).toBeLessThanOrEqual(10);
    // The owner can save it as it is (the chart's own rule: a code of 10 characters at most).
    const saved = await as(owner, 'PUT', `/api/accounts/${acc!.id}`, { code: acc!.code, name: 'Café – Sales', type: 'income' });
    expect(saved.statusCode, saved.body).toBe(200);
    const csv = await as(owner, 'GET', `/api/reports/ledger?account=${acc!.id}&from=2026-03-01&to=2026-10-31&format=csv`);
    expect(csv.statusCode, csv.body.slice(0, 120)).toBe(200);
    expect(csv.headers['content-disposition']).toMatch(/^attachment; filename="[\w.\- ]+"$/);
  });

  it('a journal brought in can’t be changed or deleted on its own (the import keeps account of it)', async () => {
    const [j] = await env.sql<{ id: string; date: string }[]>`select id, date::text as date from journals where ledger_import_id is not null limit 1`;
    const lines = await env.sql<{ accountId: string; debitCents: number; creditCents: number }[]>`select account_id, debit_cents, credit_cents from journal_lines where journal_id = ${j!.id}`;
    const edit = await as(owner, 'PUT', `/api/journals/${j!.id}`, { date: j!.date, description: 'Made-up change', reference: 'X', lines: lines.map((l) => ({ accountId: l.accountId, debitCents: Number(l.debitCents), creditCents: Number(l.creditCents), memo: '' })) });
    expect(edit.statusCode).toBe(400);
    expect(edit.json().error).toMatch(/brought in from another package/);
    const del = await as(owner, 'DELETE', `/api/journals/${j!.id}`);
    expect(del.statusCode).toBe(400);
    expect(await env.sql`select 1 from journals where id = ${j!.id}`).toHaveLength(1);
    await expectCleanAudit(env.sql, '2026-10-31');
  });
});
