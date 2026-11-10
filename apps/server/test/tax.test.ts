/** Sole proprietors' income tax, and the VAT registration threshold. */
import { estimateTax, individualTax, individualThreshold, retirementDeduction, vatThresholds, vatWatch } from '@shap/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vatStatus } from '../src/modules/vat.js';
import { login, setup, type TestEnv } from './helpers.js';

describe('tax for individuals (SARS tables)', () => {
  it('uses the 2027 table and rebates', () => {
    // R300 000: R44 118 + 26% of R54 900 = R58 392, less the R17 820 primary rebate.
    expect(individualTax(30_000_000, '2027-02-28')).toBe(4_057_200);
    // At the tax threshold nothing is due.
    expect(individualTax(9_900_000, '2027-02-28')).toBe(0);
    expect(individualTax(10_000_000, '2027-02-28')).toBe(18_000);
    // 65 to 74: R36 000 less R17 820 + R9 765.
    expect(individualTax(20_000_000, '2027-02-28', '65to74')).toBe(841_500);
    // Top rate: R666 339 + 45% of R121 400, less R17 820.
    expect(individualTax(200_000_000, '2027-02-28')).toBe(70_314_900);
  });

  it('uses the earlier table for 2026 and before', () => {
    // R42 678 + 26% of R62 900 = R59 032, less R17 235.
    expect(individualTax(30_000_000, '2026-02-28')).toBe(4_179_700);
    expect(individualTax(30_000_000, '2024-02-29')).toBe(4_179_700);
  });

  it('agrees with SARS on the tax thresholds', () => {
    expect(individualThreshold('2027-02-28', 'under65')).toBe(9_900_000);
    expect(individualThreshold('2027-02-28', '65to74')).toBe(15_325_000);
    expect(individualThreshold('2027-02-28', '75plus')).toBe(17_130_000);
    expect(individualThreshold('2026-02-28', 'under65')).toBe(9_575_000);
    expect(individualThreshold('2026-02-28', '65to74')).toBe(14_821_700);
  });

  it('limits retirement contributions to 27.5% of income and R350 000', () => {
    expect(retirementDeduction(5_000_000, 10_000_000, '2027-02-28')).toBe(2_750_000);
    expect(retirementDeduction(1_000_000, 10_000_000, '2027-02-28')).toBe(1_000_000);
    // The cap: R350 000 up to the year to February 2026, R430 000 from the year to February 2027 (Budget 2026).
    expect(retirementDeduction(80_000_000, 500_000_000, '2026-02-28')).toBe(35_000_000);
    expect(retirementDeduction(80_000_000, 500_000_000, '2027-02-28')).toBe(43_000_000);
  });

  it('adds other income and takes off the retirement deduction', () => {
    const e = estimateTax({ kind: 'individual', profitCents: 25_000_000, otherIncomeCents: 5_000_000, retirementCents: 3_000_000, assessedLossCents: 0, fyEnd: '2027-02-28' });
    expect(e).toEqual({ taxableCents: 27_000_000, retirementDeductionCents: 3_000_000, taxCents: individualTax(27_000_000, '2027-02-28') });
    expect(estimateTax({ kind: 'company', profitCents: 20_000_000, assessedLossCents: 0, fyEnd: '2027-02-28', sbc: true }).taxCents).toBe(707_000);
  });
});

describe('VAT registration threshold', () => {
  it('moved to R2.3 million on 1 April 2026', () => {
    expect(vatThresholds('2026-03-31')).toMatchObject({ compulsoryCents: 100_000_000, voluntaryCents: 5_000_000 });
    expect(vatThresholds('2026-04-01')).toMatchObject({ compulsoryCents: 230_000_000, voluntaryCents: 12_000_000 });
  });

  it('warns when near, and says so plainly when over', () => {
    const on = '2026-11-01';
    expect(vatWatch(100_000_000, 100_000_000, on).state).toBe('voluntary');
    expect(vatWatch(5_000_000, 5_000_000, on).state).toBe(null);
    expect(vatWatch(185_000_000, 150_000_000, on).state).toBe('near');
    // Not 80% of the way yet, but the last three months are running at more than the line.
    expect(vatWatch(120_000_000, 240_000_000, on).state).toBe('near');
    expect(vatWatch(231_000_000, 200_000_000, on).state).toBe('over');
  });
});

