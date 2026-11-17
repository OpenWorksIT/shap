/**
 * A business's own Shap, linked to its accountant's Shap Accountant (packages/shared link.ts,
 * docs/ACCOUNTANT.md "A client on its own Shap"). Two halves:
 *
 * - **The owner's** (Settings → People who sign in → Your accountant): make a link for the practice, choosing
 *   what it may do here; see who from it has opened the books; unlink. A link is a code that works
 *   once, for a week, kept only as its hash.
 * - **The practice's server's** (/api/link/…): it shows the link's code once, and gets a
 *   credential for this link (kept here as its hash; sealed on the practice's server). With it,
 *   and only for this link, it asks for a sign-in for one of its people (who opens the books here
 *   as someone of their own, never by password, at no more than the owner allowed), for what Shap's
 *   checks find here, to take one of its people out, or to unlink. Nothing else is answered.
 *
 * The sign-in itself is a token that works once, within a minute, opened in the practice person's
 * browser (GET /api/link/enter), which makes them a session here for LINK_SESSION_HOURS, no longer
 * however busy they are (auth.ts doesn't extend it). Everything is in this Shap's audit log, by name.
 * Each of these routes reads a small body only, and is in LINK_PATHS (the guards let only those by).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { LINK_API, LINK_DAYS, LINK_SESSION_HOURS, LINK_SIGN_IN_SECONDS, LINKED_BOOKS_TASKS, LEVELS, linkText, plainName, type Level } from '@shap/shared';
import { z } from 'zod';
import { browserName, CLIENT_COOKIE, CLIENT_SESSION_COOKIE, confirmPassword, requireRole, SESSION_COOKIE, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Db, Sql } from '../db/index.js';
import { dbScope } from '../db/routing.js';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden, HttpError, notFound } from '../lib/errors.js';
import { healthForLink, healthOf } from '../lib/practice.js';
import { newToken, sha256 } from '../lib/tokens.js';
import { parse } from '../lib/validate.js';
import { DEMO_COOKIE } from './demo.js';
import { appVersion } from './system.js';

/** What the practice's server puts before its credential, so it's never taken for a session. */
export const LINK_BEARER = 'link.';
const NOT_HERE = 'Your accountant is linked in your own Shap, not in a practice’s copy of your books or the demo company.';
const GONE = 'This link to the client’s Shap no longer works: it was unlinked there. Ask them for a new one.';

interface LinkRow {
  id: string;
  level: Level;
  practiceName: string | null;
  createdAt: Date;
  codeExpiresAt: Date | null;
  linkedAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** Takes a link away: its code and credential, everyone from the practice's sessions, and their sign-ins. */
export async function revokeLink(db: Db, id: string, by: string | null): Promise<void> {
  await db`update accountant_links set revoked_at = coalesce(revoked_at, now()), revoked_by = coalesce(revoked_by, ${by}), code_hash = null, credential_hash = null where id = ${id}`;
  await db`delete from sessions where user_id in (select id from users where link_id = ${id})`;
  await db`delete from link_entries where link_id = ${id}`;
  await db`update users set active = false where link_id = ${id}`;
}

export function registerLinkRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { config } = ctx;
  // This Shap's own books, always: never the demo company's or a practice's client's (whose
  // cookies a request here could carry).
  const real: Sql = ctx.dbs.real;
  const limit = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute' } });
  // What another server sends here is small: no more of it is read.
  const small = { bodyLimit: 16 * 1024 };
  const named = (max: number) => z.string().max(2000).transform(plainName).pipe(z.string().min(1).max(max));
  const owner = { preHandler: requireRole('owner') };
  const notHere = () => {
    const s = dbScope.getStore();
    if (s?.demo || s?.client) throw forbidden(NOT_HERE);
  };

  /* ------------------------------------------------------------ the owner's */

  app.get('/api/accountant-links', owner, async () => {
    notHere();
    const links = await real<LinkRow[]>`
      select id, level, practice_name, created_at, code_expires_at, linked_at, last_used_at, revoked_at
      from accountant_links order by created_at desc`;
    const people = await real<{ linkId: string; name: string; lastLoginAt: Date | null; active: boolean }[]>`
      select link_id, name, last_login_at, active from users where link_id is not null order by name`;
    const now = Date.now();
    return links.map((l) => ({
      ...l,
      status: l.revokedAt ? 'unlinked' : l.linkedAt ? 'linked' : l.codeExpiresAt && l.codeExpiresAt.getTime() > now ? 'waiting' : 'expired',
      people: people.filter((p) => p.linkId === l.id).map(({ linkId: _l, ...p }) => p),
    }));
  });

