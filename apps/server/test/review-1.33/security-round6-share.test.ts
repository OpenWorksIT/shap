/**
 * The sixth round of 1.33's reviews (security): the 1 000-line cap on a journal is on what's typed in (journalInput). A Shap
 * Pocket share brought into Shap Accountant puts its journal_lines in as rows, with no cap: one long
 * journal (from a phone before Pocket 1.11.4's cap, or a file made to) still comes in. Each line
 * then runs the balance check (journal_must_balance, deferred, once per line, adding up all of its
 * journal's lines): one journal of n lines costs n x n, so 6 000 lines take seconds, 16 000 about
 * half a minute, and the share's lock is held throughout. A second database plays the phone. All
 * data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeShare, practiceAndPhone } from '../accountant/phone.js';
import { expectCleanAudit } from '../helpers.js';

const BOOKS = '4a6c8e0b-2d4f-4a6b-8c0d-1e2f3a4b5c6d';

describe('a Pocket share holding one very long journal', () => {
  let t: Awaited<ReturnType<typeof practiceAndPhone>>;
  let id: string;
  beforeAll(async () => {
    t = await practiceAndPhone(`${new URL(process.env.DATABASE_URL!).pathname.slice(1)}_long_phone`);
    const { me, r } = t;
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, companyName: 'Made-up Long Lines (Pty) Ltd', businessType: 'company', fyEndMonth: 2, features: { ...settings.features, statements: true } }, 'PUT');
    // A journal of 6 000 lines on the phone, as Pocket took before its cap (or a file made so).
    const [u] = await t.phone.sql<{ id: string }[]>`select id from users limit 1`;
    const [j] = await t.phone.sql<{ id: string }[]>`insert into journals (date, description, reference, kind, created_by) values ('2026-10-01', 'Made-up long journal', '', 'manual', ${u!.id}) returning id`;
    await t.phone.sql`insert into journal_lines (journal_id, account_id, debit_cents, credit_cents, memo)
      select ${j!.id}::uuid, ${await r.acc('revenue_other')}::uuid, 0, 1, '' from generate_series(1, 5999)
      union all select ${j!.id}::uuid, ${await r.acc('bank')}::uuid, 5999, 0, ''`;
    id = await t.client('Made-up Long Lines (Pty) Ltd');
  });
  afterAll(async () => {
    await expectCleanAudit(t.phone.sql);
    await t.close();
  }, 120_000);

  it('is turned away plainly, in good time, as a journal typed in would be', async () => {
    const share = await makeShare(t.phone.sql, { number: 1, madeAt: '2026-11-10T08:00:00.000Z', through: '2026-11-10', books: BOOKS });
    const started = Date.now();
    const res = await t.bringIn(id, share);
    const took = Date.now() - started;
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toMatch(/1 000 lines/);
    expect(took).toBeLessThan(2000);
  });
});
