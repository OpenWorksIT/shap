/**
 * The test server (docs/TEST_SERVER.md): a Shap for trying Shap out with made-up books, switched on
 * on the server itself (TEST_SERVER=true), never from the app. Its owner sets it up as any kind of
 * business, then fills the books with the last full financial year and this one to date of
 * made-up activity for that setup (testdata/populate.ts), checks the figures, and wipes it all to
 * set it up as another kind of business. Nothing is sent from a test server to OpenWorks (no
 * anonymous prices, usage notes or feedback: market.ts, feedback.ts).
 *
 * On every other Shap these routes are there (so the security tests and the penetration test see
 * them) but refuse: a real business's books are never filled with made-up data or wiped from here.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { confirmPassword, FILLING_SESSION, requireRole, seesBooks, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Sql } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { getSettings, today } from '../lib/books.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { routePath } from '../lib/http.js';
import type { LiveBus } from '../lib/live.js';
import { newToken, sha256 } from '../lib/tokens.js';
import { parse } from '../lib/validate.js';
import { populate, type Io, type PopulateSummary } from '../testdata/populate.js';
import { appVersion } from './system.js';
import { DEMO_COOKIE } from './demo.js';
import { wipeBooks } from './wipe.js';

/**
 * Marks the requests the filling makes of Shap's own API: known only inside this process, so no
 * request from outside can pass for one. They aren't held back while the books fill, and don't
 * each tell the open screens to refresh.
 */
const INTERNAL = newToken();
export const isInternal = (req: FastifyRequest) => req.headers['x-shap-internal'] === INTERNAL;

/** The filling's own sign-in, as it shows in the sessions table (removed after; any left from a restart, at start-up). */
const FILLING = FILLING_SESSION;

export interface FillState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  /** Days filled of the days to fill, and the day it's on. */
  done: number;
  total: number;
  day: string | null;
  error: string | null;
  summary: PopulateSummary | null;
}

const idle = (): FillState => ({ running: false, startedAt: null, finishedAt: null, done: 0, total: 0, day: null, error: null, summary: null });

/**
 * Nothing in the books yet besides what setup made: no clients, documents, costs, journals, people,
 * items, assets, trips, time, bank statements or year ends. (Partners added after setup are fine:
 * the filling uses them.)
 */
export async function booksEmpty(db: Sql): Promise<boolean> {
  const [r] = await db<{ any: boolean }[]>`
    select exists (select 1 from clients) or exists (select 1 from documents) or exists (select 1 from costs) or exists (select 1 from journals)
        or exists (select 1 from projects) or exists (select 1 from workers) or exists (select 1 from employees) or exists (select 1 from items)
        or exists (select 1 from assets) or exists (select 1 from trips) or exists (select 1 from time_entries) or exists (select 1 from bank_lines)
        or exists (select 1 from statement_files) or exists (select 1 from year_ends) or exists (select 1 from tax_estimates) or exists (select 1 from archived_years) as any`;
  return !r!.any;
}

/**
 * Month end that locks by itself would close the past months under the filling: set to "by hand"
 * while it runs, and back after (the returned function). New books have nothing to lock yet, so
 * whatever the lock says goes (a month locked by itself before the filling began).
 */
export async function setMonthEndAside(db: Sql): Promise<{ was: 'manual' | 'auto'; restore: () => Promise<void> }> {
  const [row] = await db<{ monthEndMode: 'manual' | 'auto' }[]>`select month_end_mode from settings where id`;
  const was = row?.monthEndMode ?? 'manual';
  await db`update settings set month_end_mode = 'manual', lock_date = null, relock_date = null, month_locked_through = null where id`;
  return { was, restore: async () => void (await db`update settings set month_end_mode = ${was} where id`) };
}

const notHere = () => new HttpError(404, 'This isn’t a test server: made-up data is only for a Shap set up as one (TEST_SERVER=true on the server).', 'not_test_server');

