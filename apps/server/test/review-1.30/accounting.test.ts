/**
 * The five reviews of 1.30.0 (CPDAUDIT.md), accounting and arithmetic (from the review's own test):
 * a made-up month of trading written up in a linked client's own Shap by someone from the practice
 * (level 'books': staff with LINKED_BOOKS_TASKS), and the very same month in a client the practice
 * keeps. Then: the books audit is clean, every figure the practice person sees is what the client's
 * owner sees, the two copies agree, every audit entry is in the practice person's name (matches
 * taken from the bank's suggestions too), a line matched to a bill's payment shows as matched, and
 * the checks the practice's list shows for the linked client are what the same books give when
 * kept. All data made up.
 */
import type { InjectOptions } from 'fastify';
import { payLine } from '@shap/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { ACCOUNTANT_TERMS_VERSION } from '@shap/shared';
import type { Sql } from '../../src/db/index.js';
import { healthForLink, healthOf } from '../../src/lib/practice.js';
import { appVersion } from '../../src/modules/system.js';
import { balance, expectCleanAudit, ledgerTotal, login, ref, setup, type TestEnv } from '../helpers.js';

const V = { 'x-shap-version': appVersion() };
const COMPANY = 'Made-up Own Books (Pty) Ltd';
const END = '2026-10-31';

interface Api {
  get: <T = any>(url: string) => Promise<T>;
  post: <T = any>(url: string, body?: unknown, method?: 'POST' | 'PUT' | 'DELETE') => Promise<T>;
}
const apiOf = (call: (o: InjectOptions) => Promise<{ statusCode: number; body: string; json: () => unknown }>): Api => ({
  get: async (url) => {
    const r = await call({ method: 'GET', url });
    if (r.statusCode >= 400) throw new Error(`GET ${url} → ${r.statusCode} ${r.body}`);
    return r.json() as never;
  },
  post: async (url, body = {}, method = 'POST') => {
    const r = await call({ method, url, payload: body as never });
    if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
    return r.json() as never;
  },
});

/** The month: a customer, an invoice and part of it paid, a cost, a bill part-paid, a pay run, a journal, a bank statement. */
async function month(api: Api, sql: Sql) {
  const r = await ref(sql);
  const bank = await r.src('Business bank');
  const { sources } = await api.get('/api/reference');
  const bills = sources.find((s: { role: string | null }) => s.role === 'bills').id;
  // Last year (to 28 February 2026), so the checks build that year's statements too.
  await api.post('/api/journals', { date: '2026-01-15', description: 'Made-up rent the owner paid', lines: [{ accountId: await r.acc('rent'), debitCents: 300_000 }, { accountId: await r.acc('owner_loan'), creditCents: 300_000 }] });
  await api.post('/api/journals', { date: '2026-10-01', description: 'Made-up loan from the owner', lines: [{ accountId: await r.acc('bank'), debitCents: 2_000_000 }, { accountId: await r.acc('owner_loan'), creditCents: 2_000_000 }] });
  const client = await api.post('/api/clients', { name: 'Made-up Customer (Pty) Ltd', address: '2 Example Street, Gqeberha, 6001' });
  const inv = await api.post('/api/documents', {
    kind: 'invoice', clientId: client.id, issueDate: '2026-10-05',
    lines: [{ category: 'labour', description: 'Made-up repairs', qty: 2.5, unitPriceCents: 45_001 }, { category: 'materials', description: 'Made-up fittings', qty: 3, unitPriceCents: 12_345 }],
  });
  await api.post(`/api/documents/${inv.id}/issue`);
  await api.post(`/api/documents/${inv.id}/receipts`, { date: '2026-10-20', amountCents: 100_000, sourceId: bank });
  await api.post('/api/costs', { date: '2026-10-07', description: 'Made-up cable', supplier: 'Fictional Supplies', amountCents: 115_000, vatCents: 15_000, categoryId: await r.cat('Parts'), sourceId: bank });
  const bill = await api.post('/api/costs', { date: '2026-10-09', description: 'Made-up drill', supplier: 'Fictional Tools', amountCents: 230_000, vatCents: 30_000, categoryId: await r.cat('Tool'), sourceId: bills, billNumber: 'FT-1', dueDate: '2026-11-08' });
  const bp = await api.post(`/api/costs/${bill.id}/bill-payments`, { date: '2026-10-25', amountCents: 100_000, sourceId: bank });
  await api.post('/api/employees', { name: 'Made-up Employee', salaryCents: 1_500_000, startDate: '2026-01-01' });
  const run = await api.post('/api/pay-runs', { period: '2026-10', payDate: '2026-10-25', sourceId: bank });
  await api.post(`/api/pay-runs/${run.id}/finalise`);
  const csv = ['Date,Amount,Description', '2026/10/01,20000.00,OWNER LOAN MADE UP', '2026/10/07,-1150.00,POS PURCHASE FICTIONAL SUPPLIES', '2026/10/20,1000.00,MADE-UP CUSTOMER PAYMENT', '2026/10/25,-1000.00,FICTIONAL TOOLS FT-1', '2026/10/31,-85.00,MONTHLY ACCOUNT FEE'].join('\n');
  await api.post('/api/bank/statements', { sourceId: bank, csv, filename: 'october.csv' });
  const rec = await api.get(`/api/bank/recon?sourceId=${bank}`);
  const line = (d: string) => rec.lines.find((l: { description: string }) => l.description.startsWith(d));
  const suggested = rec.lines.filter((l: { state: string }) => l.state === 'suggested').map((l: { id: string }) => l.id);
  if (suggested.length) await api.post('/api/bank/accept', { sourceId: bank, lineIds: suggested });
  const after = await api.get(`/api/bank/recon?sourceId=${bank}`);
  const open = (d: string) => after.lines.find((l: { description: string; state: string }) => l.description.startsWith(d) && l.state !== 'matched');
  const [j] = await sql<{ id: string }[]>`select id from journals where description = 'Made-up loan from the owner'`;
  if (open('OWNER LOAN')) await api.post(`/api/bank/lines/${line('OWNER LOAN').id}/match`, { items: [{ kind: 'journal', id: j!.id }] });
  if (open('FICTIONAL TOOLS')) await api.post(`/api/bank/lines/${line('FICTIONAL TOOLS').id}/match`, { items: [{ kind: 'bill_payment', id: bp.id ?? (await sql`select id from bill_payments limit 1`)[0]!.id }] });
  if (open('MONTHLY')) await api.post('/api/bank/lines/create-costs', { items: [{ lineId: line('MONTHLY').id, categoryId: await r.cat('Bank') }] });
  const final = await api.get(`/api/bank/recon?sourceId=${bank}`);
  return { states: final.lines.map((l: { description: string; state: string }) => `${l.description}: ${l.state}`).sort(), invId: inv.id };
}

