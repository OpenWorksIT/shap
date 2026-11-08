/**
 * The books, in a background thread: PGlite (Postgres in WebAssembly) kept in the phone's
 * storage, and Shap's routes on top. The screens talk to it through engine.ts.
 */
import { Buffer } from 'buffer';
(globalThis as { Buffer?: unknown }).Buffer ??= Buffer;

import { PGlite } from '@electric-sql/pglite';
import { buildApp, createDb, migrate, setPdfFonts, type App, type Migration } from '@shap/engine';
import regularUrl from '@fontsource/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-400-normal.woff?url';
import boldUrl from '@fontsource/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-700-normal.woff?url';

const MIGRATIONS: Migration[] = Object.entries(
  import.meta.glob('../../../../packages/engine/migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>,
).map(([path, body]) => ({ name: path.split('/').pop()!, body }));

export const DATA_DIR = 'idb://shap-pocket';

export type EngineRequest =
  | { id: number; op: 'call'; method: string; url: string; body?: unknown }
  | { id: number; op: 'dump' }
  | { id: number; op: 'restore'; data: Blob }
  | { id: number; op: 'erase' }
  | { id: number; op: 'status'; template?: string };
export type EngineReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
/** A step of opening the books, for the loading screen (lib/boot.ts). */
export type EngineBoot = { boot: 'template' | 'open' | 'migrate' | 'app'; first?: boolean };
const step = (boot: EngineBoot['boot'], first?: boolean) => (self as unknown as Worker).postMessage({ boot, first } satisfies EngineBoot);

let pg: PGlite | null = null;
let app: App | null = null;
let starting: Promise<void> | null = null;
/** True when this start made new, empty books (first open, or the phone's storage was cleared). */
let fresh = false;

/** Empty, migrated books made at build time (scripts/fresh-books.mjs): a quick first open. */
let templateUrl: string | null = null;
async function storeExists(): Promise<boolean> {
  const list = await (indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> }).databases?.();
  return list ? list.some((d) => d.name === STORE) : true;
}
const STORE = '/pglite/' + DATA_DIR.slice('idb://'.length);

async function start(from?: Blob) {
  fresh = false;
  if (!from && templateUrl && !(await storeExists())) {
    step('template', true);
    try {
      const r = await fetch(templateUrl);
      if (r.ok) {
        from = await r.blob();
        fresh = true;
      }
    } catch {
      /* migrate from scratch instead */
    }
  }
  const usedTemplate = fresh;
  // Every change is written to the phone's storage before the answer comes back. (Relaxed
  // durability was tried: quicker, but PGlite then finishes writing after close(), which broke
  // restoring a backup.)
  step('open', usedTemplate);
  pg = new PGlite(DATA_DIR, from ? { loadDataDir: from } : {});
  await pg.waitReady;
  const sql = createDb(pg);
  step('migrate');
  fresh = usedTemplate || (await migrate(sql, MIGRATIONS)).includes(MIGRATIONS.map((m) => m.name).sort()[0]!);
  if (usedTemplate) await migrate(sql, MIGRATIONS);
  // The template is the same file for every phone: each set of books gets its own install id
  // (what the anonymous market rates and usage notes count as one business).
  if (usedTemplate) await sql`update settings set install_id = gen_random_uuid()`;
  step('app');
  app = (await buildApp({ sql })).app;
}

async function fonts() {
  const get = async (u: string) => new Uint8Array(await (await fetch(u)).arrayBuffer());
  try {
    setPdfFonts({ regular: await get(regularUrl), bold: await get(boldUrl) });
  } catch {
    /* Helvetica it is */
  }
}

const ready = () => (starting ??= Promise.all([start(), fonts()]).then(() => undefined));

/** Throws away the stored database (before a restore, or "erase everything"). */
async function dropStore() {
  await pg?.close();
  pg = null;
  app = null;
  await new Promise<void>((resolve) => {
    const r = indexedDB.deleteDatabase(STORE);
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  });
}

/**
 * What a web server would have sent: dates as ISO text (Shap's screens expect JSON), big
 * integers as numbers. Without this a timestamp reaches the screens as a Date object.
 */
function jsonReady(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return Number(v);
  if (Array.isArray(v)) return v.map(jsonReady);
  if (v && typeof v === 'object' && !(v instanceof ArrayBuffer) && !ArrayBuffer.isView(v)) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = jsonReady(x);
    return o;
  }
  return v;
}

/**
 * The empty books' address, as the page gives it: only ever the file next to the app (same origin,
 * fresh-books.tar.gz), never anywhere else.
 */
function ownTemplate(url: string): string | null {
  try {
    const u = new URL(url, self.location.href);
    return u.origin === self.location.origin && u.pathname.endsWith('/fresh-books.tar.gz') ? u.href : null;
  } catch {
    return null;
  }
}

self.onmessage = async (e: MessageEvent<EngineRequest>) => {
  // Only the app's own page can talk to its worker; a message from anywhere else is ignored.
  if (e.origin && e.origin !== self.location.origin) return;
  const m = e.data;
  if (!m || typeof m !== 'object' || typeof (m as { op?: unknown }).op !== 'string') return;
  const reply = (r: { ok: true; result: unknown } | { ok: false; error: string }, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage({ id: m.id, ...r }, transfer);
  try {
    if (m.op === 'status' && m.template) templateUrl = ownTemplate(m.template);
    await ready();
    if (m.op === 'call') {
      const r = await app!.handle(m.method, m.url, m.body);
      const bytes = r.body instanceof Uint8Array ? r.body : null;
      // Bytes go across as a copy we own, so they can be handed over rather than cloned.
      const body = bytes ? bytes.slice().buffer : jsonReady(r.body);
      reply({ ok: true, result: { status: r.status, headers: r.headers, body, bytes: Boolean(bytes) } }, bytes ? [body as ArrayBuffer] : []);
    } else if (m.op === 'dump') {
      reply({ ok: true, result: await pg!.dumpDataDir('gzip') });
    } else if (m.op === 'restore') {
      // Check the backup opens before letting go of what's here.
      const test = new PGlite({ loadDataDir: m.data });
      await test.query('select count(*) from settings');
      await test.close();
      await dropStore();
      starting = start(m.data);
      await starting;
      reply({ ok: true, result: null });
    } else if (m.op === 'status') {
      reply({ ok: true, result: { fresh } });
    } else if (m.op === 'erase') {
      await dropStore();
      starting = start();
      await starting;
      reply({ ok: true, result: null });
    }
  } catch (err) {
    reply({ ok: false, error: (err as Error).message || String(err) });
  }
};