export function registerTestServerRoutes(app: FastifyInstance, ctx: Ctx, bus: LiveBus): void {
  const on = ctx.config.TEST_SERVER;
  const db = ctx.dbs.real;
  let state = idle();
  // Filling or wiping: claimed before anything is awaited, so two can never run at once.
  let busy: 'filling' | 'wiping' | null = null;

  // A restart while the books were filling leaves the filling's sign-in, and month end as the
  // filling set it: the sign-in goes (its token died with the process), month end goes back.
  if (on) {
    app.addHook('onReady', async () => {
      const left = await db`delete from sessions where user_agent = ${FILLING} returning user_id`;
      if (!left.length) return;
      const [last] = await db<{ details: { monthEndMode?: string } | null }[]>`select details from audit_log where action = 'test_populate' order by id desc limit 1`;
      const mode = last?.details?.monthEndMode;
      if (mode === 'manual' || mode === 'auto') await db`update settings set month_end_mode = ${mode} where id`;
    });
  }

  // While the books fill (or are wiped), nothing else changes them (the figures it reads would move
  // under it): anyone saving is asked to wait. Signing in and out, and leaving the demo, still work.
  app.addHook('onRequest', async (req, reply) => {
    if (!busy || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || isInternal(req)) return;
    const p = routePath(req);
    if (!p.startsWith('/api/') || p.startsWith('/api/auth/') || p === '/api/demo/leave') return;
    return reply.code(423).send({ error: busy === 'wiping' ? 'The test books are being wiped. Try again in a moment.' : 'The books are being filled with made-up data. Wait till that’s done (a minute or two), then try again.', code: 'filling' });
  });

  /** Is this a test server, and how is the filling going? */
  app.get('/api/test-server', { preHandler: requireRole() }, async (req) => {
    if (!on) return { on: false };
    const settings = await getSettings(db);
    // How far the filling is; what it made, for whoever sees the books.
    const sees = seesBooks(userOrThrow(req));
    return { on: true, setupDone: settings.setupDone, empty: await booksEmpty(db), fill: sees ? state : { ...state, summary: null, error: state.error ? 'The filling stopped' : null } };
  });

  /** Fills new books with made-up data for the setup chosen (in the background: watch the status). */
  app.post('/api/test-server/populate', { preHandler: requireRole('owner') }, async (req) => {
    if (!on) throw notHere();
    const user = userOrThrow(req);
    if (req.cookies?.[DEMO_COOKIE] === '1') throw badRequest('Leave the demo company first');
    // (A second request while this one runs never gets here: it's held back above.)
    if (busy) throw badRequest('The books are already being filled');
    busy = 'filling';
    let started = false;
    try {
      const settings = await getSettings(db);
      if (!settings.setupDone) throw badRequest('Set the business up first (the first-run questions): the made-up data follows the setup.');
      if (!(await booksEmpty(db))) throw badRequest('Made-up data goes into new books only: wipe these and set up again first.');

      // Signed in as the owner who asked, for the requests the filling makes (removed after).
      const token = newToken();
      await db`insert into sessions (token_hash, user_id, expires_at, user_agent, ip) values (${sha256(token)}, ${user.id}, now() + interval '3 hours', ${FILLING}, ${req.ip})`;
      const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) => {
        const res = await app.inject({
          method,
          url,
          payload: body === undefined ? undefined : (body as never),
          headers: { 'x-shap-version': appVersion(), 'x-shap-internal': INTERNAL },
          cookies: { shap_session: token },
        });
        if (res.statusCode >= 400) {
          let msg = res.body;
          try {
            msg = (res.json() as { error?: string }).error ?? msg;
          } catch {
            // not JSON: the body as it is
          }
          throw new Error(`${method} ${url.split('?')[0]}: ${msg}`);
        }
        return res.body ? res.json() : null;
      };
      const io: Io = { get: (url) => call('GET', url), send: (method, url, body) => call(method, url, body ?? {}) };

      const monthEnd = await setMonthEndAside(db);
      state = { ...idle(), running: true, startedAt: new Date().toISOString() };
      await audit(db, { userId: user.id, action: 'test_populate', entity: 'books', ip: req.ip, details: { businessType: settings.businessType, industry: settings.industry, monthEndMode: monthEnd.was } });
      const to = today();
      started = true;
      void (async () => {
        try {
          const summary = await populate(io, db, { today: to, progress: (p) => (state = { ...state, done: p.done, total: p.total, day: p.step }) });
          state = { ...state, running: false, finishedAt: new Date().toISOString(), summary };
        } catch (err) {
          // Logged by where it stopped only (the message can quote what was being saved); the owner sees it on Home.
          req.log.warn({ at: String((err as Error).message).split(':')[0]?.slice(0, 80) }, 'test server: filling the books stopped');
          state = { ...state, running: false, finishedAt: new Date().toISOString(), error: (err as Error).message.slice(0, 500) };
        } finally {
          await monthEnd.restore().catch(() => undefined);
          await db`delete from sessions where token_hash = ${sha256(token)}`.catch(() => undefined);
          busy = null;
          // Every screen open on the books: refresh.
          bus.publish({ type: 'changed', by: null, demo: false, at: Date.now() });
        }
      })();
      return { started: true, fill: state };
    } finally {
      if (!started) busy = null;
    }
  });

  /** Wipes the books (everyone's sign-ins stay) and starts again from the first-run questions. */
  app.post('/api/test-server/wipe', { preHandler: requireRole('owner'), config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    if (!on) throw notHere();
    const user = userOrThrow(req);
    if (req.cookies?.[DEMO_COOKIE] === '1') throw badRequest('Leave the demo company first');
    if (busy) throw badRequest('Wait till the books are filled, then wipe them');
    busy = 'wiping';
    try {
      const { confirm, password } = parse(z.object({ confirm: z.string().max(20), password: z.string().max(200).optional() }), req.body);
      if (confirm.trim().toUpperCase() !== 'WIPE') throw badRequest('Type WIPE to wipe the test books');
      // Your password, as for wiping a real business's books (Settings → Wipe all data).
      await confirmPassword(db, user.id, password, req.ip);
      await wipeBooks(db);
      state = idle();
      await audit(db, { userId: user.id, action: 'test_wipe', entity: 'books', ip: req.ip });
      return { ok: true };
    } finally {
      busy = null;
    }
  });
}
