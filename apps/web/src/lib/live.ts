/**
 * Several people in Shap at once: one quiet connection to the server, which says "something
 * changed" when someone else saves. Open screens then refetch (see useApi). Read with fetch so
 * it works with the phone app's sign-in too; reconnects with backoff, and falls back to a
 * refresh every 30 seconds when something in between holds the stream back. From Sorted.
 */
import { apiUrl, authHeaders } from './api';

type Listener = () => void;
const listeners = new Set<Listener>();
let started = false;
let controller: AbortController | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const emit = () => listeners.forEach((fn) => fn());

function startPolling() {
  if (!pollTimer) pollTimer = setInterval(emit, 30_000);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function run() {
  let backoff = 1000;
  let failures = 0;
  while (started) {
    controller = new AbortController();
    const c = controller;
    const firstByte = setTimeout(() => c.abort(), 8_000);
    let live = false;
    try {
      const res = await fetch(apiUrl('/api/live'), { headers: authHeaders(), credentials: 'same-origin', signal: c.signal });
      if (!res.ok || !res.body) throw new Error(String(res.status));
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!live) {
          live = true;
          clearTimeout(firstByte);
          stopPolling();
          if (failures) emit(); // catch up on what was missed while away
          backoff = 1000;
          failures = 0;
        }
        buf += value;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (chunk.includes('event: changed')) emit();
        }
      }
    } catch {
      /* reconnect below */
    } finally {
      clearTimeout(firstByte);
    }
    if (!started) return;
    failures++;
    if (failures >= 2) startPolling();
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 60_000);
  }
}

export function startLive() {
  if (started) return;
  started = true;
  void run();
}

export function stopLive() {
  started = false;
  controller?.abort();
  stopPolling();
}

/** Calls `fn` when someone else changes something. Returns the unsubscribe. */
export function onLive(fn: Listener): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
