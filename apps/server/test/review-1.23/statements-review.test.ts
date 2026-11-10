/**
 * From the independent review of 1.23 (each failed before the fix): an asset's bill settled without
 * the business's cash (paid personally by the owner, or with a supplier's credit note) showed as
 * cash paid for the asset (IFRS for SMEs 7.18 leaves it out); subcontractors counted as employees
 * in the public interest score; and a reviewed close corporation's accounting officer's report said
 * no review was done. All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildStatements } from '../../src/statements/build.js';
import { renderStatementsPdf } from '../../src/statements/pdf.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

const FY = '2026-02-28';
const NEXT = '2027-02-28';
const pdfText = async (buf: Buffer) => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  let out = '';
  for (let n = 1; n <= doc.numPages; n++) out += (await (await doc.getPage(n)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ') + '\n';
  return out.replace(/\s+/g, ' ');
};
const lineOf = (ls: { key: string; current: number }[], key: string) => ls.find((l) => l.key === key)?.current ?? 0;

describe('assets’ bills settled without cash', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
    const me = await login(env.app, 'owner@example.co.za');
    const { settings, sources } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, companyName: 'Fictional Owner Pays (Pty) Ltd', features: { ...settings.features, statements: true, bills: true } }, 'PUT');
    const r = await ref(env.sql);
    const personally = await r.src('Paid personally (owner)');
    const bank = await r.src('Business bank');
    const bills = sources.find((s: { role: string | null }) => s.role === 'bills').id;
    const assets = await r.cat('Asset purchase');
    await me.post('/api/journals', { date: '2025-03-01', description: 'Shares issued (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 5_000_000 }, { accountId: await r.acc('share_capital'), creditCents: 5_000_000 }] });
    // A compressor on account in the first year; the owner pays the supplier personally the next.
    const compressor = await me.post('/api/costs', { date: '2026-01-20', description: 'Compressor (made up)', supplier: 'Fictional Tools', billNumber: 'FT-77', amountCents: 1_000_000, vatCents: 0, vatCode: 'no_vat', categoryId: assets, sourceId: bills });
    await me.post('/api/assets', { name: 'Compressor (made up)', category: 'equipment', purchaseDate: '2026-01-20', costCents: 1_000_000, costId: compressor.id, lifeMonths: 60 });
    const paid = await me.call({ method: 'POST', url: `/api/costs/${compressor.id}/bill-payments`, payload: { date: '2026-04-10', amountCents: 1_000_000, sourceId: personally } });
    expect(paid.statusCode, paid.body).toBe(200);
    // A welder on account the next year: R200 of it credited by the supplier, the rest paid from the bank.
    const welder = await me.post('/api/costs', { date: '2026-05-01', description: 'Welder (made up)', supplier: 'Fictional Tools', billNumber: 'FT-90', amountCents: 800_000, vatCents: 0, vatCode: 'no_vat', categoryId: assets, sourceId: bills });
    await me.post('/api/assets', { name: 'Welder (made up)', category: 'equipment', purchaseDate: '2026-05-01', costCents: 800_000, costId: welder.id, lifeMonths: 60 });
    const credit = await me.post('/api/costs', { date: '2026-05-05', description: 'Credit on the welder (made up)', supplier: 'Fictional Tools', billNumber: 'FT-CN1', amountCents: -20_000, vatCents: 0, vatCode: 'no_vat', categoryId: assets, sourceId: bills });
    const used = await me.call({ method: 'POST', url: `/api/costs/${welder.id}/bill-credits`, payload: { date: '2026-05-05', amountCents: 20_000, creditId: credit.id } });
    expect(used.statusCode, used.body).toBe(200);
    await me.post(`/api/costs/${welder.id}/bill-payments`, { date: '2026-06-01', amountCents: 780_000, sourceId: bank });
  });
  afterAll(() => env.close());

  it('shows only the cash paid for assets, in each year', async () => {
    const first = await buildStatements(env.sql, FY);
    expect(lineOf(first.scf.investing, 'ppe')).toBe(0);
    const next = await buildStatements(env.sql, NEXT);
    expect(next.checks.filter((c) => !c.ok && c.level !== 'look')).toEqual([]);
    // Only the R7 800 paid from the bank for the welder: the compressor was the owner's money, and R200 was a credit.
    expect(lineOf(next.scf.investing, 'ppe')).toBe(-780_000);
    expect(lineOf(next.scf.financing, 'owner_loans')).toBe(0);
    const note = next.notes.find((n) => n.key === 'non_cash')!;
    // This year the owner paid for the compressor; last year it was bought on credit. The welder,
    // bought and settled in the year (part credit, part cash), isn't in it.
    expect(note.tables[0]!.rows.map((r) => [r.label, r.current, r.prior])).toEqual([
      ['Assets paid for personally by the directors (on their loan accounts)', 1_000_000, 0],
      ['Assets bought on credit, unpaid at the year end', 0, 1_000_000],
    ]);
    await expectCleanAudit(env.sql, '2026-07-31');
  });
});

describe('subcontractors and a reviewed close corporation', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, businessType: 'cc', companyName: 'Fictional Builders CC', regNumber: '2005/012345/23', address: '1 Test Street, Fictional Town, 0001', features: { ...settings.features, statements: true, workers: true } }, 'PUT');
    const r = await ref(env.sql);
    await me.post('/api/journals', { date: '2025-03-01', description: 'Member’s contribution (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 5_000_000 }, { accountId: await r.acc('owner_loan'), creditCents: 5_000_000 }] });
    const subs = [];
    for (let i = 1; i <= 3; i++) subs.push(await me.post('/api/workers', { name: `Fictional Subbie ${i}`, kind: 'subcontractor', dayRateCents: 150_000 }));
    const casual = await me.post('/api/workers', { name: 'Fictional Casual', kind: 'casual', dayRateCents: 40_000 });
    for (let m = 0; m < 12; m++) {
      const d = new Date(Date.UTC(2025, 2 + m, 5)).toISOString().slice(0, 10);
      await me.post('/api/labour', { date: d, entries: [...subs, casual].map((s) => ({ workerId: s.id, days: 1, wageCents: s.id === casual.id ? 40_000 : 150_000, allowanceCents: 0 })) });
    }
  });
  afterAll(() => env.close());

  it('counts the casual worker as an employee, not the subcontractors', async () => {
    const s = await buildStatements(env.sql, FY);
    expect(s.publicInterest!.employeesWorkedOut).toBe(1);
  });

  it('says no review was done only when none was', async () => {
    await me.post('/api/statements/details', { directors: [{ name: 'Fictional Member', role: 'Member' }], assurance: 'independent_review', compiler: { name: 'Fictional Reviewer', qualification: 'CA(SA)' } }, 'PUT');
    const reviewed = await pdfText(await renderStatementsPdf(await buildStatements(env.sql, FY), {}));
    expect(reviewed).toContain('Report of the accounting officer');
    expect(reviewed).not.toContain('no audit or review was conducted');
    await me.post('/api/statements/details', { directors: [{ name: 'Fictional Member', role: 'Member' }], assurance: 'compiled', compiler: { name: 'Fictional Accountant', qualification: 'CA(SA)' } }, 'PUT');
    expect(await pdfText(await renderStatementsPdf(await buildStatements(env.sql, FY), {}))).toContain('no audit or review was conducted');
    await expectCleanAudit(env.sql, '2026-07-31');
  });
});
