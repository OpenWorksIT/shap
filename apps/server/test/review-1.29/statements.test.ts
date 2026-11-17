/**
 * From the IFRS for SMEs review of Shap 1.29 and Pocket 1.11 (CPDAUDIT.md), in the statements code
 * Shap and Shap Pocket share: a cost put right as an asset by journal is an asset bought, not
 * negative depreciation (IFRS for SMEs 7.5, 7.8); books that begin with the opening balances moved
 * in say so (3.14). Each test fails without its fix. All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildStatements } from '../../src/statements/build.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

const FY = '2026-02-28';

describe('the statements code shared with Shap Pocket (IFRS 4 and 6)', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let r: Awaited<ReturnType<typeof ref>>;
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    r = await ref(env.sql);
  });
  afterAll(async () => env.close());

  it('a cost put right as an asset by journal is an asset bought, not negative depreciation', async () => {
    await me.post('/api/journals', { date: '2025-04-01', description: 'Shares issued (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 3_000_000 }, { accountId: await r.acc('share_capital'), creditCents: 3_000_000 }] });
    await me.post('/api/journals', { date: '2025-05-01', description: 'Made-up compressor, as an expense', lines: [{ accountId: await r.acc('depreciation'), debitCents: 2_000_000 }, { accountId: await r.acc('bank'), creditCents: 2_000_000 }] });
    await me.post('/api/journals', { date: '2025-05-02', description: 'Made-up compressor put right', lines: [{ accountId: await r.acc('fixed_assets'), debitCents: 2_000_000 }, { accountId: await r.acc('depreciation'), creditCents: 2_000_000 }] });
    const s = await buildStatements(env.sql, FY);
    expect(s.scf.investing.find((l) => l.key === 'ppe')?.current).toBe(-2_000_000);
    expect(s.scf.operating.find((l) => l.key === 'depreciation')?.current ?? 0).toBe(0);
    await expectCleanAudit(env.sql, FY);
  });

  it('books that begin with opening balances moved in say the years shown start from nil before them', async () => {
    const fresh = await setup();
    try {
      const rr = await ref(fresh.sql);
      const [j] = await fresh.sql<{ id: string }[]>`insert into journals (date, description, reference, kind) values ('2025-02-28', 'Opening balances (made up)', 'Moved in', 'opening') returning id`;
      await fresh.sql`insert into journal_lines (journal_id, account_id, debit_cents, credit_cents) values (${j!.id}, ${await rr.acc('bank')}, 1000000, 0), (${j!.id}, ${await rr.acc('retained_earnings')}, 0, 1000000)`;
      const s = await buildStatements(fresh.sql, FY);
      const c = s.checks.find((x) => x.label === 'The opening position is in the books');
      expect(c?.ok).toBe(false);
      expect(c?.detail).toMatch(/opening balances moved in on 28 Feb 2025/);
      expect((await buildStatements(fresh.sql, '2027-02-28')).checks.find((x) => x.label === 'The opening position is in the books')).toBeUndefined();
      await expectCleanAudit(fresh.sql, FY);
    } finally {
      await fresh.close();
    }
  });
});
