import { appVersion } from '../src/modules/system.js';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { createUser, type Door } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { createDb, type Sql } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import type { Mail } from '../src/lib/mailer.js';
import type { Ctx } from '../src/context.js';

export interface TestEnv {
  app: FastifyInstance;
  /** The app's context (for code that runs outside a request, like the timers). */
  ctx: Ctx;
  sql: Sql;
  mails: Mail[];
  /** Every route, as Fastify has it ("GET /api/clients/:id"). */
  routes: string[];
  /** Who each route lets in, as its guard says (auth.ts doorOf). */
  doors: Record<string, Door>;
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
    // Site staff: the profile site capture became (log days and slips, see the jobs).
    const [site] = await sql<{ id: string }[]>`select id from profiles where name = 'Site staff'`;
    await createUser(sql, { name: 'Site', email: 'site@example.co.za', password: 'test-password-1', role: 'staff', profileId: site!.id });
    await createUser(sql, { name: 'Accountant', email: 'accountant@example.co.za', password: 'test-password-1', role: 'accountant' });
    // Set up as a company that's been using Shap: the letterhead as its first trading name,
    // casual workers and trading names switched on.
    await sql`update settings set setup_done = true, features = ${sql.json({ brands: true, workers: true })}`;
    // A tax invoice shows the business's address (fictional).
    await sql`update settings set address = '1 Test Street, Fictional Town, 0001'`;
    await sql`insert into brands (name, sort) select company_name, 1 from settings`;
    await sql`update settings set default_brand_id = (select id from brands limit 1)`;
  }
  const mails: Mail[] = [];
  const { app, ctx, routes, doors } = await buildApp({ config, sql, mailer: { send: async (m) => void mails.push(m) } });
  await app.ready();
  return {
    app,
    ctx,
    sql,
    mails,
    routes,
    doors,
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

/**
 * Signed in as someone without the sign-in form, as signing in leaves it (a session): for tests
 * that sign in more people than sign-in's rate limit allows in a minute.
 */
export async function sessionFor(env: Pick<TestEnv, 'app' | 'sql'>, email: string) {
  const { newToken, sha256 } = await import('../src/lib/tokens.js');
  const token = newToken();
  const [u] = await env.sql<{ id: string }[]>`select id from users where email = ${email} and active`;
  if (!u) throw new Error(`no one signs in as ${email}`);
  await env.sql`insert into sessions (token_hash, user_id, expires_at) values (${sha256(token)}, ${u.id}, now() + interval '1 hour')`;
  const call = (opts: InjectOptions) =>
    env.app.inject({ ...opts, headers: { 'x-shap-version': appVersion(), ...(opts.headers ?? {}) }, cookies: { ...(opts.cookies ?? {}), shap_session: token } });
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

/**
 * The books audit (audit/books.ts) on the books as a test left them: nothing may need fixing.
 * Returns what it found, for a test to look closer. `on`: the day to audit for (the VAT201s of
 * the year before it are checked).
 */
export async function expectCleanAudit(sql: Sql, on?: string) {
  const { auditBooks } = await import('../src/audit/books.js');
  const items = await auditBooks(sql, on);
  const fails = items.filter((i) => i.level === 'fail').map((i) => `${i.section}: ${i.text}`);
  if (fails.length) throw new Error(`The books audit found ${fails.length} to fix:\n${fails.join('\n')}`);
  return items;
}

export async function ledgerTotal(sql: Sql): Promise<number> {
  const [r] = await sql<{ t: number }[]>`select coalesce(sum(amount_cents), 0)::bigint as t from ledger`;
  return r!.t;
}
