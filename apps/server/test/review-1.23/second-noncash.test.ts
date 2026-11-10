/**
 * From the second review of 1.23, of the fixes (it failed before this fix): an asset's bill settled partly in cash, partly by the owner,
 * the rest still owed, with VAT: the non-cash adjustments are rounded one by one, so the statement
 * of cash flows misses the cash by a cent and the statements can't be signed. And a supplier's credit
 * note on another cost type, taken off an asset's bill, shows in the note as "bought on credit,
 * unpaid at the year end" after the bill is settled. All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildStatements } from '../../src/statements/build.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

const FY = '2026-02-28';
const cashCheck = (s: Awaited<ReturnType<typeof buildStatements>>) => s.checks.find((c) => c.label === 'The cash flows add up to the change in cash')!;

describe('an asset bill: part cash, part the owner, part still owed (VAT)', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
    const me = await login(env.app, 'owner@example.co.za');
    const { settings, sources } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4000000002', companyName: 'Fictional Rounding (Pty) Ltd', features: { ...settings.features, statements: true, bills: true } }, 'PUT');
    const r = await ref(env.sql);
    const personally = await r.src('Paid personally (owner)');
    const bank = await r.src('Business bank');
    const bills = sources.find((s: { role: string | null }) => s.role === 'bills').id;
    await me.post('/api/journals', { date: '2025-03-01', description: 'Shares issued (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 5_000_000 }, { accountId: await r.acc('share_capital'), creditCents: 5_000_000 }] });
    // R115.00 with R15.00 VAT: R54.94 from the bank, R10.02 by the owner personally, R50.04 owed at the year end.
    const bill = await me.post('/api/costs', { date: '2025-06-01', description: 'Drill (made up)', supplier: 'Fictional Tools', billNumber: 'FT-1', amountCents: 11_500, vatCents: 1_500, vatCode: 'standard', categoryId: await r.cat('Asset purchase'), sourceId: bills });
    await me.post('/api/assets', { name: 'Drill (made up)', category: 'tools', purchaseDate: '2025-06-01', costCents: 10_000, costId: bill.id, lifeMonths: 36 });
    await me.post(`/api/costs/${bill.id}/bill-payments`, { date: '2025-07-01', amountCents: 5_494, sourceId: bank });
    await me.post(`/api/costs/${bill.id}/bill-payments`, { date: '2025-07-02', amountCents: 1_002, sourceId: personally });
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('ends the statement of cash flows at the cash', async () => {
    const s = await buildStatements(env.sql, FY);
    expect(s.scf.netChange.current).toBe(s.scf.closing.current - s.scf.opening.current);
    expect(cashCheck(s).ok).toBe(true);
  });
});

describe('a supplier’s credit note on another cost type, taken off an asset’s bill', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
    const me = await login(env.app, 'owner@example.co.za');
    const { settings, sources } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, companyName: 'Fictional Credit (Pty) Ltd', features: { ...settings.features, statements: true, bills: true } }, 'PUT');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    const bills = sources.find((s: { role: string | null }) => s.role === 'bills').id;
    const other = (await env.sql<{ id: string }[]>`select k.id from cost_categories k join accounts a on a.id = k.account_id where a.type = 'expense' and k.active order by k.sort limit 1`)[0]!.id;
    await me.post('/api/journals', { date: '2025-03-01', description: 'Shares issued (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 5_000_000 }, { accountId: await r.acc('share_capital'), creditCents: 5_000_000 }] });
    const bill = await me.post('/api/costs', { date: '2025-05-01', description: 'Welder (made up)', supplier: 'Fictional Tools', billNumber: 'FT-90', amountCents: 800_000, vatCents: 0, vatCode: 'no_vat', categoryId: await r.cat('Asset purchase'), sourceId: bills });
    await me.post('/api/assets', { name: 'Welder (made up)', category: 'equipment', purchaseDate: '2025-05-01', costCents: 800_000, costId: bill.id, lifeMonths: 60 });
    const credit = await me.post('/api/costs', { date: '2025-05-05', description: 'Settlement discount (made up)', supplier: 'Fictional Tools', billNumber: 'FT-CN1', amountCents: -20_000, vatCents: 0, vatCode: 'no_vat', categoryId: other, sourceId: bills });
    const used = await me.call({ method: 'POST', url: `/api/costs/${bill.id}/bill-credits`, payload: { date: '2025-05-05', amountCents: 20_000, creditId: credit.id } });
    expect(used.statusCode, used.body).toBe(200);
    await me.post(`/api/costs/${bill.id}/bill-payments`, { date: '2025-06-01', amountCents: 780_000, sourceId: bank });
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('says nothing was bought on credit and unpaid: the bill is settled', async () => {
    const s = await buildStatements(env.sql, FY);
    expect(cashCheck(s).ok).toBe(true);
    const note = s.notes.find((n) => n.key === 'non_cash');
    expect(note?.tables[0]!.rows ?? []).toEqual([]);
  });
});

describe('a supplier’s credit note on an asset, the year after the bill', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
    const me = await login(env.app, 'owner@example.co.za');
    const { settings, sources } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, companyName: 'Fictional Later Credit (Pty) Ltd', features: { ...settings.features, statements: true, bills: true } }, 'PUT');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    const bills = sources.find((s: { role: string | null }) => s.role === 'bills').id;
    const assets = await r.cat('Asset purchase');
    await me.post('/api/journals', { date: '2024-03-01', description: 'Shares issued (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 5_000_000 }, { accountId: await r.acc('share_capital'), creditCents: 5_000_000 }] });
    const bill = await me.post('/api/costs', { date: '2025-01-10', description: 'Welder (made up)', supplier: 'Fictional Tools', billNumber: 'FT-90', amountCents: 800_000, vatCents: 0, vatCode: 'no_vat', categoryId: assets, sourceId: bills });
    await me.post('/api/assets', { name: 'Welder (made up)', category: 'equipment', purchaseDate: '2025-01-10', costCents: 800_000, costId: bill.id, lifeMonths: 60 });
    const credit = await me.post('/api/costs', { date: '2025-04-05', description: 'Credit on the welder (made up)', supplier: 'Fictional Tools', billNumber: 'FT-CN1', amountCents: -20_000, vatCents: 0, vatCode: 'no_vat', categoryId: assets, sourceId: bills });
    const used = await me.call({ method: 'POST', url: `/api/costs/${bill.id}/bill-credits`, payload: { date: '2025-04-05', amountCents: 20_000, creditId: credit.id } });
    expect(used.statusCode, used.body).toBe(200);
    await me.post(`/api/costs/${bill.id}/bill-payments`, { date: '2025-06-01', amountCents: 780_000, sourceId: bank });
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('has no negative "bought on credit" in the note', async () => {
    const s = await buildStatements(env.sql, FY);
    expect(cashCheck(s).ok).toBe(true);
    const rows = s.notes.find((n) => n.key === 'non_cash')?.tables[0]!.rows ?? [];
    expect(rows.filter((x) => (x.current ?? 0) < 0 || (x.prior ?? 0) < 0)).toEqual([]);
  });
});
