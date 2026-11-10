/**
 * From the independent review of 1.22 (it failed before the fix): two "issue" requests for the same draft invoice (a double tap) both pass the
 * draft check and both move stock out; two write-offs of the same claim both write off all of it.
 * Made-up data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditBooks } from '../../src/audit/books.js';
import { balance, login, ref, setup, type TestEnv, expectCleanAudit } from '../helpers.js';

const D = '2026-07-01';

describe('races', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let bank: string;
  let item: { id: string };

  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4740101508', features: { ...settings.features, inventory: true } }, 'PUT');
    bank = await (await ref(env.sql)).src('Business bank');
    item = await me.post('/api/items', { description: 'Made-up widget', unitPriceCents: 5_000, priceIncludesVat: true, stocked: true });
    await me.post('/api/stock/purchases', { date: D, supplier: 'Made-up Supplier', reference: 'MU-1', sourceId: bank, lines: [{ itemId: item.id, qtyInvoiced: 100, unitCostCents: 1_000 }] });
  });
  afterAll(() => env.close());

  it('issuing the same invoice twice at once moves its stock out once', async () => {
    const client = await me.post('/api/clients', { name: 'Made-up Client', address: '1 Made-up Road' });
    let doubled = 0;
    for (let attempt = 0; attempt < 10 && !doubled; attempt++) {
      const inv = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: D, lines: [{ category: 'goods', itemId: item.id, description: 'Made-up widget', qty: 1, unitPriceCents: 5_000 }] });
      const [a, b] = await Promise.all([me.call({ method: 'POST', url: `/api/documents/${inv.id}/issue` }), me.call({ method: 'POST', url: `/api/documents/${inv.id}/issue` })]);
      const [m] = await env.sql<{ n: number }[]>`select count(*)::int as n from stock_moves where document_id = ${inv.id}`;
      if (m!.n > 1) doubled = m!.n;
    }
    expect(doubled).toBe(0);
  });

  it('writing the same claim off twice at once writes it off once', async () => {
    let doubled = 0;
    for (let attempt = 0; attempt < 10 && !doubled; attempt++) {
      const r = await me.post('/api/stock/returns', { date: D, supplier: 'Made-up Supplier', itemId: item.id, qty: 0.1, reason: 'Wrong item (made up)' });
      const body = { date: D, reason: 'Supplier closed (made up)' };
      const [a, b] = await Promise.all([me.call({ method: 'POST', url: `/api/stock/claims/${r.claimId}/write-off`, payload: body }), me.call({ method: 'POST', url: `/api/stock/claims/${r.claimId}/write-off`, payload: body })]);
      const [s] = await env.sql<{ n: number }[]>`select count(*)::int as n from stock_claim_settlements where claim_id = ${r.claimId}`;
      if (s!.n > 1) doubled = s!.n;
    }
    expect(doubled).toBe(0);
  });

  it('leaves the books clean', async () => {
    await expectCleanAudit(env.sql, '2026-07-31');
  });
});
