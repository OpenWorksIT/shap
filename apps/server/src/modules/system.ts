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
import { requireRole, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

/** The running version, from the root package.json (in the image, or the repo when developing). */
export function appVersion(): string {
  for (const p of [join(process.cwd(), 'package.json'), join(process.cwd(), '../../package.json')]) {
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'shap' && pkg.version) return pkg.version;
    } catch {
      /* try the next */
    }
  }
  return '0.0.0';
}

const BACKUP_NAME = /^[a-z0-9_]+-(daily|manual|pre-update)-\d{4}-\d{2}-\d{2}_\d{4}\.dump$/;

export function registerSystemRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { CTL_DIR, BACKUP_DIR, GIT_SHA } = ctx.config;
  const owner = { preHandler: requireRole('owner') };
  const version = appVersion();

  const readStatus = () => {
    try {
      return JSON.parse(readFileSync(join(CTL_DIR, 'status.json'), 'utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const pending = () => {
    try {
      return readFileSync(join(CTL_DIR, 'request'), 'utf8').trim() || null;
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
        const names = (await readdir(BACKUP_DIR)).filter((n) => BACKUP_NAME.test(n));
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
      await writeFile(join(CTL_DIR, 'request'), `${action}\n`, { mode: 0o660 });
    } catch {
      throw badRequest('Shap can’t leave the request for the server. Run deploy/vps/ctl/install.sh again.');
    }
    await audit(ctx.sql, { userId: user.id, action: `system_${action}`, entity: 'system', ip: req.ip });
    return { ok: true };
  });

  app.get('/api/system/backups/:name', owner, async (req, reply) => {
    const { name } = parse(z.object({ name: z.string() }), req.params);
    if (!BACKUP_NAME.test(name)) throw notFound('Backup');
    const path = join(BACKUP_DIR, name);
    if (!existsSync(path)) throw notFound('Backup');
    const user = userOrThrow(req);
    await audit(ctx.sql, { userId: user.id, action: 'download_backup', entity: 'system', ip: req.ip, details: { name } });
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename="${name}"`);
    return reply.send(createReadStream(path));
  });
}