/** Everything in a report but ids and times, to compare two copies of the books. */
const strip = (x: unknown): unknown => {
  if (Array.isArray(x)) return x.map(strip);
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).filter(([k]) => !/(^id$|Id$|Ids$|^at$|At$|^generated|^url$|^brandName$|By$)/.test(k)).map(([k, v]) => [k, strip(v)]));
  return x;
};
const REPORTS = [
  `/api/reports/trial-balance?date=${END}`,
  `/api/reports/income-statement?from=2026-03-01&to=${END}`,
  `/api/reports/balance-sheet?date=${END}`,
  '/api/vat/return?on=2026-10-10',
  '/api/payroll/sars',
  '/api/bills',
  '/api/documents?kind=invoice',
  '/api/costs',
];

describe('a month written up in a linked client’s own Shap, and the same month kept in the practice', () => {
  let practice: TestEnv;
  let own: TestEnv;
  let base: string;
  let owner: Awaited<ReturnType<typeof login>>;
  let theirs: Awaited<ReturnType<typeof login>>;
  let linkedId: string;
  let keptId: string;
  let keptDb: Sql;
  let them: Api;
  let kept: Api;
  let linkUser: string;
  let startedAt: Date;
  const ownDb = `${new URL(process.env.DATABASE_URL!).pathname.slice(1)}_rev130_month`;
  const settingsFor = (s: Record<string, unknown>) => ({
    ...s, companyName: COMPANY, businessType: 'company', fyEndMonth: 2, vatRegistered: true, vatNumber: '4000000002', vatCategory: 'B',
    features: { ...(s.features as object), bills: true, payroll: true, bank: true, inventory: true },
  });
  const dropClients = async () => {
    const pattern = `${practice.ctx.clients.practiceDb.replace(/_/g, '\\_')}\\_\\_c\\_%`;
    for (const { datname } of await practice.sql<{ datname: string }[]>`select datname from pg_database where datname like ${pattern}`) await practice.sql.unsafe(`drop database if exists "${datname}" with (force)`);
  };

  beforeAll(async () => {
    practice = await setup({ env: { LINK_PRIVATE: 'true' } });
    await dropClients();
    await practice.sql.unsafe(`drop database if exists "${ownDb}" with (force)`);
    await practice.sql.unsafe(`create database "${ownDb}"`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${ownDb}`;
    own = await setup({ env: { DATABASE_URL: url.toString(), PUBLIC_URL: 'https://books.made-up-own.example' } });
    await own.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(own.app.server.address() as AddressInfo).port}`;
    theirs = await login(own.app, 'owner@example.co.za');
    await theirs.post('/api/settings', settingsFor((await theirs.get('/api/reference')).settings), 'PUT');
    owner = await login(practice.app, 'owner@example.co.za');
    const s = (await owner.get('/api/reference')).settings;
    await owner.post('/api/practice/terms', { version: ACCOUNTANT_TERMS_VERSION });
    await owner.post('/api/settings', { ...s, companyName: 'Made-up Practice Inc', features: { ...s.features, practice: true } }, 'PUT');

    // Linked: the owner of the client's Shap lets the practice write up the books.
    const made = await theirs.post<{ link: string }>('/api/accountant-links', { level: 'books', password: 'test-password-1' });
    linkedId = (await owner.post<{ id: string }>('/api/practice/clients/link', { link: made.link.replace(/^https?:\/\/[^/]+/, base) })).id;
    const opened = await owner.post<{ url: string; level: string }>(`/api/practice/clients/${linkedId}/open`, {});
    expect(opened.level).toBe('books');
    const r = await own.app.inject({ method: 'GET', url: opened.url.slice(base.length) });
    const cookie = r.cookies.find((c) => c.name === 'shap_session')!.value;
    them = apiOf((o) => own.app.inject({ ...o, headers: { ...V, ...(o.headers ?? {}) }, cookies: { shap_session: cookie } }) as never);
    linkUser = (await own.sql<{ id: string }[]>`select id from users where link_id is not null`)[0]!.id;

    // Kept: the same company, kept in the practice, set up as the client's own Shap is.
    keptId = (await owner.post<{ id: string }>('/api/practice/clients', { name: COMPANY })).id;
    const [c] = await practice.sql<{ dbName: string }[]>`select db_name from practice_clients where id = ${keptId}`;
    keptDb = practice.ctx.clients.get(c!.dbName);
    await keptDb`update settings set setup_done = true, features = ${keptDb.json({ brands: true, workers: true })}, address = '1 Test Street, Fictional Town, 0001'`;
    await keptDb`insert into brands (name, sort) select company_name, 1 from settings`;
    await keptDb`update settings set default_brand_id = (select id from brands limit 1)`;
    const k = await owner.call({ method: 'POST', url: `/api/practice/clients/${keptId}/open`, payload: {} });
    const cookies = Object.fromEntries(k.cookies.filter((x) => x.value).map((x) => [x.name, x.value]));
    kept = apiOf((o) => owner.call({ ...o, cookies }) as never);
    await kept.post('/api/settings', settingsFor((await kept.get('/api/reference')).settings), 'PUT');
  });
  afterAll(async () => {
    await expectCleanAudit(own.sql);
    await expectCleanAudit(keptDb);
    await expectCleanAudit(practice.sql);
    await own.close();
    await practice.ctx.clients.end();
    await dropClients();
    await practice.close();
    const pg = await setup();
    await pg.sql.unsafe(`drop database if exists "${ownDb}" with (force)`);
    await pg.close();
  });

  it('the practice person writes the month up in the client’s own Shap, as the owner would there', async () => {
    startedAt = (await own.sql<{ now: Date }[]>`select now()`)[0]!.now;
    const linked = await month(them, own.sql);
    const keptMonth = await month(kept, keptDb);
    expect(linked.states).toEqual(keptMonth.states);
    for (const db of [own.sql, keptDb]) expect((await db`select count(*)::int as n from bank_matches where kind = 'bill_payment'`)[0]!.n).toBe(1);
    // Every line matched, the one to the bill's payment among them (it showed as open, from before 1.30).
    expect(linked.states.filter((s: string) => !s.endsWith('matched'))).toEqual([]);
  });

  it('balances to the cent, and the bank, debtors, creditors and payroll accounts are what went through', async () => {
    const net = payLine({ salaryCents: 1_500_000, payDate: '2026-10-25', sdl: false });
    for (const db of [own.sql, keptDb]) {
      expect(await ledgerTotal(db)).toBe(0);
      expect(await balance(db, 'bank', END)).toBe(2_000_000 + 100_000 - 115_000 - 100_000 - net.netCents - 8_500);
      const inv = Math.round(2.5 * 45_001) + 3 * 12_345;
      expect(await balance(db, 'receivables', END)).toBe(inv + Math.round((inv * 1500) / 10000) - 100_000);
      expect(await balance(db, 'payables', END)).toBe(-130_000);
      expect(await balance(db, 'paye_payable', END)).toBe(-net.payeCents);
      expect(await balance(db, 'uncaptured', END)).toBe(0);
    }
  });

  it('shows the practice person and the client’s owner the same figures, and the kept copy the same again', async () => {
    for (const url of REPORTS) {
      const asThem = strip(await them.get(url));
      expect(strip(await theirs.get(url)), url).toEqual(asThem);
      expect(strip(await kept.get(url)), url).toEqual(asThem);
    }
    const tb = await theirs.get(`/api/reports/trial-balance?date=${END}`);
    expect(tb.totals.differenceCents).toBe(0);
    expect((await theirs.get(`/api/reports/balance-sheet?date=${END}`)).differenceCents).toBe(0);
    const d1 = await theirs.get('/api/dashboard');
    const d2 = await them.get('/api/dashboard');
    expect([d1.bankCents, d1.owing?.totalCents]).toEqual([d2.bankCents, d2.owing?.totalCents]);
  });

  it('puts every change in the client’s audit log in the practice person’s name', async () => {
    const rows = await own.sql<{ action: string; entity: string; userId: string | null; actor: string | null; name: string | null }[]>`
      select a.action, a.entity, a.user_id, u.name from audit_log a left join users u on u.id = a.user_id where a.at >= ${startedAt} order by a.id`;
    expect(rows.length).toBeGreaterThan(10);
    const notThem = rows.filter((r) => r.userId !== linkUser);
    expect(notThem.map((r) => `${r.action} ${r.entity} ${r.name}`)).toEqual([]);
    expect(new Set(rows.map((r) => r.name))).toEqual(new Set(['Owner (Made-up Practice Inc)']));
    // Matches taken from the bank's suggestions among them (they weren't in the log, from before 1.30).
    expect(rows.some((r) => r.action === 'accept_matches')).toBe(true);
    // And what was made carries their id as who made it, where the books keep that.
    const made = await own.sql<{ t: string; n: number }[]>`
      select 'costs' as t, count(*) filter (where created_by is distinct from ${linkUser})::int as n from costs
      union all select 'journals', count(*) filter (where created_by is distinct from ${linkUser})::int from journals`;
    expect(made.filter((m) => m.n > 0)).toEqual([]);
  });

  it('the checks the practice’s list shows for the linked client are what the same books give kept', async () => {
    // A kept client's directors aren't Shap users there, so they're named in the statements' details (by design): the same as the client's own.
    await kept.post('/api/statements/details', await theirs.get('/api/statements/details'), 'PUT');
    const linked = (await owner.post<{ health: Record<string, unknown> }>(`/api/practice/clients/${linkedId}/checks`, {})).health;
    const keptH = (await owner.post<{ health: Record<string, unknown> }>(`/api/practice/clients/${keptId}/checks`, {})).health;
    const direct = JSON.parse(JSON.stringify(healthForLink(await healthOf(own.sql))));
    const drop = ({ at: _a, pocket: _p, ...h }: Record<string, unknown>) => h;
    expect(drop(linked)).toEqual(drop(keptH));
    expect(drop(linked)).toEqual({ ...drop(direct), deadlines: linked.deadlines });
    const list = (await owner.get('/api/practice')).clients;
    const L = list.find((x: { id: string }) => x.id === linkedId);
    const K = list.find((x: { id: string }) => x.id === keptId);
    expect(drop(L.health)).toEqual(drop(K.health));
  });

  it('still shows the checks when a finding names long item descriptions (as kept clients’ do)', async () => {
    // Six stocked items with long made-up names, each with opening stock and never counted: one warning.
    for (const api of [them, kept]) {
      for (let i = 1; i <= 6; i++) {
        const item = await api.post<{ id: string }>('/api/items', { description: `Made-up item ${i} ${'with a long descriptive name '.repeat(6)}`.slice(0, 200), stocked: true, unitPriceCents: 10_000 });
        await api.post(`/api/items/${item.id}/opening`, { date: '2026-10-01', qty: 1, unitCostCents: 5_000, from: 'costs' });
      }
    }
    const keptR = await owner.call({ method: 'POST', url: `/api/practice/clients/${keptId}/checks`, payload: {} });
    expect(keptR.statusCode).toBe(200);
    const linkedR = await owner.call({ method: 'POST', url: `/api/practice/clients/${linkedId}/checks`, payload: {} });
    expect(linkedR.statusCode, linkedR.body).toBe(200);
    // The same findings, the same number of each; the long one cut to what the list shows.
    const shown = (await owner.get('/api/practice')).clients.find((x: { id: string }) => x.id === linkedId);
    expect([shown.health.audit.fail, shown.health.audit.warn]).toEqual([keptR.json().health.audit.fail, keptR.json().health.audit.warn]);
    expect(shown.health.audit.items.every((i: { text: string }) => i.text.length <= 500)).toBe(true);
    // Back to what it was, for the books audit at the end: the stock counted.
    for (const api of [them, kept]) {
      const items = await api.get<{ id: string; stocked: boolean }[]>('/api/items');
      await api.post('/api/stock/takes', { date: END, lines: items.filter((x) => x.stocked).map((x) => ({ itemId: x.id, countedQty: 1, reason: 'Made-up count' })) });
    }
  });
});
