/**
 * The IFRS for SMEs and company law review of 1.28.0 (CPDAUDIT.md): statements drawn from books
 * brought in from another package. Each test fails on the code the review was of. Made-up books.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acc, buildStatements, caller, expectCleanAudit, file, login, setup, XERO_TB_2026, type TestEnv } from './common.js';

const XERO_GL_FEB = `Account Transactions
Made-up Kestrel Plumbing (Pty) Ltd
For the period 1 February 2026 to 28 February 2026
Date,Source,Description,Reference,Debit,Credit
Business Bank Account (090)
10 Feb 2026,Receive Money,Made-up Clinic,RM-1,"5,000.00",
Sales (200)
10 Feb 2026,Receive Money,Made-up Clinic,RM-1,,"5,000.00"
`;
const sumOf = (ls: { current: number }[]) => ls.reduce((s, l) => s + l.current, 0);
const tb = (title: string, rows: [string, string, string, number][]) =>
  `Trial Balance\nMade-up Heron Electrical (Pty) Ltd\nAs at ${title}\nAccount,Account Code,Account Type,Debit,Credit,YTD Debit,YTD Credit\n` +
  rows.map(([n, c, t, v]) => `${n},${c},${t},,,${v > 0 ? `"${v.toFixed(2)}"` : ''},${v < 0 ? `"${(-v).toFixed(2)}"` : ''}`).join('\n') + '\n';

/** Fresh books for a company with a February year end. */
function company() {
  const t: { env: TestEnv; me: Awaited<ReturnType<typeof login>>; c: ReturnType<typeof caller> } = {} as never;
  beforeAll(async () => {
    t.env = await setup();
    await t.env.sql`update settings set business_type = 'company', fy_end_month = 2`;
    t.me = await login(t.env.app, 'owner@example.co.za');
    t.c = caller(t.me);
  });
  afterAll(async () => t.env.close());
  return t;
}

describe('a trial balance on its own at a year end (IFRS 2, 3, 10)', () => {
  const t = company();

  it('new accounts go on the lines their package’s types give', async () => {
    await t.c.bring([file('TB.csv', XERO_TB_2026)], { 'Business Bank Account': await acc(t.env, 'bank') });
    const lines = new Map((await t.env.sql<{ code: string; statementLine: string }[]>`select code, statement_line from accounts where code in ('610','710','711','800','900','416','437')`).map((l) => [l.code, l.statementLine]));
    expect(['710', '711', '900'].map((c) => lines.get(c))).toEqual(['ppe', 'ppe', 'borrowings_non_current']);
    // Their debtors and creditors go to Shap's own (its control checks are on those).
    const keys = await t.env.sql<{ systemKey: string }[]>`select a.system_key from ledger_import_accounts m join accounts a on a.id = m.account_id where m.source_code in ('610', '800') order by m.source_code`;
    expect(keys.map((k) => k.systemKey)).toEqual(['receivables', 'payables']);
    expect(lines.get('437')).toBe('finance_costs');
    // The accumulated depreciation stays with the equipment, not an "other current liability".
    const s = await buildStatements(t.env.sql, '2026-02-28');
    expect(s.sfp.liabilities.flatMap((b) => b.lines).some((l) => /other current liabilit/i.test(l.label))).toBe(false);
  });

  it('says the books begin with it: the years shown start from nil before it', async () => {
    const s = await buildStatements(t.env.sql, '2026-02-28');
    const c = s.checks.find((x) => x.label === 'The opening position is in the books');
    expect(c?.ok).toBe(false);
    expect(c?.detail).toMatch(/Bring in the trial balance at the year end before it/);
  });

  it('keeps a record of each export it brought in, and of one it replaced', async () => {
    await t.c.bring([file('TB-again.csv', XERO_TB_2026)], { 'Business Bank Account': await acc(t.env, 'bank') });
    const [imp] = await t.env.sql<{ id: string; fileHash: string }[]>`select id, file_hash from ledger_imports`;
    expect(imp!.fileHash).toMatch(/^[0-9a-f]{64}$/);
    const rows = await t.env.sql<{ action: string; entityId: string; details: Record<string, unknown> }[]>`select action, entity_id, details from audit_log where entity = 'ledger_import' order by at`;
    expect(rows.some((r) => r.action === 'books_import' && r.entityId === imp!.id)).toBe(true);
    expect(rows.some((r) => r.action === 'replace' && JSON.stringify(r.details).includes('TB.csv'))).toBe(true);
    await expectCleanAudit(t.env.sql, '2026-02-28');
  });
});

