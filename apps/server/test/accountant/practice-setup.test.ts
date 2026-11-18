/**
 * Shap Accountant from setup (Shap 1.32, docs/ACCOUNTANT.md "Setting up a practice"): the server's
 * part (may this Shap's database login make its clients' databases, and the owner's request to
 * shap-ctl to allow it, in the background), and the practice's people made in one go (profiles and
 * a sign-in each, all or none, only while nobody else signs in). All data made up.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTANT_TERMS_VERSION, PRACTICE_PROFILES, SERVER_NOT_MANAGED, STARTING_PROFILES, withNeeds } from '@shap/shared';
import { createDb } from '../../src/db/index.js';
import { expectCleanAudit, login, sessionFor, setup, type TestEnv } from '../helpers.js';

type Who = Awaited<ReturnType<typeof login>>;
/** A different address each time, for tests that call a route more often than its limit allows in a minute. */
let n = 0;
const from = () => ({ remoteAddress: `10.9.0.${++n}` });

const switchOn = async (owner: Who) => {
  const { settings } = await owner.get('/api/reference');
  await owner.post('/api/practice/terms', { version: ACCOUNTANT_TERMS_VERSION });
  await owner.post('/api/settings', { ...settings, industry: 'accounting', features: { ...settings.features, practice: true } }, 'PUT');
};
const dropClientsOf = async (admin: TestEnv['sql'], practiceDb: string) => {
  const pattern = `${practiceDb.replace(/_/g, '\\_')}\\_\\_c\\_%`;
  for (const { datname } of await admin<{ datname: string }[]>`select datname from pg_database where datname like ${pattern}`) await admin.unsafe(`drop database if exists "${datname}" with (force)`);
};

