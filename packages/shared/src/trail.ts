/**
 * Keeping people's details out of a feedback trail (the steps attached to a bug report). The web
 * app records clicks, pages and errors with these applied; the server applies them again to every
 * trail it receives or forwards, whatever app or version sent it (docs/AUDIT.md, privacy).
 */
const ID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** IDs and query values out of a path, so the trail shows the shape of the route, not who. */
export const scrubPath = (p: string) => p.replace(ID_RE, ':id').replace(/\?.*$/, (q) => (/[?&](t|token)=/.test(q) ? '?…' : q.replace(/=[^&]*/g, '=…')));

/** Email addresses, and phone or ID numbers (any run of 8 or more digits), blanked. */
export const redactText = (s: string) => s.replace(/[^\s@]+@[^\s@]+/g, '…@…').replace(/\+?\d[\d\s-]{6,}\d/g, '…');

/** One trail entry as the server keeps or forwards it. */
export const scrubTrailDetail = (detail: string) => redactText(scrubPath(String(detail ?? ''))).slice(0, 300);