describe('agreeing a year end after bringing books in (IFRS 1)', () => {
  const t = company();
  it('keeps what was brought in when one account is agreed', async () => {
    await t.c.bring([file('TB.csv', XERO_TB_2026), file('GL.csv', XERO_GL_FEB)], { 'Business Bank Account': await acc(t.env, 'bank') });
    const r = await t.me.call({ method: 'PUT', url: '/api/year-ends', payload: { fyEnd: '2026-02-28', note: 'Made-up AFS', lock: false, figures: [{ accountId: await acc(t.env, 'income_tax'), amountCents: 200_000 }] } });
    expect(r.statusCode, r.body).toBe(200);
    expect((await t.env.sql`select 1 from journals where ledger_import_id is not null`).length).toBeGreaterThan(0);
    expect(sumOf((await buildStatements(t.env.sql, '2026-02-28')).sci.revenue)).toBe(30_000_000);
    // And nothing more comes into the agreed year.
    const again = await t.c.attempt('/api/books-import/apply', { files: [file('GL.csv', XERO_GL_FEB)], mapping: [] });
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toMatch(/was agreed at its figures/);
    await expectCleanAudit(t.env.sql, '2026-02-28');
  });
});

describe('the accountant’s own journal, then the client’s trial balance again (IFRS 5)', () => {
  const t = company();
  it('keeps the accountant’s year-end adjustment, and says it stays on top', async () => {
    const bank = await acc(t.env, 'bank');
    await t.c.bring([file('TB.csv', XERO_TB_2026)], { 'Business Bank Account': bank });
    const accum = (await t.env.sql<{ id: string }[]>`select id from accounts where code = '711'`)[0]!.id;
    await t.me.post('/api/journals', { date: '2026-02-28', description: 'Made-up extra depreciation (the accountant’s)', lines: [{ accountId: await acc(t.env, 'depreciation'), debitCents: 500_000 }, { accountId: accum, creditCents: 500_000 }] });
    const mid = await buildStatements(t.env.sql, '2026-02-28');
    const r = await t.c.bring([file('TB.csv', XERO_TB_2026)], { 'Business Bank Account': bank });
    expect(r.results[0].ownEntries).toBeGreaterThan(0);
    expect((await buildStatements(t.env.sql, '2026-02-28')).sci.profit.current).toBe(mid.sci.profit.current);
    await expectCleanAudit(t.env.sql, '2026-02-28');
  });
});

describe('taking out a ledger under a trial balance (IFRS 9)', () => {
  const t = company();
  it('is refused: the trial balance was worked out with it in the books', async () => {
    await t.c.bring([file('TB.csv', XERO_TB_2026), file('GL.csv', XERO_GL_FEB)], { 'Business Bank Account': await acc(t.env, 'bank') });
    const { imports } = await t.me.get('/api/books-import');
    const gl = imports.find((i: { kind: string }) => i.kind === 'ledger');
    const del = await t.c.attempt(`/api/books-import/${gl.id}`, {}, 'DELETE');
    expect(del.statusCode).toBe(400);
    expect(del.json().error).toMatch(/take that one out first/);
    expect(sumOf((await buildStatements(t.env.sql, '2026-02-28')).sci.revenue)).toBe(30_000_000);
    await expectCleanAudit(t.env.sql, '2026-02-28');
  });
});

