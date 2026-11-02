/**
 * A short trail of what the user just did, attached to bug reports so we can retrace the steps.
 * It records where they went, what they clicked, which server calls ran and any errors, and never
 * what they typed: clicks on links record the link's path (IDs replaced), clicks on buttons their
 * label, and edits only which field changed.
 */
export interface TrailEntry {
  t: number; // ms since epoch
  kind: 'nav' | 'click' | 'edit' | 'api' | 'error' | 'console';
  detail: string;
}

const MAX = 60;
const entries: TrailEntry[] = [];
let started = false;

const ID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** Strip IDs and query strings from paths, so the trail shows the shape of the route, not who. */
export const scrubPath = (p: string) => p.replace(ID_RE, ':id').replace(/\?.*$/, (q) => (/[?&](t|token)=/.test(q) ? '?…' : q.replace(/=[^&]*/g, '=…')));

export function record(kind: TrailEntry['kind'], detail: string) {
  entries.push({ t: Date.now(), kind, detail: detail.slice(0, 300) });
  if (entries.length > MAX) entries.splice(0, entries.length - MAX);
}

export function getTrail(): TrailEntry[] {
  return entries.slice();
}

const short = (s: string | null | undefined, n = 40) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

function describe(el: Element): string | null {
  if (el.closest('[data-feedback]')) return null; // the feedback widget itself
  const link = el.closest('a[href]');
  if (link) return `link → ${scrubPath(new URL((link as HTMLAnchorElement).href, location.href).pathname)}`;
  const button = el.closest('button, [role="button"], [role="tab"], [role="radio"]');
  if (button) {
    const label = button.getAttribute('aria-label') || short(button.textContent);
    // Buttons in lists of people (e.g. "Use this file" rows) keep their label only; long labels are cut short.
    return `${button.getAttribute('role') ?? 'button'} “${label || '(no label)'}”`;
  }
  const summary = el.closest('summary');
  if (summary) return `toggle “${short(summary.textContent)}”`;
  return null;
}

function fieldName(el: Element): string {
  const id = el.getAttribute('id');
  const label = (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent) || el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder');
  return short(label) || el.tagName.toLowerCase();
}

/** Starts listening. Safe to call more than once. */
export function startTrail() {
  if (started || typeof window === 'undefined') return;
  started = true;
  record('nav', scrubPath(location.pathname + location.search));
  document.addEventListener(
    'click',
    (e) => {
      const d = e.target instanceof Element ? describe(e.target) : null;
      if (d) record('click', d);
    },
    true,
  );
  document.addEventListener(
    'change',
    (e) => {
      const el = e.target;
      if (!(el instanceof Element) || el.closest('[data-feedback]')) return;
      const what = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') ? (el.checked ? 'ticked' : 'unticked') : 'changed';
      record('edit', `${what} “${fieldName(el)}”`);
    },
    true,
  );
  window.addEventListener('error', (e) => record('error', `${e.message} @ ${scrubPath(e.filename ?? '')}:${e.lineno ?? ''}`));
  window.addEventListener('unhandledrejection', (e) => record('error', `Unhandled: ${String((e.reason as Error)?.message ?? e.reason)}`));
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    record('console', args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : '')).join(' '));
    original(...args);
  };
}
