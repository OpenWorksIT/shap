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
import { ACCOUNTANT_TERMS_URL, ACCOUNTANT_TERMS_VERSION, BUSINESS_TYPES, deadlinesFor, featureOn, isTask, LEVELS, plainName, PRACTICE_OWN_SERVER, PRACTICE_TERMS_TICK, readLink, SERVER_NOT_MANAGED, teamInput, TERMS_URL, TERMS_VERSION, VAT_CATEGORIES, withNeeds, type DeadlineInputs, type Level } from '@shap/shared';
import { z } from 'zod';
import { browserName, can, checkNewPassword, CLIENT_COOKIE, confirmPassword, CLIENT_SESSION_COOKIE, createUser, loadUser, requireAccess, requireRole, SESSION_COOKIE, userOrThrow, type AuthUser } from '../auth.js';
import type { Ctx } from '../context.js';
import { pgCode, PG, type Sql } from '../db/index.js';
import { dbScope, inClient } from '../db/routing.js';
import { audit } from '../lib/audit.js';
import { today } from '../lib/books.js';
import { badRequest, forbidden, HttpError, notFound } from '../lib/errors.js';
import { routePath } from '../lib/http.js';
import { clientDbName, cutWords, databaseRights, healthOf, mirrorUser, otherCompanies, roleFor, rolesFor, saveHealth, unmirrorUser, type ClientHealth } from '../lib/practice.js';
import { SERVER_ONLY, under } from '../lib/server-only.js';
import { applyPocketShare, readPocketShare } from './import/pocket-share.js';
import { appVersion, askCtl, BACKUP_NAME, ctlPending, ctlStatus } from './system.js';
import { linkCall, LinkError } from '../lib/link-call.js';
import { lastEnded, papersFor } from '../lib/papers.js';
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

/**
 * A Shap Pocket client's books are the owner's, on their phone, and each share replaces the copy's
 * records (import/pocket-share.ts): in the copy, only the practice's own work on them is done (the
 * statements, compiled and approved here, and the files for them).
 */
export const POCKET_COPY_MAY = [/^\/api\/statements\//, /^\/api\/attachments$/, /^\/api\/auth\//, /^\/api\/feedback$/, /^\/api\/practice\/(here|leave)$/];
export const POCKET_COPY = 'These books are a Shap Pocket client’s, from their shares: they change them in Shap Pocket and share them again. Here the practice compiles their statements and records the approval of whoever signs them for the business (its directors, members, partners or owner).';

/** Setup's team step, once someone else signs in. */
const OTHERS_SIGN_IN = 'Someone else signs in here already, so your team is added under Settings → People who sign in, one at a time.';
/** A test server's made-up clients: each one's books are a database on a server real companies share. */
export const TEST_SERVER_CLIENTS = 10;

const CLOSED = 'Those books are no longer open here: go back to the practice (Practice, in the menu) and open them again.';
const NOT_GIVEN = 'You haven’t been given this client: ask whoever runs the practice’s Shap.';

export interface ClientRow {
  id: string;
  name: string;
  kind: string;
  dbName: string | null;
  archivedAt: Date | null;
  health: ClientHealth | null;
  healthAt: Date | null;
  migrateError: string | null;
  /** A client on its own Shap: its address, the credential (sealed), and what it lets the practice do. */
  linkUrl: string | null;
  linkCredential: string | null;
  linkLevel: Level | null;
}

/**
 * What a linked client's Shap says its checks found, read as the practice keeps it: only what the
 * list shows, each of the right kind (the returns are worked out here from it), so a client's
 * server can't put anything else on the practice's list.
 */
const date = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)
  .refine((d) => {
    // (Run even when the pattern didn't match: a day that isn't one is refused, never thrown on.)
    const t = Date.parse(`${d}T00:00:00Z`);
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
  });
// A long text is cut to what the list shows, not refused: one long finding mustn't lose the rest.
const words = z.string().max(100_000).transform((s) => cutWords(s));
const some = <T extends z.ZodType>(item: T, n: number) => z.array(item).max(10_000).transform((a) => a.slice(0, n));
const deadlineInputs = z
  .object({
    businessType: z.enum(BUSINESS_TYPES),
    vatRegistered: z.boolean(),
    vatCategory: z.enum(VAT_CATEGORIES),
    fyEndMonth: z.number().int().min(1).max(12),
    turnoverTax: z.boolean(),
    employer: z.boolean(),
    approvedPbo: z.boolean().optional(),
    dividendsPaid: z
      .array(date)
      .max(10_000)
      .transform((a) => [...new Set(a)].sort().slice(-100))
      .optional(),
  })
  .nullable();
const linkedHealth = z.object({
  at: z.iso.datetime({ offset: true }),
  company: z.string().max(100_000).transform((s) => cutWords(s, 200)),
  setupDone: z.boolean(),
  vatRegistered: z.boolean(),
  audit: z.object({ fail: z.number().int().min(0).max(1e6), warn: z.number().int().min(0).max(1e6), items: some(z.object({ level: z.enum(['fail', 'warn']), section: words, text: words }), 12) }),
  statements: z
    .union([
      z.object({ yearEnd: date, status: z.enum(['draft', 'sent', 'compiled', 'approved']), changedSince: z.boolean(), failing: some(words, 50), look: some(words, 50), assurance: words.nullable(), unapprovedEarlier: date.nullable() }),
      z.object({ yearEnd: date.nullable(), error: z.literal(true) }),
      z.object({ yearEnd: z.null(), firstYearEnds: date }),
    ])
    .nullable(),
  lockedThrough: date.nullable(),
  deadlineInputs,
});

