/**
 * Shap Accountant, phase 3 (docs/ACCOUNTANT.md, "A Shap Pocket share"): a one-person business's
 * Shap Pocket books, shared from their phone, brought into the practice's copy of them. A second
 * database plays the phone: its books are made through the app as Pocket's are (the same accounting
 * code and tables), and its shares made with the same shared code Pocket uses (records, entries,
 * hashes). The reviews of 1.29 (CPDAUDIT.md) each have a test here. Every figure made up.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { entriesOff, entryHash, POCKET_SHARE_FORMAT, SHARE_TABLES, TERMS_VERSION, type PocketShare, type ShareEntry } from '@shap/shared';
import { auditBooks } from '../../src/audit/books.js';
import { healthOf } from '../../src/lib/practice.js';
import { sdlLine } from '../../src/modules/payroll.js';
import { vat201 } from '../../src/modules/taxforms.js';
import { readPocketShare } from '../../src/modules/import/pocket-share.js';
import { buildStatements } from '../../src/statements/build.js';
import { createUser } from '../../src/auth.js';
import type { Sql } from '../../src/db/index.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';
import { b64, makeShare as makeShareOf, tbOf } from './phone.js';

const BOOKS = '7a1c9a4e-2f6b-4c1d-9a3e-5b8d2c6f1a01';
/** The VAT201 of the fixtures' books, September and October 2026, as Pocket's own VAT201 has it. */
const FIXTURE_VAT = { field1: 119_600, field4: 15_600, field15: 3_000, field20: 12_600 };
const PDF = Buffer.from('%PDF-1.4\n% made-up signed page\n').toString('base64');

/** A share of the phone's books (phone.ts), these books' unless said. */
const makeShare = (src: Sql, o: { number: number; madeAt: string; through: string; books?: string; previous?: number | null }) => makeShareOf(src, { ...o, books: o.books ?? BOOKS });
/** What a year's statements say, figure by figure. */
const figuresOf = (s: Awaited<ReturnType<typeof buildStatements>>) =>
  JSON.stringify({
    profit: s.sci.profit,
    revenue: s.sci.revenue.map((l) => [l.label, l.current]),
    assets: s.sfp.assets.map((b) => b.lines.map((l) => [l.label, l.current])),
    liabilities: s.sfp.liabilities.map((b) => b.lines.map((l) => [l.label, l.current])),
    operating: s.scf.operating.map((l) => [l.label, l.current]),
    investing: s.scf.investing.map((l) => [l.label, l.current]),
    financing: s.scf.financing.map((l) => [l.label, l.current]),
    soce: s.soce.rows.map((r) => [r.label, r.values]),
  });

