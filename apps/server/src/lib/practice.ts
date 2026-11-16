/**
 * Shap Accountant (docs/ACCOUNTANT.md): a practice keeps its clients' books on its own server,
 * each client in a database of its own next to the practice's, named <practice db>__c_<12 hex>.
 * No query can join two databases, so one client's books can't reach another's: the walls are
 * Postgres's own. A request reaches a client's database only through the scope practice.ts sets
 * after its checks (db/routing.ts), the way the demo company works.
 *
 * Here: the pools (small, one per client, closed when idle), making a client's database, putting
 * the practice's people into it, and the checks the client list shows.
 */
import { addDays, deadlinesFor, featureOn, financialYear, type Deadline } from '@shap/shared';
import { auditBooks } from '../audit/books.js';
import { createDb, type Sql } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { ensureDatabase } from '../db/routing.js';
import { buildStatements } from '../statements/build.js';
import { effectiveLock, getSettings, today } from './books.js';

/** The practice's people's two ways into a client: writing the books up, or reading and compiling. */
export const LEVELS = ['books', 'review'] as const;
export type Level = (typeof LEVELS)[number];
/** Who they are in the client's own database. */
export const roleFor = (level: Level) => (level === 'books' ? 'owner' : 'accountant');

/** A client database's name, from the practice's and the client's id. */
export function clientDbName(practiceDb: string, clientId: string): string {
  const name = `${practiceDb}__c_${clientId.replace(/-/g, '').slice(0, 12)}`;
  if (!/^[a-z0-9_]{1,63}$/.test(name)) throw new Error(`Unusable client database name: ${name}`);
  return name;
}

export const dbNameOf = (url: string) => new URL(url).pathname.replace(/^\//, '') || 'shap';

/** The clients' pools, made when first needed. */
export class ClientDbs {
  private pools = new Map<string, Sql>();
  constructor(private readonly practiceUrl: string) {}

  /** The practice's own database's name. */
  get practiceDb(): string {
    return dbNameOf(this.practiceUrl);
  }

  urlFor(dbName: string): string {
    const u = new URL(this.practiceUrl);
    u.pathname = `/${dbName}`;
    return u.toString();
  }

  get(dbName: string): Sql {
    // Only this practice's clients: a name from the table, checked against the pattern.
    if (!dbName.startsWith(`${this.practiceDb}__c_`) || !/^[a-z0-9_]{1,63}$/.test(dbName)) throw new Error(`Not one of this practice's client databases: ${dbName}`);
    let sql = this.pools.get(dbName);
    if (!sql) {
      sql = createDb(this.urlFor(dbName), { max: 3, idleSeconds: 60 });
      this.pools.set(dbName, sql);
    }
    return sql;
  }

  /** A new client's database, with every migration. */
  async create(practice: Sql, dbName: string, companyName: string): Promise<Sql> {
    await ensureDatabase(practice, this.urlFor(dbName));
    const sql = this.get(dbName);
    await migrate(sql);
    await sql`update settings set company_name = ${companyName} where id`;
    return sql;
  }

  async forget(dbName: string): Promise<void> {
    const sql = this.pools.get(dbName);
    this.pools.delete(dbName);
    await sql?.end({ timeout: 5 });
  }

  async end(): Promise<void> {
    const all = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(all.map((s) => s.end({ timeout: 5 })));
  }
}

/**
 * Puts someone from the practice into a client's database, as who they are there (role from
 * their level), so what they do is in the client's own audit trail by name. They never sign in to
 * it: they open it from the practice, which makes them a session (practice.ts).
 */
export async function mirrorUser(client: Sql, u: { id: string; name: string; email: string }, level: Level): Promise<void> {
  const role = roleFor(level);
  await client.begin(async (tx) => {
    // Someone of the same email under another id (the practice re-added them): their old row steps aside.
    await tx`update users set email = email || '.replaced.' || left(id::text, 8), active = false where lower(email) = lower(${u.email}) and id <> ${u.id}`;
    await tx`
      insert into users (id, name, email, password_hash, role, active)
      values (${u.id}, ${u.name}, ${u.email}, '!practice', ${role}, true)
      on conflict (id) do update set name = excluded.name, email = excluded.email, role = excluded.role, active = true,
        profile_id = null, access_add = '{}', access_remove = '{}'
    `;
  });
}

/** Takes someone from the practice out of a client's books (their access went, or the client was archived). */
export async function unmirrorUser(client: Sql, userId: string): Promise<void> {
  await client`delete from sessions where user_id = ${userId}`;
  await client`update users set active = false where id = ${userId}`;
}

export interface ClientHealth {
  at: string;
  company: string;
  setupDone: boolean;
  vatRegistered: boolean;
  /** The books audit (audit/books.ts): what fails and what to look at. */
  audit: { fail: number; warn: number; items: { level: 'fail' | 'warn'; section: string; text: string }[] };
  /** The financial statements' checks (IFRS for SMEs, company law) for the last year that has ended. */
  statements: { yearEnd: string; failing: string[]; look: string[] } | null;
  /** The books are closed up to this day (month end, a VAT period or a year). */
  lockedThrough: string | null;
  deadlines: (Deadline & { past: boolean })[];
}

/** Every check Shap has, run on one client's books: what the practice's list shows. */
export async function healthOf(db: Sql, now = today()): Promise<ClientHealth> {
  const s = await getSettings(db);
  const audit = await auditBooks(db, now);
  const bad = audit.filter((a): a is typeof a & { level: 'fail' | 'warn' } => a.level !== 'ok');
  let statements: ClientHealth['statements'] = null;
  if (s.setupDone) {
    const current = financialYear(now, s.fyEndMonth);
    const last = financialYear(addDays(current.start, -1), s.fyEndMonth);
    try {
      const st = await buildStatements(db, last.end);
      statements = {
        yearEnd: last.end,
        failing: st.checks.filter((c) => !c.ok && c.level !== 'look').map((c) => c.label),
        look: st.checks.filter((c) => !c.ok && c.level === 'look').map((c) => c.label),
      };
    } catch {
      statements = null; // no year to build yet
    }
  }
  const [emp] = await db<{ n: number }[]>`select count(*)::int as n from employees where active`;
  const employees = emp?.n ?? 0;
  const employer = featureOn(s.features, 'payroll') && employees > 0;
  const deadlines = s.setupDone
    ? deadlinesFor({ businessType: s.businessType, vatRegistered: s.vatRegistered, vatCategory: s.vatCategory, fyEndMonth: s.fyEndMonth, turnoverTax: s.turnoverTax, employer }, now)
    : [];
  return {
    at: new Date().toISOString(),
    company: s.companyName,
    setupDone: s.setupDone,
    vatRegistered: s.vatRegistered,
    audit: { fail: bad.filter((a) => a.level === 'fail').length, warn: bad.filter((a) => a.level === 'warn').length, items: bad.slice(0, 12).map((a) => ({ level: a.level, section: a.section, text: a.text })) },
    statements,
    lockedThrough: await effectiveLock(db),
    deadlines,
  };
}
