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
import { entryHash, figuresHash, POCKET_SHARE_FORMAT, SHARE_TABLES, SHARE_USER_COLUMNS, shareEntries, TERMS_VERSION, type PocketShare } from '@shap/shared';
import { auditBooks } from '../../src/audit/books.js';
import { freshTotals } from '../../src/lib/books.js';
import { healthOf } from '../../src/lib/practice.js';
import { trialBalance } from '../../src/modules/reports.js';
import { vat201 } from '../../src/modules/taxforms.js';
import { readPocketShare } from '../../src/modules/import/pocket-share.js';
import { buildStatements } from '../../src/statements/build.js';
import { createUser } from '../../src/auth.js';
import type { Sql } from '../../src/db/index.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

const BOOKS = '7a1c9a4e-2f6b-4c1d-9a3e-5b8d2c6f1a01';

/** A share of `src`'s books, the way Pocket's engine makes one (modules/share.ts). */
async function makeShare(src: Sql, o: { number: number; madeAt: string; through: string; books?: string; previous?: number | null }): Promise<PocketShare> {
  await freshTotals(src);
  const records: Record<string, Record<string, unknown>[]> = {};
  for (const t of SHARE_TABLES) {
    const rows = await src.unsafe<{ j: string }[]>(`select row_to_json(t)::text as j from ${t.table} t`);
    records[t.table] = rows.map((r) => {
      const row = JSON.parse(r.j) as Record<string, unknown>;
      for (const c of t.leaveOut ?? []) delete row[c];
      for (const c of SHARE_USER_COLUMNS) if (c in row) row[c] = null;
      return row;
    });
  }
  const entries = await shareEntries(src as never, o.through);
  return {
    format: POCKET_SHARE_FORMAT,
    stamp: { number: o.number, madeAt: o.madeAt, through: o.through, previous: o.previous ? { number: o.previous, madeAt: '2026-10-01T08:00:00.000Z' } : null, app: 'Shap Pocket', books: o.books ?? BOOKS, version: '1.11.0' },
    records,
    entries: entries.map((e) => ({ key: e.key, hash: entryHash(e), figures: figuresHash(e) })),
    changes: { added: 0, changed: 0, removed: 0 },
  };
}
const b64 = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64');
const tbOf = async (db: Sql, d: string) => (await trialBalance(db, d)).rows.map((r) => [r.code, Number(r.balanceCents)] as [string, number]).filter(([, c]) => c !== 0);
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
    await me.post('/api/settings', { ...settings, companyName: 'Made-up Spark (Pty) Ltd', businessType: 'company', fyEndMonth: 2, vatRegistered: true, vatNumber: '4740101508', vatCategory: 'B', payeRegistered: true, payeRef: '7230767891', features: { ...settings.features, dividends: true, statements: true } }, 'PUT');
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

  it('two shares at once go in one after the other (security 3)', async () => {
    await me.post('/api/costs', { date: '2026-11-12', description: 'Tape (made up)', supplier: 'Made-up Wholesaler', amountCents: 1_000, categoryId: await r.cat('Parts'), sourceId: await r.src('Business bank') });
    const three = await makeShare(phone.sql, { number: 3, madeAt: '2026-11-13T08:00:00.000Z', through: '2026-11-13', previous: 2 });
    const four = await makeShare(phone.sql, { number: 4, madeAt: '2026-11-13T09:00:00.000Z', through: '2026-11-13', previous: 3 });
    const both = await Promise.all([bringIn(four), bringIn(three)]);
    expect(both.some((x) => x.statusCode === 200)).toBe(true);
    const db = await copy();
    expect((await db<{ n: number }[]>`select max(number)::int as n from pocket_shares`)[0]!.n).toBe(4);
    expect(await tbOf(db, '2026-11-13')).toEqual(await tbOf(phone.sql, '2026-11-13'));
  });

  it('a phone restored from an older backup: a lower number made later comes in, marked so', async () => {
    const res = await bringIn(await makeShare(phone.sql, { number: 2, madeAt: '2026-11-14T08:00:00.000Z', through: '2026-11-14', previous: 1 }));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().restored).toBe(true);
  });

  it('in the copy, the practice compiles and approves; the books themselves change only in Shap Pocket', async () => {
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
    await expectCleanAudit(await copy(), '2026-11-17');
    await expectCleanAudit(phone.sql, '2026-11-17');
  });

  it('a share made by Shap Pocket’s own engine (test/fixtures) comes in entry for entry, so the two apps read the same records the same way', async () => {
    const file = readFileSync(join(import.meta.dirname, '../fixtures/pocket-share-1.11.json'));
    const { id: other } = await owner.post('/api/practice/clients', { name: 'Made-up Mobile Sparky', kind: 'pocket' });
    const res = await owner.call({ method: 'POST', url: `/api/practice/clients/${other}/pocket-share`, payload: { name: 'Made-up Mobile Sparky share 1.json', dataBase64: file.toString('base64'), acceptTerms: true }, remoteAddress: '10.67.0.1' });
    expect(res.statusCode, res.body).toBe(200);
    const db = env.ctx.clients.get((await env.sql<{ dbName: string }[]>`select db_name from practice_clients where id = ${other}`)[0]!.dbName);
    const tb = new Map(await tbOf(db, '2026-11-17'));
    // The invoice (R1 000 + VAT) paid, the cable (R200 + VAT), a day's labour (R400), the bank charges (R95).
    expect(tb.get('1000')).toBe(115_000 - 23_000 - 9_500);
    expect([...tb.values()].reduce((a, b) => a + b, 0)).toBe(0);
    expect(await vat201(db, '2026-09-01', '2026-10-31')).toMatchObject({ field1: 115_000, field4: 15_000, field15: 3_000 });
    await expectCleanAudit(db, '2026-11-17');
  });

  it('who may bring one in is asked before anything about the client is said (security 11)', async () => {
    await createUser(env.sql, { name: 'Made-up Clerk', email: 'clerk@example.co.za', password: 'test-password-1', role: 'staff', accessAdd: ['practice.clients'] });
    const clerk = await login(env.app, 'clerk@example.co.za');
    const res = await bringIn({ not: 'a share' }, { who: clerk });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/for the practice’s owner, or whoever is given their books to write up/);
    await expectCleanAudit(env.sql);
  });
});
