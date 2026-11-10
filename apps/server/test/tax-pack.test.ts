/**
 * The tax pack (Accounts → Export → Tax pack): a year's tax figures in one PDF for the accountant,
 * from the books, every page saying they're estimates to check. All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { companyTax, ESTIMATE_SHORT } from '@shap/shared';
import { taxPack } from '../src/modules/tax-pack.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from './helpers.js';

const FY = '2026-02-28';

describe('the tax pack', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;

  const pdfText = async (buf: Buffer) => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
    let out = '';
    for (let n = 1; n <= doc.numPages; n++) out += (await (await doc.getPage(n)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ') + '\n';
    return out.replace(/\s+/g, ' ');
  };

  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, companyName: 'Fictional Taxes (Pty) Ltd', vatRegistered: true, vatNumber: '4740101508', taxNumber: '0001339050', vatCategory: 'B', address: '1 Test Street, Fictional Town, 0001' }, 'PUT');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    const client = await me.post('/api/clients', { name: 'Fictional Client', address: '2 Test Road, Fictional Town' });
    const inv = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: '2025-04-10', lines: [{ category: 'labour', description: 'Work (made up)', qty: 1, unitPriceCents: 10_000_000 }] });
    await me.post(`/api/documents/${inv.id}/issue`);
    await me.post(`/api/documents/${inv.id}/receipts`, { date: '2025-04-30', amountCents: 11_500_000, sourceId: bank });
    await me.post('/api/costs', { date: '2025-05-05', description: 'Advertising (made up)', amountCents: 1_150_000, vatCents: 150_000, vatCode: 'standard', categoryId: await r.cat('Advertising'), sourceId: bank });
    await me.post('/api/assets', { name: 'Fictional drill', category: 'tools', purchaseDate: '2025-06-01', costCents: 300_000, vatCents: 45_000, lifeMonths: 36, sourceId: bank });
    // A provisional tax estimate saved, and a payment to SARS for it.
    await me.post('/api/tax-estimates', { fyEnd: FY, period: 1, asAt: '2025-08-31', lines: [{ accountId: (await env.sql<{ id: string }[]>`select id from accounts where code = '4000'`)[0]?.id ?? (await r.acc('bank')), code: '4000', name: 'Revenue', type: 'income', actualCents: 10_000_000, projectedCents: 20_000_000, priorCents: 0 }], assessedLossCents: 0, paidCents: 0, sbc: false, note: 'First period (made up)' });
    await me.post('/api/journals', { date: '2025-08-31', description: 'Provisional tax paid (made up)', lines: [{ accountId: await r.acc('income_tax_payable'), debitCents: 2_000_000 }, { accountId: await r.acc('bank'), creditCents: 2_000_000 }] });
  });
  afterAll(() => env.close());

  it('gathers the year: the profit, Shap’s estimate of the tax, what was paid, each VAT201 period and the assets', async () => {
    const t = await taxPack(env.sql, FY);
    expect(t.fy).toMatchObject({ start: '2025-03-01', end: FY });
    expect(t.incomeCents).toBe(10_000_000);
    expect(t.profitBeforeTax).toBe(t.incomeCents - t.costsCents);
    expect(t.estimate.taxCents).toBe(companyTax(t.profitBeforeTax, FY, false));
    expect(t.estimates).toHaveLength(1);
    expect(t.paidToSarsCents).toBe(2_000_000);
    // Category B: two-monthly periods, six ending in the year; the first has the invoice's VAT.
    expect(t.vat.map((v) => v.end)).toEqual(['2025-04-30', '2025-06-30', '2025-08-31', '2025-10-31', '2025-12-31', '2026-02-28']);
    expect(t.vat[0]!.fields.field4).toBe(1_500_000);
    expect(t.assets.map((a) => a.name)).toEqual(['Fictional drill']);
  });

  it('is a PDF for the accountant, every page saying it’s an estimate, and only for those who see the books', async () => {
    const res = await me.call({ method: 'GET', url: `/api/tax-pack?fyEnd=${FY}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const text = await pdfText(res.rawPayload);
    expect(text).toContain('Fictional Taxes (Pty) Ltd');
    expect(text).toContain('Tax pack for the year ended 28 February 2026');
    expect(text).toContain('VAT201s');
    expect(text).toContain('Provisional tax estimates (IRP6)');
    expect(text).toContain('not accountants, tax practitioners or auditors');
    const pages = text.split(ESTIMATE_SHORT).length - 1;
    expect(pages).toBeGreaterThanOrEqual(2);
    const site = await login(env.app, 'site@example.co.za');
    expect((await site.call({ method: 'GET', url: `/api/tax-pack?fyEnd=${FY}` })).statusCode).toBe(403);
    await expectCleanAudit(env.sql, FY);
  });
});
