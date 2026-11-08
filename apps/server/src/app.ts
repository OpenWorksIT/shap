import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth } from './auth.js';
import type { Config } from './config.js';
import type { Ctx } from './context.js';
import { pgCode, PG, type Sql } from './db/index.js';
import { Secrets } from './lib/crypto.js';
import { HttpError } from './lib/errors.js';
import { routePath } from './lib/http.js';
import { safeError } from './lib/logging.js';
import { createMailer, type Mailer } from './lib/mailer.js';
import { registerClientRoutes } from './modules/clients.js';
import { registerCostRoutes } from './modules/costs.js';
import { registerDuplicateRoutes } from './modules/duplicates.js';
import { registerRecurringRoutes } from './modules/recurring.js';
import { registerVatRoutes } from './modules/vat.js';
import { registerPayrollRoutes } from './modules/payroll.js';
import { registerPartnerRoutes } from './modules/partners.js';
import { registerFeedbackRoutes } from './modules/feedback.js';
import { registerNoticeRoutes } from './modules/notice.js';
import { registerMarketRoutes } from './modules/market.js';
import { setPdfFonts } from './modules/pdf.js';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { registerMonthlyRoutes } from './modules/monthly.js';
import { registerDashboardRoutes } from './modules/dashboard.js';
import { registerDocumentRoutes } from './modules/documents.js';
import { registerImportRoutes } from './modules/import/routes.js';
import { registerProjectRoutes } from './modules/projects.js';
import { registerReportRoutes } from './modules/reports.js';
import { registerSettingsRoutes } from './modules/settings.js';
import { registerWorkerRoutes } from './modules/workers.js';
import { registerYearEndRoutes } from './modules/yearend.js';
import { registerArchiveRoutes } from './modules/archive.js';
import { registerTaxFormRoutes } from './modules/taxforms.js';
import { registerAuditRoutes } from './modules/audit.js';
import { registerBillRoutes } from './modules/bills.js';
import { registerLogbookRoutes } from './modules/logbook.js';
import { registerTimeRoutes } from './modules/timetrack.js';
import { registerAccountantExportRoutes } from './modules/accountantExport.js';
import { registerMoveInRoutes } from './modules/movein.js';
import { registerWipeRoutes } from './modules/wipe.js';
import { registerLiveRoutes } from './modules/live.js';
import { LiveBus } from './lib/live.js';
import { registerBankRoutes } from './modules/bank/routes.js';
import { appVersion, registerSystemRoutes } from './modules/system.js';
import { DEMO_COOKIE, registerDemoRoutes } from './modules/demo.js';
import { dbScope, DemoUnavailable, inDemo, routedDb } from './db/routing.js';
import { registerStatementRoutes } from './modules/statements.js';
import { registerCompanyFileRoutes } from './modules/company-file.js';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export interface BuildOptions {
  config: Config;
  sql: Sql;
  /** The demo company's database, if there is one. */
  demoSql?: Sql | null;
  logger?: boolean | object;
  mailer?: Mailer;
}

// The app's typeface on quotes, invoices and payslips (Helvetica if the font package is missing).
try {
  const dir = createRequire(import.meta.url).resolve('@fontsource/atkinson-hyperlegible-next/package.json').replace(/package\.json$/, 'files/');
  setPdfFonts({ regular: readFileSync(`${dir}atkinson-hyperlegible-next-latin-400-normal.woff`), bold: readFileSync(`${dir}atkinson-hyperlegible-next-latin-700-normal.woff`) });
} catch {
  /* Helvetica */
}

