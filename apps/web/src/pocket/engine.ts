/**
 * The screens' side of the engine: send a request, get the reply. Shap's screens were written
 * for a web server; in Pocket the "server" is a worker on the phone.
 */
import type { EngineBoot, EngineReply, EngineRequest } from './engine.worker';
import { bootStage } from '../lib/boot';
import { forgetSnapshots } from '../lib/snapshot';

export interface EngineResponse {
  status: number;
  headers: Record<string, string>;
  /** JSON-ready data, or bytes (PDF, photo, CSV) when `bytes`. */
  body: unknown;
  bytes: boolean;
}

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();

function engine(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<EngineReply | EngineBoot>) => {
    // A step of opening the books, for the loading screen.
    if ('boot' in e.data) return bootStage(e.data.boot, e.data.first);
    const w = waiting.get(e.data.id);
    if (!w) return;
    waiting.delete(e.data.id);
    if (e.data.ok) w.ok(e.data.result);
    else w.fail(new Error(e.data.error));
  };
  return worker;
}

type Op = EngineRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;
function send<T>(op: Op): Promise<T> {
  const id = ++seq;
  return new Promise<T>((ok, fail) => {
    waiting.set(id, { ok: ok as (v: unknown) => void, fail });
    engine().postMessage({ id, ...op });
  });
}

const rawCall = (method: string, url: string, body?: unknown) => send<EngineResponse>({ op: 'call', method, url, body });

/**
 * Every request waits for the books to be open. On a phone, opening also checks the safety
 * copy: if the phone's web storage came back empty (iOS can clear it when storage runs low),
 * the books are put back from the copy kept in the app's own files.
 */
let opened: Promise<void> | null = null;
function open(): Promise<void> {
  return (opened ??= (async () => {
    const { fresh } = await send<{ fresh: boolean }>({ op: 'status', template: new URL('fresh-books.tar.gz', document.baseURI).href });
    if (fresh) {
      // New, empty books: what Home showed last time no longer applies.
      forgetSnapshots();
      const copy = await readSafetyCopy();
      if (copy) await send<null>({ op: 'restore', data: copy });
    }
  })());
}

/** Starts opening the books now, before any screen asks (it takes a few seconds on a phone). */
export function openEarly() {
  open().catch(() => {
    /* the first screen to ask shows the error */
  });
}

export async function call(method: string, url: string, body?: unknown): Promise<EngineResponse> {
  await open();
  lastCall = Date.now();
  const r = await rawCall(method, url, body);
  if (method !== 'GET' && r.status < 400) scheduleSafetyCopy();
  return r;
}
/** The whole database as one compressed file: what a backup is. */
export const dump = () => send<Blob>({ op: 'dump' });
/** Replaces the books with a backup (checked first; nothing changes if it won't open). */
export const restore = async (data: Blob) => {
  await send<null>({ op: 'restore', data });
  forgetSnapshots();
  await writeSafetyCopy();
};
export const erase = async () => {
  await send<null>({ op: 'erase' });
  forgetSnapshots();
  await writeSafetyCopy();
};

// ---------------------------------------------------------------- the safety copy
// A second copy of the books in the app's private files on the phone, refreshed a little while
// after each change. It's not a backup (it goes if the app is deleted or the phone is lost):
// that's what Backup to iCloud / Google Drive / OneDrive / Proton Drive is for.
//
// Copying the books takes a few seconds on a phone and the books can't answer anything else
// meanwhile, so it's done when the app goes to the background (the person has stopped), or
// after two quiet minutes, never while someone is moving between screens.
const SAFETY = 'books/safety-copy.tar.gz';
let timer: ReturnType<typeof setTimeout> | null = null;
let changed = false;
let lastCall = 0;
function scheduleSafetyCopy() {
  changed = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(quietCopy, 120_000);
}
function quietCopy() {
  // Still being used: wait for a quiet moment.
  if (Date.now() - lastCall < 60_000) {
    timer = setTimeout(quietCopy, 60_000);
    return;
  }
  void flushSafetyCopy();
}
async function flushSafetyCopy() {
  if (!changed) return;
  changed = false;
  if (timer) clearTimeout(timer);
  timer = null;
  await writeSafetyCopy();
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushSafetyCopy();
  });
}
async function native() {
  const { Capacitor } = await import('@capacitor/core');
  if (!Capacitor.isNativePlatform()) return null;
  return import('@capacitor/filesystem');
}
async function writeSafetyCopy() {
  const fs = await native();
  if (!fs) return;
  try {
    const blob = await dump();
    // The browser's own encoder: far quicker than building the text in JavaScript, and it
    // doesn't freeze the screen on a big file.
    const data = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
    await fs.Filesystem.writeFile({ path: SAFETY, data, directory: fs.Directory.Library ?? fs.Directory.Data, recursive: true });
  } catch (err) {
    console.warn('safety copy not written', err);
  }
}
async function readSafetyCopy(): Promise<Blob | null> {
  const fs = await native();
  if (!fs) return null;
  try {
    const r = await fs.Filesystem.readFile({ path: SAFETY, directory: fs.Directory.Library ?? fs.Directory.Data });
    const data = typeof r.data === 'string' ? Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)) : new Uint8Array(await r.data.arrayBuffer());
    return new Blob([data], { type: 'application/gzip' });
  } catch {
    return null;
  }
}

/** A file from the engine (PDF, CSV, photo), with the name it should be saved as. */
export async function fetchBlob(path: string): Promise<{ blob: Blob; filename: string }> {
  const r = await call('GET', path);
  if (r.status >= 400) {
    const d = r.body as { error?: string; details?: { cause?: string } } | null;
    // With its status, so the screens can tell the books' refusal (said as it is) from a fault.
    throw Object.assign(new Error(d?.error ?? 'Couldn’t make that file'), { status: r.status, cause: d?.details?.cause });
  }
  const type = r.headers['content-type'] ?? 'application/octet-stream';
  const blob = r.bytes ? new Blob([r.body as ArrayBuffer], { type }) : new Blob([typeof r.body === 'string' ? r.body : JSON.stringify(r.body)], { type });
  const named = /filename="([^"]+)"/.exec(r.headers['content-disposition'] ?? '')?.[1];
  const ext = type.includes('pdf') ? 'pdf' : type.includes('csv') ? 'csv' : type.includes('png') ? 'png' : type.includes('jpeg') ? 'jpg' : type.includes('json') ? 'json' : 'bin';
  return { blob, filename: named ?? `Shap file.${ext}` };
}
