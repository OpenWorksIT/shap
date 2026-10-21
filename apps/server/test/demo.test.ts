/**
 * The demo company: once it's showing, nothing on any screen may come from the real books, and
 * getting back to them takes the owner's password.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, type Sql } from '../src/db/index.js';
import { demoUrl, ensureDatabase } from '../src/db/routing.js';
import { appVersion } from '../src/modules/system.js';
import { login, ref, setup, type TestEnv } from './helpers.js';

const MARK = 'Zebracorn';
const GETS = [
  '/api/reference', '/api/dashboard', '/api/clients', '/api/projects', '/api/workers', '/api/costs?period=all', '/api/costs/suppliers',
  '/api/documents', '/api/labour', '/api/labour/unallocated', '/api/assets', '/api/audit', '/api/balance-checks', '/api/bank/statements',
  '/api/costs/duplicates', '/api/costs/merges', '/api/costs/recurring', '/api/journals', '/api/reports/balance-sheet', '/api/reports/income-statement',
  '/api/reports/trial-balance', '/api/reports/ledger', '/api/statement-files', '/api/users', '/api/year-ends', '/api/auth/me',
];

describe('the demo company', () => {
  let env: TestEnv;
  let app: FastifyInstance;
  let demoSql: Sql;
  let owner: Awaited<ReturnType<typeof login>>;
  let demoCookies: Record<string, string> = {};

  beforeAll(async () => {
    env = await setup();
    const config = loadConfig({ ...process.env });
    const url = demoUrl(config.DATABASE_URL);
    await ensureDatabase(env.sql, url);
    demoSql = createDb(url, { max: 3 });
    await demoSql.unsafe('drop schema public cascade; create schema public;');
    ({ app } = await buildApp({ config, sql: env.sql, demoSql, mailer: { send: async () => {} } }));
    await app.ready();
    owner = await login(app, 'owner@example.co.za');
    // Real business data, with a name that can't appear in the demo company.
    const r = await ref(env.sql);
    const client = await owner.post('/api/clients', { name: `${MARK} Holdings` });
    await owner.post('/api/projects', { name: `${MARK} roof`, clientId: client.id });
    await owner.post('/api/costs', { date: '2026-10-01', description: `${MARK} sheeting`, amountCents: 123456, supplier: `${MARK} Steel`, categoryId: await r.cat('Parts'), sourceId: null });
  }, 120_000);
  afterAll(async () => {
    await app.close();
    await demoSql.end();
    await env.close();
  });

  const demo = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    owner.call({ method, url, payload: payload as never, cookies: demoCookies, headers: { 'x-shap-version': appVersion() } });

  it('switches this browser to the made-up company', async () => {
    expect((await owner.get('/api/demo/status')).active).toBe(false);
    const r = await owner.call({ method: 'POST', url: '/api/demo/enter', payload: {} });
    expect(r.statusCode).toBe(200);
    demoCookies = Object.fromEntries(r.cookies.map((c) => [c.name, c.value]));
    expect(Object.keys(demoCookies).sort()).toEqual(['shap_demo', 'shap_demo_session']);
    const status = (await demo('GET', '/api/demo/status')).json();
    expect(status).toMatchObject({ available: true, active: true });
    const me = (await demo('GET', '/api/auth/me')).json();
    expect(me.user.name).toBe('Demo Owner');
  }, 120_000);

  it('never shows anything from the real books', async () => {
    for (const url of GETS) {
      const r = await demo('GET', url);
      expect(r.statusCode, url).toBeLessThan(500);
      expect(r.body.includes(MARK), `${url} shows real data`).toBe(false);
    }
    const clients = (await demo('GET', '/api/clients')).json();
    expect(clients.length).toBeGreaterThan(3);
    // Changes go to the demo company only.
    await demo('POST', '/api/clients', { name: 'Visitor Test Co' });
    expect((await env.sql`select 1 from clients where name = 'Visitor Test Co'`).length).toBe(0);
    expect((await demoSql`select 1 from clients where name = 'Visitor Test Co'`).length).toBe(1);
  });

  it('keeps the server’s updates and backups out of reach', async () => {
    expect((await demo('GET', '/api/system')).statusCode).toBe(403);
  });

  it('needs the owner’s password to get back to the real books', async () => {
    const wrong = await demo('POST', '/api/demo/leave', { password: 'not-it' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toMatch(/Password is incorrect/);
    expect((await demo('GET', '/api/clients')).body.includes(MARK)).toBe(false);
    const ok = await demo('POST', '/api/demo/leave', { password: 'test-password-1' });
    expect(ok.statusCode).toBe(200);
    const cleared = Object.fromEntries(ok.cookies.map((c) => [c.name, c.value]));
    expect(cleared).toMatchObject({ shap_demo: '', shap_demo_session: '' });
    // Without the demo cookies, the real books are back, still signed in.
    expect((await owner.get('/api/clients')).some((c: { name: string }) => c.name.includes(MARK))).toBe(true);
  });
});
