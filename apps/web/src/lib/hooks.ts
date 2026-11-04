import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { remember, remembered } from './snapshot';

/**
 * What each screen showed last time. Coming back to a screen shows that straight away and
 * refreshes it underneath, instead of a spinner while the books are asked again.
 */
const lastSeen = new Map<string, unknown>();

/** Fetch JSON for a path; `reload()` refetches without blanking the screen. */
export function useApi<T>(path: string | null, opts: { fresh?: boolean } = {}) {
  // Home's figures also come back from the last time the app was open (lib/snapshot.ts).
  const cached = () => (path && !opts.fresh ? ((lastSeen.get(path) as T | undefined) ?? remembered<T>(path) ?? null) : null);
  const [data, setDataState] = useState<T | null>(cached);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const setData = useCallback(
    (v: T | null | ((x: T | null) => T | null)) =>
      setDataState((x) => {
        const next = typeof v === 'function' ? (v as (x: T | null) => T | null)(x) : v;
        if (path) lastSeen.set(path, next);
        return next;
      }),
    [path],
  );
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!path) return;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const d = await api<T>(path);
      if (path) {
        lastSeen.set(path, d);
        remember(path, d);
      }
      if (mine === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (err) {
      if (mine === seq.current) setError(err instanceof ApiError ? err : new ApiError(0, String(err), 'error'));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    // A new path (another client, another filter) starts from what that one showed last.
    setDataState(cached());
    void load();
  }, [load]);

  return { data, error, loading, reload: load, setData };
}

/** Re-render every `ms` so "now" lines and relative times stay current. */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function useMedia(query: string) {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const fn = () => setMatches(m.matches);
    m.addEventListener('change', fn);
    return () => m.removeEventListener('change', fn);
  }, [query]);
  return matches;
}
