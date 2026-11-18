/**
 * Shap Accountant (docs/ACCOUNTANT.md): a practice keeps its clients' books on its own server,
 * each client in a database of its own next to the practice's, named <practice db>__c_<12 hex>.
 * No query can join two databases, so a query in one client's books can't reach another's. Which
 * database a request goes to is Shap's own doing: only through the scope practice.ts sets after its
 * checks, every request (db/routing.ts), the way the demo company works. Nobody but the database's
 * own login may connect to a client's database (revokePublic).
 *
 * Here: the pools (small, one per client, closed when idle, and only so many at once), making a
 * client's database, migrating them all at start, putting the practice's people into them, and the
 * checks the client list shows.
 */
import { addDays, featureOn, financialYear, LEVELS, type DeadlineInputs, type Level } from '@shap/shared';
import { auditBooks } from '../audit/books.js';
import { createDb, type Sql } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { buildStatements } from '../statements/build.js';
import { currentStatements, stillSigned } from '../modules/financial-statements.js';
import type { Statements } from '../statements/build.js';
import { effectiveLock, freshTotals, getSettings, today } from './books.js';
import { lastEnded, tbHash, yearTb } from './papers.js';

export { LEVELS, type Level };
/** Who they are in the client's own database: its owner, or its accountant (read only, compiles). */
export const roleFor = (level: Level) => (level === 'books' ? 'owner' : 'accountant');
/** The roles a level may be in a client's books: writing up takes in compiling (open to compile). */
export const rolesFor = (level: Level): string[] => (level === 'books' ? ['owner', 'accountant'] : ['accountant']);

/** A client database's name, from the practice's and the client's id. */
export function clientDbName(practiceDb: string, clientId: string): string {
  const name = `${practiceDb}__c_${clientId.replace(/-/g, '').slice(0, 12)}`;
  if (!/^[a-z0-9_]{1,63}$/.test(name)) throw new Error(`Unusable client database name: ${name}`);
  return name;
}