export async function buildApp(opts: BuildOptions): Promise<{ app: FastifyInstance; ctx: Ctx; routes: string[] }> {
  const { config } = opts;
  const sql = routedDb(opts.sql, opts.demoSql ?? null);
  const app = Fastify({
    logger: opts.logger ?? false,
    // Behind exactly one proxy (Caddy): the client is the address it saw, not whatever a
    // client claims in its own X-Forwarded-For (which would let anyone dodge the sign-in limits).
    trustProxy: config.TRUST_PROXY ? (_address: string, hop: number) => hop < 1 : false,
    // Room for a tracker spreadsheet or a receipt photo, sent as base64 JSON.
    bodyLimit: config.UPLOAD_MB * 1024 * 1024 * 1.4,
  });
  // Every route as Fastify has it: the security tests check each one, and that the penetration
  // test's own reading of the code (deploy/test/routes.mjs) finds the same.
  const routes: string[] = [];
  app.addHook('onRoute', (r) => {
    for (const m of [r.method].flat()) if (m !== 'HEAD' && r.url.startsWith('/api/')) routes.push(`${m} ${r.url}`);
  });

  const realMailer = opts.mailer ?? createMailer(config.SMTP_URL, config.MAIL_FROM, app.log);
  const ctx: Ctx = {
    config,
    sql,
    dbs: { real: opts.sql, demo: opts.demoSql ?? null },
    // The demo company's clients are made up: nothing is ever emailed from it.
    mailer: {
      send: async (m) => (inDemo() ? void app.log.info('demo company: email not sent') : realMailer.send(m)),
      check: async () => (realMailer.check ? realMailer.check() : null),
    },
    secrets: new Secrets(config.secretsKey),
  };

  // Tells other open screens that something changed, after every successful save.
  const bus = new LiveBus();
  app.addHook('onResponse', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || reply.statusCode >= 400) return;
    const p = routePath(req);
    if (!p.startsWith('/api/') || p.startsWith('/api/auth') || p.startsWith('/api/feedback') || p.startsWith('/api/demo')) return;
    bus.publish({ type: 'changed', by: req.user?.id ?? null, demo: req.cookies?.shap_demo === '1', at: Date.now() });
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  // JSON only: a plain-text body is what a cross-site form can send.
  app.removeContentTypeParser('text/plain');

  // Which company this request is for: the demo company while its cookie is set. Everything the
  // request does (every query) runs inside this scope.
  app.addHook('onRequest', (req, _reply, done) => {
    dbScope.run({ demo: req.cookies?.[DEMO_COOKIE] === '1' }, done);
  });

  // CORS only for explicitly configured origins (e.g. a future Capacitor app).
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('access-control-allow-credentials', 'true');
      reply.header('vary', 'Origin');
      if (req.method === 'OPTIONS') {
        reply.header('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        reply.header('access-control-allow-headers', 'content-type,authorization,x-shap-version,x-shap-client');
        reply.header('access-control-max-age', '600');
        return reply.code(204).send();
      }
    }
  });

  // A page still running an older version of the app (opened before an update) mustn't change
  // anything: its screens may send what the new server reads differently. It's asked to reload.
  const version = appVersion();
  app.addHook('onRequest', async (req, reply) => {
    if (!routePath(req).startsWith('/api/') || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const theirs = req.headers['x-shap-version'];
    // Shap's own pages always send their version; a form or script on another site can't add that
    // header (browsers only allow it from Shap's own address), so a change without it is refused.
    // This is what stops another site from acting with your session. The phone app uses a token.
    const oldPage = theirs === undefined && !req.headers.authorization?.startsWith('Bearer ');
    if (oldPage || (typeof theirs === 'string' && theirs !== version && req.headers['x-shap-client'] !== 'native')) {
      return reply.code(409).send({ error: 'Shap was updated while this page was open. Reload the page, then try again.', code: 'stale_client' });
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const isApi = routePath(req).startsWith('/api/');
    if (isApi) reply.header('x-shap-version', version);
    // The app's pages: only Shap's own scripts, styles and images; never inside another site's frame.
    else if (!reply.getHeader('content-security-policy')) reply.header('content-security-policy', CSP);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('x-frame-options', 'SAMEORIGIN');
    if (isApi && !reply.getHeader('cache-control')) reply.header('cache-control', 'no-store');
    return payload;
  });

  app.setErrorHandler((err: Error, req, reply) => {
    if (err instanceof DemoUnavailable) return reply.code(503).send({ error: err.message, code: 'demo_unavailable' });
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message, code: err.code, details: err.details });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) return reply.code(429).send({ error: 'Too many requests. Please wait a moment and try again.', code: 'rate_limited' });
    if (status === 413) return reply.code(413).send({ error: `That file is too big (${config.UPLOAD_MB} MB at most).`, code: 'too_large' });
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: err.message, code: (err as { code?: string }).code ?? 'bad_request' });
    }
    // A rule the books keep themselves (migrations raise these with code SH001), said as it is.
    if (pgCode(err) === 'SH001') return reply.code(400).send({ error: err.message, code: 'books_rule' });
    // A value Postgres can't take (a date like 2026-99-99, a number out of range, a malformed
    // id): the request is wrong, not the server. Said plainly, without the database's words, and
    // logged as a warning by its code and route (no values), so one the app should have caught
    // still shows. Division by zero is the server's own mistake: an error, below.
    const pg = pgCode(err) ?? '';
    if (/^22/.test(pg) && pg !== PG.divisionByZero) {
      req.log.warn({ pgCode: pg, route: `${req.method} ${routePath(req)}` }, 'a value the database refused');
      return reply.code(400).send({ error: 'Something in that request isn’t valid (a date, number or id out of range).', code: 'invalid_value' });
    }
    // Something chosen that isn't there (a worker or job deleted meanwhile, a made-up id).
    if (pgCode(err) === PG.foreignKeyViolation) return reply.code(400).send({ error: 'Something you chose isn’t there any more. Reload the page and try again.', code: 'missing' });
    // Database rule broken (e.g. an unbalanced journal): say so plainly.
    const msg = err.message ?? '';
    if (/does not balance/.test(msg)) return reply.code(400).send({ error: msg, code: 'unbalanced' });
    req.log.error({ err: safeError(err), route: `${req.method} ${routePath(req)}` }, 'unhandled error');
    return reply.code(500).send({ error: 'Something went wrong on the server', code: 'internal' });
  });

  app.get('/api/health', async () => {
    await sql`select 1`;
    return { ok: true, time: new Date().toISOString() };
  });

  registerAuth(app, ctx);
  registerDemoRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerDashboardRoutes(app, ctx);
  registerClientRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerWorkerRoutes(app, ctx);
  registerDuplicateRoutes(app, ctx);
  registerRecurringRoutes(app, ctx);
  registerCostRoutes(app, ctx);
  registerDocumentRoutes(app, ctx);
  registerMonthlyRoutes(app, ctx);
  registerVatRoutes(app, ctx);
  registerPayrollRoutes(app, ctx);
  registerPartnerRoutes(app, ctx);
  registerFeedbackRoutes(app, ctx);
  registerNoticeRoutes(app, ctx);
  registerMarketRoutes(app, ctx);
  registerReportRoutes(app, ctx);
  registerImportRoutes(app, ctx);
  registerYearEndRoutes(app, ctx);
  registerArchiveRoutes(app, ctx);
  registerTaxFormRoutes(app, ctx);
  registerBillRoutes(app, ctx);
  registerLogbookRoutes(app, ctx);
  registerTimeRoutes(app, ctx);
  registerAccountantExportRoutes(app, ctx);
  registerMoveInRoutes(app, ctx);
  registerWipeRoutes(app, ctx);
  registerLiveRoutes(app, ctx, bus);
  registerBankRoutes(app, ctx);
  registerSystemRoutes(app, ctx);
  registerAuditRoutes(app, ctx);
  registerStatementRoutes(app, ctx);
  registerCompanyFileRoutes(app, ctx);

  // Production: serve the built web app and fall back to index.html for client-side routes.
  if (config.WEB_DIST && existsSync(join(config.WEB_DIST, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: config.WEB_DIST,
      cacheControl: false,
      // The app shell is always checked for a newer version; the hashed files never change.
      setHeaders: (res, path) => {
        if (/[\\/]assets[\\/]/.test(path)) res.header('cache-control', 'public, max-age=31536000, immutable');
        else res.header('cache-control', 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Not found', code: 'not_found' });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Not found', code: 'not_found' }));
  }

  return { app, ctx, routes };
}
