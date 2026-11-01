import type { Sql } from './index.js';

export interface Migration {
  name: string;
  body: string;
}

/**
 * Applies the migrations that have not run yet, each in its own transaction. The app bundles
 * them (see the web app's pocket/migrations.ts); the tests read them from disk.
 */
export async function migrate(sql: Sql, migrations: Migration[], log: (msg: string) => void = () => {}): Promise<string[]> {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const done = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
  const applied: string[] = [];
  for (const m of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    if (done.has(m.name)) continue;
    await sql.begin(async (tx) => {
      await tx.unsafe(m.body);
      await tx`insert into schema_migrations (name) values (${m.name})`;
    });
    log(`applied ${m.name}`);
    applied.push(m.name);
  }
  return applied;
}
