import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from './index.js';

function migrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  // Works from src/db (dev), dist/ and dist/db (bundled chunks).
  const candidates = [join(here, '..', '..', 'migrations'), join(here, '..', 'migrations'), join(here, '..', '..', '..', 'migrations')];
  return candidates.find((d) => existsSync(join(d, '001_init.sql'))) ?? candidates[0]!;
}

/** Applies any *.sql files in migrations/ that have not run yet, each in its own transaction. */
export async function migrate(sql: Sql, log: (msg: string) => void = () => {}): Promise<string[]> {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const done = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
  const dir = migrationsDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const body = await readFile(join(dir, file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name) values (${file})`;
    });
    log(`applied ${file}`);
    applied.push(file);
  }
  return applied;
}
