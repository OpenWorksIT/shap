/**
 * Shap Accountant, phase 4 (docs/ACCOUNTANT.md, "A client on its own Shap"): a business's own Shap,
 * on a server of its own (here: listening on a port), links its accountant's practice; the
 * practice's people open its books there, each time with a sign-in that works once, at no more than
 * the owner allowed; the owner unlinks whenever they like. A second, made-up server plays a client
 * Shap that says what it shouldn't, and one at a private address. All data made up.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTANT_TERMS_VERSION, LINK_WHAT_GOES, LINKED_BOOKS_TASKS, readLink } from '@shap/shared';
import type { Sql } from '../../src/db/index.js';
import { linkBaseProblem, linkCall, LinkError, privateAddress } from '../../src/lib/link-call.js';
import { appVersion } from '../../src/modules/system.js';
import { expectCleanAudit, login, setup, type TestEnv } from '../helpers.js';

type Session = Awaited<ReturnType<typeof login>>;

describe('a client on its own Shap, linked to its accountant', () => {
  let practice: TestEnv;
  let own: TestEnv;
  let base: string;
  let owner: Session;
  let theirs: Session;
  let site: Session;
  let siteId: string;
  let linked: string;
  const ownDb = `${new URL(process.env.DATABASE_URL!).pathname.slice(1)}_own`;

  /** A link from the client's own Shap, as its owner makes it, pointed at where it listens here. */
  const makeLink = async (level: 'books' | 'compile') => {
    const made = await theirs.post<{ link: string; expiresAt: string }>('/api/accountant-links', { level, password: 'test-password-1' });
    expect(made.link.startsWith(`${own.ctx.config.PUBLIC_URL.replace(/\/$/, '')}/link#`)).toBe(true);
    return made.link.replace(/^https?:\/\/[^/]+/, base);
  };
  /** What a browser does with the sign-in: opens it on the client's Shap, and keeps the cookie. */
  const enter = async (url: string) => {
    expect(url.startsWith(base)).toBe(true);
    const r = await own.app.inject({ method: 'GET', url: url.slice(base.length) });
    const cookie = r.cookies.find((c) => c.name === 'shap_session')?.value;
    return { status: r.statusCode, location: r.headers.location, cookie };
  };
  const asThem = (cookie: string) => ({
    get: (url: string) => own.app.inject({ method: 'GET', url, cookies: { shap_session: cookie } }),
  });
  const ownUsers = (sql: Sql) => sql<{ name: string; role: string; active: boolean; linkPerson: string | null }[]>`select name, role, active, link_person from users where link_id is not null order by name`;

  beforeAll(async () => {
    practice = await setup({ env: { LINK_PRIVATE: 'true' } });
    await practice.sql.unsafe(`drop database if exists "${ownDb}" with (force)`);
    await practice.sql.unsafe(`create database "${ownDb}"`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${ownDb}`;
    own = await setup({ env: { DATABASE_URL: url.toString(), PUBLIC_URL: 'https://books.made-up-own.example' } });
    await own.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(own.app.server.address() as AddressInfo).port}`;
    theirs = await login(own.app, 'owner@example.co.za');
    const { settings } = await theirs.get('/api/reference');
    await theirs.post('/api/settings', { ...settings, companyName: 'Made-up Own Books (Pty) Ltd', businessType: 'company', fyEndMonth: 2 }, 'PUT');
    owner = await login(practice.app, 'owner@example.co.za');
    site = await login(practice.app, 'site@example.co.za');
    siteId = (await practice.sql<{ id: string }[]>`select id from users where email = 'site@example.co.za'`)[0]!.id;
    const s = (await owner.get('/api/reference')).settings;
    await owner.post('/api/practice/terms', { version: ACCOUNTANT_TERMS_VERSION });
    await owner.post('/api/settings', { ...s, companyName: 'Made-up Practice Inc', features: { ...s.features, practice: true } }, 'PUT');
  });
  afterAll(async () => {
    await expectCleanAudit(own.sql);
    await expectCleanAudit(practice.sql);
    await own.close();
    await practice.ctx.clients.end();
    await practice.close();
    const pg = await setup();
    await pg.sql.unsafe(`drop database if exists "${ownDb}" with (force)`);
    await pg.close();
  });

  it('the owner makes a link with their password, saying what goes and what they let the practice do', async () => {
    expect((await theirs.call({ method: 'POST', url: '/api/accountant-links', payload: { level: 'books' } })).statusCode).toBe(400);
    const staff = await login(own.app, 'site@example.co.za');
    expect((await staff.call({ method: 'POST', url: '/api/accountant-links', payload: { level: 'books', password: 'test-password-1' } })).statusCode).toBe(403);
    expect(LINK_WHAT_GOES).toMatch(/Their Shap is sent your business’s name, what you let them do, and, when they run the checks, what Shap’s checks find in your books \(which can name your customers and suppliers\)/);
    expect(LINK_WHAT_GOES).toMatch(/OpenWorks never gets any of it/);
    // Writing up is everything staff can be given but the practice's own and closing months.
    expect(LINKED_BOOKS_TASKS).not.toContain('books.lock');
    expect(LINKED_BOOKS_TASKS.some((t) => t.startsWith('practice.'))).toBe(false);
    expect(LINKED_BOOKS_TASKS).toContain('books.adjust');
  });

  it('links in the practice: the client is listed by its own name, with what its checks find', async () => {
    const link = await makeLink('books');
    expect(readLink(link)).toMatchObject({ base });
    const r = await owner.post<{ id: string; name: string; level: string }>('/api/practice/clients/link', { link });
    expect(r).toMatchObject({ name: 'Made-up Own Books (Pty) Ltd', level: 'books' });
    linked = r.id;
    const list = (await owner.get('/api/practice')).clients;
    const c = list.find((x: { id: string }) => x.id === linked);
    expect(c).toMatchObject({ kind: 'linked', linked: { host: new URL(base).host, level: 'books', unlinked: false } });
    expect(c.health).toMatchObject({ company: 'Made-up Own Books (Pty) Ltd', setupDone: true });
    // The credential is kept sealed, never as it came; the client keeps only its hash.
    const [row] = await practice.sql<{ linkCredential: string }[]>`select link_credential from practice_clients where id = ${linked}`;
    expect(row!.linkCredential.startsWith('v1.')).toBe(true);
    const [l] = await own.sql<{ practiceName: string; codeHash: string | null; credentialHash: string }[]>`select practice_name, code_hash, credential_hash from accountant_links`;
    expect(l).toMatchObject({ practiceName: 'Made-up Practice Inc', codeHash: null });
    expect(l!.credentialHash).toMatch(/^[0-9a-f]{64}$/);
    // The link works once.
    const again = await owner.call({ method: 'POST', url: '/api/practice/clients/link', payload: { link } });
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toMatch(/That link doesn’t work: it was used already, it’s more than a week old, or it was unlinked/);
  });

  it('opens their books in a new tab, with a sign-in that works once, as someone of their own there', async () => {
    const opened = await owner.post<{ url: string; level: string }>(`/api/practice/clients/${linked}/open`, {});
    expect(opened.level).toBe('books');
    const first = await enter(opened.url);
    expect([first.status, first.location]).toEqual([303, '/']);
    const me = (await asThem(first.cookie!).get('/api/auth/me')).json();
    expect(me).toMatchObject({ user: { name: 'Owner (Made-up Practice Inc)', role: 'staff' }, fromPractice: 'Made-up Practice Inc' });
    expect(me.user.access).toEqual(expect.arrayContaining(['books.adjust', 'documents.edit', 'payroll.run']));
    // The owner's own: not theirs.
    expect((await asThem(first.cookie!).get('/api/users')).statusCode).toBe(403);
    // Used once, or after its minute, it goes nowhere.
    expect(await enter(opened.url)).toMatchObject({ status: 303, location: '/?link=expired', cookie: undefined });
    const late = await owner.post<{ url: string }>(`/api/practice/clients/${linked}/open`, { as: 'compile' });
    await own.sql`update link_entries set expires_at = now() - interval '1 second' where used_at is null`;
    expect((await enter(late.url)).location).toBe('/?link=expired');
    // To compile: as their accountant (read only).
    const compile = await enter((await owner.post<{ url: string }>(`/api/practice/clients/${linked}/open`, { as: 'compile' })).url);
    expect((await asThem(compile.cookie!).get('/api/auth/me')).json().user.role).toBe('accountant');
    // In the client's audit log, by name; and kept out of the owner's people.
    const log = await own.sql<{ action: string; name: string | null }[]>`select a.action, u.name from audit_log a left join users u on u.id = a.user_id where a.action in ('link_sign_in_made', 'login') order by a.at`;
    expect(log.filter((x) => x.name === 'Owner (Made-up Practice Inc)').map((x) => x.action)).toEqual(expect.arrayContaining(['link_sign_in_made', 'login']));
    const people = (await theirs.get('/api/users')) as { name: string }[];
    expect(people.map((p) => p.name)).not.toContain('Owner (Made-up Practice Inc)');
    const [them] = await own.sql<{ id: string }[]>`select id from users where link_id is not null`;
    const edit = await theirs.call({ method: 'PUT', url: `/api/users/${them!.id}`, payload: { name: 'x', email: 'x@example.co.za', role: 'owner', active: true } });
    expect(edit.statusCode).toBe(400);
    expect(edit.json().error).toMatch(/They’re from your accountant’s practice: unlink it under Your accountant/);
    // They never sign in with a password.
    const [email] = await own.sql<{ email: string }[]>`select email from users where link_id is not null limit 1`;
    expect((await own.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-shap-version': appVersion() }, payload: { email: email!.email, password: '!practice' } })).statusCode).toBe(401);
  });

  it('opens only as given in the practice, and never more than the client allows', async () => {
    // Site staff, given the client to compile, then not at all: their next sign-in is refused, and
    // their way in on the client's Shap is taken away.
    await practice.sql`update users set access_add = '{practice.clients}' where id = ${siteId}`;
    expect((await site.call({ method: 'POST', url: `/api/practice/clients/${linked}/open`, payload: {} })).statusCode).toBe(403);
    await owner.post(`/api/practice/clients/${linked}/access`, { access: [{ userId: siteId, level: 'compile' }] }, 'PUT');
    expect((await site.call({ method: 'POST', url: `/api/practice/clients/${linked}/open`, payload: { as: 'books' } })).statusCode).toBe(403);
    const theirsNow = await enter((await site.post<{ url: string }>(`/api/practice/clients/${linked}/open`, {})).url);
    expect((await asThem(theirsNow.cookie!).get('/api/auth/me')).json().user).toMatchObject({ name: 'Site (Made-up Practice Inc)', role: 'accountant' });
    await owner.post(`/api/practice/clients/${linked}/access`, { access: [] }, 'PUT');
    expect((await asThem(theirsNow.cookie!).get('/api/auth/me')).statusCode).toBe(401);
    expect((await ownUsers(own.sql)).find((u) => u.name === 'Site (Made-up Practice Inc)')).toMatchObject({ active: false, linkPerson: siteId });
    // A client that lets the practice only compile: opening is as their accountant, whatever the practice gives.
    const second = await owner.post<{ id: string; level: string }>('/api/practice/clients/link', { link: await makeLink('compile') });
    expect(second.level).toBe('compile');
    const refused = await owner.call({ method: 'POST', url: `/api/practice/clients/${second.id}/open`, payload: { as: 'books' } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe('The client lets your practice read their books and compile the statements, not write them up.');
    expect((await owner.post<{ level: string }>(`/api/practice/clients/${second.id}/open`, {})).level).toBe('compile');
    // Their Shap holds to it too, whatever a practice's server asks.
    const [cred] = await practice.sql<{ linkCredential: string }[]>`select link_credential from practice_clients where id = ${second.id}`;
    const ask = await own.app.inject({ method: 'POST', url: '/api/link/sign-in', headers: { authorization: `Bearer link.${practice.ctx.secrets.open(cred!.linkCredential)}` }, payload: { person: { id: siteId, name: 'Site' }, level: 'books' } });
    expect(ask.statusCode).toBe(403);
  });

  it('answers a practice’s server only with its link’s credential, saying nothing more', async () => {
    for (const [method, url] of [['POST', '/api/link/sign-in'], ['GET', '/api/link/health'], ['POST', '/api/link/person-off'], ['POST', '/api/link/unlink']] as const) {
      const none = await own.app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
      const wrong = await own.app.inject({ method, url, headers: { authorization: `Bearer link.${'x'.repeat(43)}` }, payload: method === 'POST' ? {} : undefined });
      expect([none.statusCode, wrong.statusCode], url).toEqual([401, 401]);
      expect(wrong.json().error).toBe(none.json().error);
    }
    // A session's token isn't a credential, nor a credential a session.
    const [cred] = await practice.sql<{ linkCredential: string }[]>`select link_credential from practice_clients where id = ${linked}`;
    const credential = practice.ctx.secrets.open(cred!.linkCredential);
    expect((await own.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${credential}` } })).statusCode).toBe(401);
    expect((await own.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer link.${credential}` } })).statusCode).toBe(401);
    // Not from the demo company.
    expect((await theirs.call({ method: 'GET', url: '/api/accountant-links', cookies: { shap_demo: '1' } })).statusCode).not.toBe(200);
  });

  it('the owner unlinks: nobody from the practice is in their books any more, and the practice is told why', async () => {
    const opened = await enter((await owner.post<{ url: string }>(`/api/practice/clients/${linked}/open`, {})).url);
    const links = (await theirs.get('/api/accountant-links')) as { id: string; level: string; status: string; practiceName: string; people: { name: string }[] }[];
    const l = links.find((x) => x.status === 'linked' && x.level === 'books')!;
    expect(l.people.map((p) => p.name)).toContain('Owner (Made-up Practice Inc)');
    expect(l.practiceName).toBe('Made-up Practice Inc');
    await theirs.post(`/api/accountant-links/${l.id}/unlink`, {});
    expect((await asThem(opened.cookie!).get('/api/auth/me')).statusCode).toBe(401);
    const open = await owner.call({ method: 'POST', url: `/api/practice/clients/${linked}/open`, payload: {} });
    expect(open.statusCode).toBe(400);
    expect(open.json().error).toMatch(/They’ve unlinked your practice in their Shap, so it no longer opens their books/);
    const c = (await owner.get('/api/practice')).clients.find((x: { id: string }) => x.id === linked);
    expect(c.linked.unlinked).toBe(true);
    // A new link from them links the same client again, its access kept.
    expect((await owner.post<{ id: string }>('/api/practice/clients/link', { link: await makeLink('books'), id: linked })).id).toBe(linked);
    expect((await owner.post<{ level: string }>(`/api/practice/clients/${linked}/open`, {})).level).toBe('books');
  });

  it('the practice unlinks: the client’s Shap takes its people out too', async () => {
    const opened = await enter((await owner.post<{ url: string }>(`/api/practice/clients/${linked}/open`, {})).url);
    expect(await owner.post(`/api/practice/clients/${linked}/unlink`, {})).toMatchObject({ ok: true, told: true });
    expect((await asThem(opened.cookie!).get('/api/auth/me')).statusCode).toBe(401);
    const links = (await theirs.get('/api/accountant-links')) as { status: string }[];
    expect(links.filter((x) => x.status === 'linked')).toHaveLength(1); // the compile-only one
    const log = await own.sql<{ action: string }[]>`select action from audit_log where action = 'accountant_unlinked'`;
    expect(log).toHaveLength(1);
  });
});

