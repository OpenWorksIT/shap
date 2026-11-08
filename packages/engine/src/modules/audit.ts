/**
 * The books audit (audit/books.ts), for Settings → Backup & checks: what an accountant would
 * check, run on the books on this device when it's asked for.
 */
import type { App as FastifyInstance } from '../http.js';
import { requireRole } from '../auth.js';
import type { Ctx } from '../context.js';
import { auditBooks, tally } from '../audit/books.js';

export function registerAuditRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;
  app.get('/api/audit/books', { preHandler: requireRole('owner', 'accountant') }, async () => {
    const items = await auditBooks(sql);
    return { at: new Date().toISOString(), ...tally(items), items };
  });
}