export const dbNameOf = (url: string) => new URL(url).pathname.replace(/^\//, '') || 'shap';

/**
 * Whether this Shap's database login may make databases: each client's books are one. The default
 * install's login is Postgres's superuser and may; a least-privilege one (docs/deployment.md) needs
 * CREATEDB, which shap-ctl gives the server's own Shap when asked (deploy/vps/ctl/shap-ctl.sh).
 */
export async function databaseRights(sql: Sql): Promise<{ may: boolean; login: string }> {
  const [r] = await sql<{ login: string; may: boolean }[]>`select current_user::text as login, coalesce((select rolsuper or rolcreatedb from pg_roles where rolname = current_user), false) as may`;
  return { may: Boolean(r?.may), login: r?.login ?? '' };
}

/**
 * Other companies' books on this database server: the first company's (shap) and those
 * add-company.sh adds (shap_<name>), but not this one's own, its demo or its clients'. A practice's
 * Shap belongs on a server of its own (docs/ACCOUNTANT.md), so setup and Practice say so.
 */
export async function otherCompanies(sql: Sql, o: { testDbs?: string[] } = {}): Promise<boolean> {
  // testDbs: the test servers' databases, by name, as shap-ctl last counted them (made-up books).
  const [r] = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_database
    where datname ~ '^shap(_[a-z0-9]+)?$' and datname <> current_database() and datname !~ '_demo$' and not datistemplate
      and not (datname = any(${o.testDbs ?? []}::text[]))`;
  return (r?.n ?? 0) > 0;
}

/** How many clients' pools stay open at once (each up to 3 connections): the least used close first. */
export const MAX_CLIENT_POOLS = 12;

/**
 * What a route says when a client's database isn't opened. assertOwned's refusals are Shap's own
 * words, said whole (cut short, the caution and half the command were lost); anything else (the
 * database server's own text) is cut short.
 */
export const ownRefusal = (err: unknown): string => {
  const e = err as Error & { code?: unknown };
  const message = String(e?.message ?? '');
  return e?.code === 'missing' || e?.code === 'not_ours' ? message : message.slice(0, 400);
};

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

  /** How many pools are open now (the tests). */
  get open(): number {
    return this.pools.size;
  }

  get(dbName: string): Sql {
    // Only this practice's clients: a name from the table, checked against the pattern.
    if (!dbName.startsWith(`${this.practiceDb}__c_`) || !/^[a-z0-9_]{1,63}$/.test(dbName)) throw new Error(`Not one of this practice's client databases: ${dbName}`);
    let sql = this.pools.get(dbName);
    if (sql) {
      // The most recently used last, so the least used goes first.
      this.pools.delete(dbName);
      this.pools.set(dbName, sql);
      return sql;
    }
    while (this.pools.size >= MAX_CLIENT_POOLS) {
      // The least used is let go, never ended: a request still using it carries on (it holds the
      // pool itself), and its connections close by themselves once idle (60 seconds).
      const [oldest] = this.pools.keys();
      this.pools.delete(oldest!);
    }
    sql = createDb(this.urlFor(dbName), { max: 3, idleSeconds: 60 });
    this.pools.set(dbName, sql);
    return sql;
  }

  /** Only the database's own login connects to a client's database (Postgres lets everyone by default). */
  async revokePublic(practice: Sql, dbName: string): Promise<void> {
    if (!/^[a-z0-9_]{1,63}$/.test(dbName)) throw new Error(`Unusable client database name: ${dbName}`);
    await practice.unsafe(`revoke all on database "${dbName}" from public`);
  }

  /** A new client's database, with every migration; a database already there is never taken over. */
  async create(practice: Sql, dbName: string, companyName: string): Promise<Sql> {
    if (!/^[a-z0-9_]{1,63}$/.test(dbName)) throw new Error(`Unusable client database name: ${dbName}`);
    const [has] = await practice`select 1 from pg_database where datname = ${dbName}`;
    if (has) throw Object.assign(new Error(`A database called ${dbName} is there already`), { code: 'exists' });
    await practice.unsafe(`create database "${dbName}"`);
    try {
      await this.revokePublic(practice, dbName);
      const sql = this.get(dbName);
      await migrate(sql);
      // Nothing about a client goes to OpenWorks: no usage note, no prices (feedback.ts, market.ts).
      await sql`update settings set company_name = ${companyName}, usage_consent = false, market_consent = false where id`;
      return sql;
    } catch (err) {
      // Half made: gone again, so nothing is left behind (and backed up) that nobody can open.
      await this.drop(practice, dbName).catch(() => undefined);
      throw err;
    }
  }

  /** A client database that was never finished. */
  async drop(practice: Sql, dbName: string): Promise<void> {
    if (!dbName.startsWith(`${this.practiceDb}__c_`) || !/^[a-z0-9_]{1,63}$/.test(dbName)) throw new Error(`Not one of this practice's client databases: ${dbName}`);
    await this.forget(dbName);
    await practice.unsafe(`drop database if exists "${dbName}" with (force)`);
  }

  /** Asks the practice's own database (never the client's: its settings could steer a query there) who owns a client's. */
  private checker: Sql | null = null;
  /**
   * Only a database this Shap's own login owns is opened. One another login made under a client's
   * name (one that may make databases, on a server a test server shares, after the client's was
   * dropped or while it's restored) could be set up to run its own code in this Shap's sessions,
   * and this Shap's login may be Postgres's superuser.
   */
  async assertOwned(dbName: string): Promise<void> {
    this.checker ??= createDb(this.practiceUrl, { max: 2, idleSeconds: 30 });
    const [r] = await this.checker<{ mine: boolean; owner: string; me: string }[]>`
      select datdba = (select oid from pg_roles where rolname = current_user) as mine, pg_get_userbyid(datdba) as owner, current_user::text as me from pg_database where datname = ${dbName}`;
    if (!r) throw Object.assign(new Error(`This client’s database (${dbName}) isn’t on the server. Whoever runs the server restores it from its backup.`), { code: 'missing' });
    // Handing over a database someone planted would run its code as this Shap's login: said so.
    if (!r.mine)
      throw Object.assign(
        new Error(
          `This client’s database (${dbName}) belongs to another login (${r.owner}), so Shap doesn’t open it. Only if you know where it came from (made by this server’s own Postgres login before a move to a least-privilege login, or restored from this client’s backup), whoever runs the server can hand it to this Shap’s login (alter database "${dbName}" owner to "${r.me}";). If not, leave it and find out who made it (docs/ACCOUNTANT.md).`,
        ),
        { code: 'not_ours' },
      );
  }

  /** A client's pool, for a request: once its database is checked as this Shap's own. */
  async openOwn(dbName: string): Promise<Sql> {
    if (!dbName.startsWith(`${this.practiceDb}__c_`) || !/^[a-z0-9_]{1,63}$/.test(dbName)) throw new Error(`Not one of this practice's client databases: ${dbName}`);
    await this.assertOwned(dbName);
    return this.get(dbName);
  }

  /**
   * A pool of its own for a job in the background (the checks after an update, the monthly
   * invoices): never shared with requests, so ending it when the job is done can't cut one short.
   */
  async withOwn<T>(dbName: string, job: (sql: Sql) => Promise<T>): Promise<T> {
    if (!dbName.startsWith(`${this.practiceDb}__c_`) || !/^[a-z0-9_]{1,63}$/.test(dbName)) throw new Error(`Not one of this practice's client databases: ${dbName}`);
    await this.assertOwned(dbName);
    const sql = createDb(this.urlFor(dbName), { max: 2, idleSeconds: 10 });
    try {
      return await job(sql);
    } finally {
      await sql.end({ timeout: 5 }).catch(() => undefined);
    }
  }

  async forget(dbName: string): Promise<void> {
    const sql = this.pools.get(dbName);
    this.pools.delete(dbName);
    await sql?.end({ timeout: 5 });
  }

  async end(): Promise<void> {
    const all = [...this.pools.values(), ...(this.checker ? [this.checker] : [])];
    this.pools.clear();
    this.checker = null;
    await Promise.all(all.map((s) => s.end({ timeout: 5 })));
  }
}

