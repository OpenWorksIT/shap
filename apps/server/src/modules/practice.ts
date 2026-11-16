/**
 * Shap Accountant (docs/ACCOUNTANT.md): with the feature on, this server is a practice's. It keeps
 * clients' books, each in a database of its own (lib/practice.ts), and shows the practice one list
 * of its clients with what three of Shap's checks found in each and some of the returns coming up.
 *
 * Opening a client works like showing the demo company: the browser gets a session in the
 * client's own database (as the practice person they are, mirrored there) and a cookie saying
 * which client. Every request with that cookie is checked here first: the practice's own session
 * must still be good, the feature on, the client not archived, its migrations all run, the person
 * still allowed in, and as who they were let in. Only then is the request routed to the client's
 * database (db/routing.ts). If any check fails, the cookies go and the request is refused (409,
 * client_closed): the page goes back to the practice's list rather than show the practice's own
 * books under the client's name. A session made in one client's database means nothing in
 * another's, so a cookie changed by hand opens nothing.
 */
import { createReadStream, existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { deadlinesFor, featureOn, LEVELS, type Level } from '@shap/shared';
import { z } from 'zod';
import { browserName, can, CLIENT_COOKIE, confirmPassword, CLIENT_SESSION_COOKIE, loadUser, requireAccess, requireRole, SESSION_COOKIE, userOrThrow, type AuthUser } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Sql } from '../db/index.js';
import { dbScope, inClient } from '../db/routing.js';
import { audit } from '../lib/audit.js';
import { today } from '../lib/books.js';
import { badRequest, forbidden, HttpError, notFound } from '../lib/errors.js';
import { routePath } from '../lib/http.js';
import { clientDbName, healthOf, mirrorUser, roleFor, rolesFor, saveHealth, unmirrorUser, type ClientHealth } from '../lib/practice.js';
import { SERVER_ONLY, under } from '../lib/server-only.js';
import { applyPocketShare, readPocketShare } from './import/pocket-share.js';
import { BACKUP_NAME } from './system.js';
import { newToken, sha256 } from '../lib/tokens.js';
import { parse } from '../lib/validate.js';

export { CLIENT_COOKIE };

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * What isn't for a client's books, while they're open: the server's own (lib/server-only.ts), the
 * demo, the test server, the practice's own people (the people in a client's books are the
 * practice's, put there from the practice), signing in and the password, and the practice layer
 * itself (but its "where am I" and "back to the practice").
 */
export const NOT_IN_A_CLIENT = [...SERVER_ONLY, '/api/demo', '/api/test-server', '/api/users', '/api/profiles', '/api/practice', '/api/auth/login', '/api/auth/password', '/api/auth/mfa'];
export const IN_A_CLIENT_TOO = ['/api/practice/here', '/api/practice/leave'];

const CLOSED = 'Those books are no longer open here: go back to the practice (Practice, in the menu) and open them again.';
const NOT_GIVEN = 'You haven’t been given this client: ask whoever runs the practice’s Shap.';

interface ClientRow {
  id: string;
  name: string;
  kind: string;
  dbName: string | null;
  archivedAt: Date | null;
  health: ClientHealth | null;
  healthAt: Date | null;
  migrateError: string | null;
}

const practiceOn = async (real: Sql) => {
  const [s] = await real<{ features: Record<string, boolean> | null }[]>`select features from settings where id`;
  return featureOn(s?.features, 'practice');
};

/** Who is signed in to the practice itself (its own session cookie), whatever the request is routed to. */
async function practiceUser(real: Sql, req: FastifyRequest): Promise<AuthUser | null> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const [s] = await real<{ userId: string }[]>`
    select s.user_id from sessions s join users u on u.id = s.user_id where s.token_hash = ${sha256(token)} and s.expires_at > now() and u.active`;
  return s ? loadUser(real, s.userId) : null;
}