describe('reading a Shap Pocket share', () => {
  const ok = (over: Partial<PocketShare> = {}) => ({ format: POCKET_SHARE_FORMAT, stamp: { number: 1, madeAt: '2026-11-01T08:00:00.000Z', through: '2026-11-01', previous: null, app: 'Shap Pocket', books: BOOKS, version: '1.11.0' }, records: { settings: [{ id: true, business_type: 'company' }] }, entries: [], changes: { added: 0, changed: 0, removed: 0 }, ...over });
  const read = (x: unknown) => () => readPocketShare('share.json', Buffer.from(JSON.stringify(x)));
  it('refuses what isn’t a share, or is doctored (security 5, 6, 7)', () => {
    expect(read(ok())).not.toThrow();
    expect(read('{"format":"shap-pocket-share/9"}')).toThrow(/isn’t a share this Shap can read\. If they’ve updated Shap Pocket, this Shap may need updating too/);
    expect(read(ok({ stamp: { ...ok().stamp, number: 2_147_483_647 } } as never))).toThrow(/this Shap may need updating/);
    expect(read(ok({ stamp: { ...ok().stamp, through: '9999-12-30' } } as never))).toThrow(/this Shap may need updating/);
    expect(read(ok({ records: { settings: [{ id: true }], costs: [{ amount_cents: 2 ** 53 - 1 }] } } as never))).toThrow(/bigger than any Shap keeps/);
    expect(read(ok({ records: { settings: [{ id: true }], costs: [{ 'amount; drop': 1 }] } } as never))).toThrow(/a column Shap doesn’t know/);
    expect(read(ok({ records: { settings: [{ id: true }], users: [{ id: 'x' }] } } as never))).toThrow(/this Shap may need updating/);
    const e = { key: 'cost:a:2026-10-01', hash: 'a'.repeat(64), figures: 'b'.repeat(64) };
    expect(read(ok({ entries: [e, e] }))).toThrow(/same entry twice/);
    expect(read(ok({ records: { costs: [] } } as never))).toThrow(/no business details/);
  });

  it('checks a share’s entries in one pass: many thousands don’t hold up the server (check 4)', () => {
    const made = (n: number): ShareEntry[] => Array.from({ length: n }, (_, i) => ({ key: `cost:${String(i).padStart(8, '0')}:2026-10-01`, date: '2026-10-01', source: 'cost', reference: '', description: 'Made-up', lines: [{ code: '1000', cents: -i - 1, memo: '' }, { code: '6030', cents: i + 1, memo: '' }] }));
    const ours = made(60_000);
    const theirs = ours.map((e) => ({ key: e.key, hash: entryHash(e) }));
    // The hashing alone, then the whole check: no more than a little over it (one comparing every
    // entry with every other took seconds at this size).
    let at = performance.now();
    for (const e of ours) entryHash(e);
    const hashing = performance.now() - at;
    at = performance.now();
    expect(entriesOff(theirs, ours)).toBe(0);
    expect(performance.now() - at).toBeLessThan(hashing * 3 + 500);
    // One missing, one changed, one the share hasn't got.
    expect(entriesOff([...theirs.slice(1), { key: 'cost:x:2026-10-02', hash: 'a'.repeat(64) }].map((e, i) => (i === 5 ? { ...e, hash: 'b'.repeat(64) } : e)), ours)).toBe(3);
  });
});

