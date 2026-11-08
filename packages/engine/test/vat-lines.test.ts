/**
 * VAT per line: standard-rated, zero-rated, exported and exempt lines on one invoice, prices
 * typed including or excluding VAT, the VAT201 split by line, bad debts on a mixed invoice, the
 * rate by date, and the VAT on costs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documentTotals, vatRateOn } from '@shap/shared';
import { monthRates } from '../src/modules/market.js';
import { vat201 } from '../src/modules/taxforms.js';
import { balance, ledgerTotal, login, ref, setup, type TestEnv } from './helpers.js';

describe('working out a document’s totals', () => {
  it('charges VAT only on the standard-rated lines, once on their total', () => {
    const t = documentTotals(
      [
        { qty: 1, unitPriceCents: 100_000, vatCode: 'standard' },
        { qty: 3, unitPriceCents: 3_333, vatCode: 'standard' },
        { qty: 2, unitPriceCents: 5_000, vatCode: 'zero' },
        { qty: 1, unitPriceCents: 20_000, vatCode: 'export' },
        { qty: 1, unitPriceCents: 7_000, vatCode: 'exempt' },
      ],
      1500,
      false,
    );
    expect(t.subtotalCents).toBe(100_000 + 9_999 + 10_000 + 20_000 + 7_000);
    expect(t.vatCents).toBe(Math.round(109_999 * 0.15)); // 16 499.85 → 16 500
    expect(t.totalCents).toBe(t.subtotalCents + t.vatCents);
    expect(t.byCode).toEqual({ standard: 109_999, zero: 10_000, export: 20_000, exempt: 7_000 });
    expect(t.lines.map((l) => l.vatCents).reduce((a, b) => a + b, 0)).toBe(t.vatCents);
  });

  it('takes prices including VAT exactly as typed, with the VAT worked out from them', () => {
    const t = documentTotals(
      [
        { qty: 3, unitPriceCents: 10_000, vatCode: 'standard' },
        { qty: 1, unitPriceCents: 999, vatCode: 'standard' },
        { qty: 1, unitPriceCents: 5_000, vatCode: 'zero' },
        { qty: 1, unitPriceCents: -1_000, vatCode: 'standard' }, // a discount
      ],
      1500,
      true,
    );
    expect(t.totalCents).toBe(30_000 + 999 + 5_000 - 1_000);
    expect(t.vatCents).toBe(Math.round((29_999 * 15) / 115)); // 3 912.91 → 3 913
    // Each line excluding VAT adds up to the total excluding VAT; the zero-rated line is as typed.
    expect(t.lines.reduce((a, l) => a + l.netCents, 0)).toBe(t.subtotalCents);
    expect(t.lines[2]!.netCents).toBe(5_000);
    expect(t.lines.reduce((a, l) => a + l.vatCents, 0)).toBe(t.vatCents);
  });

  it('has no VAT at a 0% rate (not registered)', () => {
    expect(documentTotals([{ qty: 1, unitPriceCents: 10_000, vatCode: 'standard' }], 0, true)).toMatchObject({ subtotalCents: 10_000, vatCents: 0, totalCents: 10_000 });
  });

  it('knows the standard rate on any date', () => {
    expect(vatRateOn('2018-03-31')).toBe(1400);
    expect(vatRateOn('2018-04-01')).toBe(1500);
    expect(vatRateOn('2026-11-09')).toBe(1500);
  });
});

describe('in the books', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let client: { id: string };
  let bank: string;
  let mixed: { id: string };
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app);
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4740101508', industry: 'electrician' }, 'PUT');
    client = await me.post('/api/clients', { name: 'Fictional Exports (Pty) Ltd', address: '1 Harbour Road, Gqeberha' });
    bank = await (await ref(env.sql)).src('Business bank');
  });
  afterAll(() => env.close());

  it('posts each kind of supply where it belongs, and the VAT201 splits them', async () => {
    mixed = await me.post('/api/documents', {
      kind: 'invoice',
      clientId: client.id,
      issueDate: '2026-11-03',
      lines: [
        { category: 'labour', description: 'Installation', qty: 1, unitPriceCents: 100_000, vatCode: 'standard' },
        { category: 'materials', description: 'Brown bread for the crew', qty: 2, unitPriceCents: 5_000, vatCode: 'zero' },
        { category: 'materials', description: 'Switchgear, exported', qty: 1, unitPriceCents: 20_000, vatCode: 'export' },
        { category: 'other', description: 'Interest on overdue account', qty: 1, unitPriceCents: 7_000, vatCode: 'exempt' },
      ],
    });
    await me.post(`/api/documents/${mixed.id}/issue`);
    const { doc, lines } = await me.get(`/api/documents/${mixed.id}`);
    expect(doc).toMatchObject({ subtotalCents: 137_000, vatCents: 15_000, totalCents: 152_000, pricesIncludeVat: false });
    expect(lines.map((l: { vatCode: string }) => l.vatCode)).toEqual(['standard', 'zero', 'export', 'exempt']);
    expect(await balance(env.sql, 'vat')).toBe(-15_000);
    expect(await balance(env.sql, 'receivables')).toBe(152_000);
    expect(await ledgerTotal(env.sql)).toBe(0);
    const f = await vat201(env.sql, '2026-11-01', '2026-11-30');
    expect(f).toMatchObject({ field1: 115_000, field2: 10_000, field2A: 20_000, field3: 7_000, field4: 15_000 });
  });

  it('credits a mixed invoice line by line, at the invoice’s VAT', async () => {
    const cn = await me.post(`/api/documents/${mixed.id}/credit-note`);
    const draft = await me.get(`/api/documents/${cn.id}`);
    expect(draft.lines.map((l: { vatCode: string }) => l.vatCode)).toEqual(['standard', 'zero', 'export', 'exempt']);
    // Take back only the exported switchgear.
    await me.post(`/api/documents/${cn.id}`, { ...draft.doc, creditReason: 'Switchgear returned', lines: [draft.lines[2]] }, 'PUT');
    await me.post(`/api/documents/${cn.id}/issue`);
    const f = await vat201(env.sql, '2026-11-01', '2026-11-30');
    expect(f).toMatchObject({ field1: 115_000, field2A: 0, field4: 15_000 });
    expect(await ledgerTotal(env.sql)).toBe(0);
  });

  it('takes an invoice priced including VAT at exactly what was typed', async () => {
    const inc = await me.post('/api/documents', {
      kind: 'invoice',
      clientId: client.id,
      issueDate: '2026-11-04',
      pricesIncludeVat: true,
      lines: [
        { category: 'labour', description: 'Install plug point', unit: 'point', qty: 3, unitPriceCents: 57_500, vatCode: 'standard' },
        { category: 'materials', description: 'Paraffin', qty: 1, unitPriceCents: 3_333, vatCode: 'zero' },
      ],
    });
    await me.post(`/api/documents/${inc.id}/issue`);
    const { doc, lines } = await me.get(`/api/documents/${inc.id}`);
    expect(doc).toMatchObject({ totalCents: 172_500 + 3_333, vatCents: 22_500, subtotalCents: 150_000 + 3_333, pricesIncludeVat: true });
    // Kept as typed; each line's total is without VAT (what the books post as revenue).
    expect(lines[0]).toMatchObject({ unitPriceCents: 57_500, lineTotalCents: 150_000 });
    expect(await ledgerTotal(env.sql)).toBe(0);
    // Shared anonymously without VAT: R500 a point, not R575.
    const rates = await monthRates(env.sql, 'electrician', '2026-11');
    expect(rates.find((r) => r.item === 'Install plug point')?.cents).toBe(50_000);
    const pdf = await me.call({ method: 'GET', url: `/api/documents/${inc.id}/pdf` });
    expect(pdf.headers['content-type']).toBe('application/pdf');
  });

  it('claims back only the VAT in a written-off mixed invoice', async () => {
    const before = (await vat201(env.sql, '2026-12-01', '2026-12-31')).field17;
    // R1 520 on the mixed invoice, R200 of it credited (the switchgear). Write off what's left.
    await me.post(`/api/documents/${mixed.id}/write-off`, { date: '2026-12-15', reason: 'Client closed down' });
    const { doc } = await me.get(`/api/documents/${mixed.id}`);
    const relief = (await vat201(env.sql, '2026-12-01', '2026-12-31')).field17 - before;
    expect(relief).toBe(Math.round((doc.writtenOffCents * 15_000) / 152_000));
    // The VAT account moved by the same amount the return claims.
    expect(await ledgerTotal(env.sql)).toBe(0);
  });

  it('dates a document’s VAT rate by its own date', async () => {
    const old = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: '2018-03-20', lines: [{ category: 'labour', description: 'Old job', qty: 1, unitPriceCents: 10_000 }] });
    expect((await me.get(`/api/documents/${old.id}`)).doc).toMatchObject({ vatRateBp: 1400, vatCents: 1_400 });
  });

  it('claims VAT on a cost only when it’s standard-rated', async () => {
    const r = await ref(env.sql);
    const cat = await r.cat('Parts');
    const add = (vatCode: string, vatCents: number) => me.post('/api/costs', { date: '2026-11-05', description: `A ${vatCode} cost`, amountCents: 11_500, vatCents, vatCode, categoryId: cat, sourceId: bank });
    expect((await add('standard', 1_500)).vatCents).toBe(1_500);
    expect((await add('not_claimable', 1_500)).vatCents).toBe(0); // entertainment, a car
    expect((await add('zero', 1_500)).vatCents).toBe(0);
    const c = await add('no_vat', 0);
    expect(c.vatCode).toBe('no_vat');
    expect((await vat201(env.sql, '2026-11-01', '2026-11-30')).field15).toBe(1_500);
  });
});
