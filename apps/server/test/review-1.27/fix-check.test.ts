/**
 * The check of the 1.27.0 review fixes (CPDAUDIT.md section 7, "The fixes, checked by a separate
 * agent"): what it found, each fixed, with the test that failed before it. All data made up.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTANT_TERMS_VERSION, FILING_SEASON_DATES, SARS_CHECKED_TO, financialYear } from '@shap/shared';
import { createDb } from '../../src/db/index.js';
import { ClientDbs, clientDbName, healthOf, MAX_CLIENT_POOLS, migrateClients, saveHealth } from '../../src/lib/practice.js';
import { buildStatements } from '../../src/statements/build.js';
import { expectCleanAudit, sessionFor, setup, type TestEnv } from '../helpers.js';

type Cookies = Record<string, string>;
type Who = Awaited<ReturnType<typeof sessionFor>>;
const PDF = Buffer.from('%PDF-1.4\n% made-up signed page\n').toString('base64');
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const pdfText = async (buf: Buffer) => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  let out = '';
  for (let n = 1; n <= doc.numPages; n++) out += (await (await doc.getPage(n)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ') + '\n';
  return out.replace(/\s+/g, ' ');
};

describe('the check of the 1.27.0 fixes', () => {
  let env: TestEnv;
  let owner: Who;
  let site: Who;
  let siteId: string;
  const made: string[] = [];
  let adds = 0;

  const pattern = () => `${env.ctx.clients.practiceDb.replace(/_/g, '\\_')}\\_\\_c\\_%`;
  const dropClients = async () => {
    for (const { datname } of await env.sql<{ datname: string }[]>`select datname from pg_database where datname like ${pattern()}`) await env.sql.unsafe(`drop database if exists "${datname}" with (force)`);
  };
  const addClient = async (name: string) => {
    const r = await owner.call({ method: 'POST', url: '/api/practice/clients', payload: { name }, remoteAddress: `10.28.0.${++adds}` });
    expect(r.statusCode, r.body).toBe(200);
    made.push(r.json().id);
    return r.json().id as string;
  };
  const open = async (who: Who, id: string, as?: string): Promise<Cookies> => {
    const r = await who.call({ method: 'POST', url: `/api/practice/clients/${id}/open`, payload: as ? { as } : {} });
    expect(r.statusCode, r.body).toBe(200);
    return Object.fromEntries(r.cookies.filter((c) => c.value).map((c) => [c.name, c.value]));
  };
  const dbNameOf = async (id: string) => (await env.sql<{ dbName: string }[]>`select db_name from practice_clients where id = ${id}`)[0]!.dbName;
  const clientDb = async (id: string) => env.ctx.clients.get(await dbNameOf(id));
  const give = (id: string, level: 'books' | 'compile' | null) => owner.post(`/api/practice/clients/${id}/access`, { access: level ? [{ userId: siteId, level }] : [] }, 'PUT');

  beforeAll(async () => {
    env = await setup();
    await dropClients();
    owner = await sessionFor(env, 'owner@example.co.za');
    site = await sessionFor(env, 'site@example.co.za');
    siteId = (await env.sql<{ id: string }[]>`select id from users where email = 'site@example.co.za'`)[0]!.id;
    await env.sql`update users set access_add = '{practice.clients}' where id = ${siteId}`;
    const { settings } = await owner.get('/api/reference');
    await owner.post('/api/practice/terms', { version: ACCOUNTANT_TERMS_VERSION });
    await owner.post('/api/settings', { ...settings, features: { ...settings.features, practice: true } }, 'PUT');
  }, 120_000);
  afterAll(async () => {
    for (const id of made) {
      const [c] = await env.sql<{ dbName: string | null }[]>`select db_name from practice_clients where id = ${id}`;
      if (c?.dbName) await expectCleanAudit(env.ctx.clients.get(c.dbName));
    }
    await expectCleanAudit(env.sql);
    await env.ctx.clients.end();
    await dropClients();
    await env.close();
  });

  it('refuses a page still in a closed client’s books, after its cookies went: nothing lands in the practice’s own (1)', async () => {
    const id = await addClient('Made-up Closed While Open CC');
    const c = await open(owner, id);
    await owner.post(`/api/practice/clients/${id}/archive`, { archived: true });
    const books = { 'x-shap-books': id };
    // The first refusal clears the cookies; the page sends the same again, without them.
    const first = await owner.call({ method: 'GET', url: '/api/live', cookies: c, headers: books });
    expect(first.statusCode).toBe(409);
    const before = (await env.sql<{ n: number }[]>`select count(*)::int as n from costs`)[0]!.n;
    const after = await owner.call({ method: 'POST', url: '/api/costs', payload: { date: '2026-11-03', description: 'Made-up', amountCents: 1000, supplier: 'Made-up', categoryId: null, sourceId: null }, headers: books });
    expect([after.statusCode, after.json().code]).toEqual([409, 'client_closed']);
    expect((await env.sql<{ n: number }[]>`select count(*)::int as n from costs`)[0]!.n).toBe(before);
    // The way back to the practice still works.
    expect((await owner.call({ method: 'GET', url: '/api/practice/here', headers: books })).statusCode).toBe(200);
  });

  it('words a recorded approval as recorded, shows the page signed, and keeps reopening it for the practice’s owner (2, 9)', async () => {
    const id = await addClient('Made-up Recorded Approval (Pty) Ltd');
    const db = await clientDb(id);
    await db`update settings set setup_done = true, business_type = 'company', fy_end_month = 2, address = '1 Made-up Street', features = features || '{"statements": true}'::jsonb`;
    const there = await open(owner, id);
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, who: Who = owner, cookies: Cookies = there) => who.call({ method, url, payload: payload as never, cookies });
    const inv = (await call('POST', '/api/documents', { kind: 'invoice', issueDate: '2025-06-01', lines: [{ category: 'labour', description: 'Work (made up)', qty: 1, unitPriceCents: 10_000 }] })).json();
    await call('POST', `/api/documents/${inv.id}/issue`);
    const details = (await call('GET', '/api/statements/details')).json();
    await call('PUT', '/api/statements/details', { ...details, directors: [{ name: 'Made-up Director', role: 'Director' }], ownerManaged: true });
    await give(id, 'compile');
    const compiler = await open(site, id);
    const compiled = await call('POST', '/api/statements/2026-02-28/compile', { date: '2026-06-01', compiler: { name: 'Made-up Compiler', qualification: 'Professional Accountant (SA)', body: 'SAIPA', number: '00000', practice: 'Made-up Practice' } }, site, compiler);
    expect(compiled.statusCode, compiled.body).toBe(200);
    const file = (await call('POST', '/api/attachments', { filename: 'signed.pdf', mime: 'application/pdf', dataBase64: PDF })).json();
    expect((await call('POST', '/api/statements/2026-02-28/approve', { name: 'Made-up Director', date: '2026-06-02', signedId: file.id })).statusCode).toBe(200);
    const [fs] = await db<{ pdf: Buffer }[]>`select a.bytes as pdf from financial_statements f join attachments a on a.id = f.final_pdf_id where f.fy_end = '2026-02-28'`;
    const text = await pdfText(fs!.pdf);
    expect(text).not.toMatch(/approved in Shap/);
    expect(text).toMatch(/Made-up Director, signed on 2 June 2026; recorded in Shap by \S.* from the signed page/);
    expect((await call('GET', '/api/statements/2026-02-28/approval-page')).body).toContain('made-up signed page');
    // Someone given the books to write up can't reopen the directors' approval; the practice's owner can.
    await give(id, 'books');
    const writer = await open(site, id);
    expect((await call('POST', '/api/statements/2026-02-28/reopen', { reason: 'Made-up' }, site, writer)).statusCode).toBe(403);
    expect((await call('POST', '/api/statements/2026-02-28/reopen', { reason: 'The directors asked (made up)' })).statusCode).toBe(200);
    expect((await db<{ s: string | null }[]>`select approval_signed_id::text as s from financial_statements where fy_end = '2026-02-28'`)[0]!.s).toBeNull();
    await give(id, null);
  });

  it('never ends a pool a request is still using, and keeps at most so many open (4)', async () => {
    const clients = new ClientDbs(env.ctx.config.DATABASE_URL);
    const names: string[] = [];
    for (let i = 0; i <= MAX_CLIENT_POOLS; i++) {
      const name = `${clients.practiceDb}__c_00000000${String(i).padStart(4, '0')}`;
      await env.sql.unsafe(`create database "${name}"`);
      names.push(name);
    }
    const first = clients.get(names[0]!);
    await first`select 1`;
    for (const n of names.slice(1)) await clients.get(n)`select 1`;
    expect(clients.open).toBeLessThanOrEqual(MAX_CLIENT_POOLS);
    // The first pool was let go, not ended: a request holding it carries on.
    await expect(first`select 1`).resolves.toBeTruthy();
    await first.end();
    await clients.end();
    for (const n of names) await env.sql.unsafe(`drop database if exists "${n}" with (force)`);
  });

  it('drops the database of a client the server stopped making (6), and one half made (accounting 10)', async () => {
    const [row] = await env.sql<{ id: string }[]>`insert into practice_clients (name, kind, created_at) values ('Made-up Interrupted', 'kept', now() - interval '2 hours') returning id`;
    const name = clientDbName(env.ctx.clients.practiceDb, row!.id);
    await env.sql.unsafe(`create database "${name}"`);
    await migrateClients(env.sql, new ClientDbs(env.ctx.config.DATABASE_URL), { info: () => undefined, warn: () => undefined });
    expect(await env.sql`select 1 from pg_database where datname = ${name}`).toHaveLength(0);
    expect(await env.sql`select 1 from practice_clients where id = ${row!.id}`).toHaveLength(0);
    // Its migrations failing as it's made: the database goes again.
    class Broken extends ClientDbs {
      override get(): ReturnType<ClientDbs['get']> {
        return createDb('postgres://postgres@localhost:5432/shap_no_such_database_made_up', { max: 1 });
      }
    }
    const broken = new Broken(env.ctx.config.DATABASE_URL);
    const half = `${broken.practiceDb}__c_00000000beef`;
    await expect(broken.create(env.sql, half, 'Made-up Half Made')).rejects.toThrow();
    expect(await env.sql`select 1 from pg_database where datname = ${half}`).toHaveLength(0);
  });

  it('works the returns out for the day the list is shown, not the day the checks ran (accounting 6)', async () => {
    const id = await addClient('Made-up Dated Returns CC');
    const db = await clientDb(id);
    await db`update settings set setup_done = true, business_type = 'company', vat_registered = true, vat_number = '4740101508', vat_category = 'A', fy_end_month = 2`;
    // Checked on 25 October: the VAT201 for August and September (due 30 October) was still to come.
    await saveHealth(env.sql, id, await healthOf(db, '2026-10-25'), new Date());
    const row = (await owner.get('/api/practice')).clients.find((c: { id: string }) => c.id === id);
    expect(row.health.deadlines.find((d: { key: string }) => d.key === 'vat201-2026-09-30')).toMatchObject({ due: '2026-10-30', past: true });
  });

  it('names an earlier ended year not approved yet (IFRS 5)', async () => {
    const id = await addClient('Made-up Two Years Open CC');
    const db = await clientDb(id);
    await db`update settings set setup_done = true, business_type = 'company', fy_end_month = 2, address = '1 Made-up Street'`;
    const there = await open(owner, id);
    for (const d of ['2024-06-01', '2025-06-01']) {
      const inv = (await owner.call({ method: 'POST', url: '/api/documents', payload: { kind: 'invoice', issueDate: d, lines: [{ category: 'labour', description: 'Work (made up)', qty: 1, unitPriceCents: 10_000 }] }, cookies: there })).json();
      await owner.call({ method: 'POST', url: `/api/documents/${inv.id}/issue`, cookies: there });
    }
    const h = await healthOf(db, '2026-11-16');
    expect(h.statements).toMatchObject({ yearEnd: '2026-02-28', unapprovedEarlier: '2025-02-28' });
  });

  it('checks the role a person is in as, not only that they’re in (security 3)', async () => {
    const id = await addClient('Made-up Role Check CC');
    await give(id, 'compile');
    const c = await open(site, id);
    // Made the client's owner behind the practice's back: refused, not let through.
    await (await clientDb(id))`update users set role = 'owner' where id = ${siteId}`;
    expect((await site.call({ method: 'POST', url: '/api/clients', payload: { name: 'Made-up' }, cookies: c })).statusCode).toBe(409);
    await give(id, null);
  });

  it('limits how fast clients are added', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await owner.call({ method: 'POST', url: '/api/practice/clients', payload: { name: '' }, remoteAddress: '10.29.0.1' })).statusCode);
    expect(codes.at(-1)).toBe(429);
  });

  it('names the one who approves a sole proprietor’s statements in the singular (8)', async () => {
    const db = await clientDb(await addClient('Made-up Sole Trader'));
    await db`update settings set setup_done = true, business_type = 'sole_prop', fy_end_month = 2`;
    const s = await buildStatements(db, '2026-02-28');
    expect(s.checks.some((c) => c.label === 'The owner who approves the statements is named')).toBe(true);
  });

  it('keeps a February year end for a trust brought in from a company file (7)', async () => {
    const db = await clientDb(await addClient('Made-up Family Trust'));
    const c = await open(owner, made.at(-1)!);
    const r = await owner.call({ method: 'POST', url: '/api/company-file', payload: { format: 'shap-company/1', settings: { businessType: 'trust', fyEndMonth: 6 } }, cookies: c });
    expect(r.statusCode, r.body).toBeLessThan(500);
    expect((await db<{ m: number }[]>`select fy_end_month as m from settings where id`)[0]!.m).toBe(2);
  });
});

describe('the words the check found (5, 8, 10, 11)', () => {
  it('says a wipe keeps the clients’ books', () => {
    const w = read('../../../web/src/components/WipeData.tsx').replace(/\s+/g, ' ');
    expect(w).toMatch(/Deletes this business’s own books on this server/);
    expect(w).toMatch(/your clients’ books, and the list of them and who opens each, stay too/);
  });
  it('tells a client’s books that the practice compiles and records the directors’ approval', () => {
    expect(read('../../../web/src/pages/FinancialStatements.tsx')).toMatch(/The practice compiles them here/);
  });
  it('names Regulation 29(5) only beside a review, never an audit', () => {
    expect(read('../../../web/src/pages/Practice.tsx')).toMatch(/\/audit\/i\.test\(st\.assurance\) \? '' :/);
  });
  it('sends an unexpected error on any screen in a client’s books to the practice’s Feedback', () => {
    expect(read('../../../web/src/lib/words.ts')).toMatch(/export let UNEXPECTED/);
    expect(read('../../../web/src/components/ClientBanner.tsx')).toMatch(/setClientWords\(Boolean\(x\.client\)\)/);
    expect(read('../../../web/src/lib/api.ts')).toMatch(/booksHere \? UNEXPECTED_IN_A_CLIENT : UNEXPECTED/);
  });
  it('has the filing season for the year before SARS_CHECKED_TO’s, so a new season isn’t missed', () => {
    const before = financialYear(`${Number(SARS_CHECKED_TO.slice(0, 4)) - 1}-02-01`, 2).end.slice(0, 4);
    expect(FILING_SEASON_DATES.some((d) => d.key.includes(before))).toBe(true);
  });
});
