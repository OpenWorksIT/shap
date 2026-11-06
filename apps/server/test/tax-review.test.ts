/** November 2026 tax review: the cases that came out wrong, worked by hand from SARS's rules. */
import { businessDayOnOrBefore, companyTax, dwtDue, emp201Due, estimateTax, individualTax, lineTotal, microDividendTax, payLine, provisionalPayable, publicHolidays, roundCents, turnoverTaxLimit, vat201Due, vatOn } from '@shap/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, ref, setup, type TestEnv } from './helpers.js';

describe('sums', () => {
  it('caps retirement contributions at R430 000 from the year to February 2027', () => {
    // R2m profit, R430 000 into a retirement annuity: all of it comes off.
    const e = estimateTax({ kind: 'individual', profitCents: 200_000_000, assessedLossCents: 0, fyEnd: '2027-02-28', retirementCents: 43_000_000 });
    expect(e.retirementDeductionCents).toBe(43_000_000);
    expect(e.taxCents).toBe(individualTax(157_000_000, '2027-02-28'));
    expect(e.taxCents).toBe(52_199_300);
  });

  it('takes PAYE off a salary out of provisional tax', () => {
    // R200 000 profit and a R300 000 salary: the year's tax on R500 000, less the PAYE on the salary.
    const tax = individualTax(50_000_000, '2027-02-28');
    const paye = individualTax(30_000_000, '2027-02-28');
    expect(provisionalPayable({ taxCents: tax, payeCents: paye, period: 1 }).payableCents).toBe(Math.round(tax / 2) - Math.round(paye / 2));
    expect(provisionalPayable({ taxCents: tax, payeCents: paye, period: 1 }).payableCents).toBe(2_892_250);
    expect(provisionalPayable({ taxCents: tax, payeCents: paye, period: 2, paidCents: 2_892_250 }).payableCents).toBe(tax - paye - 2_892_250);
  });

  it('uses the older tables for older years', () => {
    expect(individualTax(30_000_000, '2023-02-28')).toBe(4_349_500);
    expect(companyTax(100_000_000, '2022-12-31', false)).toBe(28_000_000);
    expect(companyTax(100_000_000, '2023-03-31', false)).toBe(27_000_000);
    expect(companyTax(20_000_000, '2023-03-31', true)).toBe(761_250);
    expect(turnoverTaxLimit('2026-02-28')).toBe(100_000_000);
    expect(turnoverTaxLimit('2027-02-28')).toBe(230_000_000);
  });

  it('withholds the year’s tax on two bonuses and on regular overtime', () => {
    // R25 000 a month, R80 000 bonuses in August and February: the year's PAYE is the tax on R460 000.
    const months = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02'];
    let before = 0;
    let paye = 0;
    for (const m of months) {
      const extra = m === '2026-08' || m === '2027-02' ? 8_000_000 : 0;
      paye += payLine({ salaryCents: 2_500_000, extraCents: extra, extraBeforeCents: before, payDate: `${m}-25` }).payeCents;
      before += extra;
    }
    expect(Math.abs(paye - individualTax(46_000_000, '2027-02-28'))).toBeLessThanOrEqual(12);
    // R20 000 salary and R3 000 overtime every month: the tax on R276 000.
    let ot = 0;
    for (const m of months) ot += payLine({ salaryCents: 2_000_000, overtimeCents: 300_000, payDate: `${m}-25` }).payeCents;
    expect(Math.abs(ot - individualTax(27_600_000, '2027-02-28'))).toBeLessThanOrEqual(12);
  });

  it('leaves commission out of UIF', () => {
    const p = payLine({ salaryCents: 600_000, commissionCents: 400_000, payDate: '2026-11-25' });
    expect(p.grossCents).toBe(1_000_000);
    expect(p.uifEmployeeCents).toBe(6_000);
    expect(p.uifEmployerCents).toBe(6_000);
  });

  it('exempts a micro business’s first R200 000 of dividends a year', () => {
    expect(microDividendTax(15_000_000, 0)).toBe(0);
    expect(microDividendTax(15_000_000, 10_000_000)).toBe(1_000_000); // R50 000 over: 20%
    expect(microDividendTax(5_000_000, 25_000_000)).toBe(1_000_000);
  });

  it('knows South Africa’s public holidays for due dates', () => {
    expect(publicHolidays(2029).has('2029-03-30')).toBe(true); // Good Friday
    expect(publicHolidays(2029).has('2029-04-02')).toBe(true); // Family Day
    expect(publicHolidays(2026).has('2026-08-10')).toBe(true); // Women's Day on a Sunday: Monday off
    expect(vat201Due('2029-02-28')).toBe('2029-03-29');
    expect(emp201Due('2023-03')).toBe('2023-04-06');
    expect(dwtDue('2029-02-10')).toBe('2029-03-29');
    expect(businessDayOnOrBefore('2026-12-26')).toBe('2026-12-24');
  });

  it('rounds money like Postgres does', () => {
    expect(lineTotal(1.005, 100)).toBe(101);
    expect(vatOn(-10, 1500)).toBe(-2);
    expect(vatOn(10, 1500)).toBe(2);
    expect(roundCents(-0.4)).toBe(0);
  });
});

describe('in the books', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let bank: string;
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    bank = await (await ref(env.sql)).src('Business bank');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, fyEndMonth: 2, turnoverTax: true, features: { ...settings.features, payroll: true, dividends: true } }, 'PUT');
  });
  afterAll(() => env.close());

  it('puts a pay run’s tax on the EMP201 for the month it was paid', async () => {
    await me.post('/api/employees', { name: 'Fictional Employee', salaryCents: 2_000_000, startDate: '2026-01-01' });
    const run = await me.post('/api/pay-runs', { period: '2027-02', payDate: '2027-03-01', sourceId: bank });
    await me.post(`/api/pay-runs/${run.id}/finalise`);
    const sars = await me.get('/api/payroll/sars');
    expect(sars.emp201.map((r: { period: string }) => r.period)).toEqual(['2027-03']);
    expect(sars.emp201[0].dueOn).toBe('2027-04-07');
  });

  it('charges no dividends tax on a micro business’s first R200 000 of dividends', async () => {
    await me.post('/api/dividends', { declaredOn: '2026-10-01', paidOn: '2026-10-01', shareholder: 'Fictional Owner', grossCents: 15_000_000, sourceId: bank });
    await me.post('/api/dividends', { declaredOn: '2026-11-01', paidOn: '2026-11-01', shareholder: 'Fictional Owner', grossCents: 10_000_000, sourceId: bank });
    const { dividends } = await me.get('/api/dividends');
    expect(dividends.map((d: { dwtCents: number }) => Number(d.dwtCents)).sort()).toEqual([0, 1_000_000]);
  });

  it('counts half of what selling an asset brought in as turnover', async () => {
    const a = await me.post('/api/assets', { name: 'Trailer', category: 'equipment', purchaseDate: '2026-03-15', costCents: 2_000_000, sourceId: bank, lifeMonths: 60 });
    await me.post(`/api/assets/${a.id}`, { name: 'Trailer', category: 'equipment', purchaseDate: '2026-03-15', costCents: 2_000_000, sourceId: bank, lifeMonths: 60, disposedOn: '2026-06-15', disposalProceedsCents: 1_800_000, disposalSourceId: bank }, 'PUT');
    const t = await me.get('/api/reports/turnover-tax?fyEnd=2027-02-28');
    expect(t.halfOfAssetSalesCents).toBe(900_000);
    expect(t.turnoverCents).toBe(900_000);
  });
});
