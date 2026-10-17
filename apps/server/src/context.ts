import type { Config } from './config.js';
import type { Sql } from './db/index.js';
import type { Secrets } from './lib/crypto.js';
import type { Mailer } from './lib/mailer.js';

/** Everything route modules need, passed explicitly (no globals). */
export interface Ctx {
  config: Config;
  sql: Sql;
  mailer: Mailer;
  secrets: Secrets;
}
