/**
 * The fixes from Shap 1.22's accountant bot run that Shap Pocket shares (the same accounting code):
 * goods back on an invoice still owed, a sale's slip and paid invoice, a closed year staying
 * closed, suppliers' credits taken off their bills, reports up to a past day, the statements'
 * words and lines. All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildStatements } from '../src/statements/build.js';
import { balance, expectCleanAudit, ledgerTotal, login, setup, type TestEnv } from './helpers.js';

const D = '2025-06-02';

describe('Shap 1.22’s review fixes, in Shap Pocket', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let till: string;
  let bank: string;
  let bills: string;
  let client: { id: string };

  beforeAll(async () => {
    env = await setup();
    me = await login(env.app);
    const { settings, sources } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4740101508', fyEndMonth: 2, features: { ...settings.features, sales: true, bills: true, statements: true } }, 'PUT');
    till = (await env.sql<{ id: string }[]>`select id from payment_sources where till`)[0]!.id;
    bank = sources.find((s: { name: string }) => s.name === 'Business bank').id;
    bills = (await me.get('/api/reference')).sources.find((s: { role: string | null }) => s.role === 'bills').id;
    client = await me.post('/api/clients', { name: 'Fictional Builders', address: '3 Test Road, Fictional Town' });
  });
  afterAll(() => env.close());

  it('takes goods back on an invoice still owed off what’s owed, never more', async () => {
    const inv = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: D, lines: [{ category: 'materials', description: 'Taps (made up)', qty: 2, unitPriceCents: 10_000 }] });
    await me.post(`/api/documents/${inv.id}/issue`);
    const sale = await me.get(`/api/sales/${inv.id}`);
    const r = await me.post(`/api/documents/${inv.id}/refund`, { date: D, money: 'off_owing', reason: 'One came back (made up)', lines: [{ lineId: sale.lines[0].id, qty: 1 }] });
    expect(r.amountCents).toBe(11_500);
    expect(await balance(env.sql, 'receivables')).toBe(11_500);
    const more = await me.call({ method: 'POST', url: `/api/documents/${inv.id}/refund`, payload: { date: D, money: 'paid_out', sourceId: bank, reason: 'Again', lines: [{ lineId: sale.lines[0].id, qty: 1 }] } });
    expect(more.statusCode).toBe(400);
  });

  it('makes a sale’s slip a slip: no terms, named a sale, never voided or paid again', async () => {
    const s = await me.post('/api/sales', { date: D, sourceId: till, lines: [{ description: 'Key cut (made up)', qty: 1, unitPriceCents: 2_500, category: 'other' }] });
    expect(s.doc.terms).toBe('');
    expect((await me.call({ method: 'POST', url: `/api/documents/${s.id}/void`, payload: { reason: 'x' } })).statusCode).toBe(400);
    expect((await me.call({ method: 'POST', url: `/api/documents/${s.id}/receipts`, payload: { date: D, amountCents: 100, sourceId: bank } })).statusCode).toBe(400);
    const inv = await me.post(`/api/sales/${s.id}/invoice`, { clientId: client.id });
    expect(inv.doc.terms).toMatch(/Paid in full/);
  });

  it('takes a supplier’s credit note on account off their bill', async () => {
    const cat = (await env.sql<{ id: string }[]>`select id from cost_categories where kind = 'materials' limit 1`)[0]!.id;
    const bill = await me.post('/api/costs', { date: D, description: 'Pipes (made up)', supplier: 'Fictional Plumbing', billNumber: 'FP-1', amountCents: 23_000, vatCents: 3_000, vatCode: 'standard', categoryId: cat, sourceId: bills });
    const credit = await me.post('/api/costs', { date: D, description: 'Credit for a cracked pipe (made up)', supplier: 'Fictional Plumbing', billNumber: 'FP-CN1', amountCents: -5_750, vatCents: -750, vatCode: 'standard', categoryId: cat, sourceId: bills });
    expect((await me.get('/api/bills?state=credits')).map((c: { id: string }) => c.id)).toEqual([credit.id]);
    await me.post(`/api/costs/${bill.id}/bill-credits`, { date: D, creditId: credit.id, amountCents: 5_750 });
    expect((await me.get('/api/bills?state=open')).find((b: { id: string }) => b.id === bill.id).owingCents).toBe(23_000 - 5_750);
    expect(await me.get('/api/bills?state=credits')).toEqual([]);
    expect(await ledgerTotal(env.sql)).toBe(0);
    await expectCleanAudit(env.sql, D);
  });

  it('reports up to a past day from the start of that day’s financial year', async () => {
    expect((await me.call({ method: 'GET', url: '/api/reports/income-statement?to=2026-02-28' })).statusCode).toBe(200);
  });

  it('puts other lines in revenue and the owner’s loan under current liabilities', async () => {
    const s = await buildStatements(env.sql, '2026-02-28');
    expect(s.checks.filter((c) => !c.ok)).toEqual([]);
    expect(s.sci.otherIncome).toEqual([]);
    const [acc] = await env.sql<{ statementLine: string }[]>`select statement_line from accounts where system_key = 'owner_loan'`;
    expect(acc!.statementLine).toBe('shareholder_loans_current');
  });

  it('keeps an approved year closed until the statements are reopened', async () => {
    const walkIn = await me.post('/api/sales', { date: D, sourceId: till, lines: [{ description: 'Key cut (made up)', qty: 1, unitPriceCents: 2_500 }] });
    const file = await me.post('/api/attachments', { filename: 'report.pdf', mime: 'application/pdf', dataBase64: Buffer.from('%PDF-1.4\n% made up\n').toString('base64') });
    await me.post('/api/statements/2026-02-28/compiler-report', { attachmentId: file.id, compilerName: 'Fictional Accountant', date: '2026-04-01' });
    await me.post('/api/statements/2026-02-28/approve', { name: 'Fictional Owner', date: '2026-04-02' });
    const now = (await me.get('/api/reference')).settings;
    expect((await me.call({ method: 'PUT', url: '/api/settings', payload: { ...now, lockDate: null } })).statusCode).toBe(400);
    expect((await me.call({ method: 'POST', url: `/api/sales/${walkIn.id}/invoice`, payload: { clientId: client.id } })).statusCode).toBe(400);
    await me.post('/api/statements/2026-02-28/reopen', { reason: 'A missed invoice (made up)' });
    expect((await me.call({ method: 'PUT', url: '/api/settings', payload: { ...now, lockDate: null } })).statusCode).toBe(200);
  });
});

describe('from the independent review of 1.22, in Shap Pocket', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  afterAll(() => env.close());

  it('a sale made an invoice stays as sold: its lines don’t change and nothing more is paid on it', async () => {
    env = await setup();
    me = await login(env.app);
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, vatRegistered: false, vatNumber: '', features: { ...settings.features, sales: true } }, 'PUT');
    const till = (await env.sql<{ id: string }[]>`select id from payment_sources where till`)[0]!.id;
    const client = await me.post('/api/clients', { name: 'Made-up Customer', address: '1 Made-up Road' });
    const s = await me.post('/api/sales', { date: D, sourceId: till, clientId: client.id, lines: [{ description: 'Made-up service', qty: 1, unitPriceCents: 20_000, category: 'labour' }] });
    const put = await me.call({ method: 'PUT', url: `/api/documents/${s.id}`, payload: { clientId: client.id, issueDate: D, lines: [{ category: 'labour', description: 'Made-up service', qty: 1, unitPriceCents: 30_000 }] } });
    expect(put.statusCode).toBe(400);
    const neg = await me.call({ method: 'POST', url: `/api/documents/${s.id}/receipts`, payload: { date: D, amountCents: -4_000, sourceId: till, method: 'cash' } });
    expect(neg.statusCode).toBe(400);
    expect(await balance(env.sql, 'receivables')).toBe(0);
    await expectCleanAudit(env.sql, D);
  });

  it('refuses a discount bigger than what it discounts in its VAT class', async () => {
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4740101508' }, 'PUT');
    const till = (await env.sql<{ id: string }[]>`select id from payment_sources where till`)[0]!.id;
    const res = await me.call({
      method: 'POST',
      url: '/api/sales',
      payload: { date: D, sourceId: till, lines: [
        { description: 'Brown bread x 100 (made up)', qty: 100, unitPriceCents: 2_000, vatCode: 'zero' },
        { description: 'Discount (made up)', qty: 1, unitPriceCents: -1_150_00, vatCode: 'standard' },
      ] },
    });
    expect(res.statusCode).toBe(400);
    await expectCleanAudit(env.sql, D);
  });
});

