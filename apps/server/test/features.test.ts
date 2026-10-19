import { companyTax } from '@shap/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readClientCsv, suggestMatches } from '../src/modules/clients.js';
import { balance, ledgerTotal, login, ref, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
let owner: Awaited<ReturnType<typeof login>>;
let ids: { bank: string; petrol: string; petrolAccount: string; parts: string };

// A 1×1 transparent PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

beforeAll(async () => {
  env = await setup();
  owner = await login(env.app, 'owner@example.co.za');
  const r = await ref(env.sql);
  const petrol = await r.cat('Petrol');
  const [pa] = await env.sql<{ accountId: string }[]>`select account_id from cost_categories where id = ${petrol}`;
  ids = { bank: await r.src('Business bank'), petrol, petrolAccount: pa!.accountId, parts: await r.cat('Parts') };
});
afterAll(() => env.close());

async function accountBalance(accountId: string, from: string, to: string): Promise<number> {
  const [r] = await env.sql<{ b: number }[]>`select coalesce(sum(amount_cents), 0)::bigint as b from ledger where account_id = ${accountId} and date between ${from}::date and ${to}::date`;
  return r!.b;
}
async function issueInvoice(body: Record<string, unknown>) {
  const doc = await owner.post('/api/documents', { kind: 'invoice', issueDate: '2026-05-04', lines: [{ category: 'labour', description: 'Work', qty: 1, unit: 'job', unitPriceCents: 100000 }], ...body });
  await owner.post(`/api/documents/${doc.id}/issue`);
  return owner.get(`/api/documents/${doc.id}`);
}

describe('trading names', () => {
  let alpha: { id: string };
  let beta: { id: string };

  it('starts with one, made from the company letterhead', async () => {
    const r = await owner.get('/api/reference');
    expect(r.brands).toHaveLength(1);
    expect(r.settings.defaultBrandId).toBe(r.brands[0].id);
  });

  it('adds more, each with its own bank details and colour', async () => {
    alpha = await owner.post('/api/brands', { name: 'Alpha Build', legalLine: 'Example (Pty) Ltd t/a Alpha Build', bankDetails: 'Bank A 123', accent: '#13538a' });
    beta = await owner.post('/api/brands', { name: 'Beta IT', legalLine: 'Example (Pty) Ltd t/a Beta IT', bankDetails: 'Bank B 456', accent: '#d2601a' });
    await owner.post(`/api/brands/${beta.id}/logo`, { dataBase64: PNG, mime: 'image/png', filename: 'beta.png' });
    const r = await owner.get('/api/reference');
    expect(r.brands.map((b: { name: string }) => b.name)).toEqual(expect.arrayContaining(['Alpha Build', 'Beta IT']));
    const dup = await owner.call({ method: 'POST', url: '/api/brands', payload: { name: 'Alpha Build' } });
    expect(dup.statusCode).toBe(409);
  });

  it('picks the document’s, then the job’s, then the client’s, then the default', async () => {
    const client = await owner.post('/api/clients', { name: 'Brand Client', brandId: alpha.id });
    const job = await owner.post('/api/projects', { name: 'Beta network job', clientId: client.id, brandId: beta.id });
    const fromJob = await issueInvoice({ projectId: job.id });
    expect(fromJob.doc.brandName).toBe('Beta IT');
    const fromClient = await issueInvoice({ clientId: client.id });
    expect(fromClient.doc.brandName).toBe('Alpha Build');
    const plain = await issueInvoice({ title: 'Walk-in' });
    expect(plain.doc.brandId).toBe((await owner.get('/api/reference')).settings.defaultBrandId);
    const chosen = await issueInvoice({ projectId: job.id, brandId: alpha.id });
    expect(chosen.doc.brandName).toBe('Alpha Build');
    // One numbering for the company, whatever the name on the door.
    expect([fromJob, fromClient, plain, chosen].map((d) => Number(d.doc.number))).toEqual([1, 2, 3, 4]);
  });

  it('keeps the trading name when a quote becomes an invoice', async () => {
    const q = await owner.post('/api/documents', { kind: 'quote', issueDate: '2026-05-04', brandId: beta.id, lines: [{ category: 'labour', description: 'Install', qty: 1, unit: 'job', unitPriceCents: 5000 }] });
    const inv = await owner.post(`/api/documents/${q.id}/convert`);
    expect((await owner.get(`/api/documents/${inv.id}`)).doc.brandName).toBe('Beta IT');
  });

  it('prints the PDF under the trading name', async () => {
    const list = await owner.get('/api/documents?kind=invoice');
    const beta1 = list.find((d: { brandName: string }) => d.brandName === 'Beta IT');
    const res = await owner.call({ method: 'GET', url: `/api/documents/${beta1.id}/pdf` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(String(res.headers['content-disposition'])).toContain('Beta IT');
    expect(res.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('costs not captured yet', () => {
  let costId: string;
  it('holds a cost with no payment source in its own account, off the bank', async () => {
    const before = await balance(env.sql, 'bank');
    const c = await owner.post('/api/costs', { date: '2026-05-06', description: 'Diesel', amountCents: 45000, categoryId: ids.petrol, sourceId: null });
    costId = c.id;
    expect(await balance(env.sql, 'uncaptured')).toBe(-45000);
    expect(await balance(env.sql, 'bank')).toBe(before);
    const list = await owner.get('/api/costs?source=none');
    expect(list.map((x: { id: string }) => x.id)).toEqual([costId]);
    expect((await owner.get('/api/dashboard')).uncapturedCosts).toMatchObject({ n: 1, total: 45000 });
  });

  it('moves to the right account once you say what paid it', async () => {
    const before = await balance(env.sql, 'bank');
    const r = await owner.post('/api/costs/assign-source', { ids: [costId], sourceId: ids.bank });
    expect(r.updated).toBe(1);
    expect(await balance(env.sql, 'uncaptured')).toBe(0);
    expect(await balance(env.sql, 'bank')).toBe(before - 45000);
    expect(await ledgerTotal(env.sql)).toBe(0);
  });
});

describe('agreeing a year to the accountant’s figures', () => {
  // Financial years end in February (the default).
  const FY25 = { start: '2024-03-01', end: '2025-02-28' };
  const FY26 = { start: '2025-03-01', end: '2026-02-28' };
  let accounts: Record<string, string>;

  beforeAll(async () => {
    const rows = await env.sql<{ id: string; systemKey: string | null; code: string }[]>`select id, system_key, code from accounts`;
    accounts = Object.fromEntries(rows.map((a) => [a.systemKey ?? a.code, a.id]));
    await owner.post('/api/costs', { date: '2024-05-01', description: 'Fuel', amountCents: 50000, categoryId: ids.petrol, sourceId: ids.bank });
    await owner.post('/api/costs', { date: '2025-06-01', description: 'Fuel', amountCents: 20000, categoryId: ids.petrol, sourceId: ids.bank });
  });

  it('shows Shap’s figure for each account before anything is agreed', async () => {
    const form = await owner.get(`/api/year-ends/form?fyEnd=${FY25.end}`);
    const petrol = form.rows.find((r: { id: string }) => r.id === ids.petrolAccount);
    expect(petrol).toMatchObject({ shapCents: 50000, targetCents: null });
    expect(form.rows.find((r: { id: string }) => r.id === accounts.bank).shapCents).toBe(-50000);
  });

  it('makes that year’s statements match, with anything that doesn’t tie up in suspense', async () => {
    await owner.post(
      '/api/year-ends',
      {
        fyEnd: FY25.end,
        note: 'AFS signed',
        figures: [
          { accountId: ids.petrolAccount, amountCents: 60000 },
          { accountId: accounts.bank, amountCents: -60000 },
          { accountId: accounts.share_capital, amountCents: 10000 },
        ],
      },
      'PUT',
    );
    expect(await accountBalance(ids.petrolAccount, FY25.start, FY25.end)).toBe(60000);
    expect(await balance(env.sql, 'bank', FY25.end)).toBe(-60000);
    expect(await balance(env.sql, 'share_capital', FY25.end)).toBe(-10000);
    expect(await balance(env.sql, 'suspense', FY25.end)).toBe(10000);
    expect(await ledgerTotal(env.sql)).toBe(0);
    const list = await owner.get('/api/year-ends');
    expect(list[0]).toMatchObject({ fyEnd: FY25.end, figures: 3, suspenseCents: 10000 });
  });

  it('locks the agreed year', async () => {
    const r = await owner.call({ method: 'POST', url: '/api/costs', payload: { date: '2025-01-10', description: 'Late slip', amountCents: 100, categoryId: ids.petrol, sourceId: ids.bank } });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('opens the next year from the agreed balances, without carrying last year’s profit adjustments', async () => {
    expect(await accountBalance(ids.petrolAccount, FY26.start, FY26.end)).toBe(20000);
    expect(await balance(env.sql, 'bank', FY26.end)).toBe(-80000);
  });

  it('agrees a second year on top of the first', async () => {
    await owner.post('/api/year-ends', { fyEnd: FY26.end, figures: [{ accountId: accounts.bank, amountCents: -85000 }] }, 'PUT');
    expect(await balance(env.sql, 'bank', FY26.end)).toBe(-85000);
    expect(await balance(env.sql, 'bank', FY25.end)).toBe(-60000);
    const form = await owner.get(`/api/year-ends/form?fyEnd=${FY26.end}`);
    // The form shows Shap's figure before this year's own adjustment.
    expect(form.rows.find((r: { id: string }) => r.id === accounts.bank)).toMatchObject({ shapCents: -80000, targetCents: -85000 });
    expect(await ledgerTotal(env.sql)).toBe(0);
  });

  it('goes back to Shap’s own detail when a year end is removed', async () => {
    await owner.post(`/api/year-ends/${FY26.end}`, {}, 'DELETE');
    expect(await balance(env.sql, 'bank', FY26.end)).toBe(-80000);
  });

  it('refuses a date that isn’t a year end', async () => {
    const r = await owner.call({ method: 'PUT', url: '/api/year-ends', payload: { fyEnd: '2025-03-31', figures: [] } });
    expect(r.statusCode).toBe(400);
  });

  it('lets the accountant read but not change it', async () => {
    const acct = await login(env.app, 'accountant@example.co.za');
    expect((await acct.get('/api/year-ends')).length).toBe(1);
    const r = await acct.call({ method: 'PUT', url: '/api/year-ends', payload: { fyEnd: FY26.end, figures: [] } });
    expect(r.statusCode).toBe(403);
  });
});

describe('provisional tax', () => {
  it('uses the SARS small business corporation tables', () => {
    // Years ending on or after 1 April 2026: 0% to R99,000, 7% to R365,000, R18,620 + 21% to R550,000.
    expect(companyTax(9_900_000, '2027-02-28', true)).toBe(0);
    expect(companyTax(20_000_000, '2027-02-28', true)).toBe(707_000);
    expect(companyTax(40_000_000, '2027-02-28', true)).toBe(2_597_000);
    expect(companyTax(60_000_000, '2027-02-28', true)).toBe(5_747_000 + 1_350_000);
    // The table before: 0% to R95,750.
    expect(companyTax(20_000_000, '2026-02-28', true)).toBe(729_750);
    expect(companyTax(20_000_000, '2027-02-28', false)).toBe(5_400_000);
    expect(companyTax(-5_000, '2027-02-28', true)).toBe(0);
  });

  it('projects this year to twelve months and saves an estimate', async () => {
    const r = await owner.get('/api/reports/provisional-tax?fyEnd=2027-02-28&asAt=2026-05-31');
    expect(r.months).toBe(3);
    const labour = r.lines.find((l: { type: string }) => l.type === 'income');
    expect(labour.projectedCents).toBe(Math.round((labour.actualCents / 3) * 12));
    expect(r.lines.some((l: { name: string }) => /director/i.test(l.name))).toBe(true);
    const saved = await owner.post('/api/tax-estimates', {
      fyEnd: '2027-02-28',
      period: 1,
      asAt: r.asAt,
      lines: [{ accountId: null, name: 'Sales', type: 'income', actualCents: 0, projectedCents: 20_000_000 }],
      assessedLossCents: 0,
      sbc: true,
    });
    expect(saved).toMatchObject({ taxableCents: 20_000_000, taxCents: 707_000, payableCents: 353_500 });
    expect((await owner.get('/api/reports/provisional-tax?fyEnd=2027-02-28&asAt=2026-05-31')).saved).toHaveLength(1);
  });
});

describe('deposits', () => {
  it('asks for a percentage on a quote and carries it to the invoice', async () => {
    const q = await owner.post('/api/documents', {
      kind: 'quote',
      issueDate: '2026-06-01',
      depositBp: 5000,
      lines: [{ category: 'labour', description: 'Build wall', qty: 2, unit: 'days', unitPriceCents: 150000 }],
    });
    const quote = await owner.get(`/api/documents/${q.id}`);
    expect(quote.doc).toMatchObject({ depositBp: 5000, depositDueCents: 150000 });
    const inv = await owner.post(`/api/documents/${q.id}/convert`);
    const invoice = await owner.get(`/api/documents/${inv.id}`);
    expect(invoice.doc).toMatchObject({ depositBp: 5000, depositDueCents: 150000, depositShowBalance: true });
    const pdf = await owner.call({ method: 'GET', url: `/api/documents/${inv.id}/pdf` });
    expect(pdf.statusCode).toBe(200);
  });

  it('takes a fixed amount, never more than the total, but not both kinds at once', async () => {
    const d = await owner.post('/api/documents', { kind: 'invoice', issueDate: '2026-06-02', depositCents: 999999999, lines: [{ category: 'other', description: 'Call-out', qty: 1, unitPriceCents: 50000 }] });
    expect((await owner.get(`/api/documents/${d.id}`)).doc.depositDueCents).toBe(50000);
    const both = await owner.call({ method: 'POST', url: '/api/documents', payload: { kind: 'quote', issueDate: '2026-06-02', depositBp: 1000, depositCents: 100, lines: [] } });
    expect(both.statusCode).toBe(400);
  });
});

describe('delinquent invoices', () => {
  let id: string;
  it('writes off what is left as a bad debt, off what clients owe', async () => {
    const inv = await issueInvoice({ title: 'Never paid in full', issueDate: '2026-06-10' });
    id = inv.doc.id;
    await owner.post(`/api/documents/${id}/receipts`, { date: '2026-06-15', amountCents: 40000, sourceId: ids.bank });
    const debtorsBefore = await balance(env.sql, 'receivables');
    const doc = await owner.post(`/api/documents/${id}/write-off`, { date: '2026-07-31', reason: 'Client stopped answering' });
    expect(doc.doc).toMatchObject({ paymentState: 'written_off', writtenOffCents: 60000, writtenOffOn: '2026-07-31' });
    expect(await balance(env.sql, 'bad_debts')).toBe(60000);
    expect(await balance(env.sql, 'receivables')).toBe(debtorsBefore - 60000);
    expect(await balance(env.sql, 'receivables', '2026-07-30')).toBe(debtorsBefore);
    expect(await ledgerTotal(env.sql)).toBe(0);
    const owing = await owner.get('/api/documents?kind=invoice&state=owing');
    expect(owing.some((d: { id: string }) => d.id === id)).toBe(false);
    const delinquent = await owner.get('/api/documents?kind=invoice&state=written_off');
    expect(delinquent.map((d: { id: string }) => d.id)).toEqual([id]);
    const dash = await owner.get('/api/dashboard');
    expect(dash.owing.invoices.some((i: { id: string }) => i.id === id)).toBe(false);
  });

  it('won’t take payments or be voided until the write-off is undone', async () => {
    const pay = await owner.call({ method: 'POST', url: `/api/documents/${id}/receipts`, payload: { date: '2026-08-01', amountCents: 100, sourceId: ids.bank } });
    expect(pay.statusCode).toBe(400);
    const again = await owner.call({ method: 'POST', url: `/api/documents/${id}/write-off`, payload: { date: '2026-08-01' } });
    expect(again.statusCode).toBe(400);
  });

  it('undoes cleanly', async () => {
    const doc = await owner.post(`/api/documents/${id}/write-off`, {}, 'DELETE');
    expect(doc.doc).toMatchObject({ paymentState: 'part_paid', writtenOffCents: 0, writtenOffOn: null });
    expect(await balance(env.sql, 'bad_debts')).toBe(0);
    expect(await ledgerTotal(env.sql)).toBe(0);
  });

  it('won’t write off a paid invoice or date it before the invoice', async () => {
    const early = await owner.call({ method: 'POST', url: `/api/documents/${id}/write-off`, payload: { date: '2026-06-01' } });
    expect(early.statusCode).toBe(400);
    await owner.post(`/api/documents/${id}/receipts`, { date: '2026-08-01', amountCents: 60000, sourceId: ids.bank });
    const paid = await owner.call({ method: 'POST', url: `/api/documents/${id}/write-off`, payload: { date: '2026-08-02' } });
    expect(paid.statusCode).toBe(400);
  });
});

describe('the company file', () => {
  it('saves the set-up and loads it back, merging', async () => {
    const res = await owner.call({ method: 'GET', url: '/api/company-file' });
    expect(res.statusCode).toBe(200);
    const file = res.json();
    expect(file.format).toBe('shap-company/1');
    expect(file.brands.find((b: { name: string }) => b.name === 'Beta IT').logo.mime).toBe('image/png');
    expect(file.yearEnds).toHaveLength(1);
    expect(file.yearEnds[0].figures).toBeTruthy();

    file.brands.push({ name: 'Gamma', legalLine: '', email: '', phone: '', website: '', address: '', bankDetails: 'Bank G', accent: '#118833', active: true, logo: { mime: 'image/png', dataBase64: PNG } });
    file.defaultBrand = 'Gamma';
    file.clients.find((c: { name: string }) => c.name === 'Brand Client').email = 'new@example.com';
    file.jobs = [{ name: 'Beta network job', client: null, brand: 'Gamma' }];
    const r = await owner.post('/api/company-file', { file });
    expect(r.restored).toMatchObject({ jobsBranded: 1, yearEnds: 1 });
    const refData = await owner.get('/api/reference');
    const gamma = refData.brands.find((b: { name: string }) => b.name === 'Gamma');
    expect(gamma.logoId).toBeTruthy();
    expect(refData.settings.defaultBrandId).toBe(gamma.id);
    const [p] = await env.sql<{ brandId: string }[]>`select brand_id from projects where name = 'Beta network job'`;
    expect(p!.brandId).toBe(gamma.id);
    const [c] = await env.sql<{ email: string }[]>`select email from clients where name = 'Brand Client'`;
    expect(c!.email).toBe('new@example.com');
    expect(await ledgerTotal(env.sql)).toBe(0);
  });

  it('refuses something that isn’t a company file', async () => {
    const r = await owner.call({ method: 'POST', url: '/api/company-file', payload: { file: { hello: 'world' } } });
    expect(r.statusCode).toBe(400);
  });
});

describe('matching an Invoice Ninja client export', () => {
  const clients = [
    { id: 'c1', code: 'Naidoo001', name: 'Naidoo001', projects: ['Naidoo kitchen'] },
    { id: 'c2', code: 'Dut001', name: 'Dut001', projects: ['Bathroom reno'] },
    { id: 'c3', code: 'Corner001', name: 'Corner001', projects: ['12 Oak Street shopfront'] },
    { id: 'c4', code: 'Mol001', name: 'Mol001', projects: ['Molefe deck'] },
  ];
  const csv = [
    'Name,Contact First Name,Contact Last Name,Contact Email,Phone,Street,City,Postal Code,Number',
    'Priya Naidoo,Priya,Naidoo,priya@example.com,021 555 0101,1 Main Rd,Cape Town,8001,0001',
    'Jan du Toit,Jan,du Toit,jan@example.com,,9 Long St,Cape Town,8001,0002',
    'Corner Shop (Pty) Ltd,Priya,Naidoo,shop@example.com,,12 Oak Street,Cape Town,8001,0003',
    'Someone New,,,new@example.com,,,,,0004',
  ].join('\n');

  it('reads the columns', () => {
    const rows = readClientCsv(csv);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ name: 'Priya Naidoo', email: 'priya@example.com', phone: '021 555 0101', address: '1 Main Rd\nCape Town 8001' });
  });

  it('suggests a client from the code, the job names and the street address, and nothing when unsure', () => {
    const rows = suggestMatches(readClientCsv(csv), clients);
    const by = Object.fromEntries(rows.map((r) => [r.name, r.suggestion?.clientId ?? null]));
    expect(by['Priya Naidoo']).toBe('c1');
    expect(by['Jan du Toit']).toBe('c2');
    // The shop's contact is Priya Naidoo, but the street address is in the shop's job.
    expect(by['Corner Shop (Pty) Ltd']).toBe('c3');
    expect(by['Someone New']).toBeNull();
  });
});
