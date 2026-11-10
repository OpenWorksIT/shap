/**
 * Wipe all data (POPIA's right to erasure, or starting over): every invoice, client, cost, slip,
 * worker, payroll record and setting goes, and the books start again from the first-run
 * questions. The people who sign in (and their profiles), their sessions and two-factor codes, and the audit log are
 * kept, so the owner can still sign in and there's a record that it happened. It takes the
 * owner's password and the business's name typed out, and runs in one transaction: it all
 * happens, or nothing does.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { confirmPassword, requireRole, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Sql } from '../db/index.js';
import { migrationFiles } from '../db/migrate.js';
import { audit } from '../lib/audit.js';
import { getSettings } from '../lib/books.js';
import { badRequest } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { DEMO_COOKIE } from './demo.js';

/** What to type to confirm: any of the business's names (or WIPE when it has none yet). */
export async function wipeNames(db: Sql): Promise<string[]> {
  const s = await getSettings(db);
  const brands = await db<{ name: string }[]>`select name from brands`;
  const names = [s.companyName, s.tradingName, ...brands.map((b) => b.name)].map((n) => (n ?? '').trim()).filter(Boolean);
  return names.length ? [...new Set(names)] : ['WIPE'];
}

/** Kept, in this order: the profiles before the people on them. */
const KEEP = ['profiles', 'users', 'sessions', 'recovery_codes', 'audit_log'] as const;

export async function wipeBooks(db: Sql): Promise<void> {
  const migrations = await migrationFiles();
  await db.begin(async (tx) => {
    await tx.unsafe('drop schema if exists wipe_keep cascade; create schema wipe_keep;');
    for (const t of KEEP) await tx.unsafe(`create table wipe_keep.${t} as table public.${t}`);
    await tx.unsafe('drop schema public cascade; create schema public;');
    await tx.unsafe('create table schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    for (const m of migrations) {
      await tx.unsafe(m.body);
      await tx`insert into schema_migrations (name) values (${m.name})`;
    }
    // (The migrations start the profiles again: the business's own replace them.)
    for (const t of KEEP) await tx.unsafe(`delete from public.${t}; insert into public.${t} select * from wipe_keep.${t}`);
    await tx.unsafe(`select setval(pg_get_serial_sequence('audit_log', 'id'), coalesce((select max(id) from audit_log), 1))`);
    await tx.unsafe('drop schema wipe_keep cascade');
  });
}

export function registerWipeRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/wipe', { preHandler: requireRole('owner') }, async () => ({ names: await wipeNames(ctx.dbs.real) }));

  app.post('/api/wipe', { preHandler: requireRole('owner'), config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req) => {
    const user = userOrThrow(req);
    if (req.cookies?.[DEMO_COOKIE] === '1') throw badRequest('Leave the demo company first: wiping is for your own books.');
    const { password, name } = parse(z.object({ password: z.string().max(200).optional(), name: z.string().max(200).default('') }), req.body);
    const db = ctx.dbs.real;
    await confirmPassword(db, user.id, password, req.ip);
    const names = await wipeNames(db);
    if (!names.some((n) => n.toLowerCase() === name.trim().toLowerCase())) throw badRequest(`Type the business’s name exactly (${names[0]}) to confirm`);
    await wipeBooks(db);
    await audit(db, { userId: user.id, action: 'wipe_all_data', entity: 'books', ip: req.ip });
    return { ok: true };
  });
}
