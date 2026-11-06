/**
 * November 2026 accounting review: what's in the books can't be counted twice through the bank,
 * a closed year can't be rewritten from outside it, and VAT on the business's own assets.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balance, ledgerTotal, login, ref, setup, type TestEnv } from './helpers.js';

const csvOf = (rows: [string, string, string, string][]) => ['Transaction Date,Description,Money In,Money Out', ...rows.map((r) => r.join(','))].join('\n');

describe('the bank and what’s already in the books', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let r: Awaited<ReturnType<typeof ref>>;
  let bank: string;
  let savings: string;
  let cash: string;
  let bills: string;
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    r = await ref(env.sql);
    const { settings, sources } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4000000000', features: { ...settings.features, bills: true } }, 'PUT');
    bank = await r.src('Business bank');
    cash = await r.src('Cash');
    bills = (await me.get('/api/reference')).sources.find((s: { role: string | null }) => s.role === 'bills').id;
    void sources;
    const acc = await me.post('/api/accounts', { code: '1010', name: 'Savings account', type: 'asset' });
    savings = (await me.post('/api/sources', { name: 'Savings', kind: 'bank', accountId: acc.id })).id;
  });
  afterAll(() => env.close());

  const lineOf = async (sourceId: string, description: string) => {
    const rec = await me.get(`/api/bank/recon?sourceId=${sourceId}`);
    return rec.lines.find((l: { description: string }) => l.description === description);
  };

  it('matches a paid bill’s payment, never the bill itself', async () => {
    const bill = await me.post('/api/costs', { date: '2026-09-01', description: 'Roof sheets', supplier: 'Fictional Roofing', amountCents: 345000, vatCents: 45000, categoryId: await r.cat('Parts'), sourceId: bills, billNumber: 'RF-9' });
    await me.post(`/api/costs/${bill.id}/bill-payments`, { date: '2026-09-04', amountCents: 345000, sourceId: bank });
    await me.post('/api/bank/statements', { sourceId: bank, csv: csvOf([['04/09/2026', 'FICTIONAL ROOFING RF-9', '', '3450.00']]) });
    const line = await lineOf(bank, 'FICTIONAL ROOFING RF-9');
    const c = await me.get(`/api/bank/lines/${line.id}/candidates`);
    expect(c.costs.find((x: { id: string }) => x.id === bill.id)).toBeUndefined();
    const pay = c.others.find((x: { kind: string }) => x.kind === 'bill_payment');
    expect(pay).toMatchObject({ amountCents: 345000 });
    // Matching the bill itself is refused; its payment is what the line is.
    expect((await me.call({ method: 'POST', url: `/api/bank/lines/${line.id}/match`, payload: { items: [{ kind: 'cost', id: bill.id }] } })).statusCode).toBe(400);
    await me.post(`/api/bank/lines/${line.id}/match`, { items: [{ kind: 'bill_payment', id: pay.id }] });
    expect(await balance(env.sql, 'bank')).toBe(-345000);
    expect(await balance(env.sql, 'payables')).toBe(0);
    expect(await ledgerTotal(env.sql)).toBe(0);
  });

  it('ticks off the second side of a transfer against the journal already there', async () => {
    await me.post('/api/bank/statements', { sourceId: bank, csv: csvOf([['10/09/2026', 'TRANSFER TO SAVINGS', '', '1000.00']]) });
    await me.post('/api/bank/statements', { sourceId: savings, csv: csvOf([['10/09/2026', 'TRANSFER FROM BUSINESS ACC', '1000.00', '']]) });
    const out = await lineOf(bank, 'TRANSFER TO SAVINGS');
    await me.post(`/api/bank/lines/${out.id}/transfer`, { otherSourceId: savings });
    const into = await lineOf(savings, 'TRANSFER FROM BUSINESS ACC');
    // The journal is offered on the savings statement too, and transferring finds it.
    expect((await me.get(`/api/bank/lines/${into.id}/candidates`)).others.some((x: { kind: string }) => x.kind === 'journal')).toBe(true);
    const res = await me.post(`/api/bank/lines/${into.id}/transfer`, { otherSourceId: bank });
    expect(res.matched).toBeTruthy();
    const [{ n }] = (await env.sql<{ n: number }[]>`select count(*)::int as n from journals where description like 'Transfer%'`) as unknown as [{ n: number }];
    expect(n).toBe(1);
    const [s] = await env.sql<{ b: number }[]>`select coalesce(sum(l.amount_cents), 0)::bigint as b from ledger l join payment_sources p on p.account_id = l.account_id where p.id = ${savings}`;
    expect(Number(s!.b)).toBe(100000);
    expect(await balance(env.sql, 'bank')).toBe(-345000 - 100000);
  });

  it('moves a payment recorded into another account onto the statement’s, and back on unmatching', async () => {
    const inv = await me.post('/api/documents', { kind: 'invoice', issueDate: '2026-09-12', lines: [{ category: 'labour', description: 'Work', qty: 1, unitPriceCents: 100000 }] });
    await me.post(`/api/documents/${inv.id}/issue`);
    const doc = await me.post(`/api/documents/${inv.id}/receipts`, { date: '2026-09-15', amountCents: 115000, sourceId: cash });
    const receipt = doc.receipts[0];
    await me.post('/api/bank/statements', { sourceId: bank, csv: csvOf([['15/09/2026', 'EFT FROM CLIENT', '1150.00', '']]) });
    const line = await lineOf(bank, 'EFT FROM CLIENT');
    const before = await balance(env.sql, 'bank');
    await me.post(`/api/bank/lines/${line.id}/match`, { items: [{ kind: 'receipt', id: receipt.id }] });
    expect(await balance(env.sql, 'bank')).toBe(before + 115000);
    await me.post(`/api/bank/lines/${line.id}/match`, {}, 'DELETE');
    expect(await balance(env.sql, 'bank')).toBe(before);
    const [{ sourceId }] = (await env.sql<{ sourceId: string }[]>`select source_id from receipts where id = ${receipt.id}`) as unknown as [{ sourceId: string }];
    expect(sourceId).toBe(cash);
  });
});

describe('guards on costs, bills and assets', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let r: Awaited<ReturnType<typeof ref>>;
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    r = await ref(env.sql);
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4000000000', features: { ...settings.features, bills: true } }, 'PUT');
  });
  afterAll(() => env.close());

  it('takes VAT only as much as an amount can hold, the same way round, and none on personal spending', async () => {
    const base = { date: '2026-09-01', description: 'Thing', amountCents: 1000, categoryId: await r.cat('Sundry'), sourceId: await r.src('Business bank') };
    expect((await me.call({ method: 'POST', url: '/api/costs', payload: { ...base, vatCents: 5000 } })).statusCode).toBe(400);
    expect((await me.call({ method: 'POST', url: '/api/costs', payload: { ...base, amountCents: -1150, vatCents: 150 } })).statusCode).toBe(400);
    expect((await me.post('/api/costs', { ...base, amountCents: 1150, vatCents: 150 })).vatCents).toBe(150);
    expect((await me.post('/api/costs', { ...base, amountCents: 1150, vatCents: 150, categoryId: await r.cat('Personal (owner)') })).vatCents).toBe(0);
  });

  it('keeps a paid bill and its payments together', async () => {
    const { sources } = await me.get('/api/reference');
    const bills = sources.find((s: { role: string | null }) => s.role === 'bills').id;
    const bill = await me.post('/api/costs', { date: '2026-09-02', description: 'Drill', amountCents: 115000, vatCents: 15000, categoryId: await r.cat('Tool'), sourceId: bills, billNumber: 'D-1' });
    await me.post(`/api/costs/${bill.id}/bill-payments`, { date: '2026-09-05', amountCents: 50000, sourceId: await r.src('Business bank') });
    expect((await me.call({ method: 'DELETE', url: `/api/costs/${bill.id}` })).statusCode).toBe(400);
    const edit = { date: '2026-09-02', description: 'Drill', amountCents: 30000, vatCents: 0, categoryId: await r.cat('Tool'), sourceId: bills };
    expect((await me.call({ method: 'PUT', url: `/api/costs/${bill.id}`, payload: edit })).statusCode).toBe(400);
    expect((await me.call({ method: 'PUT', url: `/api/costs/${bill.id}`, payload: { ...edit, amountCents: 115000, sourceId: await r.src('Business bank') } })).statusCode).toBe(400);
    expect(await balance(env.sql, 'payables')).toBe(-65000);
  });

  it('keeps an asset’s cost in step with the cost that bought it, and won’t lose it with the cost', async () => {
    const bank = await r.src('Business bank');
    const c = await me.post('/api/costs', { date: '2026-09-03', description: 'Laptop', amountCents: 1150000, vatCents: 150000, categoryId: await r.cat('Asset purchase'), sourceId: bank });
    const a = await me.post('/api/assets', { name: 'Laptop', category: 'computers', purchaseDate: '2026-09-03', costCents: 1, costId: c.id, lifeMonths: 36 });
    expect(Number(a.costCents)).toBe(1000000);
    await me.post(`/api/costs/${c.id}`, { date: '2026-09-03', description: 'Laptop', amountCents: 1265000, vatCents: 165000, categoryId: await r.cat('Asset purchase'), sourceId: bank }, 'PUT');
    const [{ costCents }] = (await env.sql<{ costCents: number }[]>`select cost_cents from assets where id = ${a.id}`) as unknown as [{ costCents: number }];
    expect(Number(costCents)).toBe(1100000);
    expect((await me.call({ method: 'DELETE', url: `/api/costs/${c.id}` })).statusCode).toBe(400);
  });

  it('claims VAT on an asset bought straight from the bank and charges it when one is sold', async () => {
    const bank = await r.src('Business bank');
    const trailer = await me.post('/api/assets', { name: 'Trailer', category: 'equipment', purchaseDate: '2026-09-01', costCents: 2000000, vatCents: 300000, sourceId: bank, lifeMonths: 60 });
    let v = await me.get('/api/vat/return?on=2026-09-15');
    expect(v.fields.field14).toBe(300000 + 165000); // the trailer, and the laptop before it
    // Sold for R23 000 including R3 000 VAT: the profit is worked out before VAT.
    await me.post(`/api/assets/${trailer.id}`, { name: 'Trailer', category: 'equipment', purchaseDate: '2026-09-01', costCents: 2000000, vatCents: 300000, sourceId: bank, lifeMonths: 60, disposedOn: '2026-10-15', disposalProceedsCents: 2300000, disposalVatCents: 300000, disposalSourceId: bank }, 'PUT');
    v = await me.get('/api/vat/return?on=2026-10-15');
    expect(v.fields).toMatchObject({ field1A: 2300000, field4A: 300000 });
    expect(v.fields.field13).toBe(v.fields.field4 + 300000);
    // One month's depreciation (September) was R33 333.
    const [{ gain }] = (await env.sql<{ gain: number }[]>`select coalesce(sum(amount_cents), 0)::bigint as gain from ledger where source = 'disposal' and account_id = (select id from accounts where system_key = 'disposal_gain_loss')`) as unknown as [{ gain: number }];
    expect(-Number(gain)).toBe(2000000 - (2000000 - 33333));
    expect(await ledgerTotal(env.sql)).toBe(0);
  });

  it('claims and charges no VAT on a motor car', async () => {
    const bank = await r.src('Business bank');
    const car = await me.post('/api/assets', { name: 'Double cab', category: 'vehicles', purchaseDate: '2026-09-20', costCents: 46000000, vatCents: 6000000, sourceId: bank, lifeMonths: 60, inputVatDenied: true });
    expect(Number(car.vatCents)).toBe(0);
    const c = await me.post('/api/costs', { date: '2026-09-21', description: 'Sedan', amountCents: 23000000, vatCents: 3000000, categoryId: await r.cat('Asset purchase'), sourceId: bank });
    expect((await me.call({ method: 'POST', url: '/api/assets', payload: { name: 'Sedan', category: 'vehicles', purchaseDate: '2026-09-21', costCents: 1, costId: c.id, lifeMonths: 60, inputVatDenied: true } })).statusCode).toBe(400);
  });
});

describe('a closed year stays as it was', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let r: Awaited<ReturnType<typeof ref>>;
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    r = await ref(env.sql);
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, features: { ...settings.features, dividends: true } }, 'PUT');
  });
  afterAll(() => env.close());

  it('takes a job’s costs to cost of sales when it’s finished, not back in a closed year', async () => {
    const job = await me.post('/api/projects', { name: 'Old job' });
    await me.post('/api/costs', { date: '2026-02-10', description: 'Timber', amountCents: 100000, categoryId: await r.cat('Parts'), sourceId: await r.src('Business bank'), projectId: job.id });
    await env.sql`update settings set lock_date = '2026-02-28'`;
    expect(await balance(env.sql, 'wip', '2026-02-28')).toBe(100000);
    const p = await me.get(`/api/projects/${job.id}`);
    await me.post(`/api/projects/${job.id}`, { ...p.project, status: 'cancelled' }, 'PUT');
    // The closed year still has it in work in progress; this year takes the cost.
    expect(await balance(env.sql, 'wip', '2026-02-28')).toBe(100000);
    expect(await balance(env.sql, 'wip')).toBe(0);
    // Reopening it is fine (it was finished this year)…
    await me.post(`/api/projects/${job.id}`, { ...p.project, status: 'active' }, 'PUT');
    expect(await balance(env.sql, 'wip')).toBe(100000);
  });

  it('won’t reopen a job finished in a closed year', async () => {
    const job = await me.post('/api/projects', { name: 'Finished long ago' });
    await env.sql`update settings set lock_date = null`;
    await me.post('/api/costs', { date: '2026-01-10', description: 'Paint', amountCents: 50000, categoryId: await r.cat('Parts'), sourceId: await r.src('Business bank'), projectId: job.id });
    await env.sql`update projects set status = 'done' where id = ${job.id}`;
    await env.sql`update projects set closed_on = '2026-01-31' where id = ${job.id}`;
    await env.sql`update settings set lock_date = '2026-02-28'`;
    const p = await me.get(`/api/projects/${job.id}`);
    const res = await me.call({ method: 'PUT', url: `/api/projects/${job.id}`, payload: { ...p.project, status: 'active' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/closed year/);
  });

  it('won’t move a closed year’s costs to another account', async () => {
    const res = await me.call({ method: 'PUT', url: `/api/categories/${await r.cat('Parts')}`, payload: { name: 'Parts', kind: 'materials', accountId: (await env.sql<{ id: string }[]>`select id from accounts where code = '6900'`)[0]!.id, active: true } });
    expect(res.statusCode).toBe(400);
  });

  it('closes each year’s dividends into retained earnings', async () => {
    await env.sql`update settings set lock_date = null`;
    await me.post('/api/journals', { date: '2025-06-01', description: 'Sales', lines: [{ accountId: await r.acc('bank'), debitCents: 5_000_000 }, { accountId: await r.acc('revenue_other'), creditCents: 5_000_000 }] });
    await me.post('/api/dividends', { declaredOn: '2025-12-01', paidOn: '2025-12-01', shareholder: 'Fictional Owner', grossCents: 1_000_000, sourceId: await r.src('Business bank') });
    const tb = await me.get('/api/reports/trial-balance?date=2026-06-30');
    const row = (key: string) => tb.rows.find((x: { id: string }) => x.id === key);
    expect(row(await r.acc('dividends'))).toBeUndefined();
    expect(row(await r.acc('retained_earnings')).creditCents).toBeGreaterThanOrEqual(5_000_000 - 1_000_000 - 200_000);
    expect(tb.totals.differenceCents).toBe(0);
    const bs = await me.get('/api/reports/balance-sheet?date=2026-06-30');
    expect(bs.differenceCents).toBe(0);
  });
});
