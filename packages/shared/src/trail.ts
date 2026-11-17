/**
 * Keeping people's details out of a feedback trail (the steps attached to a bug report). The web
 * app records clicks, pages and errors with these applied; the server applies them again to every
 * trail it receives or forwards, whatever app or version sent it (CPDAUDIT.md, privacy).
 */
const ID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** IDs and query values out of a path, so the trail shows the shape of the route, not who. */
export const scrubPath = (p: string) => p.replace(ID_RE, ':id').replace(/\?.*$/, (q) => (/[?&](t|token)=/.test(q) ? '?…' : q.replace(/=[^&]*/g, '=…')));

/** Email addresses, and phone or ID numbers (any run of 8 or more digits), blanked. */
export const redactText = (s: string) => s.replace(/[^\s@]+@[^\s@]+/g, '…@…').replace(/\+?\d[\d\s-]{6,}\d/g, '…');

/** One trail entry as the server keeps or forwards it. */
export const scrubTrailDetail = (detail: string) => redactText(scrubPath(String(detail ?? ''))).slice(0, 300);

/** Where on the page something the trail names sits. */
export interface TrailPlace {
  /** Inside a part of the page marked `data-private` (people's, clients' or accounts' names). */
  private: boolean;
  /** In a row of a list or a table, whose labels often carry the row's name. */
  inList: boolean;
}

/**
 * How the trail names a field that was changed: by its label, unless it sits among private details
 * or in a list's row, where a label can carry a name ("Where Loan – J Smith goes"): then only that
 * it was a field there. Labels elsewhere are the page's own words, with addresses and numbers blanked.
 */
export const trailFieldName = (label: string, place: TrailPlace, tag = 'field'): string => {
  if (place.inList) return 'a field in a list';
  if (place.private) return 'a field among private details';
  return redactText(label.replace(/\s+/g, ' ').trim().slice(0, 40)) || tag;
};

/** How the trail names a button: the same, by its label only outside private details and lists. */
export const trailButtonName = (role: string, label: string, place: TrailPlace): string => {
  if (place.inList) return `${role} in a list`;
  if (place.private) return `${role} among private details`;
  return `${role} “${redactText(label.replace(/\s+/g, ' ').trim().slice(0, 40)) || '(no label)'}”`;
};
