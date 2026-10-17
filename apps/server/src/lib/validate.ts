import type { z, ZodTypeAny } from 'zod';
import { HttpError } from './errors.js';

/** Parse a request body/query with zod; turn failures into a 400 with per-field messages. */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const fields: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join('.') || '_';
      fields[key] ??= issue.message;
    }
    const first = Object.values(fields)[0] ?? 'Invalid input';
    throw new HttpError(400, first, 'validation', { fields });
  }
  return result.data;
}