  /** A link for the practice: shown once, with the password, as giving someone the books takes. */
  app.post('/api/accountant-links', { ...owner, config: limit(10) }, async (req) => {
    notHere();
    const user = userOrThrow(req);
    const { level, password } = parse(z.object({ level: z.enum(LEVELS), password: z.string().max(200).optional() }), req.body);
    await confirmPassword(real, user.id, password, req.ip);
    const code = newToken();
    const [row] = await real<{ id: string; codeExpiresAt: Date }[]>`
      insert into accountant_links (level, code_hash, code_expires_at, created_by)
      values (${level}, ${sha256(code)}, now() + make_interval(days => ${LINK_DAYS}), ${user.id}) returning id, code_expires_at`;
    await audit(real, { userId: user.id, action: 'make_accountant_link', entity: 'accountant_link', entityId: row!.id, ip: req.ip, details: { level } });
    return { id: row!.id, level, link: linkText(config.PUBLIC_URL, code), expiresAt: row!.codeExpiresAt };
  });

  app.post('/api/accountant-links/:id/unlink', { ...owner, config: limit(10) }, async (req) => {
    notHere();
    const user = userOrThrow(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const [l] = await real<{ id: string; practiceName: string | null }[]>`select id, practice_name from accountant_links where id = ${id}`;
    if (!l) throw notFound('Link');
    await real.begin((tx) => revokeLink(tx, id, user.id));
    await audit(real, { userId: user.id, action: 'unlink_accountant', entity: 'accountant_link', entityId: id, ip: req.ip, details: { practice: l.practiceName } });
    return { ok: true };
  });

  /* ------------------------------------------------- the practice's server's */

  /** The link this request's credential is for, still linked; or refused, saying nothing more. */
  const linkOf = async (req: FastifyRequest) => {
    const header = req.headers.authorization ?? '';
    const credential = header.startsWith(`Bearer ${LINK_BEARER}`) ? header.slice(7 + LINK_BEARER.length) : '';
    if (credential.length < 20 || credential.length > 200) throw new HttpError(401, GONE, 'link_gone');
    const [l] = await real<{ id: string; level: Level; practiceName: string }[]>`
      update accountant_links set last_used_at = now() where credential_hash = ${sha256(credential)} and revoked_at is null
      returning id, level, practice_name`;
    if (!l) throw new HttpError(401, GONE, 'link_gone');
    return l;
  };
  const company = async () => (await real<{ companyName: string }[]>`select company_name from settings where id`)[0]?.companyName ?? '';
  const answer = (body: Record<string, unknown>) => ({ ...body, api: LINK_API, version: appVersion() });

  /** The practice's server shows the code once, and gets this link's credential. */
  app.post('/api/link/redeem', { ...small, config: limit(10) }, async (req) => {
    const { code, practice } = parse(z.object({ code: z.string().min(20).max(100), practice: z.object({ name: named(200) }) }), req.body);
    const credential = newToken();
    const [l] = await real<{ id: string; level: Level; createdBy: string | null }[]>`
      update accountant_links set code_hash = null, code_expires_at = null, credential_hash = ${sha256(credential)}, practice_name = ${practice.name}, linked_at = now(), last_used_at = now()
      where code_hash = ${sha256(code)} and code_expires_at > now() and revoked_at is null
      returning id, level, created_by`;
    if (!l) throw new HttpError(400, 'That link doesn’t work: it was used already, it’s more than a week old, or it was unlinked. Ask the client for a new one (Settings → People who sign in → Your accountant, in their Shap).', 'link_unknown');
    await audit(real, { actor: 'system', action: 'accountant_linked', entity: 'accountant_link', entityId: l.id, ip: req.ip, details: { practice: practice.name, level: l.level } });
    return answer({ credential, company: await company(), level: l.level });
  });

  /** A sign-in for one of the practice's people, at no more than the owner allowed. */
  app.post('/api/link/sign-in', { ...small, config: limit(30) }, async (req) => {
    const l = await linkOf(req);
    const { person, level } = parse(z.object({ person: z.object({ id: z.string().uuid(), name: named(120), mfa: z.boolean() }), level: z.enum(LEVELS) }), req.body);
    if (level === 'books' && l.level !== 'books') throw new HttpError(403, 'The client lets your practice read their books and compile the statements, not write them up.', 'link_level');
    // Two-factor sign-in, where this Shap requires it of everyone: of them too (at their practice).
    if (config.mfaRequired && !person.mfa) throw new HttpError(403, 'This Shap requires two-factor sign-in, and they haven’t turned it on at their practice.', 'link_mfa');
    const name = `${person.name} (${l.practiceName})`.slice(0, 200);
    const role = level === 'books' ? 'staff' : 'accountant';
    const access = level === 'books' ? [...LINKED_BOOKS_TASKS] : [];
    const token = newToken();
    const userId = await real.begin(async (tx) => {
      const [u] = await tx<{ id: string }[]>`
        insert into users (name, email, password_hash, role, active, link_id, link_person, access_add, access_remove)
        values (${name}, ${`practice-${l.id}-${person.id}@link.invalid`}, '!practice', ${role}, true, ${l.id}, ${person.id}, ${access}::text[], '{}')
        on conflict (link_id, link_person) where link_id is not null do update set name = excluded.name, role = excluded.role, active = true,
          profile_id = null, access_add = excluded.access_add, access_remove = '{}'
        returning id`;
      await tx`insert into link_entries (token_hash, link_id, user_id, expires_at) values (${sha256(token)}, ${l.id}, ${u!.id}, now() + make_interval(secs => ${LINK_SIGN_IN_SECONDS}))`;
      return u!.id;
    });
    await audit(real, { userId, action: 'link_sign_in_made', entity: 'accountant_link', entityId: l.id, ip: req.ip, details: { practice: l.practiceName, level } });
    return answer({ path: `/api/link/enter?t=${encodeURIComponent(token)}` });
  });

  /** In the practice person's browser: the sign-in, once, and into the books. */
  app.get('/api/link/enter', { config: limit(30) }, async (req, reply: FastifyReply) => {
    const { t } = parse(z.object({ t: z.string().max(200).default('') }), req.query);
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
    // Someone else signed in to this Shap in this browser (its owner, say) isn't signed out by it:
    // they sign out first, and the sign-in stays unused meanwhile.
    const here = req.cookies?.[SESSION_COOKIE];
    if (here) {
      const [other] = await real<{ id: string }[]>`
        select u.id from sessions s join users u on u.id = s.user_id where s.token_hash = ${sha256(here)} and s.expires_at > now() and u.active and u.link_id is null`;
      if (other) return reply.redirect('/?link=signed-in', 303);
    }
    const session = newToken();
    const entered = await real.begin(async (tx) => {
      const [e] = await tx<{ userId: string; linkId: string }[]>`
        update link_entries set used_at = now()
        where token_hash = ${sha256(t)} and used_at is null and expires_at > now()
          and link_id in (select id from accountant_links where revoked_at is null)
        returning user_id, link_id`;
      if (!e) return null;
      const [u] = await tx<{ id: string }[]>`select id from users where id = ${e.userId} and link_id = ${e.linkId} and active`;
      if (!u) return null;
      await tx`insert into sessions (token_hash, user_id, expires_at, user_agent, ip)
        values (${sha256(session)}, ${u.id}, now() + make_interval(hours => ${LINK_SESSION_HOURS}), ${browserName(req)}, ${req.ip})`;
      await tx`update users set last_login_at = now() where id = ${u.id}`;
      await audit(tx, { userId: u.id, action: 'login', entity: 'user', entityId: u.id, ip: req.ip, details: { method: 'accountant_link' } });
      return u.id;
    });
    if (!entered) return reply.redirect('/?link=expired', 303);
    reply.setCookie(SESSION_COOKIE, session, { httpOnly: true, sameSite: 'lax', secure: config.COOKIE_SECURE, path: '/', maxAge: LINK_SESSION_HOURS * 3600 });
    // Into these books, not the demo company or a practice's client (whose cookies a browser may keep).
    for (const c of [DEMO_COOKIE, CLIENT_COOKIE, CLIENT_SESSION_COOKIE]) if (req.cookies?.[c] !== undefined) reply.clearCookie(c, { path: '/' });
    return reply.redirect('/', 303);
  });

  /** What Shap's checks find here, for the practice's list (the books audit, the statements, the returns). */
  app.get('/api/link/health', { ...small, config: limit(10) }, async (req) => {
    const l = await linkOf(req);
    await audit(real, { actor: 'system', action: 'link_checks', entity: 'accountant_link', entityId: l.id, ip: req.ip, details: { practice: l.practiceName } });
    return answer({ health: healthForLink(await healthOf(real, undefined, req.log)), level: l.level });
  });

  /** One of the practice's people no longer opens these books (their access went or changed). */
  app.post('/api/link/person-off', { ...small, config: limit(60) }, async (req) => {
    const l = await linkOf(req);
    const { personId } = parse(z.object({ personId: z.string().uuid() }), req.body);
    const [u] = await real<{ id: string; active: boolean }[]>`
      update users n set active = false from users o where n.id = o.id and n.link_id = ${l.id} and n.link_person = ${personId} returning n.id, o.active`;
    if (u) {
      await real`delete from sessions where user_id = ${u.id}`;
      await real`delete from link_entries where user_id = ${u.id}`;
      if (u.active) await audit(real, { actor: 'system', action: 'link_person_off', entity: 'user', entityId: u.id, ip: req.ip, details: { practice: l.practiceName } });
    }
    return answer({ ok: true });
  });

  /** The practice unlinks: as if the owner had. */
  app.post('/api/link/unlink', { ...small, config: limit(10) }, async (req) => {
    const l = await linkOf(req);
    await real.begin((tx) => revokeLink(tx, l.id, null));
    await audit(real, { actor: 'system', action: 'accountant_unlinked', entity: 'accountant_link', entityId: l.id, ip: req.ip, details: { practice: l.practiceName, by: 'the practice' } });
    return answer({ ok: true });
  });
}