/** May they open this client, and how? The practice's owner opens all of them, either way. */
async function levelFor(real: Sql, user: AuthUser, clientId: string): Promise<Level | null> {
  if (user.role === 'owner') return 'books';
  if (!can(user, 'practice.clients')) return null;
  const [a] = await real<{ level: Level }[]>`select level from practice_access where client_id = ${clientId} and user_id = ${user.id}`;
  return a?.level ?? null;
}

export function registerPracticeScope(app: FastifyInstance, ctx: Ctx): void {
  const { dbs, clients } = ctx;
  const clear = (reply: FastifyReply) => {
    reply.clearCookie(CLIENT_COOKIE, { path: '/' });
    reply.clearCookie(CLIENT_SESSION_COOKIE, { path: '/' });
  };

  app.addHook('onRequest', async (req, reply) => {
    await scopeClient(req, reply);
    // The page says which client's books it's in (lib/api.ts): a request not routed there now
    // (the cookies went with an earlier refusal) is refused too, never answered from the practice's own.
    const claimed = req.headers['x-shap-books'];
    const p = routePath(req);
    if (typeof claimed === 'string' && claimed && p.startsWith('/api/') && dbScope.getStore()?.client?.id !== claimed && !dbScope.getStore()?.demo) {
      if (!IN_A_CLIENT_TOO.includes(p) && !(req.method === 'GET' && p === '/api/auth/me') && !p.startsWith('/api/auth/logout')) throw new HttpError(409, CLOSED, 'client_closed');
    }
  });

  async function scopeClient(req: FastifyRequest, reply: FastifyReply) {
    const id = req.cookies?.[CLIENT_COOKIE];
    const scope = dbScope.getStore();
    if (!id || !scope || scope.demo || !routePath(req).startsWith('/api/')) return;
    const p = routePath(req);
    const fail = () => {
      clear(reply);
      // A page that thought it was in a client's books mustn't read or change the practice's own
      // instead: refused, and the page goes back to the practice (lib/api.ts). Where am I, back to
      // the practice, and who am I carry on in the practice's own books.
      if (!IN_A_CLIENT_TOO.includes(p) && !(req.method === 'GET' && p === '/api/auth/me') && !p.startsWith('/api/auth/logout')) throw new HttpError(409, CLOSED, 'client_closed');
    };
    if (!isUuid(id)) return fail();
    const user = await practiceUser(dbs.real, req);
    // Not signed in to the practice at all: the cookies go, and it's an ordinary signed-out request.
    if (!user) return clear(reply);
    if (!(await practiceOn(dbs.real))) return fail();
    const [c] = await dbs.real<ClientRow[]>`select * from practice_clients where id = ${id} and archived_at is null and db_name is not null and migrate_error is null`;
    const level = c ? await levelFor(dbs.real, user, c.id) : null;
    if (!c || !level) return fail();
    const sql = clients.get(c.dbName!);
    // Their session in the client's books, as that same person and as who they were let in as: gone,
    // ended, or their level lowered since, and they're back in the practice.
    const token = req.cookies?.[CLIENT_SESSION_COOKIE];
    const [s] = token
      ? await sql<{ userId: string; role: string }[]>`
          select s.user_id, u.role from sessions s join users u on u.id = s.user_id where s.token_hash = ${sha256(token)} and s.expires_at > now() and u.active`
      : [];
    if (!s || s.userId !== user.id || !rolesFor(level).includes(s.role)) return fail();
    scope.client = { id: c.id, name: c.name, sql, practiceOwner: user.role === 'owner' };
    if (under(p, NOT_IN_A_CLIENT) && !IN_A_CLIENT_TOO.includes(p)) throw forbidden('That’s the practice’s own, so it isn’t done in a client’s books: tap Back to the practice, at the top, first.');
  }
}

