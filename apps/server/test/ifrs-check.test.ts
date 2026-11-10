/**
 * The IFRS for SMEs logic check of 1.23 (docs/IFRS.md): interest paid on a line of its own in the
 * statement of cash flows (7.14), assets bought without cash left out of it and told in a note
 * (7.18), the legal form and the edition of the standard (3.24, 3.3), stock written down to what it
 * will sell for (13.19, 27.2), and what the accountant is asked to look at: the year's income tax
 * (29), stock above its selling price, receivables long overdue (11.21). All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { companyTax, publicInterestScore, whatScoreMeans } from '@shap/shared';
import { buildStatements, editionFor, legalFormOf } from '../src/statements/build.js';
import { renderStatementsPdf } from '../src/statements/pdf.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from './helpers.js';

const FY = '2026-02-28';
const NEXT = '2027-02-28';

describe('the statements, checked against IFRS for SMEs', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let bank: string;
  let bills: string;
  let personally: string;
  let assetCat: string;
  let interest: string;
  let bill: { id: string };
  let item: { id: string };

  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    const { settings, sources } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, companyName: 'Fictional Works (Pty) Ltd', regNumber: '2021/654321/07', vatRegistered: true, vatNumber: '4740101508', address: '1 Test Street, Fictional Town, 0001', features: { ...settings.features, statements: true, inventory: true, bills: true } }, 'PUT');
    const r = await ref(env.sql);
    bank = await r.src('Business bank');
    personally = await r.src('Paid personally (owner)');
    bills = sources.find((s: { role: string | null }) => s.role === 'bills').id;
    assetCat = await r.cat('Asset purchase');
    interest = await r.cat('Interest');
    await me.post('/api/journals', { date: '2025-03-01', description: 'Shares issued (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 10_000 }, { accountId: await r.acc('share_capital'), creditCents: 10_000 }] });
    const client = await me.post('/api/clients', { name: 'Fictional Client', address: '2 Test Road, Fictional Town' });
    // An invoice from long ago, never paid: more than a year overdue at the year end.
    const old = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: '2024-11-15', lines: [{ category: 'labour', description: 'Old work (made up)', qty: 1, unitPriceCents: 200_000 }] });
    await me.post(`/api/documents/${old.id}/issue`);
    const inv = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: '2025-05-01', lines: [{ category: 'labour', description: 'Work (made up)', qty: 1, unitPriceCents: 5_000_000 }] });
    await me.post(`/api/documents/${inv.id}/issue`);
    await me.post(`/api/documents/${inv.id}/receipts`, { date: '2025-05-20', amountCents: 5_750_000, sourceId: bank });
    // Interest on an overdraft facility, paid from the bank.
    await me.post('/api/costs', { date: '2025-08-31', description: 'Interest (made up)', amountCents: 45_000, vatCents: 0, vatCode: 'exempt', categoryId: interest, sourceId: bank });
    // A laptop paid personally by the director, and a compressor bought on account (paid next year).
    const laptop = await me.post('/api/costs', { date: '2025-06-10', description: 'Laptop (made up)', supplier: 'Fictional Computers', amountCents: 2_300_000, vatCents: 300_000, vatCode: 'standard', categoryId: assetCat, sourceId: personally });
    await me.post('/api/assets', { name: 'Laptop (made up)', category: 'computers', purchaseDate: '2025-06-10', costCents: 2_000_000, costId: laptop.id, lifeMonths: 36 });
    bill = await me.post('/api/costs', { date: '2026-01-20', description: 'Compressor (made up)', supplier: 'Fictional Tools', billNumber: 'FT-77', amountCents: 1_150_000, vatCents: 150_000, vatCode: 'standard', categoryId: assetCat, sourceId: bills });
    await me.post('/api/assets', { name: 'Compressor (made up)', category: 'equipment', purchaseDate: '2026-01-20', costCents: 1_000_000, costId: bill.id, lifeMonths: 60 });
    // Stock bought at R100 a unit, selling at R57.50 (VAT included): above what it will sell for.
    item = await me.post('/api/items', { description: 'Fictional gadget', unitPriceCents: 5_750, priceIncludesVat: true, stocked: true });
    await me.post('/api/stock/purchases', { date: '2025-09-01', supplier: 'Fictional Supplier', reference: 'FS-9', sourceId: bank, lines: [{ itemId: item.id, qtyInvoiced: 10, unitCostCents: 10_000 }] });
  });
  afterAll(() => env.close());

  it('shows interest paid on its own line (7.14), and still ends at the cash', async () => {
    const s = await buildStatements(env.sql, FY);
    const op = Object.fromEntries(s.scf.operating.map((l) => [l.key, l.current]));
    expect(op.finance_costs_back).toBe(45_000);
    expect(op.interest_paid).toBe(-45_000);
    expect(s.checks.filter((c) => !c.ok && c.level !== 'look')).toEqual([]);
  });

  it('leaves out assets bought without cash, and tells them in a note (7.18)', async () => {
    const s = await buildStatements(env.sql, FY);
    // Neither the laptop (paid personally) nor the compressor (unpaid at the year end) was a cash outflow.
    expect(s.scf.investing.find((l) => l.key === 'ppe')).toBeUndefined();
    const note = s.notes.find((n) => n.key === 'non_cash')!;
    expect(note.tables[0]!.rows.map((r) => [r.label, r.current])).toEqual([
      ['Assets paid for personally by the directors (on their loan accounts)', 2_000_000],
      ['Assets bought on credit, unpaid at the year end', 1_000_000],
    ]);
    // Paid the next year: an investing outflow then (before VAT), and the cash still ties.
    await me.post(`/api/costs/${bill.id}/bill-payments`, { date: '2026-04-10', amountCents: 1_150_000, sourceId: bank });
    const next = await buildStatements(env.sql, NEXT);
    expect(next.scf.investing.find((l) => l.key === 'ppe')).toMatchObject({ current: -1_000_000, prior: 0 });
    expect(next.checks.find((c) => c.label.startsWith('The cash flows'))!.ok).toBe(true);
  });

  it('states the legal form and which edition of the standard (3.24, 3.3)', async () => {
    const s = await buildStatements(env.sql, FY);
    expect(s.legalForm).toMatch(/^Private company with limited liability, incorporated in South Africa/);
    expect(s.edition).toBe('the IFRS for SMEs Accounting Standard (2015 edition)');
    expect(s.notes[0]!.paragraphs[0]).toContain('in accordance with the IFRS for SMEs Accounting Standard (2015 edition)');
    expect(editionFor('2027-03-01')).toBe('the IFRS for SMEs Accounting Standard (third edition, 2025)');
    expect(legalFormOf('inc')).toMatch(/jointly and severally liable/);
    expect(legalFormOf('sole_prop')).toMatch(/personally liable/);
  });

  it('asks the accountant to look at the tax, stock above its price and old debts, without stopping the signing', async () => {
    const s = await buildStatements(env.sql, FY);
    const look = Object.fromEntries(s.checks.filter((c) => c.level === 'look').map((c) => [c.label.split(' (')[0], c]));
    expect(look['The year’s income tax is in the books']!.ok).toBe(false);
    expect(s.taxEstimate!.taxCents).toBe(companyTax(s.taxEstimate!.taxableCents, FY, false));
    expect(s.taxEstimate!.taxableCents).toBe(s.sci.profitBeforeTax.current);
    expect(look['Stock is carried at no more than it will sell for']!.detail).toMatch(/Fictional gadget/);
    expect(look['Receivables will be recovered']!.detail).toMatch(/1 invoice more than a year overdue/);
  });

  it('writes stock down to what it will sell for, into cost of sales', async () => {
    const before = await buildStatements(env.sql, FY);
    const cos = before.sci.costOfSales[0]?.current ?? 0;
    // R57.50 including VAT is R50 before it: 10 on hand at R50.
    const r = await me.post('/api/stock/write-downs', { date: FY, lines: [{ itemId: item.id, unitValueCents: 5_000, reason: 'Selling below cost (made up)' }] });
    expect(r).toEqual({ written: 1, valueCents: -50_000 });
    // Again at the same price: nothing more to write down.
    expect(await me.post('/api/stock/write-downs', { date: FY, lines: [{ itemId: item.id, unitValueCents: 5_000 }] })).toEqual({ written: 0, valueCents: 0 });
    const after = await buildStatements(env.sql, FY);
    expect(after.sci.costOfSales[0]!.current).toBe(cos - 50_000);
    expect(after.checks.find((c) => c.label.startsWith('Stock is carried'))!.ok).toBe(true);
  });

  it('books Shap’s estimate of the tax with a journal, and then it’s in the books', async () => {
    const s = await buildStatements(env.sql, FY);
    const r = await ref(env.sql);
    await me.post('/api/journals', { date: FY, description: 'Income tax for the year (Shap’s estimate)', lines: [{ accountId: await r.acc('income_tax'), debitCents: s.taxEstimate!.taxCents }, { accountId: await r.acc('income_tax_payable'), creditCents: s.taxEstimate!.taxCents }] });
    const after = await buildStatements(env.sql, FY);
    expect(after.taxEstimate).toBeNull();
    expect(after.checks.find((c) => c.label.startsWith('The year’s income tax'))!.ok).toBe(true);
    expect(after.sci.incomeTax.current).toBe(-s.taxEstimate!.taxCents);
    await expectCleanAudit(env.sql, FY);
  });
});

describe('the public interest score (Companies Regulations 26 to 29)', () => {
  it('adds the employees, a point per R1 million or part of liabilities and of turnover, and the holders', () => {
    expect(publicInterestScore({ employees: 3.4, liabilitiesCents: 120_000_000, turnoverCents: 50_000_000, holders: 2 })).toEqual({ employees: 3, liabilities: 2, turnover: 1, holders: 2, score: 8 });
    expect(publicInterestScore({ employees: 0, liabilitiesCents: 0, turnoverCents: 100_000_000, holders: 1 }).score).toBe(2);
  });

  it('says what the score points to', () => {
    const indep = { independentlyCompiled: true, ownerManaged: false };
    expect(whatScoreMeans(360, 'company', indep)).toMatchObject({ audit: true });
    expect(whatScoreMeans(120, 'company', { independentlyCompiled: false, ownerManaged: true })).toMatchObject({ audit: true });
    expect(whatScoreMeans(120, 'company', indep)).toMatchObject({ audit: false, review: 'auditor' });
    expect(whatScoreMeans(50, 'company', indep)).toMatchObject({ audit: false, review: 'accounting_officer' });
    expect(whatScoreMeans(50, 'company', { independentlyCompiled: true, ownerManaged: true })).toMatchObject({ audit: false, review: null });
    // An owner-managed company is still audited when its score says so (s30(2A) doesn't reach it).
    expect(whatScoreMeans(400, 'company', { independentlyCompiled: true, ownerManaged: true })).toMatchObject({ audit: true });
    expect(whatScoreMeans(50, 'cc', indep).summary).toMatch(/accounting officer’s report/);
  });
});

describe('a close corporation’s statements', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  afterAll(() => env.close());

  const pdfText = async (buf: Buffer) => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
    let out = '';
    for (let n = 1; n <= doc.numPages; n++) out += (await (await doc.getPage(n)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ') + '\n';
    return out.replace(/\s+/g, ' ');
  };

  it('carry the accounting officer’s report (s62), the score, and the members’ deficit to report', async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, businessType: 'cc', companyName: 'Fictional Plumbing CC', regNumber: '2005/012345/23', address: '1 Test Street, Fictional Town, 0001', features: { ...settings.features, statements: true, workers: true } }, 'PUT');
    const r = await ref(env.sql);
    // A loan from a member pays for a year of losses: liabilities exceed assets.
    await me.post('/api/journals', { date: '2025-03-01', description: 'Member’s loan (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 100_000 }, { accountId: await r.acc('owner_loan'), creditCents: 100_000 }] });
    await me.post('/api/costs', { date: '2025-04-01', description: 'Rent (made up)', amountCents: 300_000, vatCents: 0, vatCode: 'no_vat', categoryId: await r.cat('Sundry'), sourceId: await r.src('Business bank') });
    // Two helpers logged every month of the year: two employees on average.
    const w1 = await me.post('/api/workers', { name: 'Helper One (made up)', kind: 'casual', dayRateCents: 30_000 });
    const w2 = await me.post('/api/workers', { name: 'Helper Two (made up)', kind: 'casual', dayRateCents: 30_000 });
    for (let m = 0; m < 12; m++) {
      const d = new Date(Date.UTC(2025, 2 + m, 5)).toISOString().slice(0, 10);
      await me.post('/api/labour', { date: d, entries: [{ workerId: w1.id, days: 1, wageCents: 30_000, allowanceCents: 0 }, { workerId: w2.id, days: 1, wageCents: 30_000, allowanceCents: 0 }] });
    }
    await me.post('/api/statements/details', { directors: [{ name: 'Fictional Member', role: 'Member' }], compiler: { name: 'Fictional Officer', qualification: 'AGA(SA)' } }, 'PUT');
    const s = await buildStatements(env.sql, FY);
    expect(s.publicInterest).toMatchObject({ employeesWorkedOut: 2, holders: 1, parts: { employees: 2, holders: 1 } });
    expect(s.publicInterest!.meaning.summary).toMatch(/accounting officer’s report/);
    expect(s.checks.find((c) => c.label.startsWith('The members’ interest'))!.ok).toBe(false);
    expect(s.legalForm).toMatch(/Close corporation/);
    const text = await pdfText(await renderStatementsPdf(s, {}));
    expect(text).toContain('Report of the accounting officer');
    expect(text).toContain('in agreement with the accounting records, summarised in the manner required by section 58(2)(d) of the Act');
    expect(text).toContain('as required by section 62 of the Close Corporations Act 69 of 1984');
    await expectCleanAudit(env.sql, FY);
  });
});
