/**
 * The books audit from the command line: for the server audit (deploy/vps/audit-server.sh, in
 * the app's container) and CI. Read-only. Exit code 1 when something must be put right.
 *
 *   node apps/server/dist/audit/cli.js                 # the books, OK / WARN / FAIL per line
 *   node apps/server/dist/audit/cli.js --json FILE     # also as JSON (- for standard output)
 *   node apps/server/dist/audit/cli.js --quiet --json -
 *
 * Uses DATABASE_URL, like the app.
 */
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { createDb } from '../db/index.js';
import { appVersion } from '../modules/system.js';
import { auditBooks, tally } from './books.js';

const args = process.argv.slice(2);
const json = args.includes('--json') ? (args[args.indexOf('--json') + 1] ?? '-') : null;
const quiet = args.includes('--quiet');
const config = loadConfig();
const sql = createDb(config.DATABASE_URL, { max: 2 });
try {
  const items = await auditBooks(sql);
  const t = tally(items);
  if (!quiet) {
    let section = '';
    for (const i of items) {
      if (i.section !== section) console.log(`\n${(section = i.section)}`);
      console.log(`  ${i.level.toUpperCase().padEnd(5)} ${i.text}`);
    }
    console.log(`\n${t.fails} to fix, ${t.warns} to look at.`);
  }
  if (json) {
    const out = JSON.stringify({ format: 1, kind: 'books', at: new Date().toISOString(), version: appVersion(), ...t, items });
    if (json === '-') process.stdout.write(`${out}\n`);
    else writeFileSync(json, out);
  }
  process.exitCode = t.fails ? 1 : 0;
} finally {
  await sql.end({ timeout: 5 });
}
