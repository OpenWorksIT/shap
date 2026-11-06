/**
 * What Home showed last time, kept on the phone, so the app opens on it straight away.
 *
 * Opening the books takes a few seconds on a phone: Postgres has to start inside the app and
 * read them from storage. Home doesn't need to wait for that to appear: it shows the last
 * answers it had (the business's settings and Home's own figures) at once, and the fresh ones
 * replace them as soon as the books are open. Only these two answers are kept, they're small,
 * and they're dropped when the books are restored or erased. A copy saved by another version
 * of the app is ignored, in case what Home expects has changed.
 *
 * Only on the phone: the web app on a computer opens quickly anyway, and its storage is shared
 * with the rest of the website it's served from, so nothing is copied there in plain text.
 */
const APP_VERSION = __SHAP_VERSION__;
const ON = !__POCKET_WEB__;

const KEY = 'shap-snapshot:';
const KEPT = new Set(['/api/reference', '/api/dashboard']);
const MAX_CHARS = 300_000;

export function remembered<T>(path: string): T | undefined {
  if (!ON || !KEPT.has(path)) return undefined;
  try {
    const raw = localStorage.getItem(KEY + path);
    if (!raw) return undefined;
    const saved = JSON.parse(raw) as { v: string; data: T };
    return saved.v === APP_VERSION ? saved.data : undefined;
  } catch {
    return undefined;
  }
}

export function remember(path: string, data: unknown) {
  if (!KEPT.has(path)) return;
  if (!ON) return forgetSnapshots(); // and drop any an earlier version kept
  try {
    const raw = JSON.stringify({ v: APP_VERSION, data });
    if (raw.length <= MAX_CHARS) localStorage.setItem(KEY + path, raw);
  } catch {
    /* storage full or unavailable: the app just opens the slower way */
  }
}

export function forgetSnapshots() {
  try {
    for (const p of KEPT) localStorage.removeItem(KEY + p);
  } catch {
    /* nothing kept */
  }
}
