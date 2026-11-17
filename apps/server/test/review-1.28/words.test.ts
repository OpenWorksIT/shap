/**
 * The words on screen and liability review of 1.28.0 (CPDAUDIT.md): what the screens, the PDFs and
 * the docs say about books brought in from another package. Shap reads them, doesn't check them,
 * and never says a return worked out elsewhere is Shap's or was checked by it. Each test fails on
 * the wording the review was of. Made-up books throughout.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatDate, IMPORT_NOTE, PRACTICE_CAUTION } from '@shap/shared';
import { auditBooks } from '../../src/audit/books.js';
import { readLedger, transactionsOf } from '../../src/modules/import/ledger.js';
import { renderTaxPack, taxPack } from '../../src/modules/tax-pack.js';
import { caller, expectCleanAudit, file, login, setup, type TestEnv } from './common.js';

const ROOT = join(import.meta.dirname, '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const pdfText = async (buf: Buffer) => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  let out = '';
  for (let n = 1; n <= doc.numPages; n++) out += (await (await doc.getPage(n)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ') + '\n';
  return out.replace(/\s+/g, ' ');
};
const line = (d: string, ref: string, acc: string, dr: string, cr: string) => `${d},Invoice,${ref},,Made-up,${acc},${dr},${cr}`;
const journal = (period: string, rows: string[]) => `Made-up Co\nJournal\nFrom ${period}\nDate,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit\n${rows.join('\n')}\n`;
const NEW = { Sales: 'income', 'Business Bank Account': 'asset', 'Accounts Receivable (A/R)': 'asset', 'VAT Control': 'liability' };

describe('the words on the page and in the docs (words 1, 4 to 8, 11)', () => {
  const page = read('apps/web/src/pages/BooksImport.tsx');
  const docs = read('docs/ACCOUNTANT.md');

  it('says Shap doesn’t check what’s brought in, and who OpenWorks are, before the export steps', () => {
    expect(IMPORT_NOTE).toMatch(/doesn’t check them against the package/);
    expect(IMPORT_NOTE).toMatch(/compare these books’ trial balance with the package’s before you rely on them/);
    expect(IMPORT_NOTE).toMatch(/not accountants, tax practitioners or auditors, and this is not advice/);
    expect(page.indexOf('{IMPORT_NOTE}')).toBeGreaterThan(0);
    expect(page.indexOf('{IMPORT_NOTE}')).toBeLessThan(page.indexOf('HOW.map'));
    expect(PRACTICE_CAUTION).toMatch(/books brought in from another package are for you to check against it/);
    expect(docs).not.toMatch(/Shap checks what it can|with Shap's checks/);
    expect(docs).toMatch(/test only that the books here hang together, not that the package's figures are right/);
  });

  it('claims nothing the code doesn’t do, and promises nothing', () => {
    expect(page).not.toMatch(/as their package has them|stay on top of it|figures changed in the package\)|set it the same there first|a client’s books from the package/);
    expect(page).toMatch(/If the package has them too, they’d be counted twice/);
    expect(page).toMatch(/the package’s own help/);
    expect(page).toMatch(/or the code, with a name like it/);
    expect(page).toMatch(/Shap can’t tell why/);
    expect(read('apps/web/src/pages/YearEnd.tsx')).not.toMatch(/only right once/);
    for (const text of [docs, read('CHANGELOG.md').split('## 1.27.0')[0]!]) expect(text).not.toMatch(/never left wrong|is all there/i);
    expect(read('apps/web/src/pages/Practice.tsx')).not.toMatch(/A client whose books you keep/);
  });

  it('the file reader gives dates and money as the screens do, and doesn’t blame the export as fact (words 9)', () => {
    const f = readLedger('J.csv', [
      ['Date', 'Account', 'Debit', 'Credit'],
      ['03/09/2026', 'Sales', '', '1234.50'],
      ['03/09/2026', 'Bank', '1000.00', ''],
    ]);
    expect(() => transactionsOf(f.lines)).toThrow(new RegExp(`on ${formatDate('2026-09-03')} don’t balance \\(debits and credits are R ?234[.,]50 apart\\): the export may be missing`));
    const loose = readLedger('J.csv', [
      ['Date', 'Account', 'Reference', 'Debit', 'Credit'],
      ['03/09/2026', 'Sales', 'A', '', '100.00'],
      ['03/09/2026', 'Bank', 'B', '100.00', ''],
    ]);
    expect(transactionsOf(loose.lines)[0]?.description).toBe(`Lines of ${formatDate('2026-09-03')}`);
  });
});

describe('VAT brought in in every period of the year (words 2a)', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
    await env.sql`update settings set business_type = 'company', fy_end_month = 2, vat_registered = true, vat_category = 'B', vat_number = '4123456789'`;
  });
  afterAll(async () => env.close());

  it('the books audit says there’s no VAT201 of Shap’s to check, not that it checked each period', async () => {
    const c = caller(await login(env.app, 'owner@example.co.za'));
    const days = ['15/11/2025', '15/01/2026', '15/03/2026', '15/05/2026', '15/07/2026', '15/09/2026', '10/11/2026'];
    const rows = days.flatMap((d, i) => [line(d, `INV${i}`, 'Accounts Receivable (A/R)', '115.00', ''), line(d, `INV${i}`, 'Sales', '', '100.00'), line(d, `INV${i}`, 'VAT Control', '', '15.00')]);
    await c.bring([file('Journal.csv', journal('1 November 2025 to 30 November 2026', rows))], {}, NEW);
    const items = await auditBooks(env.sql, '2026-11-17');
    const vat = items.find((i) => /VAT201/.test(i.text));
    expect(vat?.text).toMatch(/^no VAT201 of Shap’s to check: in each of the last year’s 7 periods the VAT came in from another package/);
    expect(vat?.text).not.toMatch(/moved by what Shap/);
    await expectCleanAudit(env.sql, '2026-11-17');
  });
});

describe('VAT charged and paid in one period (words 2b, 2c, 3)', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    env = await setup();
    await env.sql`update settings set business_type = 'company', fy_end_month = 2, vat_registered = true, vat_category = 'B', vat_number = '4123456789'`;
    me = await login(env.app, 'owner@example.co.za');
    const rows = [
      line('03/09/2026', 'INV1', 'Accounts Receivable (A/R)', '1150.00', ''),
      line('03/09/2026', 'INV1', 'Sales', '', '1000.00'),
      line('03/09/2026', 'INV1', 'VAT Control', '', '150.00'),
      line('25/09/2026', 'PAY1', 'VAT Control', '150.00', ''),
      line('25/09/2026', 'PAY1', 'Business Bank Account', '', '150.00'),
    ];
    await caller(me).bring([file('Journal.csv', journal('1 September 2026 to 31 October 2026', rows))], {}, NEW);
  });
  afterAll(async () => env.close());

  it('the VAT201 screen and the tax pack still say the period’s VAT came from the package, though it nets to nil', async () => {
    const v = (await me.call({ method: 'GET', url: '/api/vat/return?on=2026-10-31' })).json();
    expect(v.importedVatCents).toBe(0);
    expect(v.importedVatLines).toBe(2);
    const screen = read('apps/web/src/components/TaxForms.tsx');
    expect(screen).toMatch(/data\.importedVatLines \|\| data\.importedVatCents/);
    expect(screen).not.toMatch(/the one worked out in that package/);
    const pack = await taxPack(env.sql, '2027-02-28');
    expect(pack.vat.find((p) => p.end === '2026-10-31')?.broughtLines).toBe(2);
    const text = await pdfText(await renderTaxPack(pack));
    expect(text).toMatch(/From another package/);
    expect(text).toMatch(/the return is the business’s, and Shap doesn’t work it out or check it/);
    expect(text).not.toMatch(/the one worked out in that package/);
    // The pack says where the year's figures came from.
    expect(text).toMatch(new RegExp(`brought in from another package up to ${formatDate('2026-10-31', 'long')} \\(that package’s figures, as Shap read them\\)`));
    await expectCleanAudit(env.sql, '2026-11-17');
  });
});

describe('a trust’s distributions brought in, in the tax pack (words 3)', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
    await env.sql`update settings set business_type = 'trust', fy_end_month = 2`;
  });
  afterAll(async () => env.close());

  it('says none of them is taken off, as the screen does', async () => {
    const c = caller(await login(env.app, 'owner@example.co.za'));
    const bank = (await env.sql<{ id: string }[]>`select id from accounts where system_key = 'bank'`)[0]!.id;
    const dividends = (await env.sql<{ id: string }[]>`select id from accounts where system_key = 'dividends'`)[0]!.id;
    const tb = `Trial Balance\nMade-up Sparky Trading Trust\nAs at 31 August 2026\nAccount,Account Code,Account Type,Debit,Credit,YTD Debit,YTD Credit\nBusiness Bank Account,090,Bank,,,"200,000.00",\nSales,200,Revenue,,,,"600,000.00"\nWages and Salaries,477,Expense,,,"100,000.00",\nDistributions to beneficiaries,970,Equity,,,"300,000.00",\n`;
    await c.bring([file('TB.csv', tb)], { 'Business Bank Account': bank, 'Distributions to beneficiaries': dividends });
    const text = await pdfText(await renderTaxPack(await taxPack(env.sql, '2027-02-28')));
    expect(text).toMatch(/distributed this year\. Shap can’t tell which part is this year’s income to beneficiaries in South Africa, so none of it is taken off this estimate/);
    expect(text).toMatch(/Until then this estimate may be too high/);
    await expectCleanAudit(env.sql, '2026-08-31');
  });
});
