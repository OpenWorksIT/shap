/**
 * The eighth round of 1.33's reviews (security): the long_journal check counts lines per journal_id by the string the file
 * spells, lowercased with braces and hyphens stripped, but keys anything else by the value itself.
 * A JSON array holding the id (["…"], [["…"]]) is a new key every line, yet the database driver
 * sends it as the plain id ('' + x), and Postgres puts every such line on one journal: 6 000 lines,
 * each counted once, pass shareProblem and cost the receiving Shap n x n. All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shareProblem } from '@shap/shared';
import { makeShare, practiceAndPhone } from '../accountant/phone.js';
import { expectCleanAudit } from '../helpers.js';

const BOOKS = '6c8e0a2d-4f6b-4c8d-8e2f-3a4b5c6d7e8f';

describe('a Pocket share holding one long journal, its id wrapped in an array', () => {
  let t: Awaited<ReturnType<typeof practiceAndPhone>>;
  let id: string;
  beforeAll(async () => {
    t = await practiceAndPhone(`${new URL(process.env.DATABASE_URL!).pathname.slice(1)}_arr_phone`);
    const { me, r } = t;
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, companyName: 'Made-up Wrapper (Pty) Ltd', businessType: 'company', fyEndMonth: 2, features: { ...settings.features, statements: true } }, 'PUT');
    const [u] = await t.phone.sql<{ id: string }[]>`select id from users limit 1`;
    const [j] = await t.phone.sql<{ id: string }[]>`insert into journals (date, description, reference, kind, created_by) values ('2026-10-01', 'Made-up long journal', '', 'manual', ${u!.id}) returning id`;
    await t.phone.sql`insert into journal_lines (journal_id, account_id, debit_cents, credit_cents, memo)
      select ${j!.id}::uuid, ${await r.acc('revenue_other')}::uuid, 0, 1, '' from generate_series(1, 5999)
      union all select ${j!.id}::uuid, ${await r.acc('bank')}::uuid, 5999, 0, ''`;
    id = await t.client('Made-up Wrapper (Pty) Ltd');
  });
  afterAll(async () => {
    await expectCleanAudit(t.phone.sql);
    await t.close();
  }, 120_000);

  it('is turned away as one journal, whatever JSON holds its id', async () => {
    const share = await makeShare(t.phone.sql, { number: 1, madeAt: '2026-11-10T08:00:00.000Z', through: '2026-11-10', books: BOOKS });
    const lines = share.records.journal_lines!;
    (lines as Record<string, unknown>[]).forEach((l, i) => (l.journal_id = i % 2 ? [String(l.journal_id)] : [[String(l.journal_id)]]));
    // The check alone: it must see one journal of 6 000 lines.
    expect(shareProblem(share)?.kind).toBe('long_journal');
    const started = Date.now();
    const res = await t.bringIn(id, share);
    const took = Date.now() - started;
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toMatch(/1 000 lines/);
    expect(took).toBeLessThan(2000);
  });
});
