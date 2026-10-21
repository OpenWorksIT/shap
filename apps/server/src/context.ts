import type { Config } from './config.js';
import type { Sql } from './db/index.js';
import type { Secrets } from './lib/crypto.js';
import type { Mailer } from './lib/mailer.js';

/** Everything route modules need, passed explicitly (no globals). */
export interface Ctx {
  config: Config;
  /** The database of the company this request is for (the real one, or the demo company). */
  sql: Sql;
  /** Both databases by name, for the few places that must choose (switching in and out of the demo). */
  dbs: { real: Sql; demo: Sql | null };
  mailer: Mailer;
  secrets: Secrets;
}
