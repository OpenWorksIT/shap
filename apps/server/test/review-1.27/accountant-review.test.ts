/**
 * The CPD reviews of Shap 1.27.0 (Shap Accountant, phase 1; CPDAUDIT.md section 7): each finding
 * fixed, with the test that failed before it. Security and privacy, accounting and arithmetic, and
 * IFRS for SMEs and company law here; SARS and tax, and the words, in their own files. All data
 * made up.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deadlinesFor, todayIso } from '@shap/shared';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Sql } from '../../src/db/index.js';
import { demoUrl, ensureDatabase } from '../../src/db/routing.js';
import { ClientDbs, findingsForList, healthOf, migrateClients, saveHealth, type ClientHealth } from '../../src/lib/practice.js';
import { runClientsMonthly } from '../../src/modules/monthly.js';
import { appVersion } from '../../src/modules/system.js';
import { expectCleanAudit, login, sessionFor, setup, type TestEnv } from '../helpers.js';

type Cookies = Record<string, string>;
type Who = Awaited<ReturnType<typeof sessionFor>>;
const PDF = Buffer.from('%PDF-1.4\n% made-up signed page\n').toString('base64');

describe('Shap Accountant 1.27.0: the reviews’ findings', () => {
  let env: TestEnv;
  let owner: Who;
  let site: Who;
  let siteId: string;
  let backups: string;
  const made: string[] = [];

  const dropClients = async () => {
    const pattern = `${env.ctx.clients.practiceDb.replace(/_/g, '\\_')}\\_\\_c\\_%`;
    for (const { datname } of await env.sql<{ datname: string }[]>`select datname from pg_database where datname like ${pattern}`) {
      await env.sql.unsafe(`drop database if exists "${datname}" with (force)`);
    }
  };
  const open = async (who: Who, id: string, as?: 'books' | 'compile'): Promise<Cookies> => {
    const r = await who.call({ method: 'POST', url: `/api/practice/clients/${id}/open`, payload: as ? { as } : {} });
    expect(r.statusCode, r.body).toBe(200);
    return Object.fromEntries(r.cookies.filter((c) => c.value).map((c) => [c.name, c.value]));
  };
  const inside = (who: Who, cookies: Cookies) => ({
    get: (url: string) => who.call({ method: 'GET', url, cookies }),
    send: (method: 'POST' | 'PUT', url: string, payload: unknown) => who.call({ method, url, payload: payload as never, cookies }),
    ok: async <T = any>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<T> => {
      const r = await who.call({ method, url, payload: payload as never, cookies });
      expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(400);
      return r.json() as T;
    },
  });
  // Each from its own address: adding clients is rate-limited.
  let adds = 0;
  const addClient = async (name: string) => {
    const r = await owner.call({ method: 'POST', url: '/api/practice/clients', payload: { name }, remoteAddress: `10.27.0.${++adds}` });
    expect(r.statusCode, r.body).toBe(200);
    const { id } = r.json() as { id: string };
    made.push(id);
    return id;
  };
  const dbNameOf = async (id: string) => (await env.sql<{ dbName: string }[]>`select db_name from practice_clients where id = ${id}`)[0]!.dbName;
  const clientDb = async (id: string) => env.ctx.clients.get(await dbNameOf(id));
  /** A client set up as a company with a February year end, VAT registered. */
  const setUp = async (id: string, extra: Partial<{ vat: boolean }> = {}) => {
    const db = await clientDb(id);
    await db`update settings set setup_done = true, business_type = 'company', vat_registered = ${extra.vat ?? false}, vat_number = ${extra.vat ? '4740101508' : ''}, address = '1 Made-up Street, Gqeberha 6001',
      vat_category = 'A', fy_end_month = 2, features = features || '{"statements": true}'::jsonb`;
    return db;
  };
  const give = (id: string, level: 'books' | 'compile') => owner.post(`/api/practice/clients/${id}/access`, { access: [{ userId: siteId, level }] }, 'PUT');

  beforeAll(async () => {
    backups = mkdtempSync(join(tmpdir(), 'shap-rev127-'));
    env = await setup({ env: { BACKUP_DIR: backups } });
    await dropClients();
    owner = await sessionFor(env, 'owner@example.co.za');
    site = await sessionFor(env, 'site@example.co.za');
    siteId = (await env.sql<{ id: string }[]>`select id from users where email = 'site@example.co.za'`)[0]!.id;
    await env.sql`update users set access_add = '{practice.clients}' where id = ${siteId}`;
    const { settings } = await owner.get('/api/reference');
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
    rmSync(backups, { recursive: true, force: true });
  });

  /* ---------------------------------------------------------------- security and privacy */

  describe('security and privacy', () => {
    it('signs out of the practice too when someone signs out in a client’s books (1)', async () => {
      const id = await addClient('Made-up Sign-out Test CC');
      const me = await sessionFor(env, 'owner@example.co.za');
      const c = await open(me, id);
      const out = await inside(me, c).send('POST', '/api/auth/logout', {});
      expect(out.statusCode).toBe(200);
      // The cookies the reply didn't clear are kept: the practice's own session is ended anyway.
      expect((await me.call({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
      expect((await me.call({ method: 'GET', url: '/api/auth/me', cookies: c })).statusCode).toBe(401);
    });

    it('lowering someone from writing up to compiling takes them out at once (3)', async () => {
      const id = await addClient('Made-up Downgrade Traders CC');
      await give(id, 'books');
      const there = inside(site, await open(site, id));
      expect((await there.send('POST', '/api/clients', { name: 'Made-up customer one' })).statusCode).toBe(200);
      await give(id, 'compile');
      const after = await there.send('POST', '/api/clients', { name: 'Made-up customer two' });
      expect(after.statusCode).toBe(409);
      // Opened again, as given now: reads, changes nothing; and can't ask for more than given.
      const again = inside(site, await open(site, id));
      expect((await again.send('POST', '/api/clients', { name: 'Made-up customer three' })).statusCode).toBe(403);
      expect((await site.call({ method: 'POST', url: `/api/practice/clients/${id}/open`, payload: { as: 'books' } })).statusCode).toBe(403);
      await owner.post(`/api/practice/clients/${id}/access`, { access: [] }, 'PUT');
    });

    it('sends nothing about a client to OpenWorks: no usage note, no prices (4)', async () => {
      const id = await addClient('Made-up Quiet Bakery (Pty) Ltd');
      const db = await clientDb(id);
      // A new client's books share nothing, whatever the defaults elsewhere.
      expect((await db<{ u: boolean; m: boolean }[]>`select usage_consent as u, market_consent as m from settings where id`)[0]).toEqual({ u: false, m: false });
      const sent: string[] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL | Request) => {
        sent.push(String(url));
        return new Response('{}', { status: 200 });
      }) as typeof fetch;
      try {
        const there = inside(owner, await open(owner, id));
        const { settings } = await there.ok('GET', '/api/reference');
        await there.ok('PUT', '/api/settings', { ...settings, usageConsent: true, marketConsent: true, setupDone: true });
        await new Promise((r) => setTimeout(r, 300));
      } finally {
        globalThis.fetch = realFetch;
      }
      expect(sent.filter((u) => u.includes('/collect'))).toEqual([]);
      expect((await db<{ s: string }[]>`select usage_sent as s from settings where id`)[0]!.s).toBe('');
    });

    it('lets no other database login connect to a client’s books (5)', async () => {
      const id = await addClient('Made-up Walled Garden CC');
      const name = await dbNameOf(id);
      const [p] = await env.sql<{ connect: boolean; temp: boolean }[]>`
        select has_database_privilege('public', ${name}, 'CONNECT') as connect, has_database_privilege('public', ${name}, 'TEMP') as temp`;
      expect(p).toEqual({ connect: false, temp: false });
    });

    it('keeps the server’s own security audit out of a client’s books (6)', async () => {
      const id = await addClient('Made-up Audit Wall CC');
      await give(id, 'books');
      const there = inside(site, await open(site, id));
      expect((await there.get('/api/audit/server')).statusCode).toBe(403);
      await owner.post(`/api/practice/clients/${id}/access`, { access: [] }, 'PUT');
    });

    it('migrates clients one at a time, leaving no pools open, and keeps a client that didn’t migrate closed (7; accounting 2)', async () => {
      const id = await addClient('Made-up Half-Migrated CC');
      const name = await dbNameOf(id);
      const db = await clientDb(id);
      const fresh = new ClientDbs(env.ctx.config.DATABASE_URL);
      const log = { info: () => undefined, warn: () => undefined };
      // 015 run again fails (its column is there already): this client stays behind.
      await db`delete from schema_migrations where name = '015_setup.sql'`;
      const r = await migrateClients(env.sql, fresh, log);
      expect(r.failed).toEqual([id]);
      expect(fresh.open).toBe(0);
      const [row] = await env.sql<{ migrateError: string | null }[]>`select migrate_error from practice_clients where id = ${id}`;
      expect(row!.migrateError).toBeTruthy();
      const opened = await owner.call({ method: 'POST', url: `/api/practice/clients/${id}/open`, payload: {} });
      expect([opened.statusCode, opened.json().code]).toEqual([409, 'not_migrated']);
      // Put right, and the next start opens it again.
      await db`insert into schema_migrations (name) values ('015_setup.sql')`;
      expect((await migrateClients(env.sql, fresh, log)).failed).toEqual([]);
      expect((await env.sql`select migrate_error from practice_clients where id = ${id}`)[0]!.migrateError).toBeNull();
      expect(name).toMatch(/__c_/);
      await fresh.end();
    });

    it('counts employees rather than naming them in what the practice keeps (8)', async () => {
      const id = await addClient('Made-up Payroll Privacy CC');
      const db = await setUp(id);
      let asked: boolean | undefined;
      await healthOf(db, '2026-11-16', undefined, {
        auditBooks: async (_db, _on, o) => {
          asked = o?.people;
          return [];
        },
      });
      expect(asked).toBe(false);
    });

    it('refuses never to make a database already there, and removes one half made (accounting 10)', async () => {
      const clients = new ClientDbs(env.ctx.config.DATABASE_URL);
      const name = `${clients.practiceDb}__c_000000000abc`;
      await env.sql.unsafe(`create database "${name}"`);
      await expect(clients.create(env.sql, name, 'Made-up Squatter')).rejects.toThrow(/there already/);
      await clients.drop(env.sql, name);
      expect(await env.sql`select 1 from pg_database where datname = ${name}`).toHaveLength(0);
      await clients.end();
    });
  });

  /* ---------------------------------------------------------------- accounting and arithmetic */

  describe('accounting and arithmetic', () => {
    it('keeps the books apart: an invoice, a receipt and a cost in a client’s books, none in the practice’s, and the checks counted exactly (11)', async () => {
      const id = await addClient('Made-up Spark Electrical (Pty) Ltd');
      await setUp(id, { vat: true });
      const before = (await env.sql<{ n: number }[]>`select count(*)::int as n from journal_lines`)[0]!.n + (await env.sql<{ n: number }[]>`select count(*)::int as n from documents`)[0]!.n;
      const there = inside(owner, await open(owner, id));
      const customer = await there.ok('POST', '/api/clients', { name: 'Made-up Guesthouse' });
      const inv = await there.ok('POST', '/api/documents', { kind: 'invoice', clientId: customer.id, issueDate: '2026-11-02', lines: [{ category: 'labour', description: 'Rewiring (made up)', qty: 1, unitPriceCents: 100_000 }] });
      await there.ok('POST', `/api/documents/${inv.id}/issue`);
      const { sources, categories } = await there.ok('GET', '/api/reference');
      await there.ok('POST', `/api/documents/${inv.id}/receipts`, { date: '2026-11-05', amountCents: 115_000, sourceId: sources[0].id, method: 'eft', reference: 'Made-up EFT' });
      await there.ok('POST', '/api/costs', { date: '2026-11-03', description: 'Cable (made up)', amountCents: 23_000, supplier: 'Made-up Wholesaler', categoryId: categories[0].id, sourceId: sources[0].id });
      await there.ok('POST', '/api/practice/leave', {});
      const after = (await env.sql<{ n: number }[]>`select count(*)::int as n from journal_lines`)[0]!.n + (await env.sql<{ n: number }[]>`select count(*)::int as n from documents`)[0]!.n;
      expect(after).toBe(before);
      const { health } = await owner.post(`/api/practice/clients/${id}/checks`);
      expect(health.audit.fail).toBe(0);
      expect(health.deadlines.some((d: { key: string }) => d.key.startsWith('vat201-'))).toBe(true);
    });

    it('keeps the practice’s clients through a wipe of its own books (1; IFRS 6)', async () => {
      const id = await addClient('Made-up Survivor Holdings (Pty) Ltd');
      const name = await dbNameOf(id);
      const { names } = await owner.get('/api/wipe');
      await owner.post('/api/wipe', { password: 'test-password-1', name: names[0] });
      // Switched on again, the client is there and opens.
      const { settings } = await owner.get('/api/reference');
      await owner.post('/api/settings', { ...settings, features: { ...settings.features, practice: true } }, 'PUT');
      const [row] = await env.sql<{ dbName: string }[]>`select db_name from practice_clients where id = ${id}`;
      expect(row?.dbName).toBe(name);
      expect((await inside(owner, await open(owner, id)).get('/api/practice/here')).json().client.id).toBe(id);
    });

    it('makes a client’s monthly invoices on their day, never emailed (3)', async () => {
      const id = await addClient('Made-up Hosting Monthly CC');
      const db = await setUp(id);
      const there = inside(owner, await open(owner, id));
      const customer = await there.ok('POST', '/api/clients', { name: 'Made-up Clinic', email: 'accounts@clinic.example' });
      const first = await there.ok('POST', '/api/documents', { kind: 'invoice', clientId: customer.id, issueDate: '2026-10-01', title: 'Hosting', lines: [{ category: 'other', description: 'Hosting (made up)', qty: 1, unitPriceCents: 50_000 }] });
      await there.ok('POST', `/api/documents/${first.id}/issue`);
      await there.ok('POST', `/api/documents/${first.id}/monthly`, { dayOfMonth: 1, startsOn: '2026-11-01', mode: 'draft', emailTo: '' });
      await there.ok('POST', '/api/practice/leave', {});
      expect(await runClientsMonthly(env.ctx, '2026-11-01')).toBe(1);
      expect((await db<{ n: number }[]>`select count(*)::int as n from documents where monthly_period = '2026-11'`)[0]!.n).toBe(1);
    });

    it('leaves the practice’s people out of a client’s directors, and doesn’t take it as owner-managed (4; IFRS 2)', async () => {
      const id = await addClient('Made-up Directors Test (Pty) Ltd');
      await setUp(id);
      const there = inside(owner, await open(owner, id));
      const d = await there.ok('GET', '/api/statements/details');
      expect(d.directors).toEqual([]);
      expect(d.ownerManaged).toBe(false);
    });

    it('checks the statements only for a year the books reach, and says when they couldn’t run (5; IFRS 3, 9)', async () => {
      const id = await addClient('Made-up New Start CC');
      const db = await setUp(id);
      const there = inside(owner, await open(owner, id));
      const inv = await there.ok('POST', '/api/documents', { kind: 'invoice', issueDate: '2026-06-01', lines: [{ category: 'labour', description: 'Work (made up)', qty: 1, unitPriceCents: 10_000 }] });
      await there.ok('POST', `/api/documents/${inv.id}/issue`);
      await there.ok('POST', '/api/practice/leave', {});
      // The books start in the year to February 2027: no year has ended for them yet.
      expect((await healthOf(db, '2026-11-16')).statements).toEqual({ yearEnd: null, firstYearEnds: '2027-02-28' });
      // A year that has ended, and the checks can't run: said, not left out.
      const later = await healthOf(db, '2027-04-10', undefined, {
        auditBooks: async (_db, on) => {
          if (on === '2027-02-28') throw new Error('made-up failure');
          return [];
        },
      });
      expect(later.statements).toEqual({ yearEnd: '2027-02-28', error: true });
    });

    it('runs the books audit at the year end too, and puts the fails first in the list (8; IFRS 4)', async () => {
      const id = await addClient('Made-up Year End Audit CC');
      const db = await setUp(id);
      const inv = await (async () => {
        const there = inside(owner, await open(owner, id));
        const x = await there.ok('POST', '/api/documents', { kind: 'invoice', issueDate: '2025-06-01', lines: [{ category: 'labour', description: 'Work (made up)', qty: 1, unitPriceCents: 10_000 }] });
        await there.ok('POST', `/api/documents/${x.id}/issue`);
        await there.ok('POST', '/api/practice/leave', {});
        return x;
      })();
      expect(inv.id).toBeTruthy();
      const h = await healthOf(db, '2026-11-16', undefined, {
        auditBooks: async (_db, on) => (on === '2026-02-28' ? [{ level: 'fail', section: 'VAT', text: 'the VAT201 and the VAT account disagree for 2025-04-01 to 2025-05-31 (made up)' }] : []),
      });
      expect(h.statements && 'failing' in h.statements && h.statements.failing).toContain('Books check at the year end: the VAT201 and the VAT account disagree for 2025-04-01 to 2025-05-31 (made up)');
      const many = [...Array.from({ length: 13 }, (_, i) => ({ level: 'warn', section: 'S', text: `warning ${i}` })), { level: 'fail', section: 'S', text: 'the one to fix' }];
      const list = findingsForList(many);
      expect([list.fail, list.warn, list.items.length, list.items[0]!.text]).toEqual([1, 13, 12, 'the one to fix']);
    });

    it('waits for the checks on the way back, keeps the newest, and works the returns out for the day they’re shown (6; IFRS 10; SARS 2)', async () => {
      const id = await addClient('Made-up Fresh List CC');
      await setUp(id, { vat: true });
      const opened = Date.now();
      const there = inside(owner, await open(owner, id));
      await there.ok('POST', '/api/practice/leave', {});
      const row = (await owner.get('/api/practice')).clients.find((c: { id: string }) => c.id === id);
      expect(new Date(row.healthAt).getTime()).toBeGreaterThanOrEqual(opened - 1000);
      // A slower run that started earlier doesn't overwrite it.
      const stale = { ...row.health, company: 'Stale (made up)' } as ClientHealth;
      await saveHealth(env.sql, id, stale, new Date(opened - 60_000));
      expect((await env.sql<{ company: string }[]>`select health->>'company' as company from practice_clients where id = ${id}`)[0]!.company).toBe('Made-up Fresh List CC');
      // Returns from what they're worked out from, today: past or not by today's date.
      const now = todayIso('Africa/Johannesburg');
      expect(row.health.deadlines).toEqual(deadlinesFor(row.health.deadlineInputs, now));
    });

    it('doesn’t close a month in a client’s books on the way out (7)', async () => {
      const id = await addClient('Made-up Locked Out CC');
      const db = await setUp(id);
      await db`update settings set month_end_mode = 'auto', month_end_day = 1, lock_date = null`;
      await give(id, 'compile');
      const there = inside(site, await open(site, id));
      await there.ok('POST', '/api/practice/leave', {});
      expect((await db<{ lock: string | null }[]>`select lock_date::text as lock from settings where id`)[0]!.lock).toBeNull();
      expect(await db`select 1 from audit_log where action = 'lock'`).toHaveLength(0);
      await owner.post(`/api/practice/clients/${id}/access`, { access: [] }, 'PUT');
    });

    it('says an employer registered for PAYE has EMP201s, nil ones included (SARS 6)', async () => {
      const id = await addClient('Made-up Seasonal Farm (Pty) Ltd');
      const db = await setUp(id);
      await db`update settings set paye_ref = '7000000000'`;
      const h = await healthOf(db, '2026-11-17');
      expect(h.deadlineInputs?.employer).toBe(true);
      expect(deadlinesFor(h.deadlineInputs!, '2026-11-17').some((d) => d.key === 'emp201-2026-10')).toBe(true);
    });
  });

  /* ---------------------------------------------------------------- IFRS for SMEs and company law */

  describe('IFRS for SMEs and company law', () => {
    it('the practice compiles, and records the directors’ approval with the page they signed, never gives it (1, 2, 5, 8)', async () => {
      const id = await addClient('Made-up Signed Off (Pty) Ltd');
      const db = await setUp(id);
      const ownerThere = inside(owner, await open(owner, id));
      const inv = await ownerThere.ok('POST', '/api/documents', { kind: 'invoice', issueDate: '2025-06-01', lines: [{ category: 'labour', description: 'Work (made up)', qty: 1, unitPriceCents: 10_000 }] });
      await ownerThere.ok('POST', `/api/documents/${inv.id}/issue`);
      // Nobody named to approve: compiling waits for them.
      await give(id, 'compile');
      const compiler = inside(site, await open(site, id));
      const compile = { date: '2026-06-01', compiler: { name: 'Made-up Compiler', qualification: 'Professional Accountant (SA)', body: 'SAIPA', number: '00000', practice: 'Made-up Practice' } };
      const early = await compiler.send('POST', '/api/statements/2026-02-28/compile', compile);
      expect(early.statusCode).toBe(400);
      expect(early.json().error).toMatch(/directors who approve the statements are named/);
      // The list says an independent review is called for (not owner-managed), apart from what's to look at.
      const before = await healthOf(db, '2026-11-16');
      expect(before.statements && 'assurance' in before.statements && before.statements.assurance).toMatch(/review/i);
      const details = await ownerThere.ok('GET', '/api/statements/details');
      await ownerThere.ok('PUT', '/api/statements/details', { ...details, directors: [{ name: 'Made-up Director', role: 'Director' }], ownerManaged: true });
      await compiler.ok('POST', '/api/statements/2026-02-28/compile', compile);
      // The practice's owner can't upload a compiler's report in a client's books.
      const file = await ownerThere.ok('POST', '/api/attachments', { filename: 'signed approval.pdf', mime: 'application/pdf', dataBase64: PDF });
      expect((await ownerThere.send('POST', '/api/statements/2026-02-28/compiler-report', { attachmentId: file.id, compilerName: 'Made-up', date: '2026-06-01' })).statusCode).toBe(403);
      // Without the signed page, or for someone not named: refused.
      expect((await ownerThere.send('POST', '/api/statements/2026-02-28/approve', { name: 'Made-up Director', date: '2026-06-02' })).statusCode).toBe(400);
      expect((await ownerThere.send('POST', '/api/statements/2026-02-28/approve', { name: 'Owner', date: '2026-06-02', signedId: file.id })).statusCode).toBe(400);
      await ownerThere.ok('POST', '/api/statements/2026-02-28/approve', { name: 'Made-up Director', date: '2026-06-02', signedId: file.id });
      const [fs] = await db<{ status: string; signed: string | null }[]>`select status, approval_signed_id::text as signed from financial_statements where fy_end = '2026-02-28'`;
      expect(fs).toEqual({ status: 'approved', signed: file.id });
      expect(await db`select 1 from audit_log where action = 'record_statements_approval'`).toHaveLength(1);
      // The list says where they stand.
      const after = await healthOf(db, '2026-11-16');
      expect(after.statements).toMatchObject({ yearEnd: '2026-02-28', status: 'approved', changedSince: false, unapprovedEarlier: null });
      await owner.post(`/api/practice/clients/${id}/access`, { access: [] }, 'PUT');
    });

    it('lets the practice’s owner, only, download a client’s own backups, with their password (7)', async () => {
      const id = await addClient('Made-up Records Kept CC');
      const name = `${await dbNameOf(id)}-daily-2026-11-15_0200.dump`;
      writeFileSync(join(backups, name), 'made-up backup');
      writeFileSync(join(backups, `${env.ctx.clients.practiceDb}-daily-2026-11-15_0200.dump`), 'the practice’s own (made up)');
      const list = await owner.get(`/api/practice/clients/${id}/backups`);
      expect(list.backups.map((b: { name: string }) => b.name)).toEqual([name]);
      await env.sql`update users set access_add = '{practice.clients,practice.manage}' where id = ${siteId}`;
      expect((await site.call({ method: 'GET', url: `/api/practice/clients/${id}/backups` })).statusCode).toBe(403);
      await env.sql`update users set access_add = '{practice.clients}' where id = ${siteId}`;
      expect((await owner.call({ method: 'POST', url: `/api/practice/clients/${id}/backups/${name}/link`, payload: { password: 'not-it' } })).statusCode).toBe(400);
      const { url } = await owner.post(`/api/practice/clients/${id}/backups/${name}/link`, { password: 'test-password-1' });
      const got = await owner.call({ method: 'GET', url });
      expect([got.statusCode, got.body]).toEqual([200, 'made-up backup']);
    });
  });
});