describe('the server, for a practice: its database login, and asking shap-ctl', () => {
  // A server set up with a least-privilege login (docs/deployment.md): it may not make databases until allowed.
  const ROLE = 'shap_t_nocreate';
  const adminUrl = new URL(process.env.DATABASE_URL!);
  const appUrl = new URL(process.env.DATABASE_URL!);
  appUrl.username = ROLE;
  appUrl.password = 'made-up-password-1';
  appUrl.pathname = `/${ROLE}`;
  const ctl = mkdtempSync(join(tmpdir(), 'shap-practice-ctl-'));
  let admin: TestEnv['sql'];
  let env: TestEnv;
  let owner: Who;

  beforeAll(async () => {
    adminUrl.pathname = '/postgres';
    admin = createDb(adminUrl.toString(), { max: 1 });
    await dropClientsOf(admin, ROLE);
    await admin.unsafe(`drop database if exists ${ROLE} with (force)`);
    await admin.unsafe(`drop role if exists ${ROLE}`);
    await admin.unsafe(`create role ${ROLE} login password 'made-up-password-1'`);
    await admin.unsafe(`create database ${ROLE} owner ${ROLE}`);
    env = await setup({ env: { DATABASE_URL: appUrl.toString(), CTL_DIR: ctl, REQUEST_DIR: ctl } });
    owner = await login(env.app, 'owner@example.co.za');
    await switchOn(owner);
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.ctx.clients.end();
    await env.close();
    await dropClientsOf(admin, ROLE);
    await admin.unsafe(`drop database if exists ${ROLE} with (force)`);
    await admin.unsafe(`drop role if exists ${ROLE}`);
    await admin.end();
    rmSync(ctl, { recursive: true, force: true });
  });

  it('says this Shap can’t make its clients’ databases, and why, where nothing can ask the server', async () => {
    expect(await owner.get('/api/practice/server')).toMatchObject({ ready: false, login: ROLE, managed: false, pending: false, asked: null, testServer: false });
    const r = await owner.call({ method: 'POST', url: '/api/practice/server', payload: {} });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe(SERVER_NOT_MANAGED);
    // Adding a client says so, and leaves nothing half made.
    const add = await owner.call({ method: 'POST', url: '/api/practice/clients', payload: { name: 'Made-up Motors' } });
    expect(add.statusCode).toBe(400);
    expect(add.json()).toMatchObject({ code: 'no_createdb', error: expect.stringMatching(/isn’t allowed to make databases\. The Practice page says what to do/) });
    expect(await env.sql`select 1 from practice_clients`).toHaveLength(0);
  });

  it('asks shap-ctl in the background where it looks after the server, once, and not over another request', async () => {
    writeFileSync(join(ctl, 'status.json'), JSON.stringify({ check: { at: '2026-11-18T08:00:00Z' } }));
    // Something else asked for first goes first.
    writeFileSync(join(ctl, 'request'), 'backup\n');
    const busy = await owner.call({ method: 'POST', url: '/api/practice/server', payload: {} });
    expect(busy.statusCode).toBe(409);
    expect(readFileSync(join(ctl, 'request'), 'utf8')).toBe('backup\n');
    rmSync(join(ctl, 'request'));
    expect(await owner.post('/api/practice/server')).toMatchObject({ ready: false, managed: true, pending: true });
    expect(readFileSync(join(ctl, 'request'), 'utf8')).toBe('practice\n');
    // Asked again while it waits: nothing more is written or logged.
    expect(await owner.post('/api/practice/server')).toMatchObject({ pending: true });
    expect(await env.sql`select details from audit_log where action = 'system_practice'`).toEqual([{ details: { login: ROLE } }]);
  });

  it('can make clients once the server has allowed it, and shows what shap-ctl said', async () => {
    // What shap-ctl.sh's practice step does (ctl-script.test.ts): CREATEDB for this login, and its status.
    rmSync(join(ctl, 'request'));
    await admin.unsafe(`alter role ${ROLE} createdb`);
    writeFileSync(join(ctl, 'status.json'), JSON.stringify({ practice: { at: '2026-11-18T08:01:00Z', ok: true, login: ROLE, message: `Its database login (${ROLE}) may now make databases.` } }));
    expect(await owner.get('/api/practice/server')).toMatchObject({ ready: true, pending: false, asked: { ok: true, message: expect.stringMatching(/may now make databases/) } });
    // Ready: asking again changes nothing.
    expect(await owner.post('/api/practice/server')).toMatchObject({ ready: true });
    expect(existsSync(join(ctl, 'request'))).toBe(false);
    const { id } = await owner.post<{ id: string }>('/api/practice/clients', { name: 'Made-up Motors' });
    const [c] = await env.sql<{ dbName: string }[]>`select db_name from practice_clients where id = ${id}`;
    await expectCleanAudit(env.ctx.clients.get(c!.dbName));
  });

  it('is the owner’s only', async () => {
    for (const email of ['site@example.co.za', 'accountant@example.co.za']) {
      const who = await sessionFor(env, email);
      expect((await who.call({ method: 'GET', url: '/api/practice/server' })).statusCode).toBe(403);
      expect((await who.call({ method: 'POST', url: '/api/practice/server', payload: {}, ...from() })).statusCode).toBe(403);
    }
  });
});

describe('the server, for a practice: on a superuser login, and other companies on it', () => {
  let env: TestEnv;
  let owner: Who;
  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
  });
  afterAll(async () => {
    await env.sql.unsafe('drop database if exists shap_madeupco with (force)');
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('is ready on the default install’s login, and says when other companies’ books are on the server', async () => {
    const s = await owner.get('/api/practice/server');
    expect(s).toMatchObject({ ready: true, pending: false });
    await env.sql.unsafe('drop database if exists shap_madeupco with (force)');
    await env.sql.unsafe('create database shap_madeupco');
    expect(await owner.get('/api/practice/server')).toMatchObject({ otherCompanies: true });
  });
});

