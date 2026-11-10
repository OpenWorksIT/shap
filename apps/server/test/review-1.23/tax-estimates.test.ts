/**
 * From the independent review of 1.23 (each failed before the fix): the assessed loss brought
 * forward was the net of every earlier year, so a profit before a loss used it up (South Africa
 * has no carry-back); a company's set-off wasn't limited to the greater of R1 million and 80% of
 * its taxable income (s20(1)(a)(ii), years ending on or after 31 March 2023); and the statements
 * taxed a trust on income it gave its beneficiaries, which the tax pack didn't. All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assessedLossCarried, assessedLossSetOff, companyTax, estimateTax } from '@shap/shared';
import { buildStatements } from '../../src/statements/build.js';
import { taxPack } from '../../src/modules/tax-pack.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

const FY = '2026-02-28';

describe('the assessed loss, worked out', () => {
  it('carries each year’s loss forward, used only by later profits', () => {
    // Profit R100 000, then a loss of R60 000, then a profit.
    expect(assessedLossCarried('company', [{ fyEnd: '2024-02-29', profitCents: 10_000_000 }, { fyEnd: '2025-02-28', profitCents: -6_000_000 }])).toBe(6_000_000);
    expect(assessedLossCarried('company', [{ fyEnd: '2024-02-29', profitCents: -6_000_000 }, { fyEnd: '2025-02-28', profitCents: 2_000_000 }])).toBe(4_000_000);
    expect(assessedLossCarried('partners', [{ fyEnd: '2025-02-28', profitCents: -6_000_000 }])).toBe(0);
  });

  it('limits a company’s set-off to the greater of R1 million and 80% of its income, from years ending 31 March 2023', () => {
    // R5 million of income, R10 million of loss: R4 million set off (80%), R1 million taxed.
    expect(assessedLossSetOff('company', 500_000_000, 1_000_000_000, '2026-02-28')).toBe(400_000_000);
    // Under R1.25 million of income, R1 million (or all of it) can be set off.
    expect(assessedLossSetOff('company', 110_000_000, 1_000_000_000, '2026-02-28')).toBe(100_000_000);
    expect(assessedLossSetOff('company', 50_000_000, 1_000_000_000, '2026-02-28')).toBe(50_000_000);
    // Before the limit, and for individuals: all of it.
    expect(assessedLossSetOff('company', 500_000_000, 1_000_000_000, '2023-02-28')).toBe(500_000_000);
    expect(assessedLossSetOff('individual', 500_000_000, 1_000_000_000, '2026-02-28')).toBe(500_000_000);
    expect(estimateTax({ kind: 'company', profitCents: 500_000_000, assessedLossCents: 1_000_000_000, fyEnd: '2026-02-28', sbc: false }).taxableCents).toBe(100_000_000);
    // The rest carries on to the next year.
    expect(assessedLossCarried('company', [{ fyEnd: '2025-02-28', profitCents: -1_000_000_000 }, { fyEnd: '2026-02-28', profitCents: 500_000_000 }])).toBe(600_000_000);
  });
});

describe('the assessed loss, from the books', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
    const me = await login(env.app, 'owner@example.co.za');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, companyName: 'Fictional Losses (Pty) Ltd', features: { ...settings.features, statements: true } }, 'PUT');
    const r = await ref(env.sql);
    const bank = await r.acc('bank');
    const revenue = await r.acc('revenue_other');
    const sundry = (await env.sql<{ id: string }[]>`select id from accounts where type = 'expense' and system_key is null limit 1`)[0]!.id;
    const j = (date: string, debit: string, credit: string, cents: number) =>
      me.post('/api/journals', { date, description: 'Made up', lines: [{ accountId: debit, debitCents: cents }, { accountId: credit, creditCents: cents }] });
    // Year to Feb 2024: R100 000 profit. Year to Feb 2025: R60 000 loss. Year to Feb 2026: R200 000 profit.
    await j('2023-06-30', bank, revenue, 10_000_000);
    await j('2024-06-30', sundry, bank, 6_000_000);
    await j('2025-06-30', bank, revenue, 20_000_000);
  });
  afterAll(() => env.close());

  it('carries the year to Feb 2025’s loss to the year to Feb 2026, the same everywhere', async () => {
    const s = await buildStatements(env.sql, FY);
    const t = await taxPack(env.sql, FY);
    expect(s.taxEstimate?.assessedLossCents).toBe(6_000_000);
    expect(t.assessedLossCents).toBe(6_000_000);
    expect(s.taxEstimate?.taxCents).toBe(companyTax(14_000_000, FY, false));
    const me = await login(env.app, 'owner@example.co.za');
    expect((await me.get(`/api/reports/provisional-tax?fyEnd=${FY}&asAt=${FY}`)).assessedLossCents).toBe(6_000_000);
    await expectCleanAudit(env.sql, FY);
  });
});

describe('a trust that gives its income to its beneficiaries', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
    const me = await login(env.app, 'owner@example.co.za');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, businessType: 'trust', companyName: 'Fictional Family Trust', features: { ...settings.features, statements: true, dividends: true } }, 'PUT');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    await me.post('/api/journals', { date: '2025-06-30', description: 'Income (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 10_000_000 }, { accountId: await r.acc('revenue_other'), creditCents: 10_000_000 }] });
    const res = await me.call({ method: 'POST', url: '/api/dividends', payload: { declaredOn: '2026-02-20', paidOn: '2026-02-25', shareholder: 'Fictional Beneficiary', grossCents: 10_000_000, conduit: true, sourceId: bank } });
    expect(res.statusCode, res.body).toBe(200);
  });
  afterAll(() => env.close());

  it('estimates nothing for the trust, as the tax pack does', async () => {
    const t = await taxPack(env.sql, FY);
    expect(t.estimate.taxCents).toBe(0);
    const s = await buildStatements(env.sql, FY);
    expect(s.taxEstimate).toBeNull();
    expect(s.checks.find((c) => c.label.startsWith('The year’s income tax'))!.ok).toBe(true);
    await expectCleanAudit(env.sql, FY);
  });
});
