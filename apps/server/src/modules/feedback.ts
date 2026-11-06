/**
 * In-app feedback ("Love this", "Don't like this", "Bug found") from every screen, as in Sorted,
 * plus the collector that lets OpenWorks hear from Shap Pocket and from other people's Shaps.
 *
 * Reports are files, so they can be read straight off the server:
 *
 *   FEEDBACK_DIR/
 *     index.jsonl                         one line per report (newest last)
 *     2026-11-02/FB-20261102-084501-a1b2-bug/
 *       report.json                       what they said, page, time, who, device, recent steps
 *       screenshot.jpg                    bug reports only, names and amounts masked unless they chose otherwise
 *       status.json                       added when the owner marks it seen / done
 *     usage/<install id>.json             the latest anonymous usage note from each set of books
 *
 * Feedback given in this Shap is kept here (the owner reads it under Settings → Feedback) and
 * also sent on to OpenWorks (COLLECTOR_URL), who make Shap; a picture goes too only if it was
 * masked. OpenWorks' own Shap runs with COLLECT=true and receives at /collect/feedback and
 * /collect/usage: open to anyone (Pocket has no account), so words only up to a size, limited per
 * address and per day.
 */
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BUSINESS_TYPES, type BusinessType, entity } from '@shap/shared';
import { requireRole, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import { badRequest, HttpError, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { addressKey } from './market.js';
import { appVersion } from './system.js';

const MAX_SHOT_BYTES = 4 * 1024 * 1024;
/** Reports from outside (Pocket, other Shaps) per day, so the folder can't be used to fill the disk. */
const OUTSIDE_PER_DAY = 500;
/** From one address a day: enough for anyone, and no single sender can use up the day's room. */
const OUTSIDE_PER_ADDRESS = 20;
/** Screenshots from outside a day, in all: past this, reports are kept without their picture. */
const OUTSIDE_SHOT_BYTES_PER_DAY = 200 * 1024 * 1024;
/** Usage notes a day, in all (each install's is one small file it overwrites). */
const USAGE_PER_DAY = 5000;
const outside = { day: '', count: 0, usage: 0, shotBytes: 0, byAddress: new Map<string, number>() };
const ID_RE = /^FB-\d{8}-\d{6}-[0-9a-f]{4}-(love|dislike|bug|idea)$/;
/** Reports and usage notes are kept for a year (as the privacy policy says), then deleted. */
const KEEP_DAYS = 365;
const INSTALL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const feedbackInput = z.object({
  kind: z.enum(['love', 'dislike', 'bug', 'idea']),
  message: z.string().trim().max(2000).default(''),
  page: z.string().max(500),
  title: z.string().max(200).default(''),
  at: z.string().datetime({ offset: true }),
  screenshot: z.string().max(Math.ceil((MAX_SHOT_BYTES * 4) / 3) + 100).nullable().default(null),
  screenshotMasked: z.boolean().default(true),
  trail: z
    .array(z.object({ t: z.number(), kind: z.enum(['nav', 'click', 'edit', 'api', 'error', 'console']), detail: z.string().max(300) }))
    .max(80)
    .default([]),
  client: z
    .object({
      userAgent: z.string().max(300).default(''),
      viewport: z.string().max(40).default(''),
      scrollY: z.number().int().default(0),
      standalone: z.boolean().default(false),
      online: z.boolean().default(true),
      build: z.string().max(80).default(''),
    })
    .default({}),
});
/** From outside: which app, which version, and (for another Shap) the role of whoever wrote it. */
const collectedInput = feedbackInput.extend({
  app: z.enum(['pocket', 'shap']),
  version: z.string().max(40).default(''),
  platform: z.string().max(20).default(''),
  role: z.string().max(20).default(''),
});

const usageInput = z.object({
  app: z.enum(['pocket', 'shap']),
  version: z.string().max(40).default(''),
  installId: z.string().regex(INSTALL_RE),
  platform: z.string().max(20).default(''),
  businessType: z.enum(BUSINESS_TYPES),
  industry: z.string().max(40).default(''),
  features: z.array(z.string().max(30)).max(20).default([]),
  vatRegistered: z.boolean().default(false),
  tone: z.enum(['casual', 'formal']).default('casual'),
});
export type UsageNote = Omit<z.infer<typeof usageInput>, 'installId'>;
/** A usage note's file name: a keyed hash of the install id, so the id itself isn't kept. */
const usageFile = (ctx: Ctx, installId: string) => ctx.secrets.hash(`usage|${installId}`).slice(0, 32);

export interface FeedbackSummary {
  id: string;
  kind: 'love' | 'dislike' | 'bug' | 'idea';
  at: string;
  receivedAt: string;
  page: string;
  message: string;
  who: string;
  source: 'here' | 'pocket' | 'shap';
  hasScreenshot: boolean;
  status?: 'new' | 'seen' | 'done';
  note?: string;
}

/** Decodes a data: URL and checks it really is a JPEG or PNG. */
function decodeImage(dataUrl: string): { bytes: Buffer; ext: 'jpg' | 'png' } {
  const m = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw badRequest('Screenshot must be a JPEG or PNG image');
  const bytes = Buffer.from(m[2]!, 'base64');
  if (bytes.length > MAX_SHOT_BYTES) throw badRequest('Screenshot is too large');
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!jpeg && !png) throw badRequest('Screenshot is not a valid image');
  return { bytes, ext: png ? 'png' : 'jpg' };
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/** Sends to OpenWorks' collector, quietly: feedback and usage notes are never worth an error. */
async function forward(url: string, path: 'feedback' | 'usage', body: unknown, log: { warn: (o: object, m: string) => void }) {
  if (!url || url === 'off') return;
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    if (!r.ok) log.warn({ status: r.status, path }, 'collector refused');
  } catch (err) {
    log.warn({ err: (err as Error).message, path }, 'collector unreachable');
  }
}

export function registerFeedbackRoutes(app: FastifyInstance, ctx: Ctx): void {
  const dir = resolve(ctx.config.FEEDBACK_DIR);
  const indexFile = join(dir, 'index.jsonl');
  const usageDir = join(dir, 'usage');
  const folderOf = (id: string) => join(dir, `${id.slice(3, 7)}-${id.slice(7, 9)}-${id.slice(9, 11)}`, id);
  const owner = requireRole('owner');

  type Input = z.infer<typeof feedbackInput>;
  const store = async (input: Input, who: Record<string, unknown>, whoText: string, source: FeedbackSummary['source'], ip: string, extra: Record<string, unknown> = {}) => {
    const shot = input.kind === 'bug' && input.screenshot ? decodeImage(input.screenshot) : null;
    const now = new Date();
    const id = `FB-${stamp(now)}-${randomBytes(2).toString('hex')}-${input.kind}`;
    const folder = folderOf(id);
    const report = {
      id,
      kind: input.kind,
      message: input.message,
      page: input.page,
      title: input.title,
      pressedAt: input.at,
      receivedAt: now.toISOString(),
      source,
      who,
      ...extra,
      // Anonymous feedback from outside keeps no address (it's only used for the day's limits).
      client: source === 'here' ? { ...input.client, ip } : { ...input.client },
      screenshot: shot ? { file: `screenshot.${shot.ext}`, detailsMasked: input.screenshotMasked } : null,
      trail: input.trail.map((e) => ({ at: new Date(e.t).toISOString(), kind: e.kind, detail: e.detail })),
    };
    await mkdir(folder, { recursive: true, mode: 0o750 });
    if (shot) await writeFile(join(folder, `screenshot.${shot.ext}`), shot.bytes, { mode: 0o640 });
    await writeFile(join(folder, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o640 });
    const summary: FeedbackSummary = { id, kind: input.kind, at: input.at, receivedAt: report.receivedAt, page: input.page, message: input.message.slice(0, 300), who: whoText, source, hasScreenshot: Boolean(shot) };
    await appendFile(indexFile, `${JSON.stringify(summary)}\n`, { mode: 0o640 });
    return id;
  };

  // Feedback from someone signed in to this Shap.
  app.post('/api/feedback', { preHandler: requireRole(), bodyLimit: 8 * 1024 * 1024, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const user = userOrThrow(req);
    const input = parse(feedbackInput, req.body);
    if (input.kind !== 'love' && !input.message) throw badRequest('Please say a few words about it');
    const id = await store(input, { id: user.id, name: user.name, role: user.role }, `${user.name} (${user.role})`, 'here', req.ip);
    req.log.info({ feedback: id }, 'feedback received');
    // On to OpenWorks, who make Shap (not from OpenWorks' own Shap: it is the collector).
    if (!ctx.config.COLLECT) {
      void forward(ctx.config.COLLECTOR_URL, 'feedback', { ...input, screenshot: input.screenshotMasked ? input.screenshot : null, app: 'shap', version: appVersion(), role: user.role }, req.log);
    }
    reply.code(201);
    return { id };
  });

  // ---------------------------------------------------------------- the collector (COLLECT=true)
  if (ctx.config.COLLECT) {
    const open = (reply: FastifyReply) => {
      // Anyone may send (Pocket has no account): no cookies are read or set here.
      reply.header('access-control-allow-origin', '*');
      reply.header('access-control-allow-methods', 'POST, OPTIONS');
      reply.header('access-control-allow-headers', 'content-type');
      reply.header('access-control-max-age', '86400');
    };
    const tooMany = () => new HttpError(429, 'Thanks: we’ve had a lot of feedback today. Please try again tomorrow.', 'rate_limited');
    const today = () => {
      const day = new Date().toISOString().slice(0, 10);
      if (outside.day !== day) Object.assign(outside, { day, count: 0, usage: 0, shotBytes: 0, byAddress: new Map() });
    };
    // Checked before a report is read, counted only once it's kept: requests that fail validation
    // don't use up the day's room, and one address can't take all of it.
    const roomFor = (ip: string) => {
      today();
      if (outside.count >= OUTSIDE_PER_DAY || (outside.byAddress.get(ip) ?? 0) >= OUTSIDE_PER_ADDRESS) throw tooMany();
    };
    const counted = (ip: string) => {
      outside.count++;
      outside.byAddress.set(ip, (outside.byAddress.get(ip) ?? 0) + 1);
    };
    app.options('/collect/*', async (_req, reply) => (open(reply), reply.code(204).send()));

    // Nothing about who sent it goes in the request log either.
    app.post('/collect/feedback', { bodyLimit: 6 * 1024 * 1024, logLevel: 'warn', config: { rateLimit: { max: 10, timeWindow: '10 minutes', keyGenerator: (req: FastifyRequest) => addressKey(req.ip) } } }, async (req, reply) => {
      open(reply);
      roomFor(addressKey(req.ip));
      const input = parse(collectedInput, req.body);
      if (input.kind !== 'love' && !input.message) throw badRequest('Please say a few words about it');
      // A day's screenshots have a ceiling in all, so the folder can't be used to fill the disk.
      const shotBytes = input.kind === 'bug' && input.screenshot ? Math.floor((input.screenshot.length * 3) / 4) : 0;
      if (shotBytes && outside.shotBytes + shotBytes > OUTSIDE_SHOT_BYTES_PER_DAY) input.screenshot = null;
      else outside.shotBytes += shotBytes;
      const label = input.app === 'pocket' ? `Shap Pocket ${input.version} (${input.platform || 'phone'})` : `another Shap ${input.version}${input.role ? `, ${input.role}` : ''}`;
      const id = await store(input, { anonymous: true, app: input.app, version: input.version, platform: input.platform, role: input.role }, label, input.app, req.ip);
      counted(addressKey(req.ip));
      req.log.info({ feedback: id, from: input.app }, 'feedback collected');
      reply.code(201);
      return { id };
    });

    app.post('/collect/usage', { bodyLimit: 16 * 1024, logLevel: 'warn', config: { rateLimit: { max: 20, timeWindow: '10 minutes', keyGenerator: (req: FastifyRequest) => addressKey(req.ip) } } }, async (req, reply) => {
      open(reply);
      // Usage notes have their own room for the day, so they don't use up the room for feedback.
      today();
      if (outside.usage >= USAGE_PER_DAY) throw tooMany();
      const input = parse(usageInput, req.body);
      outside.usage++;
      await mkdir(usageDir, { recursive: true, mode: 0o750 });
      // One note per install (the latest), filed under a keyed hash of its id rather than the id itself.
      const { installId, ...note } = input;
      await writeFile(join(usageDir, `${usageFile(ctx, installId)}.json`), JSON.stringify({ ...note, at: new Date().toISOString() }), { mode: 0o640 });
      reply.code(201);
      return { ok: true };
    });
  }

  // ---------------------------------------------------------------- the owner's inbox
  const readIndex = async (): Promise<FeedbackSummary[]> => {
    let text = '';
    try {
      text = await readFile(indexFile, 'utf8');
    } catch {
      return [];
    }
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as FeedbackSummary;
        } catch {
          return null;
        }
      })
      .filter((x): x is FeedbackSummary => Boolean(x && ID_RE.test(x.id)));
  };
  const readStatus = async (id: string): Promise<{ status: 'new' | 'seen' | 'done'; note: string }> => {
    try {
      return JSON.parse(await readFile(join(folderOf(id), 'status.json'), 'utf8'));
    } catch {
      return { status: 'new', note: '' };
    }
  };
  const idParam = z.object({ id: z.string().regex(ID_RE) });

  /** Deletes reports older than a year, and usage notes not updated for a year. */
  const prune = async (now = Date.now()) => {
    const cutoff = now - KEEP_DAYS * 86_400_000;
    const items = await readIndex();
    const old = items.filter((x) => Date.parse(x.receivedAt) < cutoff);
    if (old.length) {
      for (const x of old) await rm(folderOf(x.id), { recursive: true, force: true });
      const keep = items.filter((x) => !old.includes(x));
      await writeFile(`${indexFile}.tmp`, keep.map((x) => `${JSON.stringify(x)}\n`).join(''), { mode: 0o640 });
      await rename(`${indexFile}.tmp`, indexFile);
    }
    let notes: string[] = [];
    try {
      notes = (await readdir(usageDir)).filter((f) => f.endsWith('.json'));
    } catch {
      /* none yet */
    }
    for (const f of notes) {
      try {
        const n = JSON.parse(await readFile(join(usageDir, f), 'utf8')) as { at?: string; installId?: string };
        if (!n.at || Date.parse(n.at) < cutoff) await rm(join(usageDir, f), { force: true });
        else if (n.installId) {
          // Kept by an earlier version under the install id itself: file it under the hash instead.
          const { installId, ...kept } = n;
          // (A newer note already filed under the hash wins: 'wx' won't overwrite it.)
          await writeFile(join(usageDir, `${usageFile(ctx, installId)}.json`), JSON.stringify(kept), { mode: 0o640, flag: 'wx' }).catch(() => undefined);
          await rm(join(usageDir, f), { force: true });
        }
      } catch {
        await rm(join(usageDir, f), { force: true });
      }
    }
    return old.length;
  };
  const tidy = () => void prune().catch((err: Error) => app.log.warn({ err: err.message }, 'feedback tidy-up failed'));
  setTimeout(tidy, 60_000).unref();
  setInterval(tidy, 86_400_000).unref();
  // Tests reach the tidy-up through the app.
  app.decorate('pruneFeedback', prune);

  app.get('/api/feedback', { preHandler: owner }, async (req) => {
    const { status } = parse(z.object({ status: z.enum(['open', 'done', 'all']).default('open') }), req.query);
    const items = (await readIndex()).reverse().slice(0, 500);
    const withStatus = await Promise.all(items.map(async (i) => ({ ...i, source: i.source ?? 'here', ...(await readStatus(i.id)) })));
    return withStatus.filter((i) => status === 'all' || (status === 'done' ? i.status === 'done' : i.status !== 'done'));
  });

  app.get('/api/feedback/:id', { preHandler: owner }, async (req) => {
    const { id } = parse(idParam, req.params);
    try {
      const report = JSON.parse(await readFile(join(folderOf(id), 'report.json'), 'utf8'));
      return { ...report, ...(await readStatus(id)) };
    } catch {
      throw notFound('Feedback');
    }
  });

  app.get('/api/feedback/:id/screenshot', { preHandler: owner }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    for (const ext of ['jpg', 'png'] as const) {
      try {
        const bytes = await readFile(join(folderOf(id), `screenshot.${ext}`));
        reply.header('cache-control', 'private, no-store');
        return reply.type(ext === 'png' ? 'image/png' : 'image/jpeg').send(bytes);
      } catch {
        /* try the other type */
      }
    }
    throw notFound('Screenshot');
  });

  app.patch('/api/feedback/:id', { preHandler: owner }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ status: z.enum(['new', 'seen', 'done']), note: z.string().trim().max(1000).default('') }), req.body);
    const folder = folderOf(id);
    try {
      await readFile(join(folder, 'report.json'));
    } catch {
      throw notFound('Feedback');
    }
    await writeFile(join(folder, 'status.json'), JSON.stringify({ ...body, by: user.name, at: new Date().toISOString() }, null, 2), { mode: 0o640 });
    return { ok: true };
  });

  /** Who uses Shap for what: the anonymous notes, counted (the collector only). */
  app.get('/api/feedback/usage', { preHandler: owner }, async () => {
    let files: string[] = [];
    try {
      files = (await readdir(usageDir)).filter((f) => f.endsWith('.json'));
    } catch {
      return { collecting: ctx.config.COLLECT, total: 0, byIndustry: [], byApp: [], byFeature: [], byType: [] };
    }
    const notes = (await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(usageDir, f), 'utf8')) as UsageNote))).filter(Boolean);
    const count = (key: (n: UsageNote) => string[]) => {
      const m = new Map<string, number>();
      for (const n of notes) for (const k of key(n)) m.set(k, (m.get(k) ?? 0) + 1);
      return [...m].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
    };
    return {
      collecting: ctx.config.COLLECT,
      total: notes.length,
      byIndustry: count((n) => [n.industry || 'not said']),
      byApp: count((n) => [`${n.app}${n.platform ? ` (${n.platform})` : ''}`]),
      byType: count((n) => [entity(n.businessType).label]),
      byFeature: count((n) => n.features),
    };
  });
}

/** This Shap's own anonymous note, when its owner agreed (sent to OpenWorks, or kept if it is OpenWorks'). */
export async function reportUsage(ctx: Ctx, s: { usageConsent: boolean; installId: string; businessType: BusinessType; industry: string; features: string[]; vatRegistered: boolean; tone: 'casual' | 'formal' }, log: { warn: (o: object, m: string) => void }) {
  if (!s.usageConsent) return;
  const note = { app: 'shap' as const, version: appVersion(), installId: s.installId, platform: 'server', businessType: s.businessType, industry: s.industry, features: s.features, vatRegistered: s.vatRegistered, tone: s.tone };
  if (ctx.config.COLLECT) {
    const dir = join(resolve(ctx.config.FEEDBACK_DIR), 'usage');
    await mkdir(dir, { recursive: true, mode: 0o750 });
    const { installId, ...kept } = note;
    await writeFile(join(dir, `${usageFile(ctx, installId)}.json`), JSON.stringify({ ...kept, at: new Date().toISOString() }), { mode: 0o640 });
  } else await forward(ctx.config.COLLECTOR_URL, 'usage', note, log);
}
