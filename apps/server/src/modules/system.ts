/**
 * Settings → System: which version is running, updates from GitHub, and backups.
 * The work is done on the server by deploy/vps/ctl/shap-ctl.sh (as root, outside the app):
 * the app only leaves it a request and reads back its status. The app never holds Docker
 * or root, so a compromised session can at most ask for an update or a backup.
 */
import type { FastifyInstance } from 'fastify';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { confirmPassword, requireRole, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import rootPackage from '../../../../package.json';

/**
 * The running version: the root package.json's, built into the server (the build inlines it),
 * so it's always the version of the code that runs, and never read from a file at run time.
 */
export function appVersion(): string {
  return (rootPackage as { version?: string }).version ?? '0.0.0';
}

const BACKUP_NAME = /^[a-z0-9_]+-(daily|manual|pre-update)-\d{4}-\d{2}-\d{2}_\d{4}\.dump$/;

export function registerSystemRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { CTL_DIR, REQUEST_DIR, BACKUP_DIR, GIT_SHA } = ctx.config;
  const owner = { preHandler: requireRole('owner') };
  const version = appVersion();

  // Only this company's own backups are visible and downloadable here. shap-ctl writes every
  // database on the box into one shared dir (shap-*, and shap_<tenant>-* for each extra company);
  // without this scope the main company's owner could list and download other tenants' full
  // database dumps. Database names are [a-z0-9_] only (no "-"), so the "<db>-" prefix can't match
  // another company (e.g. "shap-" never matches "shap_friend-…").
  let ownDb: string | null = null;
  const ownDbName = async (): Promise<string> => {
    if (ownDb === null) {
      const [row] = await ctx.dbs.real<{ db: string }[]>`select current_database() as db`;
      ownDb = row!.db;
    }
    return ownDb;
  };
  const ownsBackup = (name: string, db: string): boolean => name.startsWith(`${db}-`);

  const readStatus = () => {
    try {
      return JSON.parse(readFileSync(join(CTL_DIR, 'status.json'), 'utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const pending = () => {
    try {
      return readFileSync(join(REQUEST_DIR, 'request'), 'utf8').trim() || null;
    } catch {
      return null;
    }
  };

  app.get('/api/system', owner, async () => {
    const status = readStatus();
    let backups: { name: string; sizeBytes: number; at: string }[] = [];
    let pulledByPc: string | null = null;
    if (existsSync(BACKUP_DIR)) {
      try {
        const db = await ownDbName();
        const names = (await readdir(BACKUP_DIR)).filter((n) => BACKUP_NAME.test(n) && ownsBackup(n, db));
        backups = (await Promise.all(names.map(async (name) => ({ name, s: await stat(join(BACKUP_DIR, name)) }))))
          .map(({ name, s }) => ({ name, sizeBytes: s.size, at: s.mtime.toISOString() }))
          .sort((a, b) => b.at.localeCompare(a.at));
        // The PC's copy script leaves this behind each time it fetches the backups.
        pulledByPc = (await stat(join(BACKUP_DIR, '.pulled-by-pc')).catch(() => null))?.mtime.toISOString() ?? null;
      } catch {
        /* unreadable: shown as no backups */
      }
    }
    return {
      version,
      gitSha: GIT_SHA || null,
      // Set up when shap-ctl has written its status (see deploy/vps/ctl/install.sh).
      managed: status != null,
      status,
      pending: pending(),
      backups,
      pulledByPc,
    };
  });

  app.post('/api/system/request', owner, async (req) => {
    const user = userOrThrow(req);
    const { action } = parse(z.object({ action: z.enum(['check', 'update', 'backup']) }), req.body);
    if (!readStatus()) throw badRequest('Updates and backups from here aren’t set up on this server yet (deploy/vps/ctl/install.sh).');
    try {
      await writeFile(join(REQUEST_DIR, 'request'), `${action}\n`, { mode: 0o660 });
    } catch {
      throw badRequest('Shap can’t leave the request for the server. Run deploy/vps/ctl/install.sh again.');
    }
    await audit(ctx.sql, { userId: user.id, action: `system_${action}`, entity: 'system', ip: req.ip });
    return { ok: true };
  });

  /**
   * A backup is everything: downloading one takes your password, and gives a link that works
   * for two minutes, for you only.
   */
  app.post('/api/system/backups/:name/link', { ...owner, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const user = userOrThrow(req);
    const { name } = parse(z.object({ name: z.string() }), req.params);
    if (!BACKUP_NAME.test(name) || !ownsBackup(name, await ownDbName())) throw notFound('Backup');
    await confirmPassword(ctx.dbs.real, user.id, parse(z.object({ password: z.string().max(200).optional() }), req.body ?? {}).password, req.ip);
    const t = ctx.secrets.signToken('backup-download', { name, uid: user.id }, 120);
    return { url: `/api/system/backups/${encodeURIComponent(name)}?t=${encodeURIComponent(t)}` };
  });

  app.get('/api/system/backups/:name', owner, async (req, reply) => {
    const { name } = parse(z.object({ name: z.string() }), req.params);
    if (!BACKUP_NAME.test(name) || !ownsBackup(name, await ownDbName())) throw notFound('Backup');
    const { t } = parse(z.object({ t: z.string().max(2000).default('') }), req.query);
    const link = ctx.secrets.verifyToken<{ name: string; uid: string }>('backup-download', t);
    if (!link || link.name !== name || link.uid !== req.user?.id) throw badRequest('That download link has expired. Choose the backup again.');
    const path = join(BACKUP_DIR, name);
    if (!existsSync(path)) throw notFound('Backup');
    const user = userOrThrow(req);
    await audit(ctx.sql, { userId: user.id, action: 'download_backup', entity: 'system', ip: req.ip, details: { name } });
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename="${name}"`);
    return reply.send(createReadStream(path));
  });
}
