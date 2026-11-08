import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../src/app.js';
import type { Sql } from '../src/db/index.js';
import { migrate, type Migration } from '../src/db/migrate.js';
import { createPgliteSql } from '../src/db/pglite-sql.js';
import type { App } from '../src/http.js';
import { setPdfFonts } from '../src/modules/pdf.js';

// The app's typeface on quotes and invoices, as the app hands it in.
const fontDir = join(import.meta.dirname, '..', '..', '..', 'node_modules', '@fontsource', 'atkinson-hyperlegible-next', 'files');
setPdfFonts({ regular: readFileSync(join(fontDir, 'atkinson-hyperlegible-next-latin-400-normal.woff')), bold: readFileSync(join(fontDir, 'atkinson-hyperlegible-next-latin-700-normal.woff')) });

export interface TestEnv {
  app: App;
  sql: Sql;
  close: () => Promise<void>;
}

export function migrationsFromDisk(): Migration[] {
  const dir = join(import.meta.dirname, '..', 'migrations');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((name) => ({ name, body: readFileSync(join(dir, name), 'utf8') }));
}

// Migrating takes a few seconds: do it once per test file, then give each test a copy.
let template: Promise<PGlite> | null = null;
function migrated(): Promise<PGlite> {
  return (template ??= (async () => {
    const pg = new PGlite();
    const sql = createPgliteSql(pg) as unknown as Sql;
    await migrate(sql, migrationsFromDisk());
    // Shap's tests were written for a company; tests of a fresh phone use setup({ fresh: true }).
    {
      await sql`update settings set company_name = 'Test Builders (Pty) Ltd', business_type = 'company', setup_done = true, features = '{"brands": true, "workers": true}'`;
      // As Shap starts: the letterhead is the first trading name.
      await sql`insert into brands (name, sort) values ('Test Builders (Pty) Ltd', 1)`;
      await sql`update settings set default_brand_id = (select id from brands limit 1)`;
      await sql`update accounts set type = 'liability', name = 'Owner’s loan account' where system_key = 'owner_loan'`;
      // A tax invoice shows the business's address (fictional).
      await sql`update settings set address = '1 Test Street, Fictional Town, 0001'`;
    }
    return pg;
  })());
}

/** Books exactly as a new phone has them, before the first-run questions. */
async function freshBooks(): Promise<PGlite> {
  const pg = new PGlite();
  await migrate(createPgliteSql(pg) as unknown as Sql, migrationsFromDisk());
  return pg;
}

/** A fresh, empty set of books (set up as a company, as Shap's tests expect). */
export async function setup(opts: { fresh?: boolean } = {}): Promise<TestEnv> {
  const pg = opts.fresh ? await freshBooks() : await (await migrated()).clone();
  const sql = createPgliteSql(pg) as unknown as Sql;
  const { app } = await buildApp({ sql });
  return { app, sql, close: async () => void (await pg.close()) };
}

type Call = { method?: string; url: string; payload?: unknown; headers?: Record<string, string> };

/** Calls the app the way its screens do. (No signing in on a phone: the name is kept so the tests read the same as Shap's.) */
export async function login(app: App, _who = 'owner') {
  const call = (opts: Call) => app.inject(opts);
  const get = async <T = any>(url: string): Promise<T> => {
    const r = await call({ method: 'GET', url });
    if (r.statusCode >= 400) throw new Error(`GET ${url} → ${r.statusCode} ${r.body}`);
    return r.json() as T;
  };
  const post = async <T = any>(url: string, payload: unknown = {}, method: 'POST' | 'PUT' | 'DELETE' = 'POST'): Promise<T> => {
    const r = await call({ method, url, payload });
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
