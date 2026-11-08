/** The accountant export (layouts for Pastel, Xero, QuickBooks, Sage), reminders, and Home's tax dates and clock. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILTIN_PRESETS, type ExportOptions } from '@shap/shared';
import { taxDue } from '../src/modules/dashboard.js';
import { login, ref, setup, type TestEnv } from './helpers.js';

describe('accountant export', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let invoiceId: string;
  const exp = (dataset: string, options: Partial<ExportOptions> & { columns: ExportOptions['columns'] }, extra = '') =>
    me.call({ method: 'GET', url: `/api/accountant-export?dataset=${dataset}&from=2026-10-01&to=2026-10-31&options=${encodeURIComponent(JSON.stringify(options))}${extra}` });
  const preset = (id: string) => BUILTIN_PRESETS.find((p) => p.id === id)!.options;

  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4000000002', features: { ...settings.features, timeTracker: true } }, 'PUT');
    const r = await ref(env.sql);
    const client = await me.post('/api/clients', { name: '=Evil Client', email: 'pay@example.co.za', phone: '082 000 0000' });
    const inv = await me.post('/api/documents', {
      kind: 'invoice',
      clientId: client.id,
      issueDate: '2026-10-05',
      dueDate: '2026-10-12',
      lines: [
        { category: 'labour', description: 'Install, day 1', qty: 1, unitPriceCents: 100000 },
        { category: 'materials', description: 'Cable', qty: 2, unitPriceCents: 25000 },
      ],
    });
    invoiceId = inv.id;
    await me.post(`/api/documents/${inv.id}/issue`);
    const cn = await me.post(`/api/documents/${inv.id}/credit-note`);
    await me.post(`/api/documents/${cn.id}`, { ...(await me.get(`/api/documents/${cn.id}`)).doc, issueDate: '2026-10-08', creditReason: 'One cable returned', lines: [{ category: 'materials', description: 'Cable returned', qty: 1, unitPriceCents: 25000 }] }, 'PUT');
    await me.post(`/api/documents/${cn.id}/issue`);
    await me.post(`/api/documents/${inv.id}/receipts`, { amountCents: 50000, date: '2026-10-20', sourceId: await r.src('Business bank'), method: 'eft', reference: 'EFT 1' });
    await me.post('/api/costs', { date: '2026-10-03', description: 'Fuel', supplier: 'Engen', amountCents: 57500, vatCents: 7500, categoryId: await r.cat('Parts'), sourceId: await r.src('Business bank') });
  });
  afterAll(() => env.close());

  it('exports a journal that balances, item by item and summed by month', async () => {
    const item = await exp('journal', { columns: preset('generic-journal').columns }, '&preview=1');
    expect(item.statusCode).toBe(200);
    const p = item.json();
    const amount = p.headers.indexOf('Amount (debit +, credit −)');
    expect(p.cells.reduce((s: number, r: string[]) => s + Math.round(Number(r[amount]) * 100), 0)).toBe(0);
    expect(p.total.label).toBe('Total debits');
    const month = (await exp('journal', { ...preset('journal-monthly'), groupBy: 'month' }, '&preview=1')).json();
    const debit = month.cells.reduce((s: number, r: string[]) => s + Math.round(Number(r[5] || 0) * 100), 0);
    const credit = month.cells.reduce((s: number, r: string[]) => s + Math.round(Number(r[6] || 0) * 100), 0);
    expect(debit).toBe(credit);
    expect(month.cells.every((r: string[]) => r[0] === '31/10/2026')).toBe(true);
  });

  it('lays out sales lines for Xero, with the credit note negative and formulas defused', async () => {
    const r = await exp('invoiceLines', preset('xero-sales'));
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toContain('.csv');
    const lines = String(r.body).replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('*ContactName,EmailAddress,*InvoiceNumber,Reference,*InvoiceDate,*DueDate,*Description,*Quantity,*UnitAmount,*AccountCode,*TaxType');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^'=Evil Client,pay@example\.co\.za,/);
    expect(lines[1]).toContain('05/10/2026,12/10/2026,"Install, day 1",1,1000.00,');
    expect(lines[1]).toContain('Standard Rate Sales');
    expect(lines[3]).toContain('Cable returned,-1,250.00');
    const sum = (await exp('invoiceLines', preset('generic-invoiceLines'), '&preview=1')).json();
    expect(sum.total).toEqual({ label: 'Sales excl. VAT', cents: 125000 });
  });

  it('leaves credit notes out of money received, and ages what clients owe', async () => {
    const pay = (await exp('payments', preset('generic-payments'), '&preview=1')).json();
    expect(pay.rowCount).toBe(1);
    expect(pay.total.cents).toBe(50000);
    const age = (await exp('debtors', preset('generic-debtors'), '&preview=1')).json();
    // 1 500.00 + VAT = 1 725.00, less the credit note (287.50) and 500 paid.
    expect(age.total.cents).toBe(172500 - 28750 - 50000);
    const costs = (await exp('costs', { ...preset('sage-accounting-supplier'), decimal: ',', delimiter: ';' })).body as string;
    expect(costs).toContain('Engen;;03/10/2026;Fuel;1;500,00;');
  });

  it('refuses settings it doesn’t understand', async () => {
    const r = await me.call({ method: 'GET', url: '/api/accountant-export?dataset=journal&options=%7Bnope' });
    expect(r.statusCode).toBe(400);
  });

  it('notes reminders on the invoice', async () => {
    await me.post(`/api/documents/${invoiceId}/reminded`);
    await me.post(`/api/documents/${invoiceId}/reminded`);
    const d = await me.get(`/api/documents/${invoiceId}`);
    expect(d.doc.reminders).toBe(2);
    expect(d.doc.remindedAt).toBeTruthy();
    const dash = await me.get('/api/dashboard');
    expect(dash.overdue.map((o: { id: string }) => o.id)).toContain(invoiceId);
  });

  it('shows the running clock on Home', async () => {
    await me.post('/api/time/start', { projectId: null, note: 'Admin' });
    expect((await me.get('/api/dashboard')).timer).toMatchObject({ note: 'Admin' });
    await me.post('/api/time/stop');
    expect((await me.get('/api/dashboard')).timer).toBeNull();
  });

  it('knows which SARS dates are coming up', () => {
    const s = { vatRegistered: true, vatCategory: 'B' as const, turnoverTax: false, fyEndMonth: 2 };
    expect(taxDue(s, '2026-11-02')).toEqual([{ key: 'vat201-2026-10-31', label: 'VAT201 for Sep to Oct 26', due: '2026-11-30', to: '/accounts?tab=vat201' }]);
    expect(taxDue({ ...s, vatRegistered: false, turnoverTax: true }, '2027-02-01')).toEqual([{ key: 'tt-2027-02-26', label: 'Second turnover tax payment', due: '2027-02-26', to: '/accounts?tab=tax' }]);
    expect(taxDue({ ...s, vatRegistered: false }, '2026-11-02')).toEqual([]);
  });
});
