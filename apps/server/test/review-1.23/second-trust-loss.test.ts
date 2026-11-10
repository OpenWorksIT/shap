/**
 * From the second review of 1.23, of the fixes (it failed before this fix): a trust that gives its beneficiaries more than the year's
 * income (from what it kept in earlier years) makes no assessed loss: only the year's income is
 * taxed in the beneficiaries' hands (s25B), and handing out capital isn't a deduction. Shap takes
 * every distribution off the year's result, so the excess becomes a "loss" carried forward and
 * the next years' estimates come out too low. All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildStatements } from '../../src/statements/build.js';
import { taxPack } from '../../src/modules/tax-pack.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

const FY = '2026-02-28';

describe('a trust that distributes more than a year’s income', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
    const me = await login(env.app, 'owner@example.co.za');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, businessType: 'trust', companyName: 'Fictional Family Trust', features: { ...settings.features, statements: true, dividends: true } }, 'PUT');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    const bankAcc = await r.acc('bank');
    const rev = await r.acc('revenue_other');
    const j = (date: string, cents: number) => me.post('/api/journals', { date, description: 'Income (made up)', lines: [{ accountId: bankAcc, debitCents: cents }, { accountId: rev, creditCents: cents }] });
    // Year to Feb 2024: R50 000 kept (taxed in the trust). Year to Feb 2025: R100 000 of income, R150 000 given out.
    await j('2023-06-30', 5_000_000);
    await j('2024-06-30', 10_000_000);
    const res = await me.call({ method: 'POST', url: '/api/dividends', payload: { declaredOn: '2025-02-20', paidOn: '2025-02-25', shareholder: 'Fictional Beneficiary', grossCents: 15_000_000, conduit: true, sourceId: bank } });
    expect(res.statusCode, res.body).toBe(200);
    // Year to Feb 2026: R100 000, kept.
    await j('2025-06-30', 10_000_000);
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('carries no assessed loss into the year to Feb 2026', async () => {
    const t = await taxPack(env.sql, FY);
    expect(t.assessedLossCents).toBe(0);
    expect(t.estimate.taxableCents).toBe(10_000_000);
    const s = await buildStatements(env.sql, FY);
    expect(s.taxEstimate?.assessedLossCents ?? 0).toBe(0);
  });
});
