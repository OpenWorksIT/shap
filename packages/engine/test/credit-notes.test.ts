/** Credit notes, pro-forma invoices and payment reminders. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balance, login, setup, type TestEnv } from './helpers.js';

describe('credit notes and pro-formas', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let invoice: { id: string; number: string };
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app);
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4000000002' }, 'PUT');
    const client = await me.post('/api/clients', { name: 'Mrs Dlamini' });
    invoice = await me.post('/api/documents', {
      kind: 'invoice', clientId: client.id, issueDate: '2026-10-01',
      lines: [{ category: 'labour', description: 'Labour', qty: 2, unitPriceCents: 50000 }, { category: 'materials', description: 'Geyser', qty: 1, unitPriceCents: 300000 }],
    });
    await me.post(`/api/documents/${invoice.id}/issue`);
  });
  afterAll(() => env.close());

  it('takes back part of an invoice, with the VAT, and settles that much of it', async () => {
    const before = { rev: await balance(env.sql, 'revenue_materials'), vat: await balance(env.sql, 'vat'), deb: await balance(env.sql, 'receivables') };
    const cn = await me.post(`/api/documents/${invoice.id}/credit-note`);
    expect(cn.number).toBe('CN0001');
    const draft = await me.get(`/api/documents/${cn.id}`);
    expect(draft.doc).toMatchObject({ kind: 'credit_note', creditedInvoiceNumber: invoice.number, vatRateBp: 1500 });
    // Credit only the geyser (returned), R3 000 + VAT.
    await me.post(`/api/documents/${cn.id}`, { issueDate: '2026-10-05', creditReason: 'Geyser returned', lines: [{ category: 'materials', description: 'Geyser', qty: 1, unitPriceCents: 300000 }] }, 'PUT');
    await me.post(`/api/documents/${cn.id}/issue`);
    const inv = await me.get(`/api/documents/${invoice.id}`);
    expect(inv.doc.paidCents).toBe(345000);
    expect(inv.doc.paymentState).toBe('part_paid');
    expect(inv.creditNotes).toHaveLength(1);
    expect(await balance(env.sql, 'revenue_materials')).toBe(before.rev + 300000);
    expect(await balance(env.sql, 'vat')).toBe(before.vat + 45000);
    expect(await balance(env.sql, 'receivables')).toBe(before.deb - 345000);
    expect(await balance(env.sql, 'credit_clearing')).toBe(0);
    const tb = await me.get('/api/reports/trial-balance?date=2026-10-31');
    expect(tb.totals.differenceCents).toBe(0);
    const pdf = await me.call({ method: 'GET', url: `/api/documents/${cn.id}/pdf` });
    expect(pdf.headers['content-disposition']).toContain('Credit note CN0001');
    // Its settlement can't be deleted on its own, and the invoice can't be voided under it.
    const credit = inv.receipts.find((r: { method: string }) => r.method === 'credit');
    expect((await me.call({ method: 'DELETE', url: `/api/receipts/${credit.id}` })).statusCode).toBe(400);
    expect((await me.call({ method: 'POST', url: `/api/documents/${invoice.id}/void`, payload: { reason: 'Mistake' } })).statusCode).toBe(400);
    // More than what's owed is refused.
    const big = await me.post(`/api/documents/${invoice.id}/credit-note`);
    expect((await me.call({ method: 'POST', url: `/api/documents/${big.id}/issue` })).statusCode).toBe(400);
    await me.call({ method: 'DELETE', url: `/api/documents/${big.id}` });
    // Voiding the credit note puts it back.
    await me.post(`/api/documents/${cn.id}/void`, { reason: 'Geyser kept after all' });
    expect((await me.get(`/api/documents/${invoice.id}`)).doc.paidCents).toBe(0);
    expect(await balance(env.sql, 'receivables')).toBe(before.deb);
  });

  it('numbers pro-formas on their own and turns them into invoices', async () => {
    const pf = await me.post('/api/documents', { kind: 'quote', proforma: true, issueDate: '2026-10-10', lines: [{ category: 'labour', description: 'Deposit for DB board', qty: 1, unitPriceCents: 100000 }] });
    expect(pf.number).toBe('PF0001');
    const q = await me.post('/api/documents', { kind: 'quote', issueDate: '2026-10-10', lines: [{ category: 'labour', description: 'Quote', qty: 1, unitPriceCents: 100000 }] });
    expect(q.number).not.toMatch(/^PF/);
    const pdf = await me.call({ method: 'GET', url: `/api/documents/${pf.id}/pdf` });
    expect(pdf.headers['content-disposition']).toContain('Pro-forma invoice PF0001');
    const inv = await me.post(`/api/documents/${pf.id}/convert`);
    expect((await me.get(`/api/documents/${inv.id}`)).doc.kind).toBe('invoice');
  });

  it('lists overdue invoices for reminders and remembers when one was sent', async () => {
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, features: { ...settings.features, reminders: true } }, 'PUT');
    const home = await me.get('/api/dashboard');
    const row = home.overdue.find((r: { id: string }) => r.id === invoice.id);
    expect(row).toMatchObject({ clientName: 'Mrs Dlamini', reminders: 0 });
    await me.post(`/api/documents/${invoice.id}/reminded`);
    expect((await me.get('/api/dashboard')).overdue.find((r: { id: string }) => r.id === invoice.id).reminders).toBe(1);
  });
});
