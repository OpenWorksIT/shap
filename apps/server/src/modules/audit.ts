/**
 * The audits, for Settings → Updates & backups: the books audit (audit/books.ts), run when it's
 * asked for, and the server's own security and privacy check (deploy/vps/audit-server.sh), which
 * runs every 6 hours on the server and leaves its results where the app can read them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { can, requireAccess, requireRole, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import { auditBooks, tally } from '../audit/books.js';

export function registerAuditRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;

  app.get('/api/audit/books', { preHandler: requireAccess('reports.view') }, async (req) => {
    const items = await auditBooks(sql, undefined, { people: can(userOrThrow(req), 'payroll.view') });
    return { at: new Date().toISOString(), ...tally(items), items };
  });

  /** The server check's last results, if this server runs it (a VPS set up with deploy/vps). */
  app.get('/api/audit/server', { preHandler: requireRole('owner') }, async () => {
    try {
      const r = JSON.parse(readFileSync(join(ctx.config.CTL_DIR, 'audit.json'), 'utf8')) as Record<string, unknown>;
      return { available: true, ...r };
    } catch {
      return { available: false };
    }
  });
}