describe('a Shap Pocket client in the practice', () => {
  let env: TestEnv;
  let phone: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  let me: Awaited<ReturnType<typeof login>>;
  let id: string;
  let r: Awaited<ReturnType<typeof ref>>;
  let cost: { id: string };
  let client: { id: string };
  let n = 0;
  const srcDb = `${new URL(process.env.DATABASE_URL!).pathname.slice(1)}_phone`;
  const drop = async () => {
    const pattern = `${env.ctx.clients.practiceDb.replace(/_/g, '\\_')}\\_\\_c\\_%`;
    for (const { datname } of await env.sql<{ datname: string }[]>`select datname from pg_database where datname like ${pattern}`) await env.sql.unsafe(`drop database if exists "${datname}" with (force)`);
  };
  const copy = async () => env.ctx.clients.get((await env.sql<{ dbName: string }[]>`select db_name from practice_clients where id = ${id}`)[0]!.dbName);
  const bringIn = (file: unknown, o: { who?: typeof owner; terms?: boolean; name?: string } = {}) =>
    (o.who ?? owner).call({ method: 'POST', url: `/api/practice/clients/${id}/pocket-share`, payload: { name: o.name ?? 'Made-up Spark share.json', dataBase64: b64(file), acceptTerms: o.terms ?? false }, remoteAddress: `10.66.${(++n >> 8) & 255}.${n & 255}` });
  const open = async (as: 'books' | 'compile' = 'books') => {
    const res = await owner.call({ method: 'POST', url: `/api/practice/clients/${id}/open`, payload: { as } });
    expect(res.statusCode, res.body).toBe(200);
    const cookies = Object.fromEntries(res.cookies.filter((c) => c.value).map((c) => [c.name, c.value]));
    return { get: (url: string) => owner.call({ method: 'GET', url, cookies }), send: (method: 'POST' | 'PUT', url: string, payload: unknown) => owner.call({ method, url, payload: payload as never, cookies }) };
  };

  beforeAll(async () => {
    // The phone: books of their own, made through the app.
    const base = await setup();
    await base.sql.unsafe(`drop database if exists "${srcDb}" with (force)`);
    await base.sql.unsafe(`create database "${srcDb}"`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${srcDb}`;
    phone = await setup({ env: { DATABASE_URL: url.toString() } });
    env = base;
    await drop();
    me = await login(phone.app, 'owner@example.co.za');
    r = await ref(phone.sql);
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, companyName: 'Made-up Spark (Pty) Ltd', businessType: 'company', fyEndMonth: 2, vatRegistered: true, vatNumber: '4740101508', vatCategory: 'B', payeRegistered: true, payeRef: '7230767891', sdl: true, features: { ...settings.features, dividends: true, statements: true, inventory: true } }, 'PUT');
    client = await me.post('/api/clients', { name: 'Made-up Guesthouse', email: 'guesthouse@example.co.za', address: '1 Made-up Road, Fictional Town' });
    // Last year: a sale and its money in.
    const old = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: '2025-06-10', lines: [{ category: 'labour', description: 'Rewiring (made up)', qty: 1, unitPriceCents: 200_000 }] });
    await me.post(`/api/documents/${old.id}/issue`);
    await me.post(`/api/documents/${old.id}/receipts`, { date: '2025-06-20', amountCents: 230_000, sourceId: await r.src('Business bank') });
    // This year: a standard-rated sale, a zero-rated export, a cost with VAT, an asset bought and sold, a dividend paid.
    const inv = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: '2026-07-05', lines: [{ category: 'labour', description: 'Wiring (made up)', qty: 1, unitPriceCents: 100_000 }, { category: 'materials', description: 'Exported panel (made up)', qty: 1, unitPriceCents: 50_000, vatCode: 'export' }] });
    await me.post(`/api/documents/${inv.id}/issue`);
    cost = await me.post('/api/costs', { date: '2026-07-03', description: 'Cable (made up)', supplier: 'Made-up Wholesaler', amountCents: 23_000, vatCents: 3_000, vatCode: 'standard', categoryId: await r.cat('Parts'), sourceId: await r.src('Business bank') });
    await me.post('/api/assets', { name: 'Made-up trailer', category: 'vehicles', purchaseDate: '2026-03-10', costCents: 6_000_000, sourceId: await r.src('Business bank'), lifeMonths: 60, disposedOn: '2026-08-31', disposalProceedsCents: 8_000_000, disposalSourceId: await r.src('Business bank') });
    await me.post('/api/dividends', { declaredOn: '2026-07-01', paidOn: '2026-11-02', shareholder: 'Made-up Shareholder', grossCents: 1_000_000, sourceId: await r.src('Business bank') });
    // Stock bought and sold over the counter, part of it refunded: refunds and stock records are
    // never changed or deleted in Shap, and each share replaces them (check 2).
    const till = (await phone.sql<{ id: string }[]>`select id from payment_sources where till`)[0]!.id;
    const globe = await me.post('/api/items', { description: 'LED globe (made up)', unitPriceCents: 4_600, priceIncludesVat: true, stocked: true });
    await me.post('/api/stock/purchases', { date: '2026-10-01', supplier: 'Made-up Wholesale', reference: 'MW-1', sourceId: await r.src('Business bank'), lines: [{ itemId: globe.id, qtyInvoiced: 10, unitCostCents: 2_000 }] });
    const sale = await me.post('/api/sales', { date: '2026-10-10', sourceId: till, method: 'cash', lines: [{ itemId: globe.id, description: 'LED globe (made up)', qty: 2, unitPriceCents: 4_600 }] });
    await me.post(`/api/documents/${sale.id}/refund`, { date: '2026-10-11', sourceId: till, reason: 'Wrong fitting (made up)', lines: [{ lineId: sale.lines[0].id, qty: 1, restock: true }] });
    // A day's labour (SARS 8) and provisional tax paid (SARS 4).
    const worker = await me.post('/api/workers', { name: 'Made-up Thabo', kind: 'casual', dayRateCents: 40_000 });
    await me.post('/api/labour', { date: '2026-10-07', entries: [{ workerId: worker.id, days: 1, wageCents: 40_000 }] });
    await me.post('/api/sars-payments', { kind: 'irp6', period: '2027-02', date: '2026-08-31', amountCents: 50_000, sourceId: await r.src('Business bank'), reference: 'Made-up IRP6' });
    // Last year: tools (an expense) and vehicle finance (a liability), whose kind and line can change on the phone (check 1).
    const tools = await me.post('/api/accounts', { code: '6990', name: 'Made-up tools', type: 'expense' });
    const finance = await me.post('/api/accounts', { code: '2410', name: 'Made-up vehicle finance', type: 'liability' });
    await me.post('/api/journals', { date: '2025-08-01', description: 'Tools (made up)', lines: [{ accountId: tools.id, debitCents: 300_000 }, { accountId: await r.acc('bank'), creditCents: 300_000 }] });
    await me.post('/api/journals', { date: '2025-09-01', description: 'Vehicle finance (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 1_000_000 }, { accountId: finance.id, creditCents: 1_000_000 }] });

    owner = await login(env.app, 'owner@example.co.za');
    const s2 = (await owner.get('/api/reference')).settings;
    await owner.post('/api/settings', { ...s2, features: { ...s2.features, practice: true } }, 'PUT');
    ({ id } = await owner.post('/api/practice/clients', { name: 'Made-up Spark (Pty) Ltd', kind: 'pocket' }));
  });
  afterAll(async () => {
    await env.ctx.clients.end();
    await drop();
    await phone.close();
    await env.sql.unsafe(`drop database if exists "${srcDb}" with (force)`);
    await env.close();
  });

  it('the first share asks for the practice’s acceptance of the terms, then brings the books in as the phone has them (words 5)', async () => {
    const one = await makeShare(phone.sql, { number: 1, madeAt: '2026-11-10T08:00:00.000Z', through: '2026-11-10' });
    const no = await bringIn(one);
    expect(no.statusCode).toBe(400);
    expect(no.json().error).toMatch(/Tick that you accept the terms of use/);
    const res = await bringIn(one, { terms: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ number: 1, first: true, restored: false, changes: { added: 0, changed: 0, removed: 0 } });
    const db = await copy();
    expect((await db<{ termsVersion: string }[]>`select terms_version from settings where id`)[0]!.termsVersion).toBe(TERMS_VERSION);
    // The same trial balance as the phone's, at every date.
    for (const d of ['2026-02-28', '2026-07-31', '2026-11-10']) { if (process.env.DBG) console.log(d, JSON.stringify(await tbOf(db, d)), JSON.stringify(await tbOf(phone.sql, d))); expect(await tbOf(db, d)).toEqual(await tbOf(phone.sql, d)); }
    // Their people's contact details stayed on the phone.
    expect((await db<{ email: string | null }[]>`select email from clients`)[0]!.email ?? '').toBe('');
    // The record keeps the file's fingerprint, and counts, not descriptions (security 10, IFRS 7).
    const [rec] = await db<{ fileHash: string; changes: Record<string, unknown> }[]>`select file_hash, changes from pocket_shares`;
    expect(rec!.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(rec!.changes).sort()).toEqual(['added', 'changed', 'removed']);
  });

  it('the copy’s VAT201, statements and returns are worked out from the same records as the phone’s (SARS 1–6, IFRS 1–2)', async () => {
    const db = await copy();
    // The VAT201's boxes: the documents' VAT codes came across (box 2A, the export, included).
    const theirs = await vat201(phone.sql, '2026-07-01', '2026-08-31');
    expect(theirs.field2A).toBe(5_000_000 / 100);
    expect(await vat201(db, '2026-07-01', '2026-08-31')).toEqual(theirs);
    // The statements, figure by figure, for this year and last.
    for (const fy of ['2026-02-28', '2027-02-28']) expect(figuresOf(await buildStatements(db, fy))).toBe(figuresOf(await buildStatements(phone.sql, fy)));
    // The disposal is proceeds in investing, not a negative purchase.
    const s = await buildStatements(db, '2027-02-28');
    expect(s.scf.investing.some((l) => /proceeds/i.test(l.label) && l.current > 0)).toBe(true);
    // The practice list: an employer (PAYE registered), and the dividend's tax return by the day it was paid.
    const h = await healthOf(db, '2026-11-17');
    expect(h.deadlineInputs).toMatchObject({ employer: true, vatRegistered: true });
    expect(h.deadlineInputs!.dividendsPaid).toContain('2026-11-02');
    // Nothing in the copy says the VAT came "from another package".
    expect((await auditBooks(db, '2026-11-17')).map((i) => i.text).join(' ')).not.toMatch(/another package/);
    // Provisional tax paid on the phone is paid in the copy (SARS 4), and its day wages are on the
    // SDL reminder (SARS 8): from the records themselves.
    const prov = async (sql: Sql) => (await sql<{ amountCents: number }[]>`select amount_cents from sars_payments where kind = 'irp6' and period = '2027-02'`).map((p) => Number(p.amountCents));
    expect(await prov(db)).toEqual([50_000]);
    const inside = await open('compile');
    const theirsTax = (await me.get('/api/reports/provisional-tax?fyEnd=2027-02-28')).payments;
    expect((await inside.get('/api/reports/provisional-tax?fyEnd=2027-02-28')).json().payments.map((p: { amountCents: number }) => p.amountCents)).toEqual(theirsTax.map((p: { amountCents: number }) => p.amountCents));
    expect(await sdlLine(db, true, '2026-11-17')).toEqual(await sdlLine(phone.sql, true, '2026-11-17'));
    expect((await sdlLine(db, true, '2026-11-17'))!.dayWagesCents).toBe(40_000);
    // Every record the phone has is the copy's: the partners, the SARS payments, the assets sold,
    // the day labour and the rest (what the share carries), by their ids where they have them.
    const withId = new Set((await db<{ t: string }[]>`select table_name as t from information_schema.columns where table_schema = 'public' and column_name = 'id'`).map((x) => x.t));
    for (const t of SHARE_TABLES.filter((x) => !['settings', 'accounts', 'statement_details'].includes(x.table))) {
      const rows = async (sql: Sql) => (await sql.unsafe<{ k: string }[]>(withId.has(t.table) ? `select id::text as k from ${t.table} order by 1` : `select count(*)::text as k from ${t.table}`)).map((x) => x.k);
      expect(await rows(db), t.table).toEqual(await rows(phone.sql));
    }
    expect((await db<{ n: number }[]>`select count(*)::int as n from refunds`)[0]!.n).toBe(1);
  });

  it('the same share again is already here; a lower one made earlier is refused (words 3)', async () => {
    const one = await makeShare(phone.sql, { number: 1, madeAt: '2026-11-10T08:00:00.000Z', through: '2026-11-10' });
    const again = await bringIn(one);
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe('Shap already has share 1 of these books: there’s nothing new to bring in.');
    expect(again.json().error).not.toMatch(/older than/);
  });

  it('a share of other books is refused, and the copy’s books are as they were (accounting 4, security 2)', async () => {
    const other = await makeShare(phone.sql, { number: 9, madeAt: '2026-11-11T08:00:00.000Z', through: '2026-11-11', books: '0c4b7a2e-9d1f-4e3a-8b5c-6a7d8e9f0a12' });
    const res = await bringIn(other);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/This share is of other books \(Made-up Spark \(Pty\) Ltd\), not these/);
  });

  it('a share Shap reads into other entries than the phone did is refused, and nothing comes in', async () => {
    const bad = await makeShare(phone.sql, { number: 2, madeAt: '2026-11-11T08:00:00.000Z', through: '2026-11-11', previous: 1 });
    bad.entries[0] = { ...bad.entries[0]!, hash: 'f'.repeat(64) };
    const res = await bringIn(bad);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Shap reads share 2 into 1 entry other than the Shap Pocket that made it \(1\.11\.0\) did, so nothing came in/);
    expect((await (await copy())`select count(*)::int as n from pocket_shares`)[0]!.n).toBe(1);
  });

  it('counts what changed: an entry moved to another day is one changed entry (accounting 6, 7)', async () => {
    await me.post(`/api/costs/${cost.id}`, { date: '2026-07-04', description: 'Cable (made up)', supplier: 'Made-up Wholesaler', amountCents: 23_000, vatCents: 3_000, vatCode: 'standard', categoryId: await r.cat('Parts'), sourceId: await r.src('Business bank') }, 'PUT');
    await me.post('/api/costs', { date: '2026-11-11', description: 'Conduit (made up)', supplier: 'Made-up Wholesaler', amountCents: 5_000, categoryId: await r.cat('Parts'), sourceId: await r.src('Business bank') });
    const res = await bringIn(await makeShare(phone.sql, { number: 2, madeAt: '2026-11-12T08:00:00.000Z', through: '2026-11-12', previous: 1 }));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().changes).toMatchObject({ added: 1, changed: 1, removed: 0 });
    expect(await tbOf(await copy(), '2026-11-12')).toEqual(await tbOf(phone.sql, '2026-11-12'));
  });

  it('two shares at once go in one after the other, the later one’s books last (security 3, check 6)', async () => {
    // Shares 3 and 4 differ: a cost in 3 that's gone again by 4, and another in its place.
    const tape = await me.post('/api/costs', { date: '2026-11-12', description: 'Tape (made up)', supplier: 'Made-up Wholesaler', amountCents: 1_000, categoryId: await r.cat('Parts'), sourceId: await r.src('Business bank') });
    const three = await makeShare(phone.sql, { number: 3, madeAt: '2026-11-13T08:00:00.000Z', through: '2026-11-13', previous: 2 });
    await phone.sql`delete from costs where id = ${tape.id}`;
    await me.post('/api/costs', { date: '2026-11-12', description: 'Glue (made up)', supplier: 'Made-up Wholesaler', amountCents: 3_000, categoryId: await r.cat('Parts'), sourceId: await r.src('Business bank') });
    const four = await makeShare(phone.sql, { number: 4, madeAt: '2026-11-13T09:00:00.000Z', through: '2026-11-13', previous: 3 });
    const theirs = await tbOf(phone.sql, '2026-11-13');
    const both = await Promise.all([bringIn(four), bringIn(three)]);
    // Either 3 then 4 (both come in), or 4 first and 3 refused as older: never the two at once.
    expect(both[0]!.statusCode, both[0]!.body).toBe(200);
    if (both[1]!.statusCode !== 200) expect(both[1]!.json().error).toMatch(/This is share 3, and Shap already has share 4 of these books: ask them for their latest share/);
    const db = await copy();
    const numbers = (await db<{ number: number }[]>`select number from pocket_shares order by imported_at, number`).map((x) => x.number);
    expect(numbers.at(-1)).toBe(4);
    expect(await tbOf(db, '2026-11-13')).toEqual(theirs);
    expect((await db<{ n: number }[]>`select count(*)::int as n from costs where description = 'Tape (made up)'`)[0]!.n).toBe(0);
  });

  it('a phone restored from an older backup: a lower number made later comes in, marked so', async () => {
    const res = await bringIn(await makeShare(phone.sql, { number: 2, madeAt: '2026-11-14T08:00:00.000Z', through: '2026-11-14', previous: 1 }));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().restored).toBe(true);
  });

  it('in the copy, the practice compiles and records the approval; the books themselves change only in Shap Pocket', async () => {
    const inside = await open('books');
    const no = await inside.send('POST', '/api/costs', { date: '2026-11-14', description: 'Made-up', amountCents: 100, categoryId: await r.cat('Parts'), sourceId: await r.src('Business bank') });
    expect(no.statusCode).toBe(403);
    expect(no.json().error).toMatch(/they change them in Shap Pocket and share them again/);
    // Compiling is the accountant's, signed in as themselves.
    const compiling = await open('compile');
    const details = (await compiling.get('/api/statements/2026-02-28')).json().details;
    const saved = await compiling.send('PUT', '/api/statements/details', { ...details, directors: [{ name: 'Made-up Director', role: 'Director' }] });
    expect(saved.statusCode, saved.body).toBe(200);
    const compiled = await compiling.send('POST', '/api/statements/2026-02-28/compile', { date: '2026-11-15', compiler: { name: 'Made-up Compiler', qualification: 'Professional Accountant (SA)', body: 'SAIPA', number: '00000', practice: 'Made-up Practice' } });
    expect(compiled.statusCode, compiled.body).toBe(200);
    // Recording the directors' approval records it, and nothing else: the year ends and closed
    // months are the owner's, from the phone.
    const writing = await open('books');
    const signed = await writing.send('POST', '/api/attachments', { filename: 'signed approval.pdf', mime: 'application/pdf', dataBase64: PDF });
    expect(signed.statusCode, signed.body).toBe(200);
    const approved = await writing.send('POST', '/api/statements/2026-02-28/approve', { name: 'Made-up Director', date: '2026-11-16', signedId: signed.json().id });
    expect(approved.statusCode, approved.body).toBe(200);
    const db = await copy();
    expect((await db<{ status: string }[]>`select status from financial_statements where fy_end = '2026-02-28'`)[0]!.status).toBe('approved');
    expect(await db`select 1 from year_ends where fy_end = '2026-02-28'`).toHaveLength(0);
    expect((await db<{ lockDate: string | null }[]>`select lock_date::text as lock_date from settings where id`)[0]!.lockDate).toBeNull();
  });

  it('a compiled year: its figures can’t move, its wording can, and its business details can’t change (security 1, IFRS 3, accounting 3)', async () => {
    // A name changed in last year's entries: figures the same, so it comes in.
    await phone.sql`update clients set name = 'Made-up Guesthouse and Spa' where id = ${client.id}`;
    const renamed = await bringIn(await makeShare(phone.sql, { number: 5, madeAt: '2026-11-15T08:00:00.000Z', through: '2026-11-15', previous: 2 }));
    expect(renamed.statusCode, renamed.body).toBe(200);
    // Last year's receipt moved by a day: a change to a compiled year's figures, refused and listed.
    await phone.sql`update receipts set date = '2025-06-21' where date = '2025-06-20'`;
    const moved = await bringIn(await makeShare(phone.sql, { number: 6, madeAt: '2026-11-16T08:00:00.000Z', through: '2026-11-16', previous: 5 }));
    expect(moved.statusCode).toBe(400);
    expect(moved.json().error).toMatch(/Share 6 changes 1 entry on or before 28 Feb 2026, where the statements were compiled here: 2[01] Jun 2025 · /);
    await phone.sql`update receipts set date = '2025-06-20' where date = '2025-06-21'`;
    // The year end moved under the compiled year: refused.
    await phone.sql`update settings set fy_end_month = 6`;
    const yearEnd = await bringIn(await makeShare(phone.sql, { number: 7, madeAt: '2026-11-17T08:00:00.000Z', through: '2026-11-17', previous: 5 }));
    expect(yearEnd.statusCode).toBe(400);
    expect(yearEnd.json().error).toMatch(/changes the year end, and the statements to 28 Feb 2026 were drawn up on them here/);
    await phone.sql`update settings set fy_end_month = 2`;
    // An account's kind, or the line it's shown on, changed on the phone: what the approved year's
    // statements show would move, its entries the same. Refused, and the statements as they were (check 1).
    const db = await copy();
    const before = figuresOf(await buildStatements(db, '2026-02-28'));
    await phone.sql`update accounts set type = 'asset' where code = '6990'`;
    const kind = await bringIn(await makeShare(phone.sql, { number: 8, madeAt: '2026-11-17T09:00:00.000Z', through: '2026-11-17', previous: 5 }));
    expect(kind.statusCode).toBe(400);
    expect(kind.json().error).toMatch(/Share 8 changes what the statements to 28 Feb 2026 show, where they were compiled here: an account’s kind or the line it’s shown on/);
    await phone.sql`update accounts set type = 'expense' where code = '6990'`;
    await phone.sql`update accounts set statement_line = 'borrowings_non_current' where code = '2410'`;
    const line = await bringIn(await makeShare(phone.sql, { number: 8, madeAt: '2026-11-17T09:00:00.000Z', through: '2026-11-17', previous: 5 }));
    expect(line.statusCode).toBe(400);
    await phone.sql`update accounts set statement_line = null where code = '2410'`;
    expect(figuresOf(await buildStatements(db, '2026-02-28'))).toBe(before);
    // In a year still open, an account's kind follows the phone from share to share (accounting 1).
    const hand = await me.post('/api/accounts', { code: '6991', name: 'Made-up hand tools', type: 'expense' });
    await me.post('/api/journals', { date: '2026-11-03', description: 'Hand tools (made up)', lines: [{ accountId: hand.id, debitCents: 20_000 }, { accountId: await r.acc('bank'), creditCents: 20_000 }] });
    const eight = await bringIn(await makeShare(phone.sql, { number: 8, madeAt: '2026-11-17T09:00:00.000Z', through: '2026-11-17', previous: 5 }));
    expect(eight.statusCode, eight.body).toBe(200);
    await phone.sql`update accounts set type = 'asset' where code = '6991'`;
    const nine = await bringIn(await makeShare(phone.sql, { number: 9, madeAt: '2026-11-17T10:00:00.000Z', through: '2026-11-17', previous: 8 }));
    expect(nine.statusCode, nine.body).toBe(200);
    expect((await db<{ type: string }[]>`select type from accounts where code = '6991'`)[0]!.type).toBe('asset');
    expect(figuresOf(await buildStatements(db, '2027-02-28'))).toBe(figuresOf(await buildStatements(phone.sql, '2027-02-28')));
    await expectCleanAudit(await copy(), '2026-11-17');
    await expectCleanAudit(phone.sql, '2026-11-17');
  });

  it('shares made by Shap Pocket’s own engine (test/fixtures, from its share-file test) come in entry for entry, the second after a refund too (check 2)', async () => {
    const fixture = (n: string) => readFileSync(join(import.meta.dirname, `../fixtures/${n}`));
    const { id: other } = await owner.post('/api/practice/clients', { name: 'Made-up Mobile Sparky', kind: 'pocket' });
    const send = (n: string, i: number) =>
      owner.call({ method: 'POST', url: `/api/practice/clients/${other}/pocket-share`, payload: { name: `Made-up Mobile Sparky ${n}`, dataBase64: fixture(n).toString('base64'), acceptTerms: true }, remoteAddress: `10.67.0.${i}` });
    const first = await send('pocket-share-1.11.json', 1);
    expect(first.statusCode, first.body).toBe(200);
    const db = env.ctx.clients.get((await env.sql<{ dbName: string }[]>`select db_name from practice_clients where id = ${other}`)[0]!.dbName);
    expect((await db<{ n: number }[]>`select count(*)::int as n from refunds`)[0]!.n).toBe(1);
    // The second share replaces the refund with the phone's, as every share replaces every record.
    const second = await send('pocket-share-1.11-2.json', 2);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().changes).toMatchObject({ added: 1, changed: 0, removed: 0 });
    const tb = new Map(await tbOf(db, '2026-11-17'));
    // The invoice (R1 000 + VAT) paid, the cable (R200 + VAT), the bank charges (R95), the tape (R15);
    // the cost dated 20 December not yet.
    expect(tb.get('1000')).toBe(115_000 - 23_000 - 9_500 - 1_500);
    expect([...tb.values()].reduce((a, b) => a + b, 0)).toBe(0);
    expect(new Map(await tbOf(db, '2026-12-31')).get('1000')).toBe(115_000 - 23_000 - 9_500 - 1_500 - 1_000);
    // On the VAT201: the invoice and the counter sale less the half refunded; the cable's VAT.
    expect(await vat201(db, '2026-09-01', '2026-10-31')).toMatchObject(FIXTURE_VAT);
    // What stayed on the phone isn't here: the trip's places, the brand's address.
    expect((await db<{ toPlace: string | null }[]>`select to_place from trips`)[0]!.toPlace ?? '').toBe('');
    await expectCleanAudit(db, '2026-11-17');
  });

  it('who may bring one in is asked before anything about the client is said (security 11)', async () => {
    await createUser(env.sql, { name: 'Made-up Clerk', email: 'clerk@example.co.za', password: 'test-password-1', role: 'staff', accessAdd: ['practice.clients'] });
    const clerk = await login(env.app, 'clerk@example.co.za');
    const res = await bringIn({ not: 'a share' }, { who: clerk });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/for the practice’s owner, or whoever is given their books to write up/);
    // A client kept here: the clerk isn't told it isn't on Shap Pocket; the owner is.
    const { id: kept } = await owner.post('/api/practice/clients', { name: 'Made-up Kept Client', kind: 'kept' });
    const at = (who: typeof owner) => who.call({ method: 'POST', url: `/api/practice/clients/${kept}/pocket-share`, payload: { name: 'x.json', dataBase64: b64({ not: 'a share' }) }, remoteAddress: `10.68.0.${++n & 255}` });
    const theirs = await at(clerk);
    expect(theirs.statusCode).toBe(403);
    expect(theirs.json().error).not.toMatch(/Shap Pocket\./);
    const ours = await at(owner);
    expect(ours.statusCode).toBe(400);
    expect(ours.json().error).toBe('This client’s books aren’t kept on Shap Pocket.');
    // Asked before the file is read: a body that isn't even JSON is refused as theirs to send, not read.
    const unread = await clerk.call({ method: 'POST', url: `/api/practice/clients/${id}/pocket-share`, payload: '{"name": "x.json", "dataBase64": "', headers: { 'content-type': 'application/json' }, remoteAddress: `10.68.1.${++n & 255}` });
    expect(unread.statusCode).toBe(403);
    expect(unread.json().error).toMatch(/for the practice’s owner, or whoever is given their books to write up/);
    await expectCleanAudit(env.sql);
  });
});
