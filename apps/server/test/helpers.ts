import { appVersion } from '../src/modules/system.js';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { createUser } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { createDb, type Sql } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import type { Mail } from '../src/lib/mailer.js';

export interface TestEnv {
  app: FastifyInstance;
  sql: Sql;
  mails: Mail[];
  close: () => Promise<void>;
}

/** A fresh database: empty company (default) or the demo company. */
export async function setup(opts: { demo?: boolean; env?: Record<string, string> } = {}): Promise<TestEnv> {
  const config = loadConfig({ ...process.env, ...opts.env });
  const sql = createDb(config.DATABASE_URL, { max: 4 });
  if (opts.demo) await seed(sql, { reset: true, password: 'test-password-1' });
  else {
    await sql.unsafe('drop schema public cascade; create schema public;');
    await migrate(sql);
    await createUser(sql, { name: 'Owner', email: 'owner@example.co.za', password: 'test-password-1', role: 'owner' });
    await createUser(sql, { name: 'Site', email: 'site@example.co.za', password: 'test-password-1', role: 'capture' });
    await createUser(sql, { name: 'Accountant', email: 'accountant@example.co.za', password: 'test-password-1', role: 'accountant' });
  }
  const mails: Mail[] = [];
  const { app } = await buildApp({ config, sql, mailer: { send: async (m) => void mails.push(m) } });
  await app.ready();
  return {
    app,
    sql,
    mails,
    close: async () => {
      await app.close();
      await sql.end();
    },
  };
}

/** Signs in and returns helpers that carry the session cookie. */
export async function login(app: FastifyInstance, email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password-1' }, headers: { 'x-shap-version': appVersion() } });
  if (res.statusCode !== 200) throw new Error(`login failed for ${email}: ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'shap_session')!.value;
  // As the web app does: it says which version it is.
  const call = (opts: InjectOptions) =>
    app.inject({ ...opts, headers: { 'x-shap-version': appVersion(), ...(opts.headers ?? {}) }, cookies: { ...(opts.cookies ?? {}), shap_session: cookie } });
  const get = async <T = any>(url: string): Promise<T> => {
    const r = await call({ method: 'GET', url });
    if (r.statusCode >= 400) throw new Error(`GET ${url} → ${r.statusCode} ${r.body}`);
    return r.json() as T;
  };
  const post = async <T = any>(url: string, payload: unknown = {}, method: 'POST' | 'PUT' | 'DELETE' = 'POST'): Promise<T> => {
    const r = await call({ method, url, payload: payload as never });
    if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
    return r.json() as T;
  };
  return { call, get, post };
}

export async function ref(sql: Sql) {
  const acc = async (key: string) => (await sql<{ id: string }[]>`select id from accounts where system_key = ${key}`)[0]!.id;
  const src = async (name: string) => (await sql<{ id: string }[]>`select id from payment_sources where name = ${name}`)[0]!.id;
  const cat = async (name: string) => (await sql<{ id: string }[]>`select id from cost_categories where name = ${name}`)[0]!.id;
  return { acc, src, cat };
}

export async function balance(sql: Sql, systemKey: string, upTo = '2999-12-31'): Promise<number> {
  const [r] = await sql<{ b: number }[]>`
    select coalesce(sum(l.amount_cents), 0)::bigint as b from ledger l join accounts a on a.id = l.account_id
    where a.system_key = ${systemKey} and l.date <= ${upTo}::date`;
  return r!.b;
}

export async function ledgerTotal(sql: Sql): Promise<number> {
  const [r] = await sql<{ t: number }[]>`select coalesce(sum(amount_cents), 0)::bigint as t from ledger`;
  return r!.t;
}
