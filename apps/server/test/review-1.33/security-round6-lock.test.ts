import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { today } from '../../src/lib/books.js';
import { createDb } from '../../src/db/index.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

// The sixth round of 1.33's reviews (security): moving a payment account to another account in the
// books while someone else captures against it. Every write to the books bumps the one
// books_version row, and a cost against a payment account takes a key-share lock on its row (its
// foreign key): the move took FOR UPDATE on that row first, then bumped books_version, so a capture
// holding books_version and then writing a cost deadlocked with it. It takes FOR NO KEY UPDATE now.
// Made-up business and figures.

describe('moving a payment account while someone captures against it', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('neither the move nor the capture fails', async () => {
    const owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    // A second made-up bank account in the chart, on the statements' cash line as the first is.
    const [acc] = await env.sql<{ id: string }[]>`insert into accounts (code, name, type, statement_line) values ('1003', 'Made-up second bank', 'asset', 'cash') returning id`;
    const [cat] = await env.sql<{ id: string }[]>`select id from cost_categories order by name limit 1`;
    const deadlocks = async () => (await env.sql<{ n: number }[]>`select deadlocks::int as n from pg_stat_database where datname = current_database()`)[0]!.n;
    const before = await deadlocks();
    const other = createDb(process.env.DATABASE_URL!, { max: 1 });
    let captureError: string | null = null;
    let moving: ReturnType<typeof owner.call> | null = null;
    try {
      await other.begin(async (tx) => {
        // The capture has written something already (as a bank capture's journal does).
        await tx`update books_version set changed = changed + 1`;
        // Meanwhile the owner moves the bank to the new account (same cash line: allowed).
        moving = owner.call({ method: 'PUT', url: `/api/sources/${bank}`, payload: { name: 'Business bank', kind: 'bank', accountId: acc!.id } });
        // Once the move waits (on books_version), the capture writes a cost against the bank.
        for (let i = 0; i < 100; i++) {
          const [w] = await env.sql<{ n: number }[]>`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`;
          if (w!.n > 0) break;
          await new Promise((ok) => setTimeout(ok, 20));
        }
        await tx`insert into costs (date, description, amount_cents, category_id, source_id) values (${today()}, 'Made-up cement', 50000, ${cat!.id}, ${bank})`;
      });
    } catch (err) {
      captureError = `${(err as { code?: string }).code ?? ''} ${(err as Error).message}`;
    } finally {
      await other.end();
    }
    const put = await moving!;
    // pg_stat_database is updated a moment later.
    await new Promise((ok) => setTimeout(ok, 700));
    expect(await deadlocks(), 'a deadlock').toBe(before);
    expect(captureError).toBeNull();
    expect(put.statusCode, put.body).toBe(200);
    const [moved] = await env.sql<{ accountId: string }[]>`select account_id from payment_sources where id = ${bank}`;
    expect(moved!.accountId).toBe(acc!.id);
  });
});
