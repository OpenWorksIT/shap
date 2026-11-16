/**
 * Shap Accountant (docs/ACCOUNTANT.md): with the feature on, this server is a practice's. It keeps
 * clients' books, each in a database of its own (lib/practice.ts), and shows the practice one list
 * of its clients with what each one's checks found and the returns coming up.
 *
 * Opening a client works like showing the demo company: the browser gets a session in the
 * client's own database (as the practice person they are, mirrored there) and a cookie saying
 * which client. Every request with that cookie is checked here first: the practice's own session
 * must still be good, the feature on, the client not archived, and the person still allowed in.
 * Only then is the request routed to the client's database (db/routing.ts); otherwise the cookies
 * go and it carries on in the practice's own books. A session made in one client's database means
 * nothing in another's, so a cookie changed by hand opens nothing.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { featureOn } from '@shap/shared';
import { z } from 'zod';
import { browserName, can, CLIENT_SESSION_COOKIE, loadUser, requireAccess, requireRole, SESSION_COOKIE, userOrThrow, type AuthUser } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Sql } from '../db/index.js';
import { dbScope, inClient } from '../db/routing.js';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { routePath } from '../lib/http.js';
import { clientDbName, healthOf, LEVELS, mirrorUser, unmirrorUser, type Level } from '../lib/practice.js';
import { newToken, sha256 } from '../lib/tokens.js';
import { parse } from '../lib/validate.js';

/** Which client's books this browser has open. */
export const CLIENT_COOKIE = 'shap_client';

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * What isn't for a client's books, while they're open: the server's own updates and backups, the
 * practice's feedback inbox, wiping, the demo, the test server, the practice's own people (the
 * people in a client's books are the practice's, put there from the practice), and the practice
 * layer itself (but its "where am I" and "back to the practice").
 */
const NOT_IN_A_CLIENT = ['/api/system', '/api/feedback', '/api/wipe', '/api/demo', '/api/test-server', '/api/users', '/api/profiles', '/api/practice', '/api/auth/login', '/api/auth/password', '/api/auth/mfa', '/api/auth/email'];
const IN_A_CLIENT_TOO = ['/api/practice/here', '/api/practice/leave'];

interface ClientRow {
  id: string;
  name: string;
  kind: string;
  dbName: string | null;
  archivedAt: Date | null;
  health: unknown;
  healthAt: Date | null;
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

/** May they open this client, and how? The practice's owner opens all of them. */
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
    const id = req.cookies?.[CLIENT_COOKIE];
    const scope = dbScope.getStore();
    if (!id || !scope || scope.demo || !routePath(req).startsWith('/api/')) return;
    const fail = () => {
      clear(reply);
      // A page that thought it was in a client's books mustn't change the practice's own instead.
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !IN_A_CLIENT_TOO.includes(routePath(req)))
        throw forbidden('That client’s books are no longer open here. Go back to Clients and open them again.');
    };
    if (!isUuid(id)) return fail();
    const user = await practiceUser(dbs.real, req);
    if (!user || !(await practiceOn(dbs.real))) return fail();
    const [c] = await dbs.real<ClientRow[]>`select * from practice_clients where id = ${id} and archived_at is null and db_name is not null`;
    if (!c || !(await levelFor(dbs.real, user, c.id))) return fail();
    const sql = clients.get(c.dbName!);
    // Their session in the client's books, as that same person: gone or ended, they're back in the practice.
    const token = req.cookies?.[CLIENT_SESSION_COOKIE];
    const [s] = token ? await sql<{ userId: string }[]>`select user_id from sessions where token_hash = ${sha256(token)} and expires_at > now()` : [];
    if (!s || s.userId !== user.id) return fail();
    scope.client = { id: c.id, name: c.name, sql };
    const p = routePath(req);
    if (NOT_IN_A_CLIENT.some((b) => p === b || p.startsWith(`${b}/`)) && !IN_A_CLIENT_TOO.includes(p)) throw forbidden(`Not in a client’s books. Go back to your practice first.`);
  });
}

