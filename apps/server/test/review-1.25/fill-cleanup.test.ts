/**
 * The test server's filling puts back what it set up for itself, and only then says it's done (the
 * 1.25 check of the four reviews' fixes, CPDAUDIT.md section 7): month end as it was, and its own
 * sign-in gone. Also when it fails before it begins. A browser can't pass for the filling's sign-in.
 * The filling itself is stood in for here (test-server.test.ts fills real books). All data made up.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FILLING_SESSION } from '../../src/auth.js';
import { appVersion } from '../../src/modules/system.js';
import { setup, sessionFor, type TestEnv } from '../helpers.js';

const hold = vi.hoisted(() => ({ auditFails: false }));

vi.mock('../../src/lib/audit.js', async (original) => {
  const real = await original<typeof import('../../src/lib/audit.js')>();
  return {
    ...real,
    audit: (async (db, entry) => {
      if (hold.auditFails && entry.action === 'test_populate') throw new Error('The audit log is unavailable (made up)');
      return real.audit(db, entry);
    }) as typeof real.audit,
  };
});
vi.mock('../../src/testdata/populate.js', async (original) => ({
  ...(await original<typeof import('../../src/testdata/populate.js')>()),
  populate: async () => ({ from: '2025-03-01', to: '2026-11-11', invoices: 1, quotes: 0, sales: 0, costs: 0, payRuns: 0 }),
}));

describe('the filling puts back what it set up', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup({ env: { TEST_SERVER: 'true' } });
    await env.sql`delete from workers`;
    await env.sql`update settings set setup_done = true, month_end_mode = 'auto'`;
  });
  afterAll(async () => env.close());

  const fillingSessions = async () => (await env.sql`select 1 from sessions where user_agent = ${FILLING_SESSION}`).length;
  const mode = async () => (await env.sql<{ monthEndMode: string }[]>`select month_end_mode from settings`)[0]!.monthEndMode;

  it('failing before it begins: month end back, its sign-in gone, and it can be tried again', async () => {
    const owner = await sessionFor(env, 'owner@example.co.za');
    hold.auditFails = true;
    const res = await owner.call({ method: 'POST', url: '/api/test-server/populate', payload: {} });
    hold.auditFails = false;
    expect(res.statusCode).toBe(500);
    expect(await fillingSessions()).toBe(0);
    expect(await mode()).toBe('auto');
    expect((await owner.get('/api/test-server')).fill.running).toBe(false);
    // Not left "busy": the next try gets going.
    expect((await owner.call({ method: 'POST', url: '/api/test-server/populate', payload: {} })).statusCode).toBe(200);
  });

  it('says done only once month end is back and its sign-in gone', async () => {
    // (The filling started in the test before; it finishes at once here.)
    const owner = await sessionFor(env, 'owner@example.co.za');
    for (let i = 0; i < 200; i++) {
      const s = await owner.get('/api/test-server');
      if (!s.fill.running && s.fill.finishedAt) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect((await owner.get('/api/test-server')).fill.summary.invoices).toBe(1);
    expect(await mode()).toBe('auto');
    expect(await fillingSessions()).toBe(0);
  });

  it('a browser signing in as "the filling" is kept as a browser', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'owner@example.co.za', password: 'test-password-1' },
      headers: { 'x-shap-version': appVersion(), 'user-agent': FILLING_SESSION },
    });
    expect(res.statusCode).toBe(200);
    expect(await fillingSessions()).toBe(0);
    expect((await env.sql`select 1 from sessions where user_agent = ${`(a browser) ${FILLING_SESSION}`}`).length).toBe(1);
  });
});
