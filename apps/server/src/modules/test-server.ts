/**
 * The test server (docs/TEST_SERVER.md): a Shap for trying Shap out with made-up books, switched on
 * on the server itself (TEST_SERVER=true), never from the app. Its owner sets it up as any kind of
 * business, then fills the books with the last full financial year and this one to date of
 * made-up activity for that setup (testdata/populate.ts), checks the figures, and wipes it all to
 * set it up as another kind of business. Nothing is shared from a test server (no anonymous
 * prices or usage notes: market.ts, feedback.ts).
 *
 * On every other Shap these routes are there (so the security tests and the penetration test see
 * them) but refuse: a real business's books are never filled with made-up data or wiped from here.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireRole, seesBooks, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Sql } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { getSettings, today } from '../lib/books.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { routePath } from '../lib/http.js';
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

/** Nothing in the books yet besides what setup made: no clients, documents, costs, journals or people. */
export async function booksEmpty(db: Sql): Promise<boolean> {
  const [r] = await db<{ n: number }[]>`
    select (select count(*) from clients) + (select count(*) from documents) + (select count(*) from costs) + (select count(*) from journals)
         + (select count(*) from projects) + (select count(*) from workers) + (select count(*) from employees) + (select count(*) from items)
         + (select count(*) from assets) + (select count(*) from trips) as n`;
  return Number(r!.n) === 0;
}

const notHere = () => new HttpError(404, 'This isn’t a test server: made-up data is only for a Shap set up as one (TEST_SERVER=true on the server).', 'not_test_server');

export function registerTestServerRoutes(app: FastifyInstance, ctx: Ctx): void {
  const on = ctx.config.TEST_SERVER;
  const db = ctx.dbs.real;
  let state = idle();

  // While the books fill, nothing else changes them (the figures it reads would move under it):
  // anyone saving is asked to wait. Signing in and out still works.
  app.addHook('onRequest', async (req, reply) => {
    if (!state.running || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || isInternal(req)) return;
    const p = routePath(req);
    if (!p.startsWith('/api/') || p.startsWith('/api/auth/')) return;
    return reply.code(423).send({ error: 'The books are being filled with made-up data. Wait till that’s done (a minute or two), then try again.', code: 'filling' });
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
    if (state.running) throw badRequest('The books are already being filled');
    const settings = await getSettings(db);
    if (!settings.setupDone) throw badRequest('Set the business up first (the first-run questions): the made-up data follows the setup.');
    if (!(await booksEmpty(db))) throw badRequest('Made-up data goes into new books only: wipe these and set up again first.');

    // Signed in as the owner who asked, for the requests the filling makes (removed after).
    const token = newToken();
    await db`insert into sessions (token_hash, user_id, expires_at, user_agent, ip) values (${sha256(token)}, ${user.id}, now() + interval '3 hours', 'Shap test server: filling the books', ${req.ip})`;
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

    // Month end that locks by itself would close the past months under the filling: by hand
    // while it runs, then back as it was.
    const [was] = await db<{ monthEndMode: string }[]>`select month_end_mode from settings where id`;
    await db`update settings set month_end_mode = 'manual' where id`;
    state = { ...idle(), running: true, startedAt: new Date().toISOString() };
    await audit(db, { userId: user.id, action: 'test_populate', entity: 'books', ip: req.ip, details: { businessType: settings.businessType, industry: settings.industry } });
    const to = today();
    void (async () => {
      try {
        const summary = await populate(io, db, { today: to, progress: (p) => (state = { ...state, done: p.done, total: p.total, day: p.step }) });
        state = { ...state, running: false, finishedAt: new Date().toISOString(), summary };
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, 'test server: filling the books stopped');
        state = { ...state, running: false, finishedAt: new Date().toISOString(), error: (err as Error).message.slice(0, 500) };
      } finally {
        await db`update settings set month_end_mode = ${was?.monthEndMode ?? 'manual'} where id`.catch(() => undefined);
        await db`delete from sessions where token_hash = ${sha256(token)}`.catch(() => undefined);
      }
    })();
    return { started: true, fill: state };
  });

  /** Wipes the books (everyone's sign-ins stay) and starts again from the first-run questions. */
  app.post('/api/test-server/wipe', { preHandler: requireRole('owner'), config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    if (!on) throw notHere();
    const user = userOrThrow(req);
    if (req.cookies?.[DEMO_COOKIE] === '1') throw badRequest('Leave the demo company first');
    if (state.running) throw badRequest('Wait till the books are filled, then wipe them');
    const { confirm } = parse(z.object({ confirm: z.string().max(20) }), req.body);
    if (confirm.trim().toUpperCase() !== 'WIPE') throw badRequest('Type WIPE to wipe the test books');
    await wipeBooks(db);
    state = idle();
    await audit(db, { userId: user.id, action: 'test_wipe', entity: 'books', ip: req.ip });
    return { ok: true };
  });

}
