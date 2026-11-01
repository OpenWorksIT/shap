/**
 * API client. Shap Pocket's "server" runs on the phone (pocket/engine.ts): the same requests
 * Shap's screens send to its server, answered inside the app. Nothing goes over the network.
 */
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
    const d = (r.body ?? {}) as { error?: string; code?: string; details?: { fields?: Record<string, string> } };
    throw new ApiError(r.status, d.error ?? `Something went wrong (${r.status})`, d.code ?? 'error', d.details?.fields ?? {}, d.details);
  }
  return r.body as T;
}

/** A file the books make (a PDF, a spreadsheet, a photo of a slip). */
export const apiBlob = fetchBlob;
