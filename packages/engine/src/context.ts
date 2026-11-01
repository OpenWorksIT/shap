import type { Sql } from './db/index.js';

/** Everything route modules need, passed explicitly (no globals). */
export interface Ctx {
  /** The books, on this phone. */
  sql: Sql;
  config: { UPLOAD_MB: number };
}
