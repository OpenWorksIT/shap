/**
 * The seventh round of 1.33's reviews (security): the long_journal check counts lines per journal_id as the file spells it.
 * Postgres reads a uuid whatever its case, with or without braces or hyphens, so one journal's
 * lines spelled six ways (each 1 000 or fewer) pass shareProblem and still land on one journal,
 * whose deferred balance check then costs n x n. All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeShare, practiceAndPhone } from '../accountant/phone.js';
import { expectCleanAudit } from '../helpers.js';

const BOOKS = '5b7d9f1c-3e5a-4b7c-9d1e-2f3a4b5c6d7e';

describe('a Pocket share holding one long journal, its id spelled several ways', () => {
  let t: Awaited<ReturnType<typeof practiceAndPhone>>;
  let id: string;
  beforeAll(async () => {
    t = await practiceAndPhone(`${new URL(process.env.DATABASE_URL!).pathname.slice(1)}_spell_phone`);
    const { me, r } = t;
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, companyName: 'Made-up Spelling (Pty) Ltd', businessType: 'company', fyEndMonth: 2, features: { ...settings.features, statements: true } }, 'PUT');
    const [u] = await t.phone.sql<{ id: string }[]>`select id from users limit 1`;
    const [j] = await t.phone.sql<{ id: string }[]>`insert into journals (date, description, reference, kind, created_by) values ('2026-10-01', 'Made-up long journal', '', 'manual', ${u!.id}) returning id`;
    await t.phone.sql`insert into journal_lines (journal_id, account_id, debit_cents, credit_cents, memo)
      select ${j!.id}::uuid, ${await r.acc('revenue_other')}::uuid, 0, 1, '' from generate_series(1, 5999)
      union all select ${j!.id}::uuid, ${await r.acc('bank')}::uuid, 5999, 0, ''`;
    id = await t.client('Made-up Spelling (Pty) Ltd');
  });
  afterAll(async () => {
    await expectCleanAudit(t.phone.sql);
    await t.close();
  }, 120_000);

  it('is turned away as the same journal, however its id is spelled', async () => {
    const share = await makeShare(t.phone.sql, { number: 1, madeAt: '2026-11-10T08:00:00.000Z', through: '2026-11-10', books: BOOKS });
    const spell = [
      (s: string) => s,
      (s: string) => s.toUpperCase(),
      (s: string) => `{${s}}`,
      (s: string) => `{${s.toUpperCase()}}`,
      (s: string) => s.replace(/-/g, ''),
      (s: string) => s.replace(/-/g, '').toUpperCase(),
    ];
    const lines = share.records.journal_lines!;
    lines.forEach((l, i) => (l.journal_id = spell[Math.floor(i / 1000) % spell.length]!(String(l.journal_id))));
    expect(new Set(lines.map((l) => l.journal_id)).size).toBe(6);
    const started = Date.now();
    const res = await t.bringIn(id, share);
    const took = Date.now() - started;
    console.log('status', res.statusCode, 'took', took, 'ms', res.body.slice(0, 300));
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toMatch(/1 000 lines/);
    expect(took).toBeLessThan(2000);
  });
});
