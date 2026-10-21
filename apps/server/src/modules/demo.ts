/**
 * Show the demo company: Settings → "Show the demo company" swaps this phone or browser over to
 * a made-up company (its own database) so you can show Shap to someone without your figures on
 * screen. "Back to my books" asks for your password, in case the phone was handed over.
 */
import { verify } from '@node-rs/argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DEMO_SESSION_COOKIE, requireRole, SESSION_COOKIE, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Sql } from '../db/index.js';
import { inDemo } from '../db/routing.js';
import { seed } from '../db/seed.js';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { newToken, sha256 } from '../lib/tokens.js';
import { parse } from '../lib/validate.js';

/** Set while this browser is showing the demo company. */
export const DEMO_COOKIE = 'shap_demo';

export function registerDemoRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { config, dbs } = ctx;
  const available = () => config.DEMO_ENABLED && dbs.demo != null;
  const cookie = { httpOnly: true, sameSite: 'lax' as const, secure: config.COOKIE_SECURE, path: '/', maxAge: config.SESSION_TTL_HOURS * 3600 };

  // The server's own updates and backups (your real data) are never reachable from the demo.
  app.addHook('onRequest', async (req) => {
    if (inDemo() && req.url.startsWith('/api/system')) throw forbidden('Not available in the demo company');
  });

  // Fill the demo company the first time it's shown (a few seconds), one at a time.
  let seeding: Promise<void> | null = null;
  const ensureSeeded = async (demo: Sql, fresh = false) => {
    if (!fresh) {
      const [u] = await demo<{ n: number }[]>`select count(*)::int as n from users where active`.catch(() => [{ n: 0 }]);
      if (u!.n > 0) return;
    }
    // Never wipe anything but a database meant for the demo.
    const [db] = await demo<{ name: string }[]>`select current_database() as name`;
    if (!db!.name.endsWith('_demo') && !db!.name.endsWith('_test_demo')) throw new Error(`Refusing to load the demo company into "${db!.name}"`);
    seeding ??= seed(demo, { reset: true, password: newToken() }).finally(() => (seeding = null));
    await seeding;
  };

  /** Signs this browser in to the demo company as its owner. */
  const demoSession = async (demo: Sql, req: FastifyRequest, reply: FastifyReply) => {
    const [owner] = await demo<{ id: string }[]>`select id from users where role = 'owner' and active order by created_at limit 1`;
    if (!owner) throw badRequest('The demo company has no owner');
    const token = newToken();
    await demo`insert into sessions (token_hash, user_id, expires_at, user_agent, ip)
      values (${sha256(token)}, ${owner.id}, now() + make_interval(hours => ${config.SESSION_TTL_HOURS}), ${String(req.headers['user-agent'] ?? '').slice(0, 300)}, ${req.ip})`;
    reply.setCookie(DEMO_COOKIE, '1', cookie);
    reply.setCookie(DEMO_SESSION_COOKIE, token, cookie);
  };

  app.get('/api/demo/status', async () => ({ available: available(), active: inDemo() }));

  app.post('/api/demo/enter', { preHandler: requireRole('owner') }, async (req, reply) => {
    const user = userOrThrow(req);
    if (inDemo()) throw badRequest('Already showing the demo company');
    if (!available()) throw badRequest('The demo company isn’t set up on this server');
    await ensureSeeded(dbs.demo!);
    await demoSession(dbs.demo!, req, reply);
    await audit(dbs.real, { userId: user.id, action: 'show_demo', entity: 'user', entityId: user.id, ip: req.ip });
    return { ok: true };
  });

  /** Back to your own books: your password, if you're still signed in there. */
  app.post('/api/demo/leave', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { password } = parse(z.object({ password: z.string().default('') }), req.body);
    const realToken = req.cookies[SESSION_COOKIE];
    const [me] = realToken
      ? await dbs.real<{ id: string; passwordHash: string }[]>`
          select u.id, u.password_hash from sessions s join users u on u.id = s.user_id
          where s.token_hash = ${sha256(realToken)} and s.expires_at > now() and u.active`
      : [];
    // A wrong password isn't "signed out" (that would drop the page to the sign-in screen).
    if (me && !(await verify(me.passwordHash, password).catch(() => false))) throw badRequest('Password is incorrect');
    const demoToken = req.cookies[DEMO_SESSION_COOKIE];
    if (demoToken && dbs.demo) await dbs.demo`delete from sessions where token_hash = ${sha256(demoToken)}`.catch(() => undefined);
    reply.clearCookie(DEMO_COOKIE, { path: '/' });
    reply.clearCookie(DEMO_SESSION_COOKIE, { path: '/' });
    if (me) await audit(dbs.real, { userId: me.id, action: 'leave_demo', entity: 'user', entityId: me.id, ip: req.ip });
    return { ok: true };
  });

  /** Puts the demo company back as new (and its dates up to today). */
  app.post('/api/demo/reset', { preHandler: requireRole('owner') }, async (req, reply) => {
    if (!inDemo() || !dbs.demo) throw badRequest('Only the demo company can be reset');
    await ensureSeeded(dbs.demo, true);
    await demoSession(dbs.demo, req, reply);
    return { ok: true };
  });
}