/**
 * Every client's database gets the same migrations, at start (main.ts), one at a time with its pool
 * closed after, so a practice with many clients doesn't hold a connection for each. A client whose
 * migrations failed is marked, and isn't opened until they run (an older database under newer code
 * could give wrong figures without an error). Also: only the database's own login may connect.
 */
export async function migrateClients(practice: Sql, clients: ClientDbs, log: { info: (m: string) => void; warn: (o: object, m: string) => void }): Promise<{ ok: string[]; failed: string[] }> {
  const ok: string[] = [];
  const failed: string[] = [];
  // A client whose database was never finished (the server stopped while it was made): its
  // database and its row both go. (A client on its own Shap has no database here, ever: it stays.)
  for (const c of await practice<{ id: string }[]>`select id from practice_clients where db_name is null and kind <> 'linked' and created_at < now() - interval '1 hour'`) {
    await clients.drop(practice, clientDbName(clients.practiceDb, c.id)).catch((err) => log.warn({ err }, 'a client’s unfinished database couldn’t be dropped'));
    await practice`delete from practice_clients where id = ${c.id}`;
  }
  for (const c of await practice<{ id: string; dbName: string }[]>`select id, db_name from practice_clients where db_name is not null order by created_at`) {
    try {
      // Never one another login made under its name (assertOwned): marked, and not opened.
      await clients.assertOwned(c.dbName);
      await clients.revokePublic(practice, c.dbName);
      await clients.withOwn(c.dbName, (sql) => migrate(sql, (m) => log.info(`a client's books: ${m}`)));
      await practice`update practice_clients set migrate_error = null where id = ${c.id} and migrate_error is not null`;
      ok.push(c.id);
    } catch (err) {
      log.warn({ err }, 'a client’s books: migrations failed');
      await practice`update practice_clients set migrate_error = ${String((err as Error).message).slice(0, 1000)} where id = ${c.id}`;
      failed.push(c.id);
    }
  }
  return { ok, failed };
}

/** The last Pocket share brought in, if any. */
async function lastShare(db: Sql): Promise<ClientHealth['pocket']> {
  const [p] = await db<{ number: number; through: string; importedAt: Date; restored: boolean; changes: { added?: number; changed?: number; removed?: number } }[]>`
    select number, through::text as through, imported_at, restored, changes from pocket_shares order by imported_at desc, number desc limit 1`;
  return p ? { number: p.number, through: p.through, importedAt: new Date(p.importedAt).toISOString(), added: Number(p.changes.added ?? 0), changed: Number(p.changes.changed ?? 0), removed: Number(p.changes.removed ?? 0), restored: p.restored } : null;
}

