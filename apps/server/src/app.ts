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
import { registerDashboardRoutes } from './modules/dashboard.js';
import { registerDocumentRoutes } from './modules/documents.js';
import { registerImportRoutes } from './modules/import/routes.js';
import { registerProjectRoutes } from './modules/projects.js';
import { registerReportRoutes } from './modules/reports.js';
import { registerSettingsRoutes } from './modules/settings.js';
import { registerWorkerRoutes } from './modules/workers.js';
import { registerYearEndRoutes } from './modules/yearend.js';
import { registerBankRoutes } from './modules/bank/routes.js';
import { registerSystemRoutes } from './modules/system.js';
import { registerStatementRoutes } from './modules/statements.js';
import { registerCompanyFileRoutes } from './modules/company-file.js';

export interface BuildOptions {
  config: Config;
  sql: Sql;
  logger?: boolean | object;
  mailer?: Mailer;
}

export async function buildApp(opts: BuildOptions): Promise<{ app: FastifyInstance; ctx: Ctx }> {
  const { config, sql } = opts;
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: config.TRUST_PROXY,
    // Room for a tracker spreadsheet or a receipt photo, sent as base64 JSON.
    bodyLimit: config.UPLOAD_MB * 1024 * 1024 * 1.4,
  });

  const ctx: Ctx = {
    config,
    sql,
    mailer: opts.mailer ?? createMailer(config.SMTP_URL, config.MAIL_FROM, app.log),
    secrets: new Secrets(config.secretsKey),
  };

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  // CORS only for explicitly configured origins (e.g. a future Capacitor app).
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('access-control-allow-credentials', 'true');
      reply.header('vary', 'Origin');
      if (req.method === 'OPTIONS') {
        reply.header('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        reply.header('access-control-allow-headers', 'content-type,authorization');
        reply.header('access-control-max-age', '600');
        return reply.code(204).send();
      }
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('x-frame-options', 'SAMEORIGIN');
    if (req.url.startsWith('/api/') && !reply.getHeader('cache-control')) reply.header('cache-control', 'no-store');
    return payload;
  });

  app.setErrorHandler((err: Error, req, reply) => {
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
  registerSettingsRoutes(app, ctx);
  registerDashboardRoutes(app, ctx);
  registerClientRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerWorkerRoutes(app, ctx);
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
