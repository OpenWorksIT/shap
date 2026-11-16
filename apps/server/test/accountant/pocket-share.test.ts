/**
 * Shap Accountant, phase 3 (docs/ACCOUNTANT.md, "A Shap Pocket share"): a one-person business's
 * Shap Pocket books, shared from their phone, brought into a practice's client as a read-only copy,
 * each share replacing the last entry by entry and saying what changed. Every figure made up; the
 * share laid out as Pocket makes it (Pocket's engine, modules/share.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readPocketShare } from '../../src/modules/import/pocket-share.js';
import { balance, expectCleanAudit, login, setup, type TestEnv } from '../helpers.js';

type Tx = { key: string; date: string; source: string; reference: string; description: string; lines: { code: string; cents: number; memo: string }[] };
const share = (number: number, through: string, transactions: Tx[], previous: number | null = null) => ({
  format: 'shap-pocket-share/1',
  stamp: { number, madeAt: `${through}T10:00:00.000Z`, through, previous: previous ? { number: previous, madeAt: '2026-10-31T10:00:00.000Z' } : null, app: 'Shap Pocket' },
  business: { companyName: 'Made-up Mobile Mechanic', tradingName: '', businessType: 'sole_prop', fyEndMonth: 2, vatRegistered: false, vatCategory: 'A', vatNumber: '', turnoverTax: false, approvedPbo: false },
  accounts: [
    { code: '1000', name: 'Bank – business account', type: 'asset' },
    { code: '1100', name: 'Debtors (money owed by clients)', type: 'asset' },
    { code: '4000', name: 'Project revenue – labour', type: 'income' },
    { code: '6030', name: 'Bank charges', type: 'expense' },
    { code: '6999', name: 'Tyres (made up, Pocket’s own)', type: 'expense' },
  ],
  transactions,
  changes: { added: [], changed: [], removed: [] },
  totals: { transactions: transactions.length, debitsCents: 0 },
});
const invoice: Tx = { key: 'invoice:aaa:2026-10-05', date: '2026-10-05', source: 'invoice', reference: 'INV-0001', description: 'Service (made up)', lines: [{ code: '1100', cents: 150_000, memo: 'INV-0001' }, { code: '4000', cents: -150_000, memo: 'INV-0001' }] };
const receipt: Tx = { key: 'receipt:bbb:2026-10-12', date: '2026-10-12', source: 'receipt', reference: 'INV-0001', description: 'Paid (made up)', lines: [{ code: '1000', cents: 150_000, memo: 'EFT' }, { code: '1100', cents: -150_000, memo: 'EFT' }] };
const charges: Tx = { key: 'cost:ccc:2026-10-31', date: '2026-10-31', source: 'cost', reference: '', description: 'Bank charges (made up)', lines: [{ code: '6030', cents: 9_500, memo: '' }, { code: '1000', cents: -9_500, memo: '' }] };
const tyres: Tx = { key: 'cost:ddd:2026-11-03', date: '2026-11-03', source: 'cost', reference: '', description: 'Tyres (made up)', lines: [{ code: '6999', cents: 80_000, memo: '' }, { code: '1000', cents: -80_000, memo: '' }] };
const b64 = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64');

describe('reading a Shap Pocket share', () => {
  it('reads a whole, balanced share, and refuses one that isn’t', () => {
    const ok = readPocketShare('share.json', Buffer.from(JSON.stringify(share(1, '2026-10-31', [invoice, receipt, charges]))));
    expect(ok.transactions).toHaveLength(3);
    const lopsided = { ...invoice, lines: [{ code: '1100', cents: 150_000, memo: '' }, { code: '4000', cents: -140_000, memo: '' }] };
    expect(() => readPocketShare('s.json', Buffer.from(JSON.stringify(share(1, '2026-10-31', [lopsided]))))).toThrow(/doesn’t balance/);
    expect(() => readPocketShare('s.json', Buffer.from(JSON.stringify(share(1, '2026-10-01', [invoice]))))).toThrow(/after the day it was shared/);
    expect(() => readPocketShare('s.json', Buffer.from(JSON.stringify(share(1, '2026-10-31', [{ ...invoice, lines: [{ code: '9999', cents: 1, memo: '' }, { code: '4000', cents: -1, memo: '' }] }]))))).toThrow(/doesn’t list/);
    expect(() => readPocketShare('s.json', Buffer.from(JSON.stringify(share(1, '2026-10-31', [invoice, invoice]))))).toThrow(/same entry twice/);
    expect(() => readPocketShare('s.json', Buffer.from('{"format":"shap-pocket-share/9"}'))).toThrow(/isn’t a Shap Pocket share/);
  });
});

describe('a Shap Pocket client in the practice', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  let id: string;
  const drop = async () => {
    const pattern = `${env.ctx.clients.practiceDb.replace(/_/g, '\\_')}\\_\\_c\\_%`;
    for (const { datname } of await env.sql<{ datname: string }[]>`select datname from pg_database where datname like ${pattern}`) await env.sql.unsafe(`drop database if exists "${datname}" with (force)`);
  };
  const db = async () => env.ctx.clients.get((await env.sql<{ dbName: string }[]>`select db_name from practice_clients where id = ${id}`)[0]!.dbName);
  const bringIn = (file: unknown, name = 'Made-up Mobile Mechanic share.json') => owner.call({ method: 'POST', url: `/api/practice/clients/${id}/pocket-share`, payload: { name, dataBase64: b64(file) } });

  beforeAll(async () => {
    env = await setup();
    await drop();
    owner = await login(env.app, 'owner@example.co.za');
    const { settings } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...settings, features: { ...settings.features, practice: true } }, 'PUT');
    ({ id } = await owner.post('/api/practice/clients', { name: 'Made-up Mobile Mechanic', kind: 'pocket' }));
  });
  afterAll(async () => {
    await expectCleanAudit(await db());
    await expectCleanAudit(env.sql);
    await env.ctx.clients.end();
    await drop();
    await env.close();
  });

  it('brings the first share in as the whole of the books, with the business’s details', async () => {
    const r = await bringIn(share(1, '2026-10-31', [invoice, receipt, charges]));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ number: 1, first: true, changes: { added: [], changed: [], removed: [] } });
    const c = await db();
    expect(await balance(c, 'bank', '2026-10-31')).toBe(140_500);
    expect((await c<{ name: string; type: string }[]>`select company_name as name, business_type as type from settings where id`)[0]).toEqual({ name: 'Made-up Mobile Mechanic', type: 'sole_prop' });
    // Pocket's own account came in as one here.
    expect(await c`select 1 from accounts where code = '6999' and name = 'Tyres (made up, Pocket’s own)'`).toHaveLength(1);
    // The list says which share it was.
    const row = (await owner.get('/api/practice')).clients.find((x: { id: string }) => x.id === id);
    expect(row.health.pocket).toMatchObject({ number: 1, through: '2026-10-31' });
  });

  it('brings the next share in entry by entry, saying what changed, what’s new and what went', async () => {
    const c = await db();
    const [kept] = await c<{ id: string }[]>`select journal_id as id from pocket_share_entries where key = ${invoice.key}`;
    const edited = { ...charges, description: 'Bank charges for October (made up)' };
    const r = await bringIn(share(2, '2026-11-15', [invoice, edited, tyres], 1));
    expect(r.statusCode, r.body).toBe(200);
    const { changes } = r.json();
    expect(changes.added.map((x: { key: string }) => x.key)).toEqual([tyres.key]);
    expect(changes.changed.map((x: { key: string }) => x.key)).toEqual([charges.key]);
    expect(changes.removed.map((x: { key: string; cents: number }) => [x.key, x.cents])).toEqual([[receipt.key, 150_000]]);
    // What stayed the same wasn't touched.
    expect((await c<{ id: string }[]>`select journal_id as id from pocket_share_entries where key = ${invoice.key}`)[0]!.id).toBe(kept!.id);
    expect(await balance(c, 'bank', '2026-11-30')).toBe(-89_500);
    expect(await c`select 1 from journals where ledger_import_id is not null`).toHaveLength(3);
  });

  it('refuses an older share, and one that changes a closed period', async () => {
    expect((await bringIn(share(2, '2026-11-15', [invoice]))).json().error).toMatch(/older than share 2/);
    const c = await db();
    await c`update settings set lock_date = '2026-10-31'`;
    const changedOld = { ...invoice, description: 'Service, changed after the month closed (made up)' };
    const r = await bringIn(share(3, '2026-11-20', [changedOld, { ...charges, description: 'Bank charges for October (made up)' }, tyres], 2));
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/changes 1 entry on or before 2026-10-31, where these books are closed/);
    // The same closed period, unchanged, and something new after it: fine.
    const later: Tx = { key: 'cost:eee:2026-11-18', date: '2026-11-18', source: 'cost', reference: '', description: 'Fuel (made up)', lines: [{ code: '6999', cents: 30_000, memo: '' }, { code: '1000', cents: -30_000, memo: '' }] };
    const ok = await bringIn(share(3, '2026-11-20', [invoice, { ...charges, description: 'Bank charges for October (made up)' }, tyres, later], 2));
    expect(ok.statusCode, ok.body).toBe(200);
    await c`update settings set lock_date = null`;
  });

  it('opens a Pocket client’s books to read and compile only, even for the practice’s owner', async () => {
    const r = await owner.call({ method: 'POST', url: `/api/practice/clients/${id}/open`, payload: {} });
    expect(r.json().level).toBe('compile');
    const cookies = Object.fromEntries(r.cookies.filter((k) => k.value).map((k) => [k.name, k.value]));
    expect((await owner.call({ method: 'POST', url: '/api/clients', payload: { name: 'Made-up' }, cookies })).statusCode).toBe(403);
    expect((await owner.call({ method: 'GET', url: '/api/reports/trial-balance', cookies })).statusCode).toBe(200);
    await owner.call({ method: 'POST', url: '/api/practice/leave', payload: {}, cookies });
  });

  it('takes a share only for a Pocket client, from whoever writes up its books', async () => {
    const { id: kept } = await owner.post('/api/practice/clients', { name: 'Made-up Kept Client' });
    const r = await owner.call({ method: 'POST', url: `/api/practice/clients/${kept}/pocket-share`, payload: { name: 's.json', dataBase64: b64(share(1, '2026-10-31', [invoice])) } });
    expect(r.json().error).toMatch(/aren’t kept on Shap Pocket/);
    await expectCleanAudit(env.ctx.clients.get((await env.sql<{ dbName: string }[]>`select db_name from practice_clients where id = ${kept}`)[0]!.dbName));
  });
});