describe('an account mapped to one of another kind (IFRS 4)', () => {
  const t = company();
  it('refuses an expense mapped to an asset, and doesn’t suggest one by its code alone', async () => {
    const bank = await acc(t.env, 'bank');
    const cashOnHand = (await t.env.sql<{ id: string }[]>`select id from accounts where code = '1050'`)[0]!.id;
    const read = await t.c.post('/api/books-import/read', { files: [file('TB.csv', XERO_TB_2026)] });
    const mapping = read.accounts.map((a: { code: string; name: string; accountId: string | null; type: string }) => ({ code: a.code, name: a.name, accountId: a.name === 'Business Bank Account' ? bank : a.name === 'Wages and Salaries' ? cashOnHand : a.accountId, newType: a.accountId || a.name === 'Business Bank Account' || a.name === 'Wages and Salaries' ? null : a.type }));
    const r = await t.c.attempt('/api/books-import/apply', { files: [file('TB.csv', XERO_TB_2026)], mapping });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/is on the income statement in their file/);
    // No type column (Sage, Pastel): their "1000 Sales" isn't suggested as these books' 1000 by its code.
    const SAGE_TB = `Made-up Kestrel Plumbing (Pty) Ltd\nTrial Balance as at 28 February 2026\nAccount Code,Account Name,Debit,Credit\n1000,Sales,,"300,000.00"\n8400,Bank,"300,000.00",\n`;
    const read2 = await t.c.post('/api/books-import/read', { files: [file('SageTB.csv', SAGE_TB)] });
    const ours1000 = read2.ours.find((o: { code: string }) => o.code === '1000');
    expect(read2.accounts.find((a: { name: string }) => a.name === 'Sales').accountId).not.toBe(ours1000?.id ?? 'none');
    await expectCleanAudit(t.env.sql);
  });
});

describe('depreciation that came in from the package, in the statement of cash flows (IFRS 6)', () => {
  const t = company();
  it('adds depreciation back and shows the purchase in full', async () => {
    const chosen = { Bank: await acc(t.env, 'bank'), Equipment: await acc(t.env, 'fixed_assets'), 'Accumulated Depreciation': await acc(t.env, 'accumulated_depreciation'), Depreciation: await acc(t.env, 'depreciation') };
    const T24 = tb('29 February 2024', [['Bank', '090', 'Bank', 50000], ['Share Capital', '970', 'Equity', -1000], ['Retained Earnings', '960', 'Equity', -49000]]);
    const T25 = tb('28 February 2025', [['Bank', '090', 'Bank', 60000], ['Share Capital', '970', 'Equity', -1000], ['Retained Earnings', '960', 'Equity', -49000], ['Sales', '200', 'Revenue', -30000], ['General Expenses', '429', 'Expense', 20000]]);
    // The year to Feb 2026: equipment of 20,000 bought from the bank, depreciated by 5,000.
    const T26 = tb('28 February 2026', [['Bank', '090', 'Bank', 55000], ['Equipment', '710', 'Fixed Asset', 20000], ['Accumulated Depreciation', '711', 'Fixed Asset', -5000], ['Share Capital', '970', 'Equity', -1000], ['Retained Earnings', '960', 'Equity', -59000], ['Sales', '200', 'Revenue', -40000], ['General Expenses', '429', 'Expense', 25000], ['Depreciation', '416', 'Depreciation', 5000]]);
    await t.c.bring([file('T24.csv', T24), file('T25.csv', T25), file('T26.csv', T26)], chosen);
    const s = await buildStatements(t.env.sql, '2026-02-28');
    expect(s.scf.investing.find((l) => l.key === 'ppe')?.current).toBe(-2_000_000);
    expect(s.scf.operating.find((l) => l.key === 'depreciation')?.current).toBe(500_000);
    expect(s.scf.closing.current).toBe(5_500_000);
    await expectCleanAudit(t.env.sql, '2026-02-28');
  });

  it('a depreciation journal by hand moves no cash either', async () => {
    const accum = await acc(t.env, 'accumulated_depreciation');
    await t.me.post('/api/journals', { date: '2026-02-28', description: 'Made-up impairment (the accountant’s)', lines: [{ accountId: await acc(t.env, 'depreciation'), debitCents: 100_000 }, { accountId: accum, creditCents: 100_000 }] });
    const s = await buildStatements(t.env.sql, '2026-02-28');
    expect(s.scf.investing.find((l) => l.key === 'ppe')?.current).toBe(-2_000_000);
    expect(s.scf.operating.find((l) => l.key === 'depreciation')?.current).toBe(600_000);
    await expectCleanAudit(t.env.sql, '2026-02-28');
  });
});

