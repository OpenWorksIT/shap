/**
 * Shap Accountant, phase 1 (docs/ACCOUNTANT.md): the practice keeps clients' books, each in a
 * database of its own; its people open the clients they're given; every check runs for every
 * client. The walls: a request reaches a client's database only after the practice's own session,
 * the feature, the client and the person's access are all checked, and a session in one client's
 * books means nothing in another's. All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTANT_TERMS_VERSION, deadlinesFor } from '@shap/shared';
import { dbScope } from '../../src/db/routing.js';
import { appVersion } from '../../src/modules/system.js';
import { expectCleanAudit, login, setup, type TestEnv } from '../helpers.js';

const V = { 'x-shap-version': appVersion() };
type Cookies = Record<string, string>;

describe('Shap Accountant: a practice and the clients it keeps', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  let site: Awaited<ReturnType<typeof login>>;
  let siteId: string;
  const made: string[] = [];

  const dropClients = async () => {
    const pattern = `${env.ctx.clients.practiceDb.replace(/_/g, '\\_')}\\_\\_c\\_%`;
    for (const { datname } of await env.sql<{ datname: string }[]>`select datname from pg_database where datname like ${pattern}`) {
      await env.sql.unsafe(`drop database if exists "${datname}" with (force)`);
    }
  };
  /** Opens a client and returns the cookies that keep it open. */
  const open = async (who: typeof owner, id: string): Promise<Cookies> => {
    const r = await who.call({ method: 'POST', url: `/api/practice/clients/${id}/open`, payload: {} });
    expect(r.statusCode, r.body).toBe(200);
    return Object.fromEntries(r.cookies.filter((c) => c.value).map((c) => [c.name, c.value]));
  };
  const inside = (who: typeof owner, cookies: Cookies) => ({
    get: (url: string) => who.call({ method: 'GET', url, cookies }),
    send: (method: 'POST' | 'PUT', url: string, payload: unknown) => who.call({ method, url, payload: payload as never, cookies }),
  });
  const addClient = async (name: string) => {
    const { id } = await owner.post<{ id: string }>('/api/practice/clients', { name });
    made.push(id);
    return id;
  };
  const clientDb = async (id: string) => {
    const [c] = await env.sql<{ dbName: string }[]>`select db_name from practice_clients where id = ${id}`;
    return env.ctx.clients.get(c!.dbName);
  };

  beforeAll(async () => {
    env = await setup();
    await dropClients();
    owner = await login(env.app, 'owner@example.co.za');
    site = await login(env.app, 'site@example.co.za');
    const [s] = await env.sql<{ id: string }[]>`select id from users where email = 'site@example.co.za'`;
    siteId = s!.id;
  });
  afterAll(async () => {
    for (const id of made) {
      const [c] = await env.sql<{ dbName: string }[]>`select db_name from practice_clients where id = ${id}`;
      if (c?.dbName) await expectCleanAudit(env.ctx.clients.get(c.dbName));
    }
    await expectCleanAudit(env.sql);
    await env.ctx.clients.end();
    await dropClients();
    await env.close();
  });

  it('is off until the owner switches it on', async () => {
    const r = await owner.call({ method: 'GET', url: '/api/practice' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/Shap Accountant is off/);
    const { settings } = await owner.get('/api/reference');
    await owner.post('/api/practice/terms', { version: ACCOUNTANT_TERMS_VERSION });
    await owner.post('/api/settings', { ...settings, features: { ...settings.features, practice: true } }, 'PUT');
    expect((await owner.get('/api/practice')).clients).toEqual([]);
  });

  it('keeps a client’s books in a database of their own: what’s done there stays there', async () => {
    const id = await addClient('Pretend Plumbing (Pty) Ltd');
    const c = await open(owner, id);
    expect(Object.keys(c).sort()).toEqual(['shap_client', 'shap_client_session']);
    const there = inside(owner, c);
    expect((await there.get('/api/practice/here')).json().client).toEqual({ id, name: 'Pretend Plumbing (Pty) Ltd' });
    const ref = (await there.get('/api/reference')).json();
    expect(ref.settings.companyName).toBe('Pretend Plumbing (Pty) Ltd');
    // In the client's books, as the owner there: a customer of theirs.
    const add = await there.send('POST', '/api/clients', { name: 'Made-up Customer of the Plumber' });
    expect(add.statusCode, add.body).toBe(200);
    const db = await clientDb(id);
    expect((await db`select name from clients`).map((r) => r.name)).toContain('Made-up Customer of the Plumber');
    // Not in the practice's own books.
    expect((await env.sql`select 1 from clients where name = 'Made-up Customer of the Plumber'`).length).toBe(0);
    // What was done is in the client's own audit trail, by the practice person who did it.
    const [who] = await db<{ name: string }[]>`select u.name from audit_log a join users u on u.id = a.user_id where a.entity = 'client' order by a.at desc limit 1`;
    expect(who?.name).toBe('Owner');
    // Back to the practice: the cookies go, and the client's session with them.
    const leave = await there.send('POST', '/api/practice/leave', {});
    expect(leave.statusCode).toBe(200);
    expect(leave.cookies.filter((k) => ['shap_client', 'shap_client_session'].includes(k.name)).every((k) => k.value === '')).toBe(true);
    expect((await there.get('/api/practice/here')).json().client).toBeNull();
    expect((await db`select count(*)::int as n from sessions`)[0]!.n).toBe(0);
  });

  it('opens a client only for the people given it, and only as they were given it', async () => {
    const id = await addClient('Fictional Bakery CC');
    // Staff without the task, or with it but not given this client: no.
    expect((await site.call({ method: 'POST', url: `/api/practice/clients/${id}/open`, payload: {} })).statusCode).toBe(403);
    await env.sql`update users set access_add = '{practice.clients}' where id = ${siteId}`;
    expect((await site.call({ method: 'POST', url: `/api/practice/clients/${id}/open`, payload: {} })).statusCode).toBe(403);
    // Given it to compile: in the client's books as its accountant (reads, changes nothing).
    await owner.post(`/api/practice/clients/${id}/access`, { access: [{ userId: siteId, level: 'compile' }] }, 'PUT');
    const list = await site.get('/api/practice');
    expect(list.clients.map((x: { name: string }) => x.name)).toEqual(['Fictional Bakery CC']);
    const c = await open(site, id);
    const there = inside(site, c);
    expect((await there.get('/api/reports/trial-balance')).statusCode).toBe(200);
    expect((await there.send('POST', '/api/clients', { name: 'Made-up' })).statusCode).toBe(403);
    // Taken off the client: out of its books at once, back in the practice's own.
    await owner.post(`/api/practice/clients/${id}/access`, { access: [] }, 'PUT');
    expect((await there.get('/api/practice/here')).json().client).toBeNull();
    const change = await there.send('POST', '/api/clients', { name: 'Made-up' });
    expect(change.statusCode).toBe(409);
    expect(change.json()).toMatchObject({ code: 'client_closed', error: expect.stringMatching(/no longer open/) });
    await env.sql`update users set access_add = '{}' where id = ${siteId}`;
  });

  it('a session in one client’s books opens no other client’s, and a cookie changed by hand opens nothing', async () => {
    const a = await addClient('Made-up Electrical (Pty) Ltd');
    const b = await addClient('Pretend Painters CC');
    const c = await open(owner, a);
    // Client B's id with client A's session: not a session in B's books, so back to the practice.
    const forged = inside(owner, { ...c, shap_client: b });
    expect((await forged.get('/api/practice/here')).json().client).toBeNull();
    expect((await forged.send('POST', '/api/clients', { name: 'Made-up Intruder' })).statusCode).toBe(409);
    // Reading isn't let through either: nothing from the practice's own books under the client's name.
    expect((await forged.get('/api/reports/trial-balance')).statusCode).toBe(409);
    expect((await (await clientDb(b))`select 1 from clients where name = 'Made-up Intruder'`).length).toBe(0);
    // Not an id at all.
    expect((await inside(owner, { ...c, shap_client: "x' or '1'='1" }).get('/api/practice/here')).json().client).toBeNull();
    // Someone signed out of the practice can't use a client's cookies alone.
    const alone = await env.app.inject({ method: 'GET', url: '/api/reference', headers: V, cookies: c });
    expect(alone.statusCode).toBe(401);
  });

  it('keeps what isn’t for a client’s books out of them', async () => {
    const id = await addClient('Fictional Florist (Pty) Ltd');
    const there = inside(owner, await open(owner, id));
    for (const url of ['/api/system', '/api/users', '/api/practice', '/api/wipe', '/api/test-server/status', '/api/audit/server', '/api/feedback']) {
      expect((await there.get(url)).statusCode, url).toBe(403);
    }
    expect((await there.get('/api/practice/here')).statusCode).toBe(200);
    // No email from a client's books (the practice's mailbox isn't the client's).
    const scope = { demo: false, client: { id, name: 'Fictional Florist (Pty) Ltd', sql: await clientDb(id) } };
    await expect(dbScope.run(scope, () => env.ctx.mailer.send({ to: 'someone@example.com', subject: 'Made up', text: 'Made up' }))).rejects.toThrow(/Email isn’t sent from a client’s books/);
    await there.send('POST', '/api/practice/leave', {});
  });

  it('doesn’t open an archived client, and closes it for anyone who had it open', async () => {
    const id = await addClient('Pretend Panelbeaters CC');
    const there = inside(owner, await open(owner, id));
    await owner.post(`/api/practice/clients/${id}/archive`, { archived: true });
    expect((await there.get('/api/practice/here')).json().client).toBeNull();
    const again = await owner.call({ method: 'POST', url: `/api/practice/clients/${id}/open`, payload: {} });
    expect(again.statusCode).toBe(400);
    await owner.post(`/api/practice/clients/${id}/archive`, { archived: false });
    expect((await inside(owner, await open(owner, id)).get('/api/practice/here')).json().client.id).toBe(id);
  });

  it('runs three of Shap’s checks on a client’s books for the list: the books audit, the statements’ checks, how far they’re closed; and the returns due', async () => {
    const id = await addClient('Made-up Movers (Pty) Ltd');
    const db = await clientDb(id);
    await db`update settings set setup_done = true, business_type = 'company', vat_registered = true, vat_number = '4740101508', vat_category = 'A', fy_end_month = 2`;
    const { health } = await owner.post(`/api/practice/clients/${id}/checks`);
    expect(health.company).toBe('Made-up Movers (Pty) Ltd');
    expect(health.audit).toEqual(expect.objectContaining({ fail: expect.any(Number), warn: expect.any(Number) }));
    expect(health.deadlines.some((d: { label: string }) => /^VAT201 for /.test(d.label))).toBe(true);
    const list = await owner.get('/api/practice');
    const row = list.clients.find((x: { id: string }) => x.id === id);
    expect(row.health.company).toBe('Made-up Movers (Pty) Ltd');
    expect(row.healthAt).toBeTruthy();
  });

  it('adds clients and gives them out only for those who manage the practice', async () => {
    await env.sql`update users set access_add = '{practice.clients}' where id = ${siteId}`;
    expect((await site.call({ method: 'POST', url: '/api/practice/clients', payload: { name: 'Made-up' } })).statusCode).toBe(403);
    expect((await site.call({ method: 'PUT', url: `/api/practice/clients/${made[0]}/access`, payload: { access: [] } })).statusCode).toBe(403);
    await env.sql`update users set access_add = '{}' where id = ${siteId}`;
  });
});

