/** The tax pack from Shap 1.23, in Shap Pocket: a year's tax figures in one PDF for the accountant. All data made up. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { companyTax } from '@shap/shared';
import { taxPack } from '../src/modules/tax-pack.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from './helpers.js';

const FY = '2026-02-28';

describe('the tax pack (Shap Pocket)', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app);
    const { settings, sources } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, companyName: 'Fictional Taxes (Pty) Ltd', vatRegistered: true, vatNumber: '4740101508', vatCategory: 'B', fyEndMonth: 2, address: '1 Test Street, Fictional Town, 0001' }, 'PUT');
    const bank = sources.find((s: { name: string }) => s.name === 'Business bank').id;
    const client = await me.post('/api/clients', { name: 'Fictional Client', address: '2 Test Road, Fictional Town' });
    const inv = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: '2025-04-10', lines: [{ category: 'labour', description: 'Work (made up)', qty: 1, unitPriceCents: 10_000_000 }] });
    await me.post(`/api/documents/${inv.id}/issue`);
    await me.post(`/api/documents/${inv.id}/receipts`, { date: '2025-04-30', amountCents: 11_500_000, sourceId: bank });
    const r = await ref(env.sql);
    await me.post('/api/journals', { date: '2025-08-31', description: 'Provisional tax paid (made up)', lines: [{ accountId: await r.acc('income_tax_payable'), debitCents: 2_000_000 }, { accountId: await r.acc('bank'), creditCents: 2_000_000 }] });
  });
  afterAll(() => env.close());

  it('gathers the year and makes a PDF', async () => {
    const t = await taxPack(env.sql, FY);
    expect(t.incomeCents).toBe(10_000_000);
    expect(t.estimate.taxCents).toBe(companyTax(t.profitBeforeTax, FY, false));
    expect(t.paidToSarsCents).toBe(2_000_000);
    expect(t.vat).toHaveLength(6);
    const res = await me.call({ method: 'GET', url: `/api/tax-pack?fyEnd=${FY}` });
    expect(res.statusCode).toBe(200);
    expect(new TextDecoder().decode(res.rawPayload.slice(0, 5))).toBe('%PDF-');
    await expectCleanAudit(env.sql, FY);
  });
});
