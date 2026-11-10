/**
 * From the independent review of 1.22 (it failed before the fix): approving the statements calls agreeYear, which deletes the tracker import's
 * trial-balance journal (kind 'import') dated on or before the year end. The statements were
 * signed WITH it; the year is then agreed and closed WITHOUT it. Made-up data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildStatements } from '../../src/statements/build.js';
import { figuresHash } from '../../src/modules/financial-statements.js';
import { balance, login, ref, setup, type TestEnv, expectCleanAudit } from '../helpers.js';

const Y = '2026-02-28';

describe('approving after a tracker import', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, companyName: 'Made-up Builders (Pty) Ltd', features: { ...settings.features, statements: true } }, 'PUT');
    const r = await ref(env.sql);
    await me.post('/api/journals', { date: '2025-03-02', description: 'Shares (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 10_000 }, { accountId: await r.acc('share_capital'), creditCents: 10_000 }] });
    // What the tracker import writes when it agrees the bank and the owner's loan to the tracker's
    // trial balance (import/apply.ts: kind 'import'), here at the start of the year.
    const [j] = await env.sql<{ id: string }[]>`insert into journals (date, description, reference, kind) values ('2025-03-01', 'Agree balances to the trial balance (made up)', 'Tracker import', 'import') returning id`;
    await env.sql`insert into journal_lines (journal_id, account_id, debit_cents, credit_cents, memo) values
      (${j!.id}, ${await r.acc('bank')}, 3_000_000, 0, ''), (${j!.id}, ${await r.acc('owner_loan')}, 0, 3_000_000, '')`;
  });
  afterAll(() => env.close());

  it('agrees the year at exactly the figures signed (the tracker’s journal kept)', async () => {
    const before = await buildStatements(env.sql, Y);
    const bankBefore = await balance(env.sql, 'bank', Y);
    const file = await me.post('/api/attachments', { filename: 'report.pdf', mime: 'application/pdf', dataBase64: Buffer.from('%PDF-1.4\n% made up\n').toString('base64') });
    await me.post(`/api/statements/${Y}/compiler-report`, { attachmentId: file.id, compilerName: 'Made-up Accountant', date: '2026-04-01' });
    await me.post(`/api/statements/${Y}/approve`, { name: 'Made-up Director', date: '2026-04-02' });
    const after = await buildStatements(env.sql, Y);
    const bankAfter = await balance(env.sql, 'bank', Y);
    const view = await me.get(`/api/statements/${Y}`);
    expect(figuresHash(after)).toBe(figuresHash(before));
  });

  it('leaves the books clean', async () => {
    await expectCleanAudit(env.sql, '2026-07-31');
  });
});