/** The practice's owner has accepted the Shap Accountant terms as they are now (terms.ts). */
export const accountantTermsAccepted = async (real: Sql) => {
  const [s] = await real<{ accountantTermsVersion: string }[]>`select accountant_terms_version from settings where id`;
  return s?.accountantTermsVersion === ACCOUNTANT_TERMS_VERSION;
};
export const ACCOUNTANT_TERMS_NEEDED = 'The Shap Accountant terms of use have changed, or haven’t been accepted for this practice yet: its owner accepts them on the Practice page before any client’s books are opened. Nothing in the clients’ books changes meanwhile, except monthly invoices set up there, which are still made on their day; their backups can still be downloaded from the Practice page.';

export const practiceOn = async (real: Sql) => {
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

/** Asks a linked client's own Shap (lib/link-call.ts), with that link's credential. */
function callLinkedWith<T>(ctx: Ctx, c: Pick<ClientRow, 'linkUrl' | 'linkCredential'>, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  return linkCall<T>({ base: c.linkUrl!, method, path, credential: ctx.secrets.open(c.linkCredential!), body, allowPrivate: ctx.config.LINK_PRIVATE, version: appVersion() });
}

const UNLINKED = 'Their Shap no longer knows this link: they unlinked your practice there (or their books there were put back from before it). To link again, ask them for a new link (Settings → People who sign in → Your accountant, in their Shap).';
/**
 * What a linked client's Shap refused, in the practice's own words: what it says itself isn't
 * shown (lib/link-call.ts), only what its code means.
 */
export function linkWords(err: LinkError): string {
  const words: Record<string, string> = {
    link_unknown: 'That link doesn’t work: it was used already, it’s more than a week old, or it was unlinked. Ask the client for a new one (Settings → People who sign in → Your accountant, in their Shap).',
    link_gone: UNLINKED,
    link_level: 'The client lets your practice read their books and compile the statements, not write them up.',
    link_mfa: 'Their Shap requires two-factor sign-in of everyone who opens its books: turn it on for yourself here (Your account: your name, in the menu), then open their books again.',
  };
  return words[err.code ?? ''] ?? err.message;
}

const RANK: Record<Level, number> = { compile: 1, books: 2 };

/** What each of these people may open among the practice's linked clients (that are still linked), now. */
export async function linkedLevels(real: Sql, userIds: string[]): Promise<Map<string, Map<string, Level | null>>> {
  const out = new Map<string, Map<string, Level | null>>();
  const linked = await real<{ id: string }[]>`select id from practice_clients where kind = 'linked' and link_credential is not null`;
  if (!linked.length) return out;
  for (const id of userIds) {
    const u = await loadUser(real, id);
    const levels = new Map<string, Level | null>();
    for (const c of linked) levels.set(c.id, u ? await levelFor(real, u, c.id) : null);
    out.set(id, levels);
  }
  return out;
}

/**
 * Whoever may now open a linked client less than before (or not at all), or everyone given who
 * had their password or two-factor reset, is taken out of its own Shap at once: asked of each client's Shap, all at once. Returns those not taken out, as
 * "person (client)", for the screen to say: they're out when their sign-in there ends anyway
 * (LINK_SESSION_HOURS), and their next one is as given now.
 */
export async function takeOutOfLinked(ctx: Ctx, real: Sql, before: Map<string, Map<string, Level | null>>, log: { warn: (o: object, m: string) => void }, opts: { all?: boolean } = {}): Promise<string[]> {
  if (!before.size) return [];
  const after = await linkedLevels(real, [...before.keys()]);
  const asks: { clientId: string; userId: string }[] = [];
  for (const [userId, was] of before)
    for (const [clientId, level] of was) {
      const now = after.get(userId)?.get(clientId) ?? null;
      // (`all`: their password or two-factor was reset: out of every client they may open, as out
      // of their own sessions here; they open it again as given.)
      if (level && (opts.all || !now || RANK[now] < RANK[level])) asks.push({ clientId, userId });
    }
  const missed: string[] = [];
  await Promise.all(
    asks.map(async (a) => {
      const [c] = await real<ClientRow[]>`select * from practice_clients where id = ${a.clientId}`;
      if (!c?.linkCredential) return;
      try {
        await callLinkedWith(ctx, c, 'POST', '/api/link/person-off', { personId: a.userId });
      } catch (err) {
        log.warn({ err }, 'practice: a linked client’s Shap didn’t take someone out');
        const [u] = await real<{ name: string }[]>`select name from users where id = ${a.userId}`;
        missed.push(`${u?.name ?? 'Someone'} (${c.name})`);
      }
    }),
  );
  return missed;
}

/** May they open this client, and how? The practice's owner opens all of them, either way. */
export async function levelFor(real: Sql, user: AuthUser, clientId: string): Promise<Level | null> {
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
    if (!(await practiceOn(dbs.real)) || !(await accountantTermsAccepted(dbs.real))) return fail();
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
    scope.client = { id: c.id, name: c.name, sql, practiceOwner: user.role === 'owner', kind: c.kind };
    if (under(p, NOT_IN_A_CLIENT) && !IN_A_CLIENT_TOO.includes(p)) throw forbidden('That’s the practice’s own, so it isn’t done in a client’s books: tap Back to the practice, at the top, first.');
    if (c.kind === 'pocket' && req.method !== 'GET' && req.method !== 'HEAD' && !POCKET_COPY_MAY.some((re) => re.test(p))) throw forbidden(POCKET_COPY);
  }
}