/* ---------------------------------------------------------------- the demo company and the practice */

describe('the demo company and the practice’s clients (security 2)', () => {
  let env: TestEnv;
  let app: FastifyInstance;
  let demoSql: Sql;

  beforeAll(async () => {
    env = await setup();
    const config = loadConfig({ ...process.env });
    const url = demoUrl(config.DATABASE_URL);
    await ensureDatabase(env.sql, url);
    demoSql = createDb(url, { max: 3 });
    await demoSql.unsafe('drop schema public cascade; create schema public;');
    ({ app } = await buildApp({ config, sql: env.sql, demoSql, mailer: { send: async () => {} } }));
    await app.ready();
  }, 120_000);
  afterAll(async () => {
    await app.close();
    await demoSql.end();
    await env.close();
  });

  it('never reaches the real practice’s list, its people or its clients from the demo', async () => {
    const owner = await login(app, 'owner@example.co.za');
    const { settings } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...settings, features: { ...settings.features, practice: true } }, 'PUT');
    // A client row only (no database needed for the walls).
    const [c] = await env.sql<{ id: string }[]>`insert into practice_clients (name, kind) values ('Made-up Real Client CC', 'kept') returning id`;
    const r = await owner.call({ method: 'POST', url: '/api/demo/enter', payload: {} });
    const demoCookies = Object.fromEntries(r.cookies.map((k) => [k.name, k.value]));
    const demo = (method: 'GET' | 'PUT', url: string, payload?: unknown) => owner.call({ method, url, payload: payload as never, cookies: demoCookies, headers: { 'x-shap-version': appVersion() } });
    expect((await demo('GET', '/api/practice')).statusCode).toBe(403);
    expect((await demo('PUT', `/api/practice/clients/${c!.id}`, { name: 'Renamed in the demo' })).statusCode).toBe(403);
    expect((await demo('PUT', `/api/practice/clients/${c!.id}/access`, { access: [] })).statusCode).toBe(403);
    expect((await demo('GET', '/api/audit/server')).statusCode).toBe(403);
    expect((await demo('GET', '/api/practice/here')).statusCode).toBe(200);
    expect((await env.sql<{ name: string }[]>`select name from practice_clients where id = ${c!.id}`)[0]!.name).toBe('Made-up Real Client CC');
    await env.sql`delete from practice_clients where id = ${c!.id}`;
  }, 60_000);
});