describe('a client’s Shap that says what it shouldn’t, or isn’t where a client’s Shap could be', () => {
  let practice: TestEnv;
  let fake: Server;
  let base: string;
  let owner: Session;
  const heard: { url: string; body: string; auth: string }[] = [];
  let health: unknown;

  beforeAll(async () => {
    practice = await setup({ env: { LINK_PRIVATE: 'true' } });
    owner = await login(practice.app, 'owner@example.co.za');
    const s = (await owner.get('/api/reference')).settings;
    await owner.post('/api/practice/terms', { version: ACCOUNTANT_TERMS_VERSION });
    await owner.post('/api/settings', { ...s, features: { ...s.features, practice: true } }, 'PUT');
    // The practice's own books have a customer: none of it goes to a client's Shap.
    await owner.post('/api/clients', { name: 'Zandile Canarybird (made up)', email: 'canary@client.example' });
    fake = createServer((req: IncomingMessage, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        heard.push({ url: req.url ?? '', body, auth: req.headers.authorization ?? '' });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/link/redeem') return res.end(JSON.stringify({ credential: 'c'.repeat(43), company: 'Made-up Odd Books', level: 'books', api: 1 }));
        if (req.url === '/api/link/health') return res.end(JSON.stringify({ health }));
        if (req.url === '/api/link/sign-in') return res.end(JSON.stringify({ path: 'https://elsewhere.example/steal' }));
        res.statusCode = 404;
        res.end('{}');
      });
    });
    await new Promise<void>((done) => fake.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await expectCleanAudit(practice.sql);
    fake.close();
    await practice.ctx.clients.end();
    await practice.close();
  });

  it('sends a client’s Shap only the link’s code, the practice’s name, and who opens the books', async () => {
    health = { company: 'x', deadlineInputs: { businessType: 'not-a-business' } };
    const r = await owner.post<{ id: string }>('/api/practice/clients/link', { link: `${base}/link#${'a'.repeat(43)}` });
    // Their checks came back unread, so the list has none for them.
    expect((await owner.get('/api/practice')).clients.find((c: { id: string }) => c.id === r.id).health).toBeNull();
    const checks = await owner.call({ method: 'POST', url: `/api/practice/clients/${r.id}/checks`, payload: {} });
    expect(checks.statusCode).toBe(502);
    expect(checks.json().error).toMatch(/came back in a way this Shap doesn’t read/);
    // A sign-in that would send the browser elsewhere isn't passed on.
    expect((await owner.call({ method: 'POST', url: `/api/practice/clients/${r.id}/open`, payload: {} })).statusCode).toBe(502);
    const practiceName = (await practice.sql<{ companyName: string }[]>`select company_name from settings where id`)[0]!.companyName;
    expect(JSON.parse(heard.find((h) => h.url === '/api/link/redeem')!.body)).toEqual({ code: 'a'.repeat(43), practice: { name: practiceName } });
    expect(Object.keys(JSON.parse(heard.find((h) => h.url === '/api/link/sign-in')!.body)).sort()).toEqual(['level', 'person']);
    expect(Object.keys(JSON.parse(heard.find((h) => h.url === '/api/link/sign-in')!.body).person).sort()).toEqual(['id', 'name']);
    for (const h of heard) expect(h.body).not.toMatch(/Canarybird|canary@client/);
    expect(heard.filter((h) => h.url !== '/api/link/redeem').every((h) => h.auth === `Bearer link.${'c'.repeat(43)}`)).toBe(true);
    // Checks the list can read come in.
    health = { at: '2026-11-17T08:00:00.000Z', company: 'Made-up Odd Books', setupDone: true, vatRegistered: false, audit: { fail: 0, warn: 1, items: [{ level: 'warn', section: 'Made-up', text: 'Made-up' }] }, statements: null, lockedThrough: null, deadlineInputs: { businessType: 'company', vatRegistered: false, vatCategory: 'A', fyEndMonth: 2, turnoverTax: false, employer: false }, extra: '<script>' };
    const ok = await owner.post<{ health: Record<string, unknown> }>(`/api/practice/clients/${r.id}/checks`, {});
    expect(ok.health).not.toHaveProperty('extra');
    expect(ok.health.company).toBe('Made-up Odd Books');
  });

  it('reaches only public https addresses, unless the server is set to reach private ones', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0']) expect(privateAddress(ip), ip).toBe(true);
    for (const ip of ['41.0.0.1', '196.25.1.1', '2c0f:f4c0::1']) expect(privateAddress(ip), ip).toBe(false);
    expect(linkBaseProblem('http://books.made-up.example', false)).toMatch(/over https/);
    expect(linkBaseProblem('https://127.0.0.1:8443', false)).toMatch(/private address/);
    expect(linkBaseProblem('https://books.made-up.example', false)).toBeNull();
    // A name that resolves to a private address is refused when connecting, not only when typed.
    const err = await linkCall({ base: 'https://localhost:1', method: 'GET', path: '/api/link/health', allowPrivate: false, version: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LinkError);
    expect((err as LinkError).code).toBe('link_address');
    // And the practice's own server, set as most are, refuses one.
    const strict = await setup({ env: {} });
    try {
      const o = await login(strict.app, 'owner@example.co.za');
      const s = (await o.get('/api/reference')).settings;
      await o.post('/api/practice/terms', { version: ACCOUNTANT_TERMS_VERSION });
      await o.post('/api/settings', { ...s, features: { ...s.features, practice: true } }, 'PUT');
      const r = await o.call({ method: 'POST', url: '/api/practice/clients/link', payload: { link: `${base}/link#${'b'.repeat(43)}` } });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(/over https/);
      expect(await strict.sql`select 1 from practice_clients`).toHaveLength(0);
      await expectCleanAudit(strict.sql);
    } finally {
      await strict.ctx.clients.end();
      await strict.close();
    }
  });
});