describe('a closed year whose figures the package has since changed (IFRS 7)', () => {
  const t = company();
  it('is refused as a prior-period matter, not put into this year as a cash flow', async () => {
    const bank = await acc(t.env, 'bank');
    await t.c.bring([file('TB26.csv', tb('28 February 2026', [['Bank', '090', 'Bank', 45000], ['Share Capital', '970', 'Equity', -1000], ['Retained Earnings', '960', 'Equity', -39000], ['Sales', '200', 'Revenue', -110000], ['General Expenses', '429', 'Expense', 105000]]))], { Bank: bank });
    await t.env.sql`update settings set lock_date = '2026-02-28'`;
    // The package later got a R2,000 expense in February 2026.
    const TB27 = tb('31 October 2026', [['Bank', '090', 'Bank', 63000], ['Share Capital', '970', 'Equity', -1000], ['Retained Earnings', '960', 'Equity', -42000], ['Sales', '200', 'Revenue', -50000], ['General Expenses', '429', 'Expense', 30000]]);
    const read = await t.c.post('/api/books-import/read', { files: [file('TB27.csv', TB27)] });
    const mapping = read.accounts.map((a: { code: string; name: string; accountId: string | null; type: string }) => ({ code: a.code, name: a.name, accountId: a.name === 'Bank' ? bank : a.accountId, newType: a.name === 'Bank' ? null : a.type }));
    const r = await t.c.attempt('/api/books-import/apply', { files: [file('TB27.csv', TB27)], mapping });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/R 2 000.00 less profit than these books, and those years are closed here/);
    expect(await t.env.sql`select 1 from journals where date = '2026-10-31'`).toHaveLength(0);
    // Open, it comes in, and the check says how much the earlier years moved.
    await t.env.sql`update settings set lock_date = null`;
    const check = await t.c.post('/api/books-import/check', { files: [file('TB27.csv', TB27)], mapping });
    expect(check.results[0].earlierYearsCents).toBe(200_000);
    await expectCleanAudit(t.env.sql, '2026-02-28');
  });
});

describe('a package whose year isn’t these books’ 12 months (IFRS 8)', () => {
  const t = company();
  it('says which year a trial balance’s income and expenses are taken for, and what it would move', async () => {
    const bank = await acc(t.env, 'bank');
    // Incorporated 1 December 2025, a first year to 28 February 2027 (Companies Act s27(2)).
    const GL = `Journal Report\nMade-up Ibis Solar (Pty) Ltd\nFor the period 1 December 2025 to 28 February 2027\nDate,Account,Account Code,Description,Reference,Debit,Credit\n15 Jan 2026,Bank,090,Made-up sale,INV-1,"10000.00",\n15 Jan 2026,Sales,200,Made-up sale,INV-1,,"10000.00"\n15 Jun 2026,Bank,090,Made-up sale,INV-2,"20000.00",\n15 Jun 2026,Sales,200,Made-up sale,INV-2,,"20000.00"\n`;
    const TB = `Trial Balance\nMade-up Ibis Solar (Pty) Ltd\nAs at 28 February 2027\nAccount,Account Code,Account Type,Debit,Credit,YTD Debit,YTD Credit\nBank,090,Bank,,,"30000.00",\nSales,200,Revenue,,,,"30000.00"\n`;
    const files = [file('TB.csv', TB), file('GL.csv', GL)];
    const read = await t.c.post('/api/books-import/read', { files });
    expect(read.files.find((f: { kind: string }) => f.kind === 'trialBalance').yearFrom).toBe('2026-03-01');
    const mapping = read.accounts.map((a: { code: string; name: string; accountId: string | null; type: string | null }) => ({ code: a.code, name: a.name, accountId: a.name === 'Bank' ? bank : a.accountId, newType: a.name === 'Bank' ? null : (a.type ?? 'income') }));
    const check = await t.c.post('/api/books-import/check', { files, mapping });
    const tbResult = check.results.find((x: { kind: string }) => x.kind === 'trialBalance');
    expect(tbResult.yearFrom).toBe('2026-03-01');
    expect(tbResult.adjustments.map((a: { name: string; cents: number }) => [a.name, a.cents])).toContainEqual(['Sales', -1_000_000]);
    // The check is undone: nothing came in.
    expect(await t.env.sql`select 1 from ledger_imports`).toHaveLength(0);
    await expectCleanAudit(t.env.sql);
  });
});

describe('an account’s kind, whichever file gives it (IFRS 11)', () => {
  const t = company();
  it('takes it from the trial balance when the ledger comes first', async () => {
    const read = await t.c.post('/api/books-import/read', { files: [file('GL.csv', XERO_GL_FEB), file('TB.csv', XERO_TB_2026)] });
    expect(read.accounts.find((a: { name: string }) => a.name === 'Sales').type).toBe('income');
  });
});