/** Saves a client's checks, unless a run that started later saved first. */
export async function saveHealth(practice: Sql, id: string, health: ClientHealth, started: Date): Promise<void> {
  await practice`update practice_clients set health = ${practice.json(health as never)}, health_at = ${started}
    where id = ${id} and (health_at is null or health_at < ${started})`;
}

/** After an update (main.ts): every client's checks again, one at a time, in the background. */
export async function refreshAllHealth(practice: Sql, clients: ClientDbs, ids: string[], log: { warn: (o: object, m: string) => void }): Promise<void> {
  for (const c of await practice<{ id: string; dbName: string }[]>`select id, db_name from practice_clients where id = any(${ids}::uuid[]) and archived_at is null`) {
    const started = new Date();
    try {
      await saveHealth(practice, c.id, await clients.withOwn(c.dbName, (sql) => healthOf(sql, today(), log)), started);
    } catch (err) {
      log.warn({ err }, 'practice: a client’s checks failed');
    }
  }
}

/**
 * Puts someone from the practice into a client's database, as who they are there (role from
 * their level), so what they do is in the client's own audit trail by name. They never sign in to
 * it: they open it from the practice, which makes them a session (practice.ts). Marked as the
 * practice's ('!practice', no password), so they're never taken for the client's own directors.
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

/** Takes someone from the practice out of a client's books (their access went or changed, or the client was archived). */
export async function unmirrorUser(client: Sql, userId: string): Promise<void> {
  await client`delete from sessions where user_id = ${userId}`;
  await client`update users set active = false where id = ${userId}`;
}

export interface ClientHealth {
  at: string;
  company: string;
  setupDone: boolean;
  vatRegistered: boolean;
  /** The books audit (audit/books.ts) on the day they ran: what to fix (first) and what to look at. */
  audit: { fail: number; warn: number; items: { level: 'fail' | 'warn'; section: string; text: string }[] };
  /**
   * The financial statements for the newest year that has ended (none before the books' first year
   * ends): where they stand, their checks (IFRS for SMEs, company law) and the books audit at that
   * year end (what compiling refuses), whether a signed set still matches the books, and an earlier
   * ended year not yet approved. `error`: the checks couldn't run.
   */
  statements:
    | { yearEnd: string; status: string; changedSince: boolean; failing: string[]; look: string[]; assurance: string | null; unapprovedEarlier: string | null; error?: undefined }
    | { yearEnd: string | null; error: true }
    | { yearEnd: null; firstYearEnds: string; error?: undefined }
    | null;
  /** The books are closed up to this day (month end, a VAT period or a year). */
  lockedThrough: string | null;
  /** A Shap Pocket client's last share brought in, and what changed since the one before. */
  pocket?: { number: number; through: string; importedAt: string; added: number; changed: number; removed: number; restored?: boolean } | null;
  /** What the returns are worked out from (deadlinesFor, again each time the list is shown). */
  deadlineInputs: DeadlineInputs | null;
  /**
   * The trial balance's fingerprint at the latest ended year end (lib/papers.ts tbHash), and when (the
   * database's clock), for the list to say when the books have changed since a sign-off given before
   * then. The practice's own: healthForLink never sends it.
   */
  tb?: { fyEnd: string; hash: string; at: string } | null;
  /** A linked client's Shap's last answer couldn't be read: what's here is from before it. */
  stale?: true;
  /** Nothing of a linked client's checks was ever read but what the returns are worked out from. */
  unread?: true;
}

const ASSURANCE = 'The assurance fits the public interest score';

/** Three of Shap's checks, run on one client's books: what the practice's list shows. */
/** What the checks call (the tests give their own books audit). */
export interface HealthDeps {
  auditBooks: typeof auditBooks;
}

export async function healthOf(db: Sql, now = today(), log?: { warn: (o: object, m: string) => void }, deps: HealthDeps = { auditBooks }): Promise<ClientHealth> {
  await freshTotals(db);
  try {
    return await healthNow(db, now, log, deps);
  } catch (err) {
    // Someone saved while they ran: once more, on the books as they are then.
    if ((err as { code?: string }).code === '40001') return healthNow(db, now, log, deps);
    throw err;
  }
}