export function registerPracticeRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { dbs, clients, config } = ctx;
  const real = dbs.real;
  const cookie = { httpOnly: true, sameSite: 'lax' as const, secure: config.COOKIE_SECURE, path: '/', maxAge: config.SESSION_TTL_HOURS * 3600 };
  const limit = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute' } });
  const view = { preHandler: requireAccess('practice.clients') };
  const manage = { preHandler: requireAccess('practice.manage') };

  const assertOn = async () => {
    if (!(await practiceOn(real))) throw badRequest('Shap Accountant is off. The owner switches it on under Settings → Features.');
  };
  const clientOr404 = async (id: string) => {
    if (!isUuid(id)) throw notFound('Client');
    const [c] = await real<ClientRow[]>`select * from practice_clients where id = ${id}`;
    if (!c) throw notFound('Client');
    return c;
  };
  const usable = (c: ClientRow) => {
    if (!c.dbName) throw badRequest('This client’s books were never finished on the server: archive it and add it again.');
    if (c.archivedAt) throw badRequest('That client is archived');
    if (c.migrateError) throw new HttpError(409, 'Shap couldn’t bring this client’s books up to date when it last started, so they aren’t opened until it can. Whoever runs the server can see why in its log; they open again after the next start that brings them up to date.', 'not_migrated');
    return c.dbName;
  };

  /** Where this browser is: the practice's own books, or a client's. Works in both. */
  app.get('/api/practice/here', { preHandler: requireRole() }, async () => ({ client: inClient() }));

  app.get('/api/practice', view, async (req) => {
    const user = userOrThrow(req);
    await assertOn();
    const rows = await real<(ClientRow & { level: Level | null })[]>`
      select c.*, a.level from practice_clients c left join practice_access a on a.client_id = c.id and a.user_id = ${user.id}
      where c.db_name is not null order by c.archived_at nulls first, lower(c.name)`;
    const manages = can(user, 'practice.manage');
    // Who manages sees every client (they can give themselves any of them); others, theirs.
    const mine = user.role === 'owner' || manages ? rows : rows.filter((r) => r.level);
    // Only staff can be given a client: read-only accountants can't have "Open the clients they're given".
    const people = manages ? await real<{ id: string; name: string; email: string; role: string }[]>`select id, name, email, role from users where active and role = 'staff' order by lower(name)` : [];
    const access = manages ? await real<{ clientId: string; userId: string; level: Level }[]>`select client_id, user_id, level from practice_access` : [];
    const now = today();
    return {
      clients: mine.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        archived: r.archivedAt != null,
        notUpToDate: r.migrateError != null,
        level: user.role === 'owner' ? 'books' : r.level,
        // The returns are worked out again for today, so a date moves to past by itself.
        health: r.health ? { ...r.health, deadlines: r.health.deadlineInputs ? deadlinesFor(r.health.deadlineInputs, now) : [] } : null,
        healthAt: r.healthAt,
        access: access.filter((a) => a.clientId === r.id).map((a) => ({ userId: a.userId, level: a.level })),
      })),
      people,
    };
  });

  /** A new client whose books the practice keeps: a database of its own, set up through its Welcome when first opened. */
  app.post('/api/practice/clients', { ...manage, config: limit(10) }, async (req) => {
    const user = userOrThrow(req);
    await assertOn();
    // kept: written up here; imported: brought in from the package the client keeps them in
    // (books-import.ts); pocket: a read-only copy of their Shap Pocket books, from their shares.
    const { name, kind } = parse(z.object({ name: z.string().trim().min(1).max(200), kind: z.enum(['kept', 'imported', 'pocket']).default('kept') }), req.body);
    const [c] = await real<{ id: string }[]>`insert into practice_clients (name, kind, created_by) values (${name}, ${kind}, ${user.id}) returning id`;
    const dbName = clientDbName(clients.practiceDb, c!.id);
    try {
      await clients.create(real, dbName, name);
    } catch (err) {
      await real`delete from practice_clients where id = ${c!.id}`;
      req.log.error({ err }, 'practice: a client’s database couldn’t be made');
      if ((err as { code?: string }).code === '42501')
        throw badRequest('Couldn’t make this client’s books on the server. Shap Accountant needs the database login to be allowed to create databases: whoever runs the server can allow it (docs/ACCOUNTANT.md, on Shap’s GitHub).');
      throw err;
    }
    await real.begin(async (tx) => {
      await tx`update practice_clients set db_name = ${dbName} where id = ${c!.id}`;
      await audit(tx, { userId: user.id, action: 'practice_client_add', entity: 'practice_client', entityId: c!.id, ip: req.ip, details: { name, kind } });
    });
    return { id: c!.id };
  });

  /** Open a client's books in this browser: as given, or, for someone who writes them up, to compile (read only). */
  app.post('/api/practice/clients/:id/open', { ...view, config: limit(30) }, async (req, reply) => {
    const user = userOrThrow(req);
    await assertOn();
    const c = await clientOr404((req.params as { id: string }).id);
    const dbName = usable(c);
    const given = await levelFor(real, user, c.id);
    if (!given) throw forbidden(NOT_GIVEN);
    const { as } = parse(z.object({ as: z.enum(LEVELS).optional() }), req.body ?? {});
    // Never more than given: writing up takes in compiling, not the other way round.
    if (as === 'books' && given !== 'books') throw forbidden('You’ve been given these books to read and compile, not to write up.');
    // A Shap Pocket client's books are the owner's, on their phone: here they're a copy to read and compile.
    const level = c.kind === 'pocket' ? 'compile' : (as ?? given);
    const sql = clients.get(dbName);
    await mirrorUser(sql, user, level);
    const token = newToken();
    await sql`insert into sessions (token_hash, user_id, expires_at, user_agent, ip)
      values (${sha256(token)}, ${user.id}, now() + make_interval(hours => ${config.SESSION_TTL_HOURS}), ${browserName(req)}, ${req.ip})`;
    reply.setCookie(CLIENT_COOKIE, c.id, cookie);
    reply.setCookie(CLIENT_SESSION_COOKIE, token, cookie);
    await audit(real, { userId: user.id, action: 'practice_client_open', entity: 'practice_client', entityId: c.id, ip: req.ip, details: { level, role: roleFor(level) } });
    return { ok: true, name: c.name, level };
  });

  // The checks of one client at a time, and not again within the minute (a quick look in and out).
  const running = new Map<string, Promise<ClientHealth | null>>();
  const refreshHealth = (id: string, sql: Sql): Promise<ClientHealth | null> => {
    const already = running.get(id);
    if (already) return already;
    const started = new Date();
    const job = (async () => {
      try {
        const health = await healthOf(sql, today(), { warn: (o, m) => app.log.warn(o, m) });
        // A slower run that started earlier never overwrites a newer one.
        await saveHealth(real, id, health, started);
        return health;
      } catch (err) {
        app.log.warn({ err }, 'practice: a client’s checks failed');
        return null;
      } finally {
        running.delete(id);
      }
    })();
    running.set(id, job);
    return job;
  };

  /** Back to the practice: the client's session ends, and its checks run again for the list (waited for, up to a few seconds). */
  app.post('/api/practice/leave', async (req, reply) => {
    const here = dbScope.getStore()?.client ?? null;
    const token = req.cookies?.[CLIENT_SESSION_COOKIE];
    reply.clearCookie(CLIENT_COOKIE, { path: '/' });
    reply.clearCookie(CLIENT_SESSION_COOKIE, { path: '/' });
    if (here && token) {
      await here.sql`delete from sessions where token_hash = ${sha256(token)}`.catch(() => undefined);
      const [c] = await real<{ healthAt: Date | null }[]>`select health_at from practice_clients where id = ${here.id}`;
      if (!c?.healthAt || Date.now() - c.healthAt.getTime() > 10_000) {
        await Promise.race([refreshHealth(here.id, here.sql), new Promise((r) => setTimeout(r, 8000).unref())]);
      }
    }
    return { ok: true };
  });

  /** Run the checks on a client's books now. */
  app.post('/api/practice/clients/:id/checks', { ...view, config: limit(10) }, async (req) => {
    const user = userOrThrow(req);
    await assertOn();
    const c = await clientOr404((req.params as { id: string }).id);
    const dbName = usable(c);
    if (!(await levelFor(real, user, c.id))) throw forbidden(NOT_GIVEN);
    const health = await refreshHealth(c.id, clients.get(dbName));
    if (!health) throw badRequest('Shap’s checks couldn’t run on this client’s books. Open them and look, or let us know: tap Feedback, then Bug found.');
    return { health: { ...health, deadlines: health.deadlineInputs ? deadlinesFor(health.deadlineInputs, today()) : [] } };
  });

  /** Who in the practice opens this client, and how. */
  app.put('/api/practice/clients/:id/access', manage, async (req) => {
    const user = userOrThrow(req);
    await assertOn();
    const c = await clientOr404((req.params as { id: string }).id);
    const { access } = parse(z.object({ access: z.array(z.object({ userId: z.string().uuid(), level: z.enum(LEVELS) })).max(200) }), req.body);
    const people = new Set((await real<{ id: string }[]>`select id from users where active and role = 'staff'`).map((p) => p.id));
    for (const a of access) if (!people.has(a.userId)) throw badRequest('Only the practice’s own staff can be given a client');
    const before = await real<{ userId: string; level: Level }[]>`select user_id, level from practice_access where client_id = ${c.id}`;
    await real.begin(async (tx) => {
      await tx`delete from practice_access where client_id = ${c.id}`;
      for (const a of access) await tx`insert into practice_access (client_id, user_id, level) values (${c.id}, ${a.userId}, ${a.level})`;
      await audit(tx, { userId: user.id, action: 'practice_client_access', entity: 'practice_client', entityId: c.id, ip: req.ip, details: { access } });
    });
    // Whoever lost the client, or whose level changed, is out of its books at once (open it again, as given now).
    const now = new Map(access.map((a) => [a.userId, a.level]));
    if (c.dbName) for (const b of before) if (now.get(b.userId) !== b.level) await unmirrorUser(clients.get(c.dbName), b.userId);
    return { ok: true };
  });

  /** Archive a client: whoever is in its books is taken out, and nobody opens it until it's brought back; its database (and backups) stay. */
  app.post('/api/practice/clients/:id/archive', manage, async (req) => {
    const user = userOrThrow(req);
    await assertOn();
    const c = await clientOr404((req.params as { id: string }).id);
    const { archived } = parse(z.object({ archived: z.boolean() }), req.body);
    await real.begin(async (tx) => {
      await tx`update practice_clients set archived_at = ${archived ? new Date() : null} where id = ${c.id}`;
      await audit(tx, { userId: user.id, action: archived ? 'practice_client_archive' : 'practice_client_unarchive', entity: 'practice_client', entityId: c.id, ip: req.ip });
    });
    if (archived && c.dbName) await clients.get(c.dbName)`delete from sessions`;
    return { ok: true };
  });

  /**
   * A Shap Pocket share into a Pocket client's books (lib: import/pocket-share.ts), for whoever writes
   * up the client's books here (the owner, or someone given them to write up): the whole of the books,
   * entry by entry, with what changed since the last share. Its checks run again for the list.
   */
  app.post('/api/practice/clients/:id/pocket-share', { ...view, bodyLimit: 60 * 1024 * 1024, config: limit(10) }, async (req) => {
    const user = userOrThrow(req);
    await assertOn();
    const c = await clientOr404((req.params as { id: string }).id);
    const dbName = usable(c);
    if (c.kind !== 'pocket') throw badRequest('This client’s books aren’t kept on Shap Pocket.');
    if ((await levelFor(real, user, c.id)) !== 'books') throw forbidden('Bringing in their share is for whoever writes up their books.');
    const { name, dataBase64 } = parse(z.object({ name: z.string().max(200), dataBase64: z.string().max(80_000_000) }), req.body);
    const share = readPocketShare(name, Buffer.from(dataBase64, 'base64'));
    const sql = clients.get(dbName);
    // The practice person is there by name, as the copy's reader.
    await mirrorUser(sql, user, 'compile');
    const result = await sql.begin(async (tx) => {
      const r = await applyPocketShare(tx, share, name, user.id);
      await audit(tx, { userId: user.id, action: 'pocket_share_in', entity: 'pocket_share', entityId: String(r.number), ip: req.ip, details: { added: r.changes.added.length, changed: r.changes.changed.length, removed: r.changes.removed.length } });
      return r;
    });
    await audit(real, { userId: user.id, action: 'practice_pocket_share', entity: 'practice_client', entityId: c.id, ip: req.ip, details: { number: result.number } });
    await refreshHealth(c.id, sql);
    return result;
  });

  /**
   * A client's own backups (shap-ctl backs up each client's database, named after it), for the
   * practice's owner only: to hand a client its books, or keep them as the Companies Act asks
   * (s24). Downloading one takes the owner's password and gives a link for two minutes, as the
   * practice's own backups do (system.ts).
   */
  const owner = { preHandler: requireRole('owner') };
  const backupsOf = async (dbName: string) => {
    const dir = config.BACKUP_DIR;
    if (!existsSync(dir)) return [];
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => BACKUP_NAME.test(n) && n.startsWith(`${dbName}-`));
    return (await Promise.all(names.map(async (name) => ({ name, s: await stat(join(dir, name)) }))))
      .map(({ name, s }) => ({ name, sizeBytes: s.size, at: s.mtime.toISOString() }))
      .sort((a, b) => b.at.localeCompare(a.at));
  };
  app.get('/api/practice/clients/:id/backups', owner, async (req) => {
    await assertOn();
    const c = await clientOr404((req.params as { id: string }).id);
    return { backups: c.dbName ? await backupsOf(c.dbName) : [] };
  });
  app.post('/api/practice/clients/:id/backups/:name/link', { ...owner, config: limit(10) }, async (req) => {
    const user = userOrThrow(req);
    await assertOn();
    const { id, name } = parse(z.object({ id: z.string(), name: z.string().max(200) }), req.params);
    const c = await clientOr404(id);
    if (!c.dbName || !BACKUP_NAME.test(name) || !name.startsWith(`${c.dbName}-`)) throw notFound('Backup');
    await confirmPassword(real, user.id, parse(z.object({ password: z.string().max(200).optional() }), req.body ?? {}).password, req.ip);
    const t = ctx.secrets.signToken('client-backup', { id: c.id, name, uid: user.id }, 120);
    return { url: `/api/practice/clients/${c.id}/backups/${encodeURIComponent(name)}?t=${encodeURIComponent(t)}` };
  });
  app.get('/api/practice/clients/:id/backups/:name', owner, async (req, reply) => {
    const user = userOrThrow(req);
    const { id, name } = parse(z.object({ id: z.string(), name: z.string().max(200) }), req.params);
    const c = await clientOr404(id);
    if (!c.dbName || !BACKUP_NAME.test(name) || !name.startsWith(`${c.dbName}-`)) throw notFound('Backup');
    const { t } = parse(z.object({ t: z.string().max(2000).default('') }), req.query);
    const link = ctx.secrets.verifyToken<{ id: string; name: string; uid: string }>('client-backup', t);
    if (!link || link.id !== c.id || link.name !== name || link.uid !== user.id) throw badRequest('That download link has expired. Choose the backup again.');
    const path = join(config.BACKUP_DIR, name);
    if (!existsSync(path)) throw notFound('Backup');
    await audit(real, { userId: user.id, action: 'download_client_backup', entity: 'practice_client', entityId: c.id, ip: req.ip, details: { name } });
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename="${name}"`);
    return reply.send(createReadStream(path));
  });

  /** Rename a client (on the practice's list; its own books keep their own name). */
  app.put('/api/practice/clients/:id', manage, async (req) => {
    const user = userOrThrow(req);
    await assertOn();
    const c = await clientOr404((req.params as { id: string }).id);
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(200) }), req.body);
    await real.begin(async (tx) => {
      await tx`update practice_clients set name = ${name} where id = ${c.id}`;
      await audit(tx, { userId: user.id, action: 'practice_client_rename', entity: 'practice_client', entityId: c.id, ip: req.ip, details: { name } });
    });
    return { ok: true };
  });
}