describe('the practice’s people, from setup', () => {
  let env: TestEnv;
  let owner: Who;
  const made: string[] = [];
  const person = (name: string, email: string, profile: string, password = 'horse battery staple 7') => ({ name, email, profile, password });
  const team = {
    profiles: [
      { name: 'Bookkeeper', access: ['practice.clients'] },
      { name: 'Practice manager', access: ['practice.manage'] },
      { name: 'Admin', access: ['documents.edit', 'documents.paid', 'clients.edit', 'reports.view'] },
    ],
    people: [person('Thandi Made-up', 'thandi@example.co.za', 'Bookkeeper'), person('Pieter Pretend', 'pieter@example.co.za', 'Practice manager'), person('Lerato Fiction', 'lerato@example.co.za', 'Admin')],
  };

  beforeAll(async () => {
    env = await setup();
    await dropClientsOf(env.sql, env.ctx.clients.practiceDb);
    owner = await login(env.app, 'owner@example.co.za');
  });
  afterAll(async () => {
    for (const id of made) {
      const [c] = await env.sql<{ dbName: string }[]>`select db_name from practice_clients where id = ${id}`;
      if (c?.dbName) await expectCleanAudit(env.ctx.clients.get(c.dbName));
    }
    await expectCleanAudit(env.sql);
    await env.ctx.clients.end();
    await dropClientsOf(env.sql, env.ctx.clients.practiceDb);
    await env.close();
  });

  it('starts a practice with a bookkeeper, a practice manager and Shap’s admin', () => {
    expect(PRACTICE_PROFILES.map((p) => p.name)).toEqual(['Bookkeeper', 'Practice manager', 'Admin']);
    expect(PRACTICE_PROFILES[2]!.access).toEqual(STARTING_PROFILES.find((p) => p.name === 'Admin')!.access);
  });

  it('is for a practice, its owner, and only while nobody else signs in', async () => {
    const off = await owner.call({ method: 'POST', url: '/api/practice/team', payload: team });
    expect(off.statusCode).toBe(400);
    expect(off.json().error).toMatch(/Shap Accountant is off/);
    await switchOn(owner);
    const site = await sessionFor(env, 'site@example.co.za');
    expect((await site.call({ method: 'POST', url: '/api/practice/team', payload: team })).statusCode).toBe(403);
    const others = await owner.call({ method: 'POST', url: '/api/practice/team', payload: team });
    expect(others.statusCode).toBe(400);
    expect(others.json().error).toMatch(/Someone else signs in here already/);
    // Setup's team step is told, so it offers Settings instead (a test server wiped and set up again).
    expect(await owner.get('/api/practice/server')).toMatchObject({ othersSignIn: true });
    await env.sql`update users set active = false where email <> 'owner@example.co.za'`;
    expect(await owner.get('/api/practice/server')).toMatchObject({ othersSignIn: false });
  });

  it('refuses the whole team over one problem, and makes none of it', async () => {
    const refused = async (payload: unknown, words: RegExp) => {
      const r = await owner.call({ method: 'POST', url: '/api/practice/team', payload: payload as never, ...from() });
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json().error).toMatch(words);
    };
    await refused({ ...team, people: [...team.people, person('Twin', 'THANDI@example.co.za', 'Bookkeeper')] }, /same email/);
    await refused({ ...team, people: [person('Me again', 'owner@example.co.za', 'Bookkeeper')] }, /your email/);
    await refused({ ...team, people: [person('Old', 'site@example.co.za', 'Bookkeeper')] }, /already signs in with site@example\.co\.za/);
    await refused({ ...team, people: [person('Weak', 'weak@example.co.za', 'Bookkeeper', 'aaaaaaaaaaaa')] }, /first passwords anyone would guess/);
    await refused({ ...team, profiles: [...team.profiles, { name: 'bookkeeper', access: [] }] }, /same name/);
    await refused({ ...team, people: [] }, /skip this step/);
    // The last one has no profile: the first two are made inside the same transaction, then undone.
    await refused({ ...team, people: [...team.people, person('Nomvula Nobody', 'nomvula@example.co.za', 'Storeman')] }, /no profile called Storeman/);
    expect(await env.sql`select 1 from users where email in ('thandi@example.co.za', 'pieter@example.co.za', 'lerato@example.co.za')`).toHaveLength(0);
    expect(await env.sql`select 1 from profiles where name in ('Bookkeeper', 'Practice manager')`).toHaveLength(0);
  });

  it('makes the profiles and a sign-in each, and they do as their profiles say', async () => {
    const ok = await owner.call({ method: 'POST', url: '/api/practice/team', payload: team, ...from() });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ people: 3 });
    const profiles = await env.sql<{ name: string; access: string[] }[]>`select name, access from profiles order by name`;
    // Shap's own Admin is changed as ticked (nobody is on it yet), not made twice.
    expect(profiles.filter((p) => p.name === 'Admin')).toEqual([{ name: 'Admin', access: withNeeds(team.profiles[2]!.access) }]);
    expect(profiles.find((p) => p.name === 'Practice manager')!.access).toEqual(expect.arrayContaining(['practice.clients', 'practice.manage']));
    const people = await env.sql<{ email: string; role: string; profile: string }[]>`select u.email, u.role, p.name as profile from users u join profiles p on p.id = u.profile_id where u.active and u.role = 'staff' order by u.email`;
    expect(people).toEqual([
      { email: 'lerato@example.co.za', role: 'staff', profile: 'Admin' },
      { email: 'pieter@example.co.za', role: 'staff', profile: 'Practice manager' },
      { email: 'thandi@example.co.za', role: 'staff', profile: 'Bookkeeper' },
    ]);
    const log = await env.sql<{ action: string; entity: string }[]>`select action, entity from audit_log where entity in ('user', 'profile') order by at`;
    expect(log.filter((l) => l.entity === 'user' && l.action === 'create')).toHaveLength(3);
    expect(log.filter((l) => l.entity === 'profile')).toHaveLength(3);

    // Each signs in with the password set for them.
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'thandi@example.co.za', password: 'horse battery staple 7' }, headers: { 'x-shap-version': (await import('../../src/modules/system.js')).appVersion() } });
    expect(res.statusCode).toBe(200);
    const thandi = await sessionFor(env, 'thandi@example.co.za');
    const pieter = await sessionFor(env, 'pieter@example.co.za');
    const lerato = await sessionFor(env, 'lerato@example.co.za');
    expect((await thandi.call({ method: 'GET', url: '/api/practice' })).statusCode).toBe(200);
    expect((await thandi.call({ method: 'POST', url: '/api/practice/clients', payload: { name: 'Made-up Bakery' } })).statusCode).toBe(403);
    const { id } = await pieter.post<{ id: string }>('/api/practice/clients', { name: 'Made-up Bakery' });
    made.push(id);
    expect((await lerato.call({ method: 'GET', url: '/api/practice' })).statusCode).toBe(403);
    expect((await lerato.call({ method: 'GET', url: '/api/documents' })).statusCode).toBe(200);

    // Done once: the rest are added under Settings → People who sign in.
    const again = await owner.call({ method: 'POST', url: '/api/practice/team', payload: { ...team, people: [person('Late', 'late@example.co.za', 'Bookkeeper')] }, ...from() });
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toMatch(/Settings → People who sign in/);
  });

  it('is never done in a client’s books', async () => {
    const [c] = await env.sql<{ id: string }[]>`select id from practice_clients limit 1`;
    const r = await owner.call({ method: 'POST', url: `/api/practice/clients/${c!.id}/open`, payload: {} });
    expect(r.statusCode, r.body).toBe(200);
    const cookies = Object.fromEntries(r.cookies.filter((c) => c.value).map((c) => [c.name, c.value]));
    for (const [method, url] of [['POST', '/api/practice/team'], ['GET', '/api/practice/server'], ['POST', '/api/practice/server']] as const) {
      expect((await owner.call({ method, url, payload: method === 'POST' ? team : undefined, cookies, ...from() })).statusCode).toBe(403);
    }
  });
});
