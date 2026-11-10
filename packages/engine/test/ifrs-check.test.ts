/**
 * The IFRS for SMEs logic check from Shap 1.23 (Shap's docs/IFRS.md), in Shap Pocket (the same
 * accounting code): interest paid on its own line (7.14), assets bought without cash left out of
 * the cash flows and told in a note (7.18), the legal form and the edition of the standard (3.24,
 * 3.3), the public interest score, a close corporation's accounting officer's report, and what the
 * accountant is asked to look at, the year's tax among it. All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { companyTax, publicInterestScore, whatScoreMeans } from '@shap/shared';
import { buildStatements, editionFor, legalFormOf } from '../src/statements/build.js';
import { renderStatementsPdf } from '../src/statements/pdf.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from './helpers.js';

const FY = '2026-02-28';

describe('the statements, checked against IFRS for SMEs (Shap Pocket)', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let bill: { id: string };
  let bank: string;

  beforeAll(async () => {
    env = await setup();
    me = await login(env.app);
    const { settings, sources } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, companyName: 'Fictional Works (Pty) Ltd', regNumber: '2021/654321/07', vatRegistered: true, vatNumber: '4740101508', fyEndMonth: 2, address: '1 Test Street, Fictional Town, 0001', features: { ...settings.features, statements: true, bills: true } }, 'PUT');
    const r = await ref(env.sql);
    bank = sources.find((s: { name: string }) => s.name === 'Business bank').id;
    const bills = sources.find((s: { role: string | null }) => s.role === 'bills').id;
    const client = await me.post('/api/clients', { name: 'Fictional Client', address: '2 Test Road, Fictional Town' });
    const old = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: '2024-11-15', lines: [{ category: 'labour', description: 'Old work (made up)', qty: 1, unitPriceCents: 200_000 }] });
    await me.post(`/api/documents/${old.id}/issue`);
    const inv = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: '2025-05-01', lines: [{ category: 'labour', description: 'Work (made up)', qty: 1, unitPriceCents: 5_000_000 }] });
    await me.post(`/api/documents/${inv.id}/issue`);
    await me.post(`/api/documents/${inv.id}/receipts`, { date: '2025-05-20', amountCents: 5_750_000, sourceId: bank });
    await me.post('/api/costs', { date: '2025-08-31', description: 'Interest (made up)', amountCents: 45_000, vatCents: 0, vatCode: 'exempt', categoryId: await r.cat('Interest'), sourceId: bank });
    const laptop = await me.post('/api/costs', { date: '2025-06-10', description: 'Laptop (made up)', amountCents: 2_300_000, vatCents: 300_000, vatCode: 'standard', categoryId: await r.cat('Asset purchase'), sourceId: await r.src('Paid personally (owner)') });
    await me.post('/api/assets', { name: 'Laptop (made up)', category: 'computers', purchaseDate: '2025-06-10', costCents: 2_000_000, costId: laptop.id, lifeMonths: 36 });
    bill = await me.post('/api/costs', { date: '2026-01-20', description: 'Compressor (made up)', supplier: 'Fictional Tools', billNumber: 'FT-77', amountCents: 1_150_000, vatCents: 150_000, vatCode: 'standard', categoryId: await r.cat('Asset purchase'), sourceId: bills });
    await me.post('/api/assets', { name: 'Compressor (made up)', category: 'equipment', purchaseDate: '2026-01-20', costCents: 1_000_000, costId: bill.id, lifeMonths: 60 });
  });
  afterAll(() => env.close());

  it('shows interest paid on its own line, and leaves out assets bought without cash', async () => {
    const s = await buildStatements(env.sql, FY);
    const op = Object.fromEntries(s.scf.operating.map((l) => [l.key, l.current]));
    expect(op.interest_paid).toBe(-45_000);
    expect(s.scf.investing.find((l) => l.key === 'ppe')).toBeUndefined();
    expect(s.notes.find((n) => n.key === 'non_cash')!.tables[0]!.rows.map((r) => r.current)).toEqual([2_000_000, 1_000_000]);
    expect(s.checks.filter((c) => !c.ok && c.level !== 'look')).toEqual([]);
    await me.post(`/api/costs/${bill.id}/bill-payments`, { date: '2026-04-10', amountCents: 1_150_000, sourceId: bank });
    const next = await buildStatements(env.sql, '2027-02-28');
    expect(next.scf.investing.find((l) => l.key === 'ppe')).toMatchObject({ current: -1_000_000 });
  });

  it('states the legal form and the edition, and asks the accountant about the tax and old debts', async () => {
    const s = await buildStatements(env.sql, FY);
    expect(s.legalForm).toMatch(/limited liability/);
    expect(s.notes[0]!.paragraphs[0]).toContain('(2015 edition)');
    expect(editionFor('2027-01-01')).toMatch(/third edition/);
    expect(legalFormOf('sole_prop')).toMatch(/personally liable/);
    expect(s.taxEstimate!.taxCents).toBe(companyTax(s.taxEstimate!.taxableCents, FY, false));
    expect(s.checks.find((c) => c.label.startsWith('Receivables will be recovered'))!.ok).toBe(false);
    const r = await ref(env.sql);
    await me.post('/api/journals', { date: FY, description: 'Income tax for the year (made up)', lines: [{ accountId: await r.acc('income_tax'), debitCents: s.taxEstimate!.taxCents }, { accountId: await r.acc('income_tax_payable'), creditCents: s.taxEstimate!.taxCents }] });
    const after = await buildStatements(env.sql, FY);
    expect(after.checks.find((c) => c.label.startsWith('The year’s income tax'))!.ok).toBe(true);
    await expectCleanAudit(env.sql, FY);
  });

  it('works out the public interest score and what it points to', () => {
    expect(publicInterestScore({ employees: 3.4, liabilitiesCents: 120_000_000, turnoverCents: 50_000_000, holders: 2 }).score).toBe(8);
    expect(whatScoreMeans(400, 'company', { independentlyCompiled: true, ownerManaged: true }).audit).toBe(true);
    expect(whatScoreMeans(50, 'company', { independentlyCompiled: true, ownerManaged: false }).review).toBe('accounting_officer');
  });
});

describe('a close corporation (Shap Pocket)', () => {
  let env: TestEnv;
  afterAll(() => env.close());

  it('carries the accounting officer’s report and the score', async () => {
    env = await setup();
    const me = await login(env.app);
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, businessType: 'cc', companyName: 'Fictional Plumbing CC', regNumber: '2005/012345/23', fyEndMonth: 2, address: '1 Test Street, Fictional Town, 0001', features: { ...settings.features, statements: true } }, 'PUT');
    const r = await ref(env.sql);
    await me.post('/api/journals', { date: '2025-03-01', description: 'Member’s loan (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 100_000 }, { accountId: await r.acc('owner_loan'), creditCents: 100_000 }] });
    await me.post('/api/statements/details', { directors: [{ name: 'Fictional Member', role: 'Member' }] }, 'PUT');
    const s = await buildStatements(env.sql, FY);
    expect(s.legalForm).toMatch(/Close corporation/);
    expect(s.publicInterest).toMatchObject({ holders: 1, meaning: { audit: false } });
    const pdf = await renderStatementsPdf(s, {});
    expect(pdf.length).toBeGreaterThan(10_000);
    await expectCleanAudit(env.sql, FY);
  });
});
