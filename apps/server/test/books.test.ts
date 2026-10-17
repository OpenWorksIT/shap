import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balance, ledgerTotal, login, ref, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
let owner: Awaited<ReturnType<typeof login>>;
let ids: { bank: string; cash: string; owner: string; parts: string; petrol: string; workTypeYard: string };

beforeAll(async () => {
  env = await setup();
  owner = await login(env.app, 'owner@example.co.za');
  const r = await ref(env.sql);
  const [yard] = await env.sql<{ id: string }[]>`select id from work_types order by sort limit 1`;
  ids = {
    bank: await r.src('Business bank'),
    cash: await r.src('Cash'),
    owner: await r.src('Paid personally (owner)'),
    parts: await r.cat('Parts'),
    petrol: await r.cat('Petrol'),
    workTypeYard: yard!.id,
  };
});
afterAll(() => env.close());

describe('a job from quote to paid', () => {
  let projectId: string;
  let workerId: string;
  let quoteId: string;
  let invoiceId: string;

  it('sets up a job and a worker', async () => {
    const client = await owner.post('/api/clients', { name: 'Jan Smith', code: 'Smith001', email: 'jan@example.com' });
    const project = await owner.post('/api/projects', { name: 'Smith boundary wall', clientId: client.id, startDate: '2026-03-02' });
    projectId = project.id;
    expect(project.number).toBe(1);
    const worker = await owner.post('/api/workers', { name: 'Sipho', dayRateCents: 40000, allowanceCents: 5000 });
    workerId = worker.id;
  });

  it('quotes from the parts plan with mark-up', async () => {
    await owner.post(`/api/projects/${projectId}/planned`, { description: 'Bricks', qty: 500, unit: 'each', unitCostCents: 300 });
    const q = await owner.post(`/api/projects/${projectId}/quote-from-plan`, { markupBp: 3500 });
    quoteId = q.id;
    const doc = await owner.get(`/api/documents/${quoteId}`);
    expect(doc.doc.number).toBe('Q0001');
    expect(doc.lines[0]).toMatchObject({ category: 'materials', qty: 500, unitPriceCents: 405 });
    expect(doc.doc.totalCents).toBe(202500);
  });

  it('keeps job costs in work in progress until the job is invoiced', async () => {
    await owner.post('/api/labour', { date: '2026-03-03', projectId, entries: [{ workerId, days: 1, wageCents: 40000, allowanceCents: 5000 }] });
    await owner.post('/api/costs', { date: '2026-03-03', description: 'Bricks', amountCents: 150000, categoryId: ids.parts, sourceId: ids.bank, projectId });
    expect(await balance(env.sql, 'wip')).toBe(195000);
    expect(await balance(env.sql, 'cos_labour')).toBe(0);
    expect(await balance(env.sql, 'cos_materials')).toBe(0);
  });

  it('turns the quote into an invoice, which moves the costs to cost of sales on its date', async () => {
    const inv = await owner.post(`/api/documents/${quoteId}/convert`);
    invoiceId = inv.id;
    expect(inv.number).toBe('1');
    const quote = await owner.get(`/api/documents/${quoteId}`);
    expect(quote.doc.status).toBe('accepted');
    // Draft invoices aren't in the books yet.
    expect(await balance(env.sql, 'receivables')).toBe(0);
    const doc = await owner.get(`/api/documents/${invoiceId}`);
    await owner.post(`/api/documents/${invoiceId}`, { ...doc.doc, issueDate: '2026-03-10', dueDate: '2026-03-17', lines: [...doc.lines, { category: 'labour', description: 'Building', qty: 1, unitPriceCents: 120000 }] }, 'PUT');
    await owner.post(`/api/documents/${invoiceId}/issue`);
    expect(await balance(env.sql, 'receivables')).toBe(322500);
    expect(await balance(env.sql, 'revenue_materials')).toBe(-202500);
    expect(await balance(env.sql, 'revenue_labour')).toBe(-120000);
    expect(await balance(env.sql, 'wip')).toBe(0);
    expect(await balance(env.sql, 'cos_labour', '2026-03-09')).toBe(0);
    expect(await balance(env.sql, 'cos_labour', '2026-03-10')).toBe(45000);
    expect(await balance(env.sql, 'cos_materials')).toBe(150000);
  });

  it('lets an issued invoice be changed on the fly', async () => {
    const doc = await owner.get(`/api/documents/${invoiceId}`);
    await owner.post(`/api/documents/${invoiceId}`, { ...doc.doc, lines: doc.lines.map((l: { unitPriceCents: number; category: string }) => (l.category === 'labour' ? { ...l, unitPriceCents: 150000 } : l)) }, 'PUT');
    expect(await balance(env.sql, 'receivables')).toBe(352500);
  });

  it('records payments and shows the invoice paid', async () => {
    await owner.post(`/api/documents/${invoiceId}/receipts`, { date: '2026-03-12', amountCents: 200000, sourceId: ids.bank });
    let doc = await owner.get(`/api/documents/${invoiceId}`);
    expect(doc.doc.paymentState).toBe('part_paid');
    await owner.post(`/api/documents/${invoiceId}/receipts`, { date: '2026-03-15', amountCents: 152500, sourceId: ids.bank });
    doc = await owner.get(`/api/documents/${invoiceId}`);
    expect(doc.doc.paymentState).toBe('paid');
    expect(await balance(env.sql, 'receivables')).toBe(0);
  });

  it('won’t void a paid invoice or delete an issued one', async () => {
    const v = await owner.call({ method: 'POST', url: `/api/documents/${invoiceId}/void`, payload: { reason: 'oops' } });
    expect(v.statusCode).toBe(400);
    const d = await owner.call({ method: 'DELETE', url: `/api/documents/${invoiceId}` });
    expect(d.statusCode).toBe(400);
  });

  it('summarises the job like the Per Project sheet', async () => {
    const p = await owner.get(`/api/projects/${projectId}`);
    expect(p.summary).toMatchObject({
      quotedMaterialsCents: 202500, // from the accepted quote
      actualLabourCents: 45000,
      actualMaterialsCents: 150000,
      invoicedLabourCents: 150000,
      invoicedMaterialsCents: 202500,
      receivedCents: 352500,
      grossProfitCents: 352500 - 195000,
    });
    expect(p.planned[0].totalCents).toBe(150000);
  });

  it('renders the PDF', async () => {
    const r = await owner.call({ method: 'GET', url: `/api/documents/${invoiceId}/pdf` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('wages', () => {
  it('owes the worker what they earned until paid', async () => {
    const [w] = await env.sql<{ id: string }[]>`select id from workers where name = 'Sipho'`;
    await owner.post('/api/wage-payments', { date: '2026-03-06', workerId: w!.id, amountCents: 30000, sourceId: ids.cash });
    const workers = await owner.get('/api/workers');
    expect(workers[0].balanceCents).toBe(15000);
    expect(await balance(env.sql, 'wages_payable')).toBe(-15000);
    // Cash wages come out of the owner's pocket in the default setup.
    expect(await balance(env.sql, 'owner_loan')).toBe(-30000);
  });

  it('counts general work as a running cost and lets unallocated days be allocated', async () => {
    const [w] = await env.sql<{ id: string }[]>`select id from workers where name = 'Sipho'`;
    const r = await owner.post('/api/labour', { date: '2026-03-20', entries: [{ workerId: w!.id, days: 1, wageCents: 40000, allowanceCents: 5000 }] });
    expect(await balance(env.sql, 'general_labour')).toBe(45000);
    const list = await owner.get('/api/labour/unallocated');
    expect(list).toHaveLength(1);
    await owner.post('/api/labour/allocate', { ids: r.ids, workTypeId: ids.workTypeYard });
    expect(await owner.get('/api/labour/unallocated')).toHaveLength(0);
    expect(await balance(env.sql, 'general_labour')).toBe(45000);
  });
});

describe('the books', () => {
  it('posts running costs to their category and payer', async () => {
    await owner.post('/api/costs', { date: '2026-03-05', description: 'Diesel', amountCents: 80000, categoryId: ids.petrol, sourceId: ids.owner });
    const [petrolAcc] = await env.sql<{ id: string }[]>`select account_id as id from cost_categories where name = 'Petrol'`;
    const [b] = await env.sql<{ b: number }[]>`select sum(amount_cents)::bigint as b from ledger where account_id = ${petrolAcc!.id}`;
    expect(b!.b).toBe(80000);
  });

  it('depreciates an asset monthly and takes it off the books when sold', async () => {
    const a = await owner.post('/api/assets', { name: 'Mixer', category: 'equipment', purchaseDate: '2026-03-15', costCents: 360000, sourceId: ids.owner, lifeMonths: 36 });
    expect(await balance(env.sql, 'accumulated_depreciation', '2026-05-31')).toBe(-30000);
    await owner.post(`/api/assets/${a.id}`, { name: 'Mixer', category: 'equipment', purchaseDate: '2026-03-15', costCents: 360000, sourceId: ids.owner, lifeMonths: 36, disposedOn: '2026-06-15', disposalProceedsCents: 300000 }, 'PUT');
    expect(await balance(env.sql, 'fixed_assets', '2026-07-01')).toBe(0);
    expect(await balance(env.sql, 'accumulated_depreciation', '2026-07-01')).toBe(0);
    expect(await balance(env.sql, 'disposal_gain_loss', '2026-07-01')).toBe(360000 - 30000 - 300000);
    expect(await ledgerTotal(env.sql)).toBe(0);
  });

  it('rejects an unbalanced journal and accepts a balanced one', async () => {
    const r = await ref(env.sql);
    const loan = await r.acc('owner_loan');
    const bank = await r.acc('bank');
    const bad = await owner.call({ method: 'POST', url: '/api/journals', payload: { date: '2026-03-31', description: 'x', lines: [{ accountId: loan, debitCents: 100 }, { accountId: bank, creditCents: 90 }] } });
    expect(bad.statusCode).toBe(400);
    await owner.post('/api/journals', { date: '2026-03-31', description: 'Company repaid the owner', lines: [{ accountId: loan, debitCents: 50000 }, { accountId: bank, creditCents: 50000 }] });
    expect(await ledgerTotal(env.sql)).toBe(0);
  });

  it('agrees a statement balance with one adjustment', async () => {
    const r = await ref(env.sql);
    const bank = await r.acc('bank');
    const loan = await r.acc('owner_loan');
    const books = await balance(env.sql, 'bank', '2026-03-31');
    const check = await owner.post('/api/balance-checks', { accountId: bank, date: '2026-03-31', statementBalanceCents: books - 12345 });
    await owner.post(`/api/balance-checks/${check.id}/adjust`, { againstAccountId: loan });
    expect(await balance(env.sql, 'bank', '2026-03-31')).toBe(books - 12345);
  });

  it('balances the trial balance and balance sheet, and carries profit into retained earnings', async () => {
    const tb = await owner.get('/api/reports/trial-balance?date=2027-03-31');
    expect(tb.totals.differenceCents).toBe(0);
    const pl = tb.rows.filter((r: { type: string }) => ['income', 'cost_of_sales', 'expense'].includes(r.type));
    expect(pl).toHaveLength(0); // a new financial year: last year's profit is now retained earnings
    const bs = await owner.get('/api/reports/balance-sheet?date=2027-03-31');
    expect(bs.differenceCents).toBe(0);
    const is = await owner.get('/api/reports/income-statement?from=2026-03-01&to=2027-02-28&by=month');
    expect(is.months).toHaveLength(12);
    expect(is.totals.netProfit.totalCents).toBe(is.totals.netProfit.months.reduce((s: number, v: number) => s + v, 0));
  });

  it('closes the books up to the lock date', async () => {
    await env.sql`update settings set lock_date = '2026-03-31'`;
    const r = await owner.call({ method: 'POST', url: '/api/costs', payload: { date: '2026-03-20', description: 'Late slip', amountCents: 100, categoryId: ids.parts, sourceId: ids.bank } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/closed/);
    await env.sql`update settings set lock_date = null`;
  });
});

describe('who can do what', () => {
  it('lets site capture log days at the worker’s rate, but not see the books', async () => {
    const site = await login(env.app, 'site@example.co.za');
    const [w] = await env.sql<{ id: string }[]>`select id from workers where name = 'Sipho'`;
    const [p] = await env.sql<{ id: string }[]>`select id from projects limit 1`;
    const r = await site.post('/api/labour', { date: '2026-04-01', projectId: p!.id, entries: [{ workerId: w!.id, days: 0.5, wageCents: 999999, allowanceCents: 999999 }] });
    const [e] = await env.sql<{ wageCents: number; allowanceCents: number }[]>`select wage_cents, allowance_cents from labour_entries where id = ${r.ids[0]}`;
    expect(e).toEqual({ wageCents: 20000, allowanceCents: 5000 });
    expect((await site.call({ method: 'GET', url: '/api/reports/trial-balance' })).statusCode).toBe(403);
    expect((await site.call({ method: 'GET', url: `/api/workers/${w!.id}` })).statusCode).toBe(403);
    const workers = await site.get('/api/workers');
    expect(Object.keys(workers[0])).not.toContain('dayRateCents');
  });

  it('lets the accountant read and export, but not change anything', async () => {
    const acc = await login(env.app, 'accountant@example.co.za');
    expect((await acc.call({ method: 'GET', url: '/api/reports/balance-sheet' })).statusCode).toBe(200);
    expect((await acc.call({ method: 'GET', url: '/api/export/ledger?format=csv' })).statusCode).toBe(200);
    expect((await acc.call({ method: 'POST', url: '/api/costs', payload: {} })).statusCode).toBe(403);
    expect((await acc.call({ method: 'PUT', url: '/api/settings', payload: {} })).statusCode).toBe(403);
  });

  it('keeps the audit log append-only', async () => {
    await expect(env.sql`delete from audit_log`).rejects.toThrow(/append-only/);
  });
});
