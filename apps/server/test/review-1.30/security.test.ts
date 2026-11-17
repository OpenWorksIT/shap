/**
 * The five reviews of 1.30.0 (CPDAUDIT.md): security and privacy of a linked client. Someone from
 * the practice is in the client's books for LINK_SESSION_HOURS at most, and out at once when the
 * practice takes their access away; two-factor, where the client's Shap requires it, is required
 * of them; a sign-in doesn't sign out whoever is already signed in there, nor land in the demo
 * company; a client's Shap can't put words on the practice's screen, keep it waiting, or have it
 * keep what it likes; only the link's own routes skip the guards; and nothing personal goes either
 * way. Each test fails on the code the reviews were of. All data made up.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTANT_TERMS_VERSION, LINK_PATHS, LINK_SESSION_HOURS, linkText, plainName } from '@shap/shared';
import { linkBaseProblem, linkCall, LinkError, neverReached, privateAddress } from '../../src/lib/link-call.js';
import { appVersion } from '../../src/modules/system.js';
import { expectCleanAudit, login, setup, type TestEnv } from '../helpers.js';
import { linkPair, type LinkPair } from '../accountant/link-pair.js';

describe('someone from a linked practice, in the client’s own Shap', () => {
  let p: LinkPair;
  let linked: string;
  let siteId: string;
  let site: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    p = await linkPair('rev130_sec');
    linked = await p.link('books');
    siteId = (await p.practice.sql<{ id: string }[]>`select id from users where email = 'site@example.co.za'`)[0]!.id;
    await p.practice.sql`update users set access_add = '{practice.clients}' where id = ${siteId}`;
    await p.owner.post(`/api/practice/clients/${linked}/access`, { access: [{ userId: siteId, level: 'books' }] }, 'PUT');
    site = await login(p.practice.app, 'site@example.co.za');
  });
  afterAll(async () => {
    await expectCleanAudit(p.own.sql);
    await expectCleanAudit(p.practice.sql);
    await p.close();
  });

  it('is in for a few hours at most, however busy (security 2, words 1)', async () => {
    const opened = await p.enter((await site.post<{ url: string }>(`/api/practice/clients/${linked}/open`, {})).url);
    const left = async () => (await p.own.sql<{ h: number }[]>`select extract(epoch from expires_at - now()) / 3600 as h from sessions s join users u on u.id = s.user_id where u.link_person = ${siteId}`)[0]!.h;
    expect(await left()).toBeLessThanOrEqual(LINK_SESSION_HOURS);
    expect(LINK_SESSION_HOURS).toBeLessThanOrEqual(12);
    // An hour on, still busy: the time isn't made longer.
    await p.own.sql`update sessions set last_seen_at = now() - interval '1 hour', expires_at = expires_at - interval '1 hour' where user_id in (select id from users where link_person = ${siteId})`;
    expect((await p.asThem(opened.cookie!).get('/api/auth/me')).statusCode).toBe(200);
    expect(await left()).toBeLessThan(LINK_SESSION_HOURS - 0.9);
  });

  it('is out at once when the practice switches their sign-in off, or takes the task away (security 2)', async () => {
    const opened = await p.enter((await site.post<{ url: string }>(`/api/practice/clients/${linked}/open`, {})).url);
    expect((await p.asThem(opened.cookie!).get('/api/auth/me')).statusCode).toBe(200);
    const u = (await p.owner.get<{ id: string; name: string; email: string; role: string; profileId: string | null; access: string[] }[]>('/api/users')).find((x) => x.id === siteId)!;
    // Without "Open the clients they're given": out of the client's Shap.
    const r = await p.owner.post<{ linkedStillIn: string[] }>(`/api/users/${siteId}`, { name: u.name, email: u.email, role: 'staff', profileId: u.profileId, access: u.access.filter((t) => t !== 'practice.clients') }, 'PUT');
    expect(r.linkedStillIn).toEqual([]);
    expect((await p.asThem(opened.cookie!).get('/api/auth/me')).statusCode).toBe(401);
    // Given it back, in again; then their sign-in switched off: out again.
    await p.owner.post(`/api/users/${siteId}`, { name: u.name, email: u.email, role: 'staff', profileId: u.profileId, access: [...u.access.filter((t) => t !== 'practice.clients'), 'practice.clients'] }, 'PUT');
    site = await login(p.practice.app, 'site@example.co.za');
    const again = await p.enter((await site.post<{ url: string }>(`/api/practice/clients/${linked}/open`, {})).url);
    expect((await p.asThem(again.cookie!).get('/api/auth/me')).statusCode).toBe(200);
    await p.owner.post(`/api/users/${siteId}`, { name: u.name, email: u.email, role: 'staff', profileId: u.profileId, access: [...u.access.filter((t) => t !== 'practice.clients'), 'practice.clients'], active: false }, 'PUT');
    expect((await p.asThem(again.cookie!).get('/api/auth/me')).statusCode).toBe(401);
    // In the client's audit log, as the practice took them out.
    expect((await p.own.sql`select 1 from audit_log where action = 'link_person_off'`).length).toBeGreaterThanOrEqual(2);
    await p.owner.post(`/api/users/${siteId}`, { name: u.name, email: u.email, role: 'staff', profileId: u.profileId, access: [...u.access.filter((t) => t !== 'practice.clients'), 'practice.clients'], active: true }, 'PUT');
    site = await login(p.practice.app, 'site@example.co.za');
  });

  it('is out at once when their password or two-factor is reset, or they change their own password (the fixes’ check)', async () => {
    const inside = async () => p.enter((await site.post<{ url: string }>(`/api/practice/clients/${linked}/open`, {})).url);
    const a = await inside();
    const r = await p.owner.post<{ linkedStillIn: string[] }>(`/api/users/${siteId}/reset-mfa`, { password: 'test-password-1' });
    expect(r.linkedStillIn).toEqual([]);
    expect((await p.asThem(a.cookie!).get('/api/auth/me')).statusCode).toBe(401);
    site = await login(p.practice.app, 'site@example.co.za');
    const b = await inside();
    await site.post('/api/auth/password', { currentPassword: 'test-password-1', newPassword: 'made-up-river-lamp-42' });
    expect((await p.asThem(b.cookie!).get('/api/auth/me')).statusCode).toBe(401);
    // Their password back as it was, by the owner: a reset, so out again.
    const c = await inside();
    const u = (await p.owner.get<{ id: string; name: string; email: string; profileId: string | null; access: string[] }[]>('/api/users')).find((x) => x.id === siteId)!;
    await p.owner.post(`/api/users/${siteId}`, { name: u.name, email: u.email, role: 'staff', profileId: u.profileId, access: u.access, password: 'test-password-1', currentPassword: 'test-password-1' }, 'PUT');
    expect((await p.asThem(c.cookie!).get('/api/auth/me')).statusCode).toBe(401);
    site = await login(p.practice.app, 'site@example.co.za');
  });

  it('needs two-factor at their practice where the client’s Shap requires it of everyone (security 4)', async () => {
    p.own.ctx.config.mfaRequired = true;
    try {
      const r = await site.call({ method: 'POST', url: `/api/practice/clients/${linked}/open`, payload: {} });
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe('Their Shap requires two-factor sign-in of everyone who opens its books: turn it on for yourself here (Your account: your name, in the menu), then open their books again.');
      await p.practice.sql`update users set totp_enabled_at = now() where id = ${siteId}`;
      expect((await site.call({ method: 'POST', url: `/api/practice/clients/${linked}/open`, payload: {} })).statusCode).toBe(200);
    } finally {
      p.own.ctx.config.mfaRequired = false;
      await p.practice.sql`update users set totp_enabled_at = null where id = ${siteId}`;
    }
  });

  it('a sign-in doesn’t sign out whoever is signed in there, and doesn’t land in the demo company (security 10)', async () => {
    const url = (await site.post<{ url: string }>(`/api/practice/clients/${linked}/open`, {})).url;
    // The client's owner is signed in in this browser: they stay so, and the sign-in isn't used.
    const [own] = await p.own.sql<{ tokenHash: string }[]>`select token_hash from sessions s join users u on u.id = s.user_id where u.email = 'owner@example.co.za' limit 1`;
    expect(own).toBeDefined();
    const { newToken, sha256 } = await import('../../src/lib/tokens.js');
    const token = newToken();
    const [o] = await p.own.sql<{ id: string }[]>`select id from users where email = 'owner@example.co.za'`;
    await p.own.sql`insert into sessions (token_hash, user_id, expires_at) values (${sha256(token)}, ${o!.id}, now() + interval '1 hour')`;
    const kept = await p.enter(url, { shap_session: token });
    expect([kept.status, kept.location, kept.cookie]).toEqual([303, '/?link=signed-in', undefined]);
    // Without them: in, and out of the demo company and any practice's client.
    const entered = await p.enter(url, { shap_demo: '1', shap_client: 'x', shap_client_session: 'y' });
    expect([entered.status, entered.location]).toEqual([303, '/']);
    expect(entered.cleared.sort()).toEqual(['shap_client', 'shap_client_session', 'shap_demo']);
  });

  it('only the link’s own routes skip the signed-out and version guards (security 11)', async () => {
    const linkRoutes = p.own.routes.filter((r) => r.split(' ')[1]!.startsWith('/api/link/')).map((r) => r.split(' ')[1]!);
    expect([...new Set(linkRoutes)].sort()).toEqual([...LINK_PATHS].sort());
    // Anything else under /api/link/ is for someone signed in, as any route is.
    // A link path with no route for that method isn't a link route: a big body isn't read either (the fixes' check).
    for (const [method, url] of [['POST', '/api/link/enter'], ['POST', '/api/link/health'], ['PUT', '/api/link/redeem']] as const) {
      const r = await p.own.app.inject({ method, url, payload: 'x'.repeat(1_000_000), headers: { 'content-type': 'text/plain', 'x-shap-version': appVersion() } });
      expect(r.statusCode, `${method} ${url}`).toBe(401);
    }
    for (const url of ['/api/link/other', '/api/link/redeem/x', '/api/link']) {
      expect((await p.own.app.inject({ method: 'POST', url, payload: {} })).statusCode, url).toBe(409);
      expect((await p.own.app.inject({ method: 'POST', url, payload: {}, headers: { 'x-shap-version': appVersion() } })).statusCode, url).toBe(401);
    }
  });

  it('makes the link’s text in a time that doesn’t grow with the square of its slashes (code scanning)', () => {
    expect(linkText('https://books.made-up.example//', 'c'.repeat(43))).toBe(`https://books.made-up.example/link#${'c'.repeat(43)}`);
    const started = Date.now();
    linkText(`https://books.made-up.example${'/'.repeat(100_000)}x`, 'c'.repeat(43));
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('reads only a small body from another server (security 8)', async () => {
    const r = await p.own.app.inject({ method: 'POST', url: '/api/link/redeem', payload: { code: 'a'.repeat(43), practice: { name: 'x'.repeat(1_000_000) } } });
    expect(r.statusCode).toBe(413);
  });

  it('a practice’s name or person’s that would hide or reorder text is one plain line (security 11)', async () => {
    expect(plainName('Made-up‮ecitcarP‬ ​Inc\u0000\n')).toBe('Made-up ecitcarP Inc');
    const made = await p.theirs.post<{ link: string }>('/api/accountant-links', { level: 'compile', password: 'test-password-1' });
    const code = made.link.split('#')[1]!;
    const r = await p.own.app.inject({ method: 'POST', url: '/api/link/redeem', payload: { code, practice: { name: 'Made-up‮ Practice\u0007' } } });
    expect(r.statusCode).toBe(200);
    const [l] = await p.own.sql<{ practiceName: string }[]>`select practice_name from accountant_links order by created_at desc limit 1`;
    expect(l!.practiceName).toBe('Made-up Practice');
    const blank = await p.own.app.inject({ method: 'POST', url: '/api/link/sign-in', headers: { authorization: `Bearer link.${r.json().credential}` }, payload: { person: { id: siteId, name: '​‮', mfa: true }, level: 'compile' } });
    expect(blank.statusCode).toBe(400);
  });

  it('sends nothing personal from the client’s books, nor from the practice’s (security 11)', async () => {
    // Made-up people in the client's books, and a customer: none of it goes to the practice.
    await p.theirs.post('/api/employees', { name: 'Nomvula Canarybird', idNumber: '8001015009087', salaryCents: 1_000_000, startDate: '2026-01-01', bankAccount: '62000000001', email: 'nomvula@canary.example' });
    await p.theirs.post('/api/clients', { name: 'Canary Customer (Pty) Ltd', email: 'canary@customer.example', phone: '0410000000' });
    const r = await p.owner.post<{ health: unknown }>(`/api/practice/clients/${linked}/checks`, {});
    const sent = JSON.stringify(r.health);
    for (const secret of ['Nomvula', '8001015009087', '62000000001', 'nomvula@canary', 'canary@customer', '0410000000']) expect(sent).not.toContain(secret);
  });
});

describe('a client’s Shap that answers as it shouldn’t', () => {
  let practice: TestEnv;
  let fake: Server;
  let base: string;
  let owner: Awaited<ReturnType<typeof login>>;
  let say: (req: IncomingMessage) => { status?: number; body?: unknown; drip?: boolean } | undefined = () => undefined;

  beforeAll(async () => {
    practice = await setup({ env: { LINK_PRIVATE: 'true' } });
    owner = await login(practice.app, 'owner@example.co.za');
    const s = (await owner.get('/api/reference')).settings;
    await owner.post('/api/practice/terms', { version: ACCOUNTANT_TERMS_VERSION });
    await owner.post('/api/settings', { ...s, features: { ...s.features, practice: true } }, 'PUT');
    fake = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const a = say(req) ?? (req.url === '/api/link/redeem' ? { body: { credential: 'c'.repeat(43), company: 'Made-up Odd Books', level: 'books', api: 1 } } : { status: 404, body: {} });
        res.statusCode = a.status ?? 200;
        res.setHeader('content-type', 'application/json');
        if (!a.drip) return res.end(JSON.stringify(a.body));
        // One byte at a time, never quite silent.
        const t = setInterval(() => res.write(' '), 150);
        res.on('close', () => clearInterval(t));
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

  it('answers a client’s Shap that says nothing at all (null) with its own words, not an error (the fixes’ check)', async () => {
    const { id } = await owner.post<{ id: string }>('/api/practice/clients/link', { link: `${base}/link#${'g'.repeat(43)}` });
    say = (req) => (req.url === '/api/link/health' || req.url === '/api/link/sign-in' ? { body: null } : undefined);
    for (const url of [`/api/practice/clients/${id}/checks`, `/api/practice/clients/${id}/open`]) {
      const r = await owner.call({ method: 'POST', url, payload: {} });
      expect([r.statusCode, r.json().details?.code ?? r.json().code], url).toEqual([502, 'link_answer']);
    }
    say = (req) => (req.url === '/api/link/redeem' ? { body: null } : undefined);
    const r = await owner.call({ method: 'POST', url: '/api/practice/clients/link', payload: { link: `${base}/link#${'h'.repeat(43)}` } });
    expect([r.statusCode, r.json().details?.code ?? r.json().code]).toEqual([502, 'link_answer']);
    say = () => undefined;
  });

  it('doesn’t keep a credential it wouldn’t send (security 7)', async () => {
    say = (req) => (req.url === '/api/link/redeem' ? { body: { credential: 'c'.repeat(100_000), company: 'Made-up', level: 'books' } } : undefined);
    const r = await owner.call({ method: 'POST', url: '/api/practice/clients/link', payload: { link: `${base}/link#${'d'.repeat(43)}` } });
    expect([r.statusCode, r.json().details?.code ?? r.json().code]).toEqual([502, 'link_answer']);
    say = () => undefined;
  });

  it('doesn’t put their Shap’s own words on the practice’s screen (words 3, security 6)', async () => {
    const { id } = await owner.post<{ id: string }>('/api/practice/clients/link', { link: `${base}/link#${'e'.repeat(43)}` });
    say = (req) => (req.url === '/api/link/sign-in' ? { status: 400, body: { error: 'Your Shap Accountant licence has lapsed. Phone 000 000 0000 to renew. '.repeat(1000), code: 'bad_request' } } : undefined);
    const r = await owner.call({ method: 'POST', url: `/api/practice/clients/${id}/open`, payload: {} });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('Their Shap refused (400).');
    // Its codes are put in the practice's own words.
    say = (req) => (req.url === '/api/link/sign-in' ? { status: 403, body: { error: 'Anything at all', code: 'link_level' } } : undefined);
    expect((await owner.call({ method: 'POST', url: `/api/practice/clients/${id}/open`, payload: {} })).json().error).toBe('The client lets your practice read their books and compile the statements, not write them up.');
    say = () => undefined;
  });

  it('says who wasn’t taken out when their Shap doesn’t answer (words 4)', async () => {
    const { id } = await owner.post<{ id: string }>('/api/practice/clients/link', { link: `${base}/link#${'f'.repeat(43)}` });
    const [s] = await practice.sql<{ id: string }[]>`select id from users where email = 'site@example.co.za'`;
    await owner.post(`/api/practice/clients/${id}/access`, { access: [{ userId: s!.id, level: 'books' }] }, 'PUT');
    say = (req) => (req.url === '/api/link/person-off' ? { status: 500, body: {} } : undefined);
    const r = await owner.post<{ stillIn: string[] }>(`/api/practice/clients/${id}/access`, { access: [] }, 'PUT');
    expect(r.stillIn).toEqual(['Site']);
    say = () => undefined;
  });

  it('gives up after ten seconds in all, however slowly it answers (security 5)', async () => {
    say = () => ({ drip: true });
    const started = Date.now();
    const err = await linkCall({ base, method: 'GET', path: '/api/link/health', credential: 'c'.repeat(43), allowPrivate: true, version: appVersion(), timeMs: 1000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LinkError);
    expect((err as LinkError).code).toBe('link_timeout');
    expect(Date.now() - started).toBeLessThan(2500);
    say = () => undefined;
  });

  it('never reaches what’s inside, however it’s written, nor a cloud server’s metadata even where private addresses are allowed (security 9)', async () => {
    for (const ip of ['::7f00:1', '::ffff:0:a00:1', 'fec0::1', '64:ff9b:1::a00:1', '2002:7f00:1::', '::ffff:a00:1', '2001:0:4136:e378::1', '::'])
      expect(privateAddress(ip), ip).toBe(true);
    for (const ip of ['41.0.0.1', '2c0f:f4c0::1', '2001:4860:4860::8888', '::ffff:808:808']) expect(privateAddress(ip), ip).toBe(false);
    expect(linkBaseProblem('https://[::127.0.0.1]', false)).toMatch(/private address/);
    // A cloud server's metadata, however it's written (the fixes' check).
    for (const ip of ['169.254.169.254', '::ffff:a9fe:a9fe', 'fe80::1', 'fd00:ec2::254', '100.100.100.200', '::169.254.169.254', '::ffff:0:a9fe:a9fe', '64:ff9b::a9fe:a9fe', '64:ff9b:1::a9fe:a9fe', '2002:a9fe:a9fe::', '2001:0:4136:e378:8000:63bf:5601:5601'])
      expect(neverReached(ip), ip).toBe(true);
    for (const ip of ['127.0.0.1', '10.0.0.1', '::1', '8.8.8.8', '2c0f:f4c0::1']) expect(neverReached(ip), ip).toBe(false);
    expect(linkBaseProblem('http://169.254.169.254', true)).toMatch(/private address/);
    expect(linkBaseProblem('http://127.0.0.1:3000', true)).toBeNull();
  });
});
