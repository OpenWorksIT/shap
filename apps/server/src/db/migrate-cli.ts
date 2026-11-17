import { loadConfig } from '../config.js';
import { ClientDbs, migrateClients } from '../lib/practice.js';
import { createDb } from './index.js';
import { migrate } from './migrate.js';

// This database's migrations, then (Shap Accountant) each of a practice's clients' books' own, as
// the server does when it starts (main.ts). A client whose migrations fail is marked, and named here.
const config = loadConfig();
const sql = createDb(config.DATABASE_URL, { max: 1 });
const clients = new ClientDbs(config.DATABASE_URL);
let failed = 0;
try {
  const applied = await migrate(sql, (m) => console.log(m));
  console.log(applied.length ? `Done: ${applied.length} migration(s) applied.` : 'Database is up to date.');
  const c = await migrateClients(sql, clients, { info: (m) => console.log(m), warn: (o, m) => console.error(m, o) });
  if (c.ok.length || c.failed.length) console.log(`Clients' books: ${c.ok.length} up to date${c.failed.length ? `, ${c.failed.length} failed (${c.failed.join(', ')})` : ''}.`);
  failed = c.failed.length;
} finally {
  await clients.end();
  await sql.end();
}
if (failed) process.exit(1);
