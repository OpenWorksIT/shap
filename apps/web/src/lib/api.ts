/**
 * API client. In the browser the session rides in an httpOnly cookie.
 * A native (Capacitor) build sets VITE_API_URL to the Shap server and stores the
 * bearer token returned at login, because cross-origin cookies are unreliable in webviews.
 */
const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const NATIVE = Boolean(import.meta.env.VITE_API_URL);
const TOKEN_KEY = 'shap.token';

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

function token(): string | null {
  if (!NATIVE) return null;
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setNativeToken(t: string | null) {
  if (!NATIVE) return;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function authHeaders(): Record<string, string> {
  const t = token();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export function apiUrl(path: string): string {
  return `${BASE}${path}`;
}

/** This page's version; the server says its own on every reply. */
export const APP_VERSION = __SHAP_VERSION__;
let onStale: ((serverVersion: string) => void) | null = null;
/** Called when the server is a different version from this page (updated while it was open). */
export function setStaleHandler(fn: (serverVersion: string) => void) {
  onStale = fn;
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        'X-Shap-Version': APP_VERSION,
        'X-Shap-Client': NATIVE ? 'native' : 'web',
        ...authHeaders(),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: NATIVE ? 'omit' : 'same-origin',
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'Can’t reach the Shap server. Check your connection.', 'network');
  }
  const server = res.headers.get('x-shap-version');
  if (server && server !== APP_VERSION && !NATIVE) onStale?.(server);
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/login')) onUnauthorized?.();
    const d = (data ?? {}) as { error?: string; code?: string; details?: { fields?: Record<string, string> } };
    throw new ApiError(res.status, d.error ?? `Request failed (${res.status})`, d.code ?? 'error', d.details?.fields ?? {}, d.details);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
