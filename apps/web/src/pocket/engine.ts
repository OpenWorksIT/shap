/**
 * The screens' side of the engine: send a request, get the reply. Shap's screens were written
 * for a web server; in Pocket the "server" is a worker on the phone.
 */
import type { EngineReply, EngineRequest } from './engine.worker';

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
  worker.onmessage = (e: MessageEvent<EngineReply>) => {
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

export const call = (method: string, url: string, body?: unknown) => send<EngineResponse>({ op: 'call', method, url, body });
/** The whole database as one compressed file: what a backup is. */
export const dump = () => send<Blob>({ op: 'dump' });
/** Replaces the books with a backup (checked first; nothing changes if it won't open). */
export const restore = (data: Blob) => send<null>({ op: 'restore', data });
export const erase = () => send<null>({ op: 'erase' });

/** A file from the engine (PDF, CSV, photo), with the name it should be saved as. */
export async function fetchBlob(path: string): Promise<{ blob: Blob; filename: string }> {
  const r = await call('GET', path);
  if (r.status >= 400) throw new Error((r.body as { error?: string } | null)?.error ?? 'Couldn’t make that file');
  const type = r.headers['content-type'] ?? 'application/octet-stream';
  const blob = r.bytes ? new Blob([r.body as ArrayBuffer], { type }) : new Blob([typeof r.body === 'string' ? r.body : JSON.stringify(r.body)], { type });
  const named = /filename="([^"]+)"/.exec(r.headers['content-disposition'] ?? '')?.[1];
  const ext = type.includes('pdf') ? 'pdf' : type.includes('csv') ? 'csv' : type.includes('png') ? 'png' : type.includes('jpeg') ? 'jpg' : type.includes('json') ? 'json' : 'bin';
  return { blob, filename: named ?? `Shap file.${ext}` };
}