export function registerPracticeRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { dbs, clients, config } = ctx;
  const real = dbs.real;
  const cookie = { httpOnly: true, sameSite: 'lax' as const, secure: config.COOKIE_SECURE, path: '/', maxAge: config.SESSION_TTL_HOURS * 3600 };
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

  /** Where this browser is: the practice's own books, or a client's. Works in both. */
  app.get('/api/practice/here', { preHandler: requireRole() }, async () => ({ client: inClient() }));

  app.get('/api/practice', view, async (req) => {
    const user = userOrThrow(req);
    await assertOn();
    const rows = await real<(ClientRow & { level: Level | null })[]>`
      select c.*, a.level from practice_clients c left join practice_access a on a.client_id = c.id and a.user_id = ${user.id}
      order by c.archived_at nulls first, lower(c.name)`;
    const mine = user.role === 'owner' ? rows : rows.filter((r) => r.level);
    const people = can(user, 'practice.manage')
      ? await real<{ id: string; name: string; email: string; role: string }[]>`select id, name, email, role from users where active and role <> 'owner' order by lower(name)`
      : [];
    const access = can(user, 'practice.manage') ? await real<{ clientId: string; userId: string; level: Level }[]>`select client_id, user_id, level from practice_access` : [];
    return {
      clients: mine.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        archived: r.archivedAt != null,
        level: user.role === 'owner' ? 'books' : r.level,
        health: r.health,
        healthAt: r.healthAt,
        access: access.filter((a) => a.clientId === r.id).map((a) => ({ userId: a.userId, level: a.level })),
      })),
      people,
    };
  });

  /** A new client whose books the practice keeps: a database of its own, set up through its Welcome when first opened. */
  app.post('/api/practice/clients', manage, async (req) => {
    const user = userOrThrow(req);
    await assertOn();
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(200) }), req.body);
    const [c] = await real<{ id: string }[]>`insert into practice_clients (name, kind, created_by) values (${name}, 'kept', ${user.id}) returning id`;
    const dbName = clientDbName(clients.practiceDb, c!.id);
    try {
      await clients.create(real, dbName, name);
    } catch (err) {
      await real`delete from practice_clients where id = ${c!.id}`;
      throw badRequest(`Couldn’t make the client’s database (${(err as Error).message}). Shap Accountant needs its database login to be allowed to create databases (docs/ACCOUNTANT.md).`);
    }
    await real`update practice_clients set db_name = ${dbName} where id = ${c!.id}`;
    await audit(real, { userId: user.id, action: 'practice_client_add', entity: 'practice_client', entityId: c!.id, ip: req.ip, details: { name } });
    return { id: c!.id };
  });

  /** Open a client's books in this browser. */
  app.post('/api/practice/clients/:id/open', view, async (req, reply) => {
    const user = userOrThrow(req);
    await assertOn();
    const c = await clientOr404((req.params as { id: string }).id);
    if (c.archivedAt || !c.dbName) throw badRequest('That client is archived');
    const level = await levelFor(real, user, c.id);
    if (!level) throw forbidden('You haven’t been given this client');
    const sql = clients.get(c.dbName);
    await mirrorUser(sql, user, level);
    const token = newToken();
    await sql`insert into sessions (token_hash, user_id, expires_at, user_agent, ip)
      values (${sha256(token)}, ${user.id}, now() + make_interval(hours => ${config.SESSION_TTL_HOURS}), ${browserName(req)}, ${req.ip})`;
    reply.setCookie(CLIENT_COOKIE, c.id, cookie);
    reply.setCookie(CLIENT_SESSION_COOKIE, token, cookie);
    await audit(real, { userId: user.id, action: 'practice_client_open', entity: 'practice_client', entityId: c.id, ip: req.ip, details: { level } });
    return { ok: true, name: c.name, level };
  });

  /** Back to the practice: the client's session ends, and its checks run again for the list. */
  app.post('/api/practice/leave', async (req, reply) => {
    const here = dbScope.getStore()?.client ?? null;
    const token = req.cookies?.[CLIENT_SESSION_COOKIE];
    reply.clearCookie(CLIENT_COOKIE, { path: '/' });
    reply.clearCookie(CLIENT_SESSION_COOKIE, { path: '/' });
    if (here && token) {
      await here.sql`delete from sessions where token_hash = ${sha256(token)}`.catch(() => undefined);
      void refreshHealth(here.id, here.sql);
    }
    return { ok: true };
  });

  const refreshHealth = async (id: string, sql: Sql) => {
    try {
      const health = await healthOf(sql);
      await real`update practice_clients set health = ${real.json(health as never)}, health_at = now() where id = ${id}`;
      return health;
    } catch (err) {
      app.log.warn({ err }, 'practice: a client’s checks failed');
      return null;
    }
  };

  /** Run every check on a client's books now. */
  app.post('/api/practice/clients/:id/checks', view, async (req) => {
    const user = userOrThrow(req);
    await assertOn();
    const c = await clientOr404((req.params as { id: string }).id);
    if (c.archivedAt || !c.dbName) throw badRequest('That client is archived');
    if (!(await levelFor(real, user, c.id))) throw forbidden('You haven’t been given this client');
    const health = await refreshHealth(c.id, clients.get(c.dbName));
    if (!health) throw badRequest('The checks couldn’t run on this client’s books. Open them and look, or tell us under Feedback.');
    return { health };
  });

  /** Who in the practice opens this client, and how. */
  app.put('/api/practice/clients/:id/access', manage, async (req) => {
    const user = userOrThrow(req);
    await assertOn();
    const c = await clientOr404((req.params as { id: string }).id);
    const { access } = parse(z.object({ access: z.array(z.object({ userId: z.string().uuid(), level: z.enum(LEVELS) })).max(200) }), req.body);
    const people = new Set((await real<{ id: string }[]>`select id from users where active and role <> 'owner'`).map((p) => p.id));
    for (const a of access) if (!people.has(a.userId)) throw badRequest('Only the practice’s own people can be given a client');
    const before = await real<{ userId: string }[]>`select user_id from practice_access where client_id = ${c.id}`;
    await real.begin(async (tx) => {
      await tx`delete from practice_access where client_id = ${c.id}`;
      for (const a of access) await tx`insert into practice_access (client_id, user_id, level) values (${c.id}, ${a.userId}, ${a.level})`;
    });
    // Whoever lost the client is out of its books at once.
    const kept = new Set(access.map((a) => a.userId));
    if (c.dbName) for (const b of before) if (!kept.has(b.userId)) await unmirrorUser(clients.get(c.dbName), b.userId);
    await audit(real, { userId: user.id, action: 'practice_client_access', entity: 'practice_client', entityId: c.id, ip: req.ip, details: { access } });
    return { ok: true };
  });

  /** Archive a client: nobody opens it until it's brought back; its database (and backups) stay. */
  app.post('/api/practice/clients/:id/archive', manage, async (req) => {
    const user = userOrThrow(req);
    await assertOn();
    const c = await clientOr404((req.params as { id: string }).id);
    const { archived } = parse(z.object({ archived: z.boolean() }), req.body);
    await real`update practice_clients set archived_at = ${archived ? new Date() : null} where id = ${c.id}`;
    if (archived && c.dbName) await clients.get(c.dbName)`delete from sessions`;
    await audit(real, { userId: user.id, action: archived ? 'practice_client_archive' : 'practice_client_unarchive', entity: 'practice_client', entityId: c.id, ip: req.ip });
    return { ok: true };
  });

  /** Rename a client (on the practice's list; its own books keep their own name). */
  app.put('/api/practice/clients/:id', manage, async (req) => {
    const user = userOrThrow(req);
    await assertOn();
    const c = await clientOr404((req.params as { id: string }).id);
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(200) }), req.body);
    await real`update practice_clients set name = ${name} where id = ${c.id}`;
    await audit(real, { userId: user.id, action: 'practice_client_rename', entity: 'practice_client', entityId: c.id, ip: req.ip, details: { name } });
    return { ok: true };
  });
}