/** The month before a day's month, as YYYY-MM. */
const financialMonthBefore = (day: string): string => {
  const [y, m] = day.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

/** Long words cut to length, as the practice's list shows them (each check's text, a name). */
export const cutWords = (s: string, n = 500): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * What a business's own Shap sends its linked practice from its checks (modules/links.ts), and
 * nothing else: the same as a kept client's, each text cut to what the practice's list reads, and
 * without anything from Shap Pocket. (Everything named here is in LINK_WHAT_GOES, link.ts.)
 */
export function healthForLink(h: ClientHealth): ClientHealth {
  const st = h.statements;
  return {
    at: h.at,
    company: cutWords(h.company, 200),
    setupDone: h.setupDone,
    vatRegistered: h.vatRegistered,
    audit: { fail: h.audit.fail, warn: h.audit.warn, items: h.audit.items.slice(0, 12).map((i) => ({ level: i.level, section: cutWords(i.section), text: cutWords(i.text) })) },
    statements:
      !st || st.error || st.yearEnd === null
        ? st
        : { yearEnd: st.yearEnd, status: st.status, changedSince: st.changedSince, failing: st.failing.slice(0, 50).map((w) => cutWords(w)), look: st.look.slice(0, 50).map((w) => cutWords(w)), assurance: st.assurance === null ? null : cutWords(st.assurance), unapprovedEarlier: st.unapprovedEarlier },
    lockedThrough: h.lockedThrough,
    deadlineInputs: h.deadlineInputs && { ...h.deadlineInputs, dividendsPaid: [...new Set(h.deadlineInputs.dividendsPaid ?? [])].sort().slice(-100) },
  };
}

/** The books audit's findings for the list: what to fix first, then what to look at, the first 12. */
export function findingsForList(items: { level: string; section: string; text: string }[]): { fail: number; warn: number; items: { level: 'fail' | 'warn'; section: string; text: string }[] } {
  const bad = items.filter((a): a is typeof a & { level: 'fail' | 'warn' } => a.level === 'fail' || a.level === 'warn');
  const ordered = [...bad.filter((a) => a.level === 'fail'), ...bad.filter((a) => a.level === 'warn')];
  // Cut to what the list shows, kept or linked alike (healthForLink).
  return { fail: ordered.filter((a) => a.level === 'fail').length, warn: ordered.filter((a) => a.level === 'warn').length, items: ordered.slice(0, 12).map((a) => ({ level: a.level, section: cutWords(a.section), text: cutWords(a.text) })) };
}

async function healthNow(db: Sql, now: string, log: { warn: (o: object, m: string) => void } | undefined, deps: HealthDeps): Promise<ClientHealth> {
  // One view of the books for all of it, as they stand now.
  return db.begin('isolation level repeatable read', async (t) => {
    // The checks take the pool's type; inside the transaction they only query.
    const tx = t as unknown as Sql;
    const s = await getSettings(tx);
    // Employees are counted, never named: the list is kept in the practice's own database.
    const audit = findingsForList(await deps.auditBooks(tx, now, { people: false }));
    let statements: ClientHealth['statements'] = null;
    if (s.setupDone) {
      const ended = financialYear(addDays(financialYear(now, s.fyEndMonth).start, -1), s.fyEndMonth).end;
      try {
        const [first] = await tx<{ d: string | null }[]>`select min(date)::text as d from ledger_totals where amount_cents <> 0`;
        const firstEnd = first?.d ? financialYear(first.d, s.fyEndMonth).end : null;
        if (!firstEnd) statements = null;
        else if (firstEnd > ended) statements = { yearEnd: null, firstYearEnds: firstEnd };
        else {
          const { statements: st, row } = await currentStatements(tx, ended);
          const status = row?.status ?? 'draft';
          const signed = row?.snapshot && (status === 'compiled' || status === 'approved');
          const changedSince = signed ? !stillSigned(row as { snapshot: Statements; snapshotHash: string }, await buildStatements(tx, ended, st.details)) : false;
          // What compiling refuses: the statements' own checks, and the books audit at the year end.
          const atYearEnd = signed ? [] : (await deps.auditBooks(tx, ended, { people: false })).filter((i) => i.level === 'fail').map((i) => `Books check at the year end: ${i.text}`);
          const assurance = st.checks.find((c) => c.label === ASSURANCE && !c.ok)?.detail ?? null;
          const approved = new Set((await tx<{ fyEnd: string }[]>`select fy_end::text as fy_end from financial_statements where status = 'approved'`).map((r) => r.fyEnd));
          let earlier: string | null = null;
          for (let end = firstEnd; end < ended && !earlier; end = financialYear(addDays(end, 1), s.fyEndMonth).end) if (!approved.has(end)) earlier = end;
          statements = {
            yearEnd: ended,
            status,
            changedSince,
            failing: [...st.checks.filter((c) => !c.ok && c.level !== 'look').map((c) => c.label), ...atYearEnd].slice(0, 50).map((w) => cutWords(w)),
            look: st.checks.filter((c) => !c.ok && c.level === 'look' && c.label !== ASSURANCE).map((c) => cutWords(c.label)).slice(0, 50),
            assurance: assurance === null ? null : cutWords(assurance),
            unapprovedEarlier: earlier,
          };
        }
      } catch (err) {
        log?.warn({ err }, 'practice: a client’s statements checks failed');
        statements = { yearEnd: ended, error: true };
      }
    }
    // An employer: registered for PAYE, paying people on Shap's payroll, or paid someone lately.
    const [emp] = await tx<{ n: number }[]>`select count(*)::int as n from employees where active`;
    const [runs] = await tx<{ n: number }[]>`select count(*)::int as n from pay_runs where pay_date >= ${addDays(now, -100)}::date`;
    const employer = Boolean(s.payeRef?.trim()) || (featureOn(s.features, 'payroll') && (emp?.n ?? 0) > 0) || (runs?.n ?? 0) > 0;
    // Dividends paid: Shap's own records, dividends in ledgers brought in from another package
    // (the day each was declared there: a trial balance's own journal has no such day), and
    // journals by hand to Dividends: a month whose hand journals come to a dividend paid (one undone
    // in the month comes to nothing), on its first such day. Far enough back for the DTR01s still
    // on the list (deadlinesFor's 45 days back: due at the end of the month after).
    const back = addDays(now, -45);
    const since = `${financialMonthBefore(back)}-01`;
    const paid = await tx<{ d: string }[]>`
      select distinct paid_on::text as d from dividends where paid_on >= ${since}::date
      union
      select distinct j.date::text from journals j join ledger_imports i on i.id = j.ledger_import_id and i.kind = 'ledger'
        join journal_lines jl on jl.journal_id = j.id join accounts a on a.id = jl.account_id
        where a.system_key = 'dividends' and jl.debit_cents > 0 and j.date >= ${since}::date
      union
      select min(case when jl.debit_cents > 0 then j.date end)::text from journals j
        join journal_lines jl on jl.journal_id = j.id join accounts a on a.id = jl.account_id
        where a.system_key = 'dividends' and j.kind = 'manual' and j.ledger_import_id is null and j.date >= ${since}::date
        group by date_trunc('month', j.date) having sum(jl.debit_cents - jl.credit_cents) > 0
      order by 1`;
    // The latest ended year's trial balance fingerprint (lib/papers.ts), for the practice's list.
    let tb: ClientHealth['tb'] = null;
    if (s.setupDone) {
      const fyEnd = lastEnded(s.fyEndMonth, now);
      // When, by the database's clock (as the sign-offs' are): the books as they stood then.
      const [{ at } = { at: new Date().toISOString() }] = await tx<{ at: string }[]>`select now()::text as at`;
      tb = { fyEnd, hash: tbHash((await yearTb(tx, fyEnd)).rows), at };
    }
    return {
      at: new Date().toISOString(),
      company: s.companyName,
      setupDone: s.setupDone,
      vatRegistered: s.vatRegistered,
      audit,
      statements,
      lockedThrough: await effectiveLock(tx),
      pocket: await lastShare(tx),
      deadlineInputs: s.setupDone
        ? { businessType: s.businessType, vatRegistered: s.vatRegistered, vatCategory: s.vatCategory, fyEndMonth: s.fyEndMonth, turnoverTax: s.turnoverTax, employer, approvedPbo: Boolean(s.approvedPbo), dividendsPaid: paid.map((p) => p.d) }
        : null,
      tb,
    };
  }) as Promise<ClientHealth>;
}
