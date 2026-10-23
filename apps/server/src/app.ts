import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth } from './auth.js';
import type { Config } from './config.js';
import type { Ctx } from './context.js';
import type { Sql } from './db/index.js';
import { Secrets } from './lib/crypto.js';
import { HttpError } from './lib/errors.js';
import { createMailer, type Mailer } from './lib/mailer.js';
import { registerClientRoutes } from './modules/clients.js';
import { registerCostRoutes } from './modules/costs.js';
import { registerDuplicateRoutes } from './modules/duplicates.js';
import { registerRecurringRoutes } from './modules/recurring.js';
import { registerDashboardRoutes } from './modules/dashboard.js';
import { registerDocumentRoutes } from './modules/documents.js';
import { registerImportRoutes } from './modules/import/routes.js';
import { registerProjectRoutes } from './modules/projects.js';
import { registerReportRoutes } from './modules/reports.js';
import { registerSettingsRoutes } from './modules/settings.js';
import { registerWorkerRoutes } from './modules/workers.js';
import { registerYearEndRoutes } from './modules/yearend.js';
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

export async function buildApp(opts: BuildOptions): Promise<{ app: FastifyInstance; ctx: Ctx }> {
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

  const realMailer = opts.mailer ?? createMailer(config.SMTP_URL, config.MAIL_FROM, app.log);
  const ctx: Ctx = {
    config,
    sql,
    dbs: { real: opts.sql, demo: opts.demoSql ?? null },
    // The demo company's clients are made up: nothing is ever emailed from it.
    mailer: { send: async (m) => (inDemo() ? void app.log.info({ to: m.to }, 'demo company: email not sent') : realMailer.send(m)) },
    secrets: new Secrets(config.secretsKey),
  };

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
    if (!req.url.startsWith('/api/') || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const theirs = req.headers['x-shap-version'];
    // Shap's own pages always send their version; a form or script on another site can't add that
    // header (browsers only allow it from Shap's own address), so a change without it is refused.
    // This is what stops another site from acting with your session. The phone app uses a token.
    const oldPage = theirs === undefined && !req.headers.authorization;
    if (oldPage || (typeof theirs === 'string' && theirs !== version && req.headers['x-shap-client'] !== 'native')) {
      return reply.code(409).send({ error: 'Shap was updated while this page was open. Reload the page, then try again.', code: 'stale_client' });
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/')) reply.header('x-shap-version', version);
    // The app's pages: only Shap's own scripts, styles and images; never inside another site's frame.
    else if (!reply.getHeader('content-security-policy')) reply.header('content-security-policy', CSP);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('x-frame-options', 'SAMEORIGIN');
    if (req.url.startsWith('/api/') && !reply.getHeader('cache-control')) reply.header('cache-control', 'no-store');
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
    // Database rule broken (e.g. an unbalanced journal): say so plainly.
    const msg = err.message ?? '';
    if (/does not balance/.test(msg)) return reply.code(400).send({ error: msg, code: 'unbalanced' });
    req.log.error({ err }, 'unhandled error');
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
  registerReportRoutes(app, ctx);
  registerImportRoutes(app, ctx);
  registerYearEndRoutes(app, ctx);
  registerBankRoutes(app, ctx);
  registerSystemRoutes(app, ctx);
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

  return { app, ctx };
}