describe('the returns coming up for a client', () => {
  it('works out the VAT201 and the EMP201 from the client’s own settings', () => {
    const due = deadlinesFor({ businessType: 'company', vatRegistered: true, vatCategory: 'A', fyEndMonth: 2, turnoverTax: false, employer: true }, '2026-11-17');
    // Category A ends in odd months: October and November, due the last business day of December;
    // August and September's was due on Friday 30 October (the 31st a Saturday).
    expect(due).toContainEqual({ key: 'vat201-2026-11-30', label: 'VAT201 for Oct to Nov 26 (on eFiling; by the 25th otherwise)', due: '2026-12-31', past: false });
    expect(due).toContainEqual({ key: 'vat201-2026-09-30', label: 'VAT201 for Aug to Sep 26 (on eFiling; by the 25th otherwise)', due: '2026-10-30', past: true });
    // October's EMP201: the 7th is a Saturday, so Friday 6 November, already past.
    expect(due).toContainEqual({ key: 'emp201-2026-10', label: 'EMP201 for October 2026', due: '2026-11-06', past: true });
    // A non-employer has no EMP201; a sole proprietor no ITR14.
    const sole = deadlinesFor({ businessType: 'sole_prop', vatRegistered: false, vatCategory: 'A', fyEndMonth: 2, turnoverTax: false, employer: false }, '2027-02-01');
    expect(sole.some((d) => /EMP201|ITR14|VAT201/.test(d.label))).toBe(false);
    expect(sole.some((d) => d.label === 'Second provisional tax payment (IRP6, year to February 2027)')).toBe(true);
  });
});
