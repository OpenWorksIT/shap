/**
 * OpenWorks' notices to every copy of Shap (shared/notice.ts): read from Shap's public repository
 * twice a day and shown at the top of the app. Nothing about this Shap is sent: it's a plain
 * download of one small public file. If it can't be reached, the last one read stands.
 */
import type { FastifyInstance } from 'fastify';
import { noticesFor, type Notice } from '@shap/shared';
import { requireRole } from '../auth.js';
import type { Ctx } from '../context.js';
import { today } from '../lib/books.js';
import { appVersion } from './system.js';

const EVERY_MS = 12 * 3_600_000;

export function registerNoticeRoutes(app: FastifyInstance, ctx: Ctx): void {
  const url = ctx.config.NOTICE_URL;
  let file: unknown = null;
  let readAt = 0;
  const read = async () => {
    if (!url || !/^https:\/\//.test(url)) return;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
      if (!r.ok) return;
      const text = await r.text();
      if (text.length > 64 * 1024) return;
      file = JSON.parse(text);
      readAt = Date.now();
    } catch {
      /* offline, or not there: keep what we had */
    }
  };
  if (ctx.config.NODE_ENV !== 'test') {
    void read();
    const t = setInterval(() => void read(), EVERY_MS);
    t.unref();
    app.addHook('onClose', async () => clearInterval(t));
  }

  app.get('/api/notice', { preHandler: requireRole() }, async (): Promise<{ notices: Notice[]; readAt: string | null }> => ({
    notices: noticesFor(file, 'shap', appVersion(), today()),
    readAt: readAt ? new Date(readAt).toISOString() : null,
  }));
}
