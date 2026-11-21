import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { today } from '../../src/lib/books.js';
import { createDb } from '../../src/db/index.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

// The seventh round of 1.33's reviews (security): renaming and moving a payment account at once,
// while someone else captures against it. A new name (a unique column) takes the row's full lock,
// so a capture holding books_version and then writing a cost against it can deadlock with the
// move: no one lock order fits both orders a capture takes, so the move is tried once more (the
// database picks the one that waited first, the move), and the capture is never the one that
// fails here. Made-up business and figures.

describe('renaming and moving a payment account while someone captures against it', () => {
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
    const other = createDb(process.env.DATABASE_URL!, { max: 1 });
    let captureError: string | null = null;
    let moving: ReturnType<typeof owner.call> | null = null;
    try {
      await other.begin(async (tx) => {
        // The capture has written something already (as a bank capture's journal does).
        await tx`update books_version set changed = changed + 1`;
        // Meanwhile the owner moves the bank to the new account (same cash line: allowed).
        moving = owner.call({ method: 'PUT', url: `/api/sources/${bank}`, payload: { name: 'Business bank (made-up rename)', kind: 'bank', accountId: acc!.id } });
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
    expect(captureError).toBeNull();
    expect(put.statusCode, put.body).toBe(200);
    const [moved] = await env.sql<{ accountId: string }[]>`select account_id from payment_sources where id = ${bank}`;
    expect(moved!.accountId).toBe(acc!.id);
  });
});
