/**
 * Shap Pocket has no server: the routes run inside the app, on the phone. This is the small
 * part of a web framework they need: register routes, match a request to one, run it, and
 * turn what it returns (or throws) into a reply. The route modules are the same ones Shap's
 * server uses, so the method names and shapes follow Fastify's.
 */
import type { AuthUser } from './auth.js';
import { HttpError } from './lib/errors.js';

export interface Req {
  method: string;
  url: string;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: unknown;
  headers: Record<string, string | undefined>;
  ip: string;
  cookies: Record<string, string | undefined>;
  user: AuthUser | null;
  log: Logger;
}

export interface Logger {
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

export type Handler = (req: Req, reply: Reply) => unknown;
export interface RouteOptions {
  preHandler?: Handler | Handler[];
  bodyLimit?: number;
  config?: unknown;
}

export class Reply {
  statusCode = 200;
  sent = false;
  payload: unknown = undefined;
  readonly headers: Record<string, string> = {};
  code(n: number) {
    this.statusCode = n;
    return this;
  }
  status(n: number) {
    return this.code(n);
  }
  header(k: string, v: string | number) {
    this.headers[k.toLowerCase()] = String(v);
    return this;
  }
  getHeader(k: string) {
    return this.headers[k.toLowerCase()];
  }
  type(t: string) {
    return this.header('content-type', t);
  }
  send(payload?: unknown) {
    this.payload = payload;
    this.sent = true;
    return this;
  }
}

/** What a route answered: JSON-ready data, text, or bytes (a PDF, a photo, a spreadsheet). */
export interface Response {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
  pre: Handler[];
}

const consoleLog: Logger = { info: () => {}, warn: (...a) => console.warn(...a), error: (...a) => console.error(...a) };

export class App {
  private routes: Route[] = [];
  private onRequest: Handler[] = [];
  readonly log: Logger;
  /** Who is using the app: there's one person, the owner. Set when the app starts. */
  user: AuthUser | null = null;

  constructor(log: Logger = consoleLog) {
    this.log = log;
  }

  private add(method: string, path: string, a: RouteOptions | Handler, b?: Handler) {
    const opts = typeof a === 'function' ? {} : a;
    const handler = (typeof a === 'function' ? a : b)!;
    const pre = opts.preHandler ? (Array.isArray(opts.preHandler) ? opts.preHandler : [opts.preHandler]) : [];
    this.routes.push({ method, parts: path.split('/').filter(Boolean), handler, pre });
  }
  get(path: string, a: RouteOptions | Handler, b?: Handler) {
    this.add('GET', path, a, b);
  }
  post(path: string, a: RouteOptions | Handler, b?: Handler) {
    this.add('POST', path, a, b);
  }
  put(path: string, a: RouteOptions | Handler, b?: Handler) {
    this.add('PUT', path, a, b);
  }
  delete(path: string, a: RouteOptions | Handler, b?: Handler) {
    this.add('DELETE', path, a, b);
  }
  patch(path: string, a: RouteOptions | Handler, b?: Handler) {
    this.add('PATCH', path, a, b);
  }
  addHook(name: 'onRequest' | 'preHandler', fn: Handler) {
    if (name === 'onRequest' || name === 'preHandler') this.onRequest.push(fn);
  }
  /** Every route, for checks that each one behaves. */
  list() {
    return this.routes.map((r) => ({ method: r.method, path: '/' + r.parts.join('/') }));
  }

  private match(method: string, path: string) {
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    for (const r of this.routes) {
      if (r.method !== method || r.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const want = r.parts[i]!;
        if (want.startsWith(':')) params[want.slice(1)] = parts[i]!;
        else if (want !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { route: r, params };
    }
    return null;
  }

  async handle(method: string, url: string, body?: unknown, headers: Record<string, string | undefined> = {}): Promise<Response> {
    const u = new URL(url, 'http://pocket');
    // The query as an object with no prototype: a parameter called __proto__ or constructor is
    // just a name, never a way into the object itself.
    const query: Record<string, string> = Object.create(null) as Record<string, string>;
    u.searchParams.forEach((v, k) => {
      if (k !== '__proto__' && k !== 'constructor' && k !== 'prototype') query[k] = v;
    });
    const reply = new Reply();
    const req: Req = { method, url: u.pathname + u.search, params: {}, query, body: body ?? null, headers, ip: 'device', cookies: {}, user: this.user, log: this.log };
    try {
      const found = this.match(method, u.pathname);
      if (!found) throw new HttpError(404, 'Not found', 'not_found');
      req.params = found.params;
      for (const h of [...this.onRequest, ...found.route.pre]) {
        await h(req, reply);
        if (reply.sent) return done(reply);
      }
      const out = await found.route.handler(req, reply);
      if (!reply.sent) reply.send(out === undefined ? null : out);
    } catch (err) {
      errorReply(err, reply, this.log);
    }
    return done(reply);
  }

  /** The same call shape as Fastify's inject, for the tests. */
  async inject(o: { method?: string; url: string; payload?: unknown; headers?: Record<string, string> }) {
    const r = await this.handle(o.method ?? 'GET', o.url, o.payload, o.headers);
    const bytes = r.body instanceof Uint8Array ? r.body : null;
    const text = bytes ? new TextDecoder().decode(bytes) : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return {
      statusCode: r.status,
      headers: r.headers,
      body: text,
      rawPayload: bytes ?? new TextEncoder().encode(text),
      json: () => JSON.parse(text),
      cookies: [] as { name: string; value: string }[],
    };
  }

  async close() {}
  async ready() {}
}

function done(reply: Reply): Response {
  const p = reply.payload;
  const isBytes = p instanceof Uint8Array;
  if (!reply.headers['content-type']) reply.headers['content-type'] = isBytes ? 'application/octet-stream' : typeof p === 'string' ? 'text/plain; charset=utf-8' : 'application/json';
  return { status: reply.statusCode, headers: reply.headers, body: p ?? null };
}

function errorReply(err: unknown, reply: Reply, log: Logger) {
  const e = err as Error & { statusCode?: number; code?: string };
  reply.payload = undefined;
  delete reply.headers['content-type'];
  if (err instanceof HttpError) {
    reply.code(err.statusCode).send({ error: err.message, code: err.code, details: err.details });
    return;
  }
  if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
    reply.code(e.statusCode).send({ error: e.message, code: e.code ?? 'bad_request' });
    return;
  }
  // A rule the books keep themselves (migrations raise these with code SH001), said as it is.
  if (e.code === 'SH001') {
    reply.code(400).send({ error: e.message, code: 'books_rule' });
    return;
  }
  // A value the database can't take (a date like 2026-99-99, a number out of range, a malformed
  // id): the request is wrong, said plainly, without the database's words.
  if (/^22/.test(String(e.code ?? ''))) {
    reply.code(400).send({ error: 'Something in that request isn’t valid (a date, number or id out of range).', code: 'invalid_value' });
    return;
  }
  // Something chosen that isn't there (deleted meanwhile).
  if (e.code === '23503') {
    reply.code(400).send({ error: 'Something you chose isn’t there any more. Go back and try again.', code: 'missing' });
    return;
  }
  // Database rule broken (e.g. an unbalanced journal): say so plainly.
  if (/does not balance/.test(e.message ?? '')) {
    reply.code(400).send({ error: e.message, code: 'unbalanced' });
    return;
  }
  log.error('unhandled error', err);
  reply.code(500).send({ error: 'Something went wrong. Please try again.', code: 'internal' });
}
