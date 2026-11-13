/**
 * API client. Shap Pocket's "server" runs on the phone (pocket/engine.ts): the same requests
 * Shap's screens send to its server, answered inside the app. Nothing goes over the network.
 */
import { scrubPath, UNEXPECTED } from '@shap/shared';
import { call, fetchBlob } from '../pocket/engine';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string,
    public fields: Record<string, string> = {},
    public details?: unknown,
  ) {
    super(message);
  }
}

/** This build's version. */
export const APP_VERSION = __SHAP_VERSION__;

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  let r;
  try {
    r = await call(method, path, opts.body);
  } catch (err) {
    throw new ApiError(0, `Shap couldn’t open your books: ${(err as Error).message}`, 'engine');
  }
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (r.status >= 400) {
    const d = (r.body ?? {}) as { error?: string; code?: string; details?: { fields?: Record<string, string>; cause?: string } };
    if (r.status >= 500) unexpected(method, path, r.status, d.details?.cause);
    throw new ApiError(r.status, d.error ?? UNEXPECTED, d.code ?? 'error', d.details?.fields ?? {}, d.details);
  }
  return r.body as T;
}

/** One the books didn't expect: where and why, into Feedback's trail (redacted there). */
function unexpected(method: string, path: string, status: number, cause?: string) {
  console.error(`${method} ${scrubPath(path)} → ${status}${cause ? `: ${cause}` : ''}`);
}

/** A file the books make (a PDF, a spreadsheet, a photo of a slip). A refusal comes back as an ApiError. */
export async function apiBlob(path: string): Promise<{ blob: Blob; filename: string }> {
  try {
    return await fetchBlob(path);
  } catch (err) {
    const e = err as Error & { status?: number; cause?: string };
    if (!e.status) throw err;
    if (e.status >= 500) unexpected('GET', path, e.status, e.cause);
    throw new ApiError(e.status, e.message, 'error');
  }
}
