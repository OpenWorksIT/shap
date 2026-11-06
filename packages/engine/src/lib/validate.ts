import type { z, ZodTypeAny } from 'zod';
import { HttpError } from './errors.js';

/**
 * The most items any list in a request may have before it is checked at all. zod checks every
 * item of a list, even far past its own limit, and reports a problem per item: a few megabytes of
 * `[0,0,0,…]` would keep the server busy for half a minute. Nothing Shap sends comes near this.
 */
export const MAX_LIST_ITEMS = 20_000;
/** How deep objects and lists may nest in a request. */
const MAX_DEPTH = 40;
/** How many problems a refused request is told about. */
const MAX_PROBLEMS = 20;

/** Does anything in `v` hold a list longer than `max`, or nest deeper than allowed? */
export function oversized(v: unknown, max = MAX_LIST_ITEMS, depth = 0): boolean {
  if (v === null || typeof v !== 'object') return false;
  if (depth > MAX_DEPTH) return true;
  if (Array.isArray(v)) {
    if (v.length > max) return true;
    for (const x of v) if (x !== null && typeof x === 'object' && oversized(x, max, depth + 1)) return true;
    return false;
  }
  for (const k in v) {
    const x = (v as Record<string, unknown>)[k];
    if (x !== null && typeof x === 'object' && oversized(x, max, depth + 1)) return true;
  }
  return false;
}

/** Parse a request body/query with zod; turn failures into a 400 with per-field messages. */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown, opts: { maxItems?: number } = {}): z.output<S> {
  if (oversized(data, opts.maxItems)) throw new HttpError(400, 'That’s more than Shap takes in one go', 'too_many_items');
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const fields: Record<string, string> = {};
    let n = 0;
    for (const issue of result.error.issues) {
      const key = issue.path.join('.') || '_';
      if (key in fields) continue;
      fields[key] = issue.message;
      if (++n >= MAX_PROBLEMS) break;
    }
    const first = Object.values(fields)[0] ?? 'Invalid input';
    throw new HttpError(400, first, 'validation', { fields });
  }
  return result.data;
}
