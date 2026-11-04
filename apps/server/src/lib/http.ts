import type { FastifyRequest } from 'fastify';

/**
 * The route a request actually matched, for security decisions. find-my-way percent-decodes the
 * path to route it, but req.url keeps the encoding, so a raw `req.url.startsWith('/api/...')`
 * check is bypassable: `/api/%73ystem` reaches the `/api/system` handler while `req.url` is still
 * `"/api/%73ystem"`. `routeOptions.url` is the registered pattern (e.g. `/api/feedback/:id`), set
 * once routing has run — before the onRequest hooks. A decoded path is the fallback if it's absent
 * (e.g. an unmatched route on its way to the 404 handler).
 */
export function routePath(req: FastifyRequest): string {
  const r = req.routeOptions?.url;
  if (r) return r;
  const raw = req.url.split('?')[0] ?? '/';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
