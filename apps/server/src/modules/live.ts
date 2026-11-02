import type { FastifyInstance } from 'fastify';
import { requireRole } from '../auth.js';
import type { Ctx } from '../context.js';
import { DEMO_COOKIE } from './demo.js';
import type { LiveBus } from '../lib/live.js';

/**
 * Several people in Shap at once: each open screen keeps one quiet connection here and hears
 * "something changed" when someone else saves, then refetches what it shows. Events carry no
 * data, so nothing reaches a screen that shouldn't see it.
 */
export function registerLiveRoutes(app: FastifyInstance, ctx: Ctx, bus: LiveBus): void {
  app.get('/api/live', { preHandler: requireRole() }, (req, reply) => {
    const demo = req.cookies?.[DEMO_COOKIE] === '1';
    const me = req.user?.id ?? null;
    reply.hijack();
    const res = reply.raw;
    const origin = req.headers.origin;
    const cors: Record<string, string> =
      origin && ctx.config.corsOrigins.includes(origin) ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' } : {};
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...cors,
    });
    res.write('retry: 3000\n\n');
    res.write('event: hello\ndata: {}\n\n');
    const unsubscribe = bus.subscribe((e) => {
      if (e.demo !== demo || e.by === me) return;
      res.write(`event: changed\ndata: ${JSON.stringify({ type: 'changed', at: e.at })}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
