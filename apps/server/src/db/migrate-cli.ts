import { loadConfig } from '../config.js';
import { createDb } from './index.js';
import { migrate } from './migrate.js';

const config = loadConfig();
const sql = createDb(config.DATABASE_URL, { max: 1 });
try {
  const applied = await migrate(sql, (m) => console.log(m));
  console.log(applied.length ? `Done: ${applied.length} migration(s) applied.` : 'Database is up to date.');
} finally {
  await sql.end();
}
