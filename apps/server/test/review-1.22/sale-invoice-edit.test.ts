/**
 * From the independent review of 1.22 (it failed before the fix): a sale made with (or into) an invoice is kind 'invoice', so the ordinary invoice
 * routes treat it as one: a business not registered for VAT can change its lines (the payment
 * taken at the counter stays), and anyone can add receipts to it (a negative one pays money back
 * outside the refund/credit note path). Either way debtors show a sale as owing. Made-up data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditBooks } from '../../src/audit/books.js';
import { balance, login, setup, type TestEnv, expectCleanAudit } from '../helpers.js';

const D = '2026-07-01';

describe('a sale that became an invoice', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let till: string;
  let client: { id: string };

  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    const { settings } = await me.get('/api/reference');
    // Not registered for VAT (the default in the test setup), sales on.
    await me.post('/api/settings', { ...settings, vatRegistered: false, features: { ...settings.features, sales: true } }, 'PUT');
    till = (await env.sql<{ id: string }[]>`select id from payment_sources where till`)[0]!.id;
    client = await me.post('/api/clients', { name: 'Made-up Customer', address: '1 Made-up Road' });
  });
  afterAll(() => env.close());

  it('non-VAT: its lines can’t be changed after the counter payment', async () => {
    const s = await me.post('/api/sales', { date: D, sourceId: till, clientId: client.id, lines: [{ description: 'Made-up service', qty: 1, unitPriceCents: 20_000, category: 'labour' }] });
    expect(s.doc.kind).toBe('invoice');
    const res = await me.call({ method: 'PUT', url: `/api/documents/${s.id}`, payload: { clientId: client.id, issueDate: D, lines: [{ category: 'labour', description: 'Made-up service', qty: 1, unitPriceCents: 30_000 }] } });
    const items = await auditBooks(env.sql, '2026-07-31');
    expect(res.statusCode).toBe(400);
  });

  it('any business: no receipt can be added to it (money back is a refund, with its credit note)', async () => {
    const s = await me.post('/api/sales', { date: D, sourceId: till, lines: [{ description: 'Made-up goods', qty: 1, unitPriceCents: 10_000 }] });
    await me.post(`/api/sales/${s.id}/customer`, { clientId: client.id });
    const before = await balance(env.sql, 'receivables');
    const res = await me.call({ method: 'POST', url: `/api/documents/${s.id}/receipts`, payload: { date: D, amountCents: -4_000, sourceId: till, method: 'cash' } });
    expect(res.statusCode).toBe(400);
  });

  it('leaves the books clean', async () => {
    await expectCleanAudit(env.sql, '2026-07-31');
  });
});