describe('a sole proprietor in the app', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
  });
  afterAll(() => env.close());

  const ownerAccount = async () => (await env.sql<{ name: string; type: string }[]>`select name, type from accounts where system_key = 'owner_loan'`)[0]!;

  it('switches the year to February and the owner’s account to capital and drawings', async () => {
    const s = (await owner.get('/api/reference')).settings;
    const saved = await owner.post('/api/settings', { ...s, businessType: 'sole_prop', fyEndMonth: 6, lockDate: s.lockDate ?? null }, 'PUT');
    expect(saved).toMatchObject({ businessType: 'sole_prop', fyEndMonth: 2 });
    expect(await ownerAccount()).toEqual({ name: 'Owner’s capital and drawings', type: 'equity' });
    const r = await owner.get('/api/reports/provisional-tax?fyEnd=2027-02-28&asAt=2026-05-31');
    expect(r.businessType).toBe('sole_prop');
    expect(r.lines.some((l: { name: string }) => /director/i.test(l.name))).toBe(false);
    // Back to a company: the loan account returns.
    await owner.post('/api/settings', { ...saved, businessType: 'company' }, 'PUT');
    expect(await ownerAccount()).toEqual({ name: 'Owner’s loan account', type: 'liability' });
    await owner.post('/api/settings', { ...saved, businessType: 'sole_prop' }, 'PUT');
  });

  it('keeps an owner’s account name they chose', async () => {
    await env.sql`update accounts set name = 'My money in the business' where system_key = 'owner_loan'`;
    const s = (await owner.get('/api/reference')).settings;
    await owner.post('/api/settings', { ...s, businessType: 'company' }, 'PUT');
    expect(await ownerAccount()).toEqual({ name: 'My money in the business', type: 'liability' });
    await owner.post('/api/settings', { ...s, businessType: 'sole_prop' }, 'PUT');
    expect((await ownerAccount()).type).toBe('equity');
  });

  it('saves an estimate on the tables for individuals', async () => {
    const saved = await owner.post('/api/tax-estimates', {
      fyEnd: '2027-02-28',
      period: 1,
      asAt: '2026-05-31',
      kind: 'individual',
      ageBand: 'under65',
      otherIncomeCents: 0,
      retirementCents: 0,
      lines: [{ accountId: null, name: 'Sales', type: 'income', actualCents: 0, projectedCents: 30_000_000 }],
    });
    expect(saved).toMatchObject({ taxableCents: 30_000_000, taxCents: 4_057_200, payableCents: 2_028_600 });
  });

  it('balances with the owner’s account as equity', async () => {
    const bs = await owner.get('/api/reports/balance-sheet');
    expect(bs.differenceCents).toBe(0);
  });

  it('watches the VAT threshold until registered', async () => {
    const client = await owner.post('/api/clients', { name: 'Big Client' });
    const inv = await owner.post('/api/documents', {
      kind: 'invoice',
      clientId: client.id,
      issueDate: '2026-10-15',
      lines: [{ category: 'labour', description: 'Rewiring, three blocks', qty: 1, unitPriceCents: 190_000_000 }],
    });
    await owner.post(`/api/documents/${inv.id}/issue`);
    const near = await vatStatus(env.sql, '2026-11-01');
    expect(near.state).toBe('near');
    expect(near.last12Cents).toBeGreaterThanOrEqual(190_000_000);
    expect((await owner.get('/api/dashboard')).vat.state).toBeTruthy();
    const more = await owner.post('/api/documents', {
      kind: 'invoice',
      clientId: client.id,
      issueDate: '2026-10-20',
      lines: [{ category: 'labour', description: 'Rewiring, two more blocks', qty: 1, unitPriceCents: 50_000_000 }],
    });
    await owner.post(`/api/documents/${more.id}/issue`);
    expect((await vatStatus(env.sql, '2026-11-01')).state).toBe('over');
    // Any 12 months in a row count: a year on, the 12 months to October 2026 were still over the line.
    expect(await vatStatus(env.sql, '2027-11-01')).toMatchObject({ state: 'over', last12Cents: 0, peak12Cents: 240_000_000, peakTo: '2026-10-31' });
    // Only once it's more than two years back does Shap stop pointing at it.
    expect((await vatStatus(env.sql, '2029-11-01')).state).toBe(null);
    await env.sql`update settings set vat_registered = true`;
    expect(await vatStatus(env.sql, '2026-11-01')).toMatchObject({ registered: true, state: null });
  });
});

describe('SARS’s figures for the year we’re in', () => {
  it('have been checked for the current year of assessment (the standard update on a new tax year, CPDAUDIT.md)', async () => {
    const { SARS_CHECKED_TO, taxYearEnd, todayIso } = await import('@shap/shared');
    // From 1 March, this fails until the new year's tables are checked against SARS and put in,
    // and SARS_CHECKED_TO (packages/shared/src/tax.ts) is moved on: docs/SARS.md says where each is.
    expect(taxYearEnd(todayIso()) <= SARS_CHECKED_TO, `the year to ${taxYearEnd(todayIso())} hasn't been checked against SARS: see CPDAUDIT.md, "When SARS changes something"`).toBe(true);
  });
});
