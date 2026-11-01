// Builds empty, fully migrated books once, at build time, so the app's first open on a phone
// loads them instead of running every migration there (which takes several seconds).
// Same steps as the engine's migrate(): schema_migrations, then each file in order.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const dir = new URL('../../../packages/engine/migrations/', import.meta.url).pathname;
const out = new URL('../public/', import.meta.url).pathname;
const pg = new PGlite();
await pg.exec('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  await pg.exec('begin;');
  await pg.exec(readFileSync(join(dir, name), 'utf8'));
  await pg.query('insert into schema_migrations (name) values ($1)', [name]);
  await pg.exec('commit;');
}
const blob = await pg.dumpDataDir('gzip');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'fresh-books.tar.gz'), Buffer.from(await blob.arrayBuffer()));
console.log(`fresh-books.tar.gz: ${(blob.size / 1024).toFixed(0)} KB`);
await pg.close();