export function registerPracticeRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { dbs, clients, config } = ctx;
  const real = dbs.real;
  const cookie = { httpOnly: true, sameSite: 'lax' as const, secure: config.COOKIE_SECURE, path: '/', maxAge: config.SESSION_TTL_HOURS * 3600 };
  const limit = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute' } });
  const view = { preHandler: requireAccess('practice.clients') };
  const manage = { preHandler: requireAccess('practice.manage') };

  const assertSwitchedOn = async () => {
    if (!(await practiceOn(real))) throw badRequest('Shap Accountant is off. The owner switches it on under Settings → Features.');
  };
  const assertOn = async () => {
    await assertSwitchedOn();
    if (!(await accountantTermsAccepted(real))) throw badRequest(ACCOUNTANT_TERMS_NEEDED, { needsAccountantTerms: true });
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

  /**
   * The Shap Accountant terms, accepted for the practice by its owner: before Shap Accountant is
   * switched on (Settings), and when they change (Practice). In the practice's own books only.
   */
  app.post('/api/practice/terms', { preHandler: requireRole('owner'), config: limit(10) }, async (req) => {
    const user = userOrThrow(req);
    if (inClient()) throw forbidden('That’s the practice’s own, so it isn’t done in a client’s books: tap Back to the practice, at the top, first.');
    const { version } = parse(z.object({ version: z.string().max(20) }), req.body);
    if (version !== ACCOUNTANT_TERMS_VERSION) throw badRequest('Those aren’t the Shap Accountant terms as they are now: reload the page and read them again.');
    const [s] = await real<{ accountantTermsVersion: string }[]>`select accountant_terms_version from settings where id`;
    if (s?.accountantTermsVersion !== version) {
      await real`update settings set accountant_terms_version = ${version}, accountant_terms_accepted_at = now() where id`;
      await audit(real, { userId: user.id, action: 'accept_accountant_terms', entity: 'settings', ip: req.ip, details: { version, url: ACCOUNTANT_TERMS_URL } });
    }
    return { version };
  });

  /**
   * The server, for Shap Accountant (setup asks as soon as the practice says it keeps clients'
   * books here, and Practice while it can't yet): may this Shap's database login make each client's
   * database, and is the server the practice's alone? Where shap-ctl looks after the server, its
   * owner asks it to allow that (POST), in the background; elsewhere, whoever runs the server does.
   */
  const othersSignIn = async (me: string) => (await real`select 1 from users where id <> ${me} and link_id is null and active limit 1`).length > 0;
  const serverState = async (me: string) => {
    const { may, login } = await databaseRights(real);
    const status = ctlStatus(config);
    const asked = status && typeof status.practice === 'object' && status.practice ? (status.practice as { at?: string; ok?: boolean; message?: string }) : null;
    return {
      ready: may,
      login,
      managed: status != null,
      pending: ctlPending(config) === 'practice',
      asked: asked ? { at: String(asked.at ?? ''), ok: asked.ok === true, message: String(asked.message ?? '').slice(0, 400) } : null,
      otherCompanies: await otherCompanies(real),
      testServer: config.TEST_SERVER,
      // Setup's team step makes the practice's people only while nobody else signs in (below).
      othersSignIn: await othersSignIn(me),
    };
  };
  const practiceOwner = { preHandler: requireRole('owner') };
  app.get('/api/practice/server', practiceOwner, async (req) => serverState(userOrThrow(req).id));
  app.post('/api/practice/server', { ...practiceOwner, config: limit(5) }, async (req) => {
    const user = userOrThrow(req);
    // Asked once Shap Accountant is on, its terms accepted for the practice (the end of setup, or Practice).
    await assertOn();
    const state = await serverState(user.id);
    if (state.ready || state.pending) return state;
    // Never on a server that other companies' books share (shap-ctl refuses too): a practice's Shap runs on a server of its own.
    if (state.otherCompanies && !state.testServer) throw badRequest(`Other companies’ books are on this server, so Shap doesn’t ask it to let this Shap make databases. ${PRACTICE_OWN_SERVER}`);
    if (!state.managed) throw badRequest(SERVER_NOT_MANAGED);
    // One request at a time: an update or a backup asked for already goes first, and this is asked again after it.
    const waiting = ctlPending(config);
    if (waiting) throw new HttpError(409, 'The server is busy with an update or a backup: Shap asks once it’s done.', 'ctl_busy');
    if (!(await askCtl(config, 'practice'))) throw badRequest('Shap can’t leave the request for the server. Whoever runs the server can fix this by running deploy/vps/ctl/install.sh again.');
    await audit(real, { userId: user.id, action: 'system_practice', entity: 'system', ip: req.ip, details: { login: state.login } });
    return { ...state, pending: true };
  });

  /**
   * The practice's people, from setup: its profiles (what each kind of staff does) and a sign-in for
   * each person on one, all at once or none. Only while nobody else signs in here yet: after that,
   * Settings → People who sign in, one at a time.
   */
  app.post('/api/practice/team', { ...practiceOwner, config: limit(5) }, async (req) => {
    const me = userOrThrow(req);
    if (inClient()) throw forbidden('That’s the practice’s own, so it isn’t done in a client’s books: tap Back to the practice, at the top, first.');
    await assertOn();
    const input = parse(teamInput, req.body);
    if (await othersSignIn(me.id)) throw badRequest(OTHERS_SIGN_IN);
    const emails = input.people.map((p) => p.email);
    if (new Set(emails).size !== emails.length) throw badRequest('Two people have the same email: each signs in with their own.');
    if (emails.includes(me.email.toLowerCase())) throw badRequest('One of them has your email: each person signs in with their own.');
    const taken = await real<{ email: string }[]>`select email from users where email in ${real(emails)}`;
    if (taken.length) throw badRequest(`Someone already signs in with ${taken.map((t) => t.email).join(', ')}.`);
    const profileNames = input.profiles.map((p) => p.name.toLowerCase());
    if (new Set(profileNames).size !== profileNames.length) throw badRequest('Two profiles have the same name: give each its own.');
    for (const p of input.people) checkNewPassword(p.password, p);
    const made = await real.begin(async (tx) => {
      // One team at a time: two at once would each find nobody else signed in.
      await tx`select pg_advisory_xact_lock(hashtext('shap:practice_team'))`;
      if ((await tx`select 1 from users where id <> ${me.id} and link_id is null and active limit 1`).length) throw badRequest(OTHERS_SIGN_IN);
      const ids = new Map<string, string>();
      for (const p of input.profiles) {
        const access = withNeeds(p.access.filter(isTask));
        // Shap's own (Admin, say) are changed as ticked here, but only while nobody is on them at all
        // (someone signed out of Shap for now would have the change when let back in).
        const [had] = await tx<{ id: string; people: number }[]>`select id, (select count(*)::int from users u where u.profile_id = profiles.id) as people from profiles where lower(name) = lower(${p.name})`;
        if (had?.people) throw badRequest(`Someone is on the profile ${p.name} already: change it under Settings → People who sign in, or give this one another name.`);
        const [row] = had
          ? await tx<{ id: string }[]>`update profiles set access = ${access}, updated_at = now() where id = ${had.id} returning id`
          : await tx<{ id: string }[]>`insert into profiles (name, access) values (${p.name}, ${access}) returning id`;
        ids.set(p.name.toLowerCase(), row!.id);
        await audit(tx, { userId: me.id, action: had ? 'update' : 'create', entity: 'profile', entityId: row!.id, ip: req.ip, details: { name: p.name, access } });
      }
      let n = 0;
      for (const person of input.people) {
        let profileId = ids.get(person.profile.toLowerCase());
        if (!profileId) profileId = (await tx<{ id: string }[]>`select id from profiles where lower(name) = lower(${person.profile})`)[0]?.id;
        if (!profileId) throw badRequest(`There’s no profile called ${person.profile}: choose one of the profiles for ${person.name}.`);
        const u = await createUser(tx, { name: person.name, email: person.email, password: person.password, role: 'staff', profileId, accessAdd: [], accessRemove: [] });
        await audit(tx, { userId: me.id, action: 'create', entity: 'user', entityId: u.id, ip: req.ip, details: { role: 'staff', profileId, add: [], remove: [], from: 'setup' } });
        n++;
      }
      return n;
    }).catch((err) => {
      if (pgCode(err) === PG.uniqueViolation) throw new HttpError(409, 'Someone saved people or profiles with these names just now: reload, and look under Settings → People who sign in.', 'conflict');
      throw err;
    });
    return { people: made };
  });

  app.get('/api/practice', view, async (req) => {
    const user = userOrThrow(req);
    await assertOn();
    const rows = await real<(ClientRow & { level: Level | null })[]>`
      select c.*, a.level from practice_clients c left join practice_access a on a.client_id = c.id and a.user_id = ${user.id}
      where c.db_name is not null or c.kind = 'linked' order by c.archived_at nulls first, lower(c.name)`;
    const manages = can(user, 'practice.manage');
    // Who manages sees every client (they can give themselves any of them); others, theirs.
    const mine = user.role === 'owner' || manages ? rows : rows.filter((r) => r.level);
    // Only staff can be given a client: read-only accountants can't have "Open the clients they're given".
    const people = manages ? await real<{ id: string; name: string; email: string; role: string }[]>`select id, name, email, role from users where active and role = 'staff' order by lower(name)` : [];
    const access = manages ? await real<{ clientId: string; userId: string; level: Level }[]>`select client_id, user_id, level from practice_access` : [];
    const now = today();
    // Each client's engagement letters and its latest ended year's working papers (working-papers.ts).
    const yearOf = (id: string) => {
      const m = mine.find((r) => r.id === id)?.health?.deadlineInputs?.fyEndMonth;
      return m ? lastEnded(m, now) : null;
    };
    // A kept client's last checks keep that year's trial balance fingerprint: a sign-off given before them says if the books had changed by then.
    const papers = await papersFor(real, mine.map((r) => r.id), yearOf, (id) => {
      const h = mine.find((r) => r.id === id)?.health;
      return h?.tb && h.tb.fyEnd === yearOf(id) ? { hash: h.tb.hash, at: h.tb.at } : null;
    });
    return {
      clients: mine.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        archived: r.archivedAt != null,
        notUpToDate: r.migrateError != null,
        // On their own Shap: where, what they let the practice do, and whether it's still linked.
        linked: r.kind === 'linked' ? { host: r.linkUrl ? new URL(r.linkUrl).host : '', level: r.linkLevel, unlinked: !r.linkCredential } : null,
        level: user.role === 'owner' ? 'books' : r.level,
        // The returns are worked out again for today, so a date moves to past by itself.
        health: r.health ? { ...r.health, deadlines: r.health.deadlineInputs ? deadlinesFor(r.health.deadlineInputs, now) : [] } : null,
        healthAt: r.healthAt,
        access: access.filter((a) => a.clientId === r.id).map((a) => ({ userId: a.userId, level: a.level })),
        papers: papers.get(r.id) ?? null,
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
    // A test server shares its server with real companies: its made-up clients' databases are kept few.
    if (config.TEST_SERVER) {
      const [n] = await real<{ n: number }[]>`select count(*)::int as n from practice_clients where kind <> 'linked'`;
      if (n!.n >= TEST_SERVER_CLIENTS) throw badRequest(`A test server keeps at most ${TEST_SERVER_CLIENTS} clients’ books (archived ones count: they stay on the server).`);
    }
    const [c] = await real<{ id: string }[]>`insert into practice_clients (name, kind, created_by) values (${name}, ${kind}, ${user.id}) returning id`;
    const dbName = clientDbName(clients.practiceDb, c!.id);
    try {
      await clients.create(real, dbName, name);
    } catch (err) {
      await real`delete from practice_clients where id = ${c!.id}`;
      req.log.error({ err }, 'practice: a client’s database couldn’t be made');
      if ((err as { code?: string }).code === '42501')
        throw new HttpError(400, `Couldn’t make this client’s books on the server: this Shap’s database login isn’t allowed to make databases. ${user.role === 'owner' ? 'The Practice page says' : 'Your practice’s owner sees, on the Practice page,'} what to do (docs/ACCOUNTANT.md, on Shap’s GitHub).`, 'no_createdb');
      throw err;
    }
    await real.begin(async (tx) => {
      await tx`update practice_clients set db_name = ${dbName} where id = ${c!.id}`;
      await audit(tx, { userId: user.id, action: 'practice_client_add', entity: 'practice_client', entityId: c!.id, ip: req.ip, details: { name, kind } });
    });
    return { id: c!.id };
  });

  /** Open a client's books in this browser: as given, or, for someone who writes them up, to compile (read only). */
  /* ---------------------------------------- a client on its own Shap (linked) */

  const practiceName = async () => {
    const [p] = await real<{ companyName: string; tradingName: string }[]>`select company_name, trading_name from settings where id`;
    return (p?.tradingName || p?.companyName || 'A practice').slice(0, 200);
  };
  /** Asks the client's own Shap (lib/link-call.ts), with this link's credential. */
  const callLinked = <T>(c: ClientRow, method: 'GET' | 'POST', path: string, body?: unknown) => callLinkedWith<T>(ctx, c, method, path, body);
  /** What the client's Shap said, as the practice is told it; an unlinked client is marked so. */
  const linkRefusal = async (c: ClientRow, err: unknown) => {
    if (!(err instanceof LinkError)) return err;
    if (err.code === 'link_gone') {
      await real`update practice_clients set link_credential = null where id = ${c.id}`;
      return badRequest(UNLINKED, { code: 'link_gone' });
    }
    return new HttpError(err.status >= 500 ? 502 : err.status === 403 ? 403 : 400, linkWords(err), err.code);
  };
  const linked = (c: ClientRow) => {
    if (!c.linkUrl || !c.linkCredential) throw badRequest(c.linkUrl ? UNLINKED : 'This client isn’t linked yet.', { code: 'link_gone' });
    return c;
  };
  /**
   * What was shown before is marked as from before (their Shap didn't answer, or its answer couldn't
   * be read), with what the returns are worked out from if that reads on its own; in one statement,
   * and not over a summary saved since these checks began (another run, at the same time).
   */
  const markStale = async (c: ClientRow, started: Date, inputs: DeadlineInputs | null | undefined) => {
    const add = { stale: true, ...(inputs !== undefined ? { deadlineInputs: inputs } : {}) };
    const r = await real`update practice_clients set health = health || ${real.json(add as never)}::jsonb
      where id = ${c.id} and health is not null and (health_at is null or health_at <= ${started}) returning id`;
    return r.length > 0;
  };
  const linkedHealthOf = async (c: ClientRow, log: { warn: (o: object, m: string) => void }): Promise<ClientHealth> => {
    const started = new Date();
    let answer: { health: unknown; level?: Level };
    try {
      answer = await callLinked<{ health: unknown; level?: Level }>(linked(c), 'GET', '/api/link/health');
    } catch (err) {
      // Not reached, or not answering: what's shown is from before (unlinked is said on its own).
      if (err instanceof LinkError && err.code !== 'link_gone') await markStale(c, started, undefined);
      throw await linkRefusal(c, err);
    }
    const read = linkedHealth.safeParse(answer.health);
    if (!read.success) {
      log.warn({ issues: read.error.issues.slice(0, 5).map((i) => ({ path: i.path, code: i.code })) }, 'practice: a linked client’s checks came back unread');
      // What the returns are worked out from is taken on its own if it reads, so the returns
      // coming up aren't lost with the rest.
      const inputs = deadlineInputs.safeParse((answer.health as { deadlineInputs?: unknown } | null)?.deadlineInputs);
      const marked = await markStale(c, started, inputs.success ? inputs.data : undefined);
      if (!marked && inputs.success && inputs.data) {
        // Nothing read before: the returns alone, said to be all that could be read.
        const only: ClientHealth = { at: started.toISOString(), company: c.name, setupDone: true, vatRegistered: inputs.data.vatRegistered, audit: { fail: 0, warn: 0, items: [] }, statements: null, lockedThrough: null, deadlineInputs: inputs.data, stale: true, unread: true };
        await saveHealth(real, c.id, only, started);
      }
      throw new HttpError(502, 'Their Shap’s checks came back in a way this Shap doesn’t read, so what’s shown is from before: one of the two may need updating.', 'link_answer');
    }
    const health = read.data as ClientHealth;
    await saveHealth(real, c.id, health, started);
    if (answer.level && answer.level !== c.linkLevel && LEVELS.includes(answer.level)) await real`update practice_clients set link_level = ${answer.level} where id = ${c.id}`;
    return health;
  };

  /** A client on its own Shap: the link its owner made there, pasted in here (packages/shared link.ts). */
  app.post('/api/practice/clients/link', { ...manage, config: limit(10) }, async (req) => {
    const user = userOrThrow(req);
    await assertOn();
    const { link, id } = parse(z.object({ link: z.string().trim().min(10).max(400), id: z.string().uuid().optional() }), req.body);
    const read = readLink(link);
    if (!read) throw badRequest('That isn’t a link from Shap. In their own Shap, the client makes one under Settings → People who sign in → Your accountant: it starts with their Shap’s address and ends with /link# and a code.');
    const again = id ? await clientOr404(id) : null;
    if (again && again.kind !== 'linked') throw badRequest('That client’s books aren’t on their own Shap.');
    let answer: { credential: string; company: string; level: Level; api?: number };
    try {
      answer = await linkCall({ base: read.base, method: 'POST', path: '/api/link/redeem', body: { code: read.code, practice: { name: await practiceName() } }, allowPrivate: config.LINK_PRIVATE, version: appVersion() });
    } catch (err) {
      if (err instanceof LinkError) throw new HttpError(err.status >= 500 ? 502 : 400, linkWords(err), err.code);
      throw err;
    }
    if (typeof answer.credential !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(answer.credential) || !LEVELS.includes(answer.level)) throw new HttpError(502, 'Their Shap answered in a way this Shap doesn’t read: one of the two may need updating.', 'link_answer');
    const company = typeof answer.company === 'string' ? cutWords(plainName(answer.company.slice(0, 2000)), 200) : '';
    const name = company || new URL(read.base).host;
    const sealed = ctx.secrets.seal(answer.credential);
    const clientId = await real.begin(async (tx) => {
      const [c] = again
        ? await tx<{ id: string }[]>`update practice_clients set link_url = ${read.base}, link_credential = ${sealed}, link_level = ${answer.level}, archived_at = null where id = ${again.id} returning id`
        : await tx<{ id: string }[]>`insert into practice_clients (name, kind, created_by, link_url, link_credential, link_level) values (${name}, 'linked', ${user.id}, ${read.base}, ${sealed}, ${answer.level}) returning id`;
      await audit(tx, { userId: user.id, action: 'practice_client_link', entity: 'practice_client', entityId: c!.id, ip: req.ip, details: { host: new URL(read.base).host, level: answer.level } });
      return c!.id;
    });
    // What their checks find, for the list, now (it's there next time anyway).
    await linkedHealthOf(await clientOr404(clientId), req.log).catch((err) => req.log.warn({ err }, 'practice: a linked client’s first checks failed'));
    return { id: clientId, name, level: answer.level };
  });

  /** The practice unlinks a client on its own Shap: their Shap takes the practice's people out too. */
  app.post('/api/practice/clients/:id/unlink', { ...manage, config: limit(10) }, async (req) => {
    const user = userOrThrow(req);
    await assertOn();
    const c = await clientOr404((req.params as { id: string }).id);
    if (c.kind !== 'linked') throw badRequest('That client’s books aren’t on their own Shap.');
    let told = true;
    if (c.linkCredential)
      await callLinked(c, 'POST', '/api/link/unlink').catch((err) => {
        told = err instanceof LinkError && err.code === 'link_gone';
        req.log.warn({ err }, 'practice: a linked client’s Shap didn’t take the unlink');
      });
    await real.begin(async (tx) => {
      await tx`update practice_clients set link_credential = null, archived_at = coalesce(archived_at, now()) where id = ${c.id}`;
      await audit(tx, { userId: user.id, action: 'practice_client_unlink', entity: 'practice_client', entityId: c.id, ip: req.ip, details: { told } });
    });
    return { ok: true, told };
  });

  /** Opening a linked client: a sign-in their Shap makes for this person, opened in a new tab. */
  const openLinked = async (req: FastifyRequest, user: AuthUser, c: ClientRow) => {
    const given = await levelFor(real, user, c.id);
    if (!given) throw forbidden(NOT_GIVEN);
    const { as } = parse(z.object({ as: z.enum(LEVELS).optional() }), req.body ?? {});
    if (as === 'books' && given !== 'books') throw forbidden('You’ve been given these books to read and compile, not to write up.');
    // As given, and never more than the client lets the practice do.
    let level: Level = as ?? given;
    if (level === 'books' && c.linkLevel !== 'books') {
      if (as === 'books') throw forbidden('The client lets your practice read their books and compile the statements, not write them up.');
      level = 'compile';
    }
    let path: string;
    try {
      // Whether they sign in here with two-factor: their Shap may require it (links.ts there).
      const [m] = await real<{ mfa: boolean }[]>`select totp_enabled_at is not null as mfa from users where id = ${user.id}`;
      ({ path } = await callLinked<{ path: string }>(linked(c), 'POST', '/api/link/sign-in', { person: { id: user.id, name: user.name, mfa: Boolean(m?.mfa) }, level }));
    } catch (err) {
      throw await linkRefusal(c, err);
    }
    if (typeof path !== 'string' || !/^\/api\/link\/enter\?t=[A-Za-z0-9_%-]{20,200}$/.test(path)) throw new HttpError(502, 'Their Shap answered in a way this Shap doesn’t read: one of the two may need updating.', 'link_answer');
    await audit(real, { userId: user.id, action: 'practice_client_open', entity: 'practice_client', entityId: c.id, ip: req.ip, details: { level, linked: true } });
    return { ok: true, name: c.name, level, url: `${c.linkUrl}${path}` };
  };

  app.post('/api/practice/clients/:id/open', { ...view, config: limit(30) }, async (req, reply) => {
    const user = userOrThrow(req);
    await assertOn();
    const c = await clientOr404((req.params as { id: string }).id);
    if (c.kind === 'linked') return openLinked(req, user, c);
    const dbName = usable(c);
    const given = await levelFor(real, user, c.id);
    if (!given) throw forbidden(NOT_GIVEN);
    const { as } = parse(z.object({ as: z.enum(LEVELS).optional() }), req.body ?? {});
    // Never more than given: writing up takes in compiling, not the other way round.
    if (as === 'books' && given !== 'books') throw forbidden('You’ve been given these books to read and compile, not to write up.');
    // (A Shap Pocket client's copy takes only the practice's own work on it, at either level: POCKET_COPY_MAY.)
    const level = as ?? given;
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
    if (c.kind === 'linked') {
      if (!(await levelFor(real, user, c.id))) throw forbidden(NOT_GIVEN);
      const health = await linkedHealthOf(c, req.log);
      return { health: { ...health, deadlines: health.deadlineInputs ? deadlinesFor(health.deadlineInputs, today()) : [] } };
    }
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
    // On the client's own Shap: asked to take them out now. Whoever their Shap didn't answer for is
    // said (they're out when their sign-in there ends; their next one is as given now).
    const stillIn: string[] = [];
    if (c.kind === 'linked' && c.linkCredential)
      await Promise.all(
        before
          .filter((b) => now.get(b.userId) !== b.level)
          .map(async (b) => {
            try {
              await callLinked(c, 'POST', '/api/link/person-off', { personId: b.userId });
            } catch (err) {
              req.log.warn({ err }, 'practice: a linked client’s Shap didn’t take someone out');
              stillIn.push((await real<{ name: string }[]>`select name from users where id = ${b.userId}`)[0]?.name ?? 'Someone');
            }
          }),
      );
    return { ok: true, stillIn };
  });

  /** Archive a client: whoever is in its books is taken out, and nobody opens it until it's brought back; its database (and backups) stay. */
  app.post('/api/practice/clients/:id/archive', manage, async (req) => {
    const user = userOrThrow(req);
    await assertOn();
    const c = await clientOr404((req.params as { id: string }).id);
    const { archived } = parse(z.object({ archived: z.boolean() }), req.body);
    if (c.kind === 'linked' && c.linkCredential) throw badRequest('A client on their own Shap is unlinked instead (Unlink): their books stay theirs, on their Shap.');
    await real.begin(async (tx) => {
      await tx`update practice_clients set archived_at = ${archived ? new Date() : null} where id = ${c.id}`;
      await audit(tx, { userId: user.id, action: archived ? 'practice_client_archive' : 'practice_client_unarchive', entity: 'practice_client', entityId: c.id, ip: req.ip });
    });
    if (archived && c.dbName) await clients.get(c.dbName)`delete from sessions`;
    return { ok: true };
  });

  /**
   * A Shap Pocket share into a Pocket client's copy of their books (import/pocket-share.ts), for the
   * practice's owner or whoever is given the client's books to write up: the share's records replace
   * the copy's, checked entry by entry against the phone's. The first share (and the first after the
   * terms change) records the practice's acceptance of the terms for these books. The checks run
   * again for the list.
   */
  const SHARE_WHO = 'Bringing in their shares is for the practice’s owner, or whoever is given their books to write up (Who opens it).';
  // Who may, before the file (up to the upload size) is read, or anything more about the client is
  // said. Someone not given the practice's clients at all is refused at the door, as for any route.
  const mayBringIn = async (req: FastifyRequest) => {
    const user = userOrThrow(req);
    if (!can(user, 'practice.clients')) return;
    await assertOn();
    const c = await clientOr404((req.params as { id: string }).id);
    if ((await levelFor(real, user, c.id)) !== 'books') throw forbidden(SHARE_WHO);
  };
  app.post('/api/practice/clients/:id/pocket-share', { ...view, onRequest: mayBringIn, bodyLimit: Math.round(config.UPLOAD_MB * 1024 * 1024 * 1.4), config: limit(10) }, async (req) => {
    const user = userOrThrow(req);
    await assertOn();
    const c = await clientOr404((req.params as { id: string }).id);
    if ((await levelFor(real, user, c.id)) !== 'books') throw forbidden(SHARE_WHO);
    const dbName = usable(c);
    if (c.kind !== 'pocket') throw badRequest('This client’s books aren’t kept on Shap Pocket.');
    const { name, dataBase64, acceptTerms } = parse(z.object({ name: z.string().max(200), dataBase64: z.string().max(Math.round(config.UPLOAD_MB * 1024 * 1024 * 1.4)), acceptTerms: z.boolean().default(false) }), req.body);
    const share = readPocketShare(name, Buffer.from(dataBase64, 'base64'));
    const sql = clients.get(dbName);
    const [terms] = await sql<{ termsVersion: string }[]>`select terms_version from settings where id`;
    const accepting = (terms?.termsVersion ?? '') !== TERMS_VERSION;
    if (accepting && !acceptTerms) throw badRequest(`Confirm that you accept the Shap Accountant terms of use for your practice’s use of Shap on these books first: ${PRACTICE_TERMS_TICK}`, { needsTerms: true });
    // The practice person is there by name, as the copy's reader.
    await mirrorUser(sql, user, 'compile');
    const result = await sql.begin(async (tx) => {
      const r = await applyPocketShare(tx, share, name, user.id);
      if (accepting) {
        await tx`update settings set terms_version = ${TERMS_VERSION}, terms_accepted_at = now() where id`;
        await audit(tx, { userId: user.id, action: 'accept_terms', entity: 'settings', ip: req.ip, details: { version: TERMS_VERSION, url: TERMS_URL, accountantVersion: ACCOUNTANT_TERMS_VERSION, accountantUrl: ACCOUNTANT_TERMS_URL, for: 'the practice’s use of Shap on these books' } });
      }
      await audit(tx, { userId: user.id, action: 'pocket_share_in', entity: 'pocket_share', entityId: String(r.number), ip: req.ip, details: { through: r.through, added: r.changes.added, changed: r.changes.changed, removed: r.changes.removed, restored: r.restored, file: name.slice(0, 200), hash: share.fileHash } });
      return r;
    });
    await audit(real, { userId: user.id, action: 'practice_pocket_share', entity: 'practice_client', entityId: c.id, ip: req.ip, details: { number: result.number, hash: share.fileHash } });
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
  // A client's backups, to hand them their books or keep them as the law asks: whether or not the
  // practice has accepted the Shap Accountant terms as they are now (ACCOUNTANT_TERMS_NEEDED).
  app.get('/api/practice/records', owner, async () => {
    await assertSwitchedOn();
    return { clients: await real<{ id: string; name: string; archived: boolean }[]>`select id, name, archived_at is not null as archived from practice_clients where db_name is not null order by archived_at nulls first, lower(name)` };
  });
  app.get('/api/practice/clients/:id/backups', owner, async (req) => {
    await assertSwitchedOn();
    const c = await clientOr404((req.params as { id: string }).id);
    return { backups: c.dbName ? await backupsOf(c.dbName) : [] };
  });
  app.post('/api/practice/clients/:id/backups/:name/link', { ...owner, config: limit(10) }, async (req) => {
    const user = userOrThrow(req);
    await assertSwitchedOn();
    const { id, name } = parse(z.object({ id: z.string(), name: z.string().max(200) }), req.params);
    const c = await clientOr404(id);
    if (!c.dbName || !BACKUP_NAME.test(name) || !name.startsWith(`${c.dbName}-`)) throw notFound('Backup');
    await confirmPassword(real, user.id, parse(z.object({ password: z.string().max(200).optional() }), req.body ?? {}).password, req.ip);
    const t = ctx.secrets.signToken('client-backup', { id: c.id, name, uid: user.id }, 120);
    return { url: `/api/practice/clients/${c.id}/backups/${encodeURIComponent(name)}?t=${encodeURIComponent(t)}` };
  });
  app.get('/api/practice/clients/:id/backups/:name', owner, async (req, reply) => {
    const user = userOrThrow(req);
    await assertSwitchedOn();
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
