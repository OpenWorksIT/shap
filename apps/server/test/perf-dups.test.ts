import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findDuplicates } from '../src/modules/costs.js';
import { ref, setup, type TestEnv } from './helpers.js';

describe('finding twins among many costs', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
    const r = await ref(env.sql);
    const cat = await r.cat('Parts');
    await env.sql`insert into costs (date, description, amount_cents, supplier, category_id)
      select date '2025-01-01' + (i % 600), 'Item ' || i, 1000 + (i * 37) % 90000, 'Supplier ' || (i % 50), ${cat} from generate_series(1, 6000) i`;
  });
  afterAll(() => env.close());
  it('stays quick', async () => {
    const t = Date.now();
    await findDuplicates(env.sql);
    expect(Date.now() - t).toBeLessThan(3000);
  });
});
