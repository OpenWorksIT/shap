/**
 * From the accountant bot's review of the tax and SARS rules (1.23.2; each failed before its fix).
 * A company that qualifies as a small business corporation was estimated at 27% unless a
 * provisional estimate for that very year said otherwise, and the statements and the tax pack could
 * disagree; nothing checked the R20 million gross income limit; any tax in the books (a provisional
 * payment journalled to the expense) hid the estimate; the "Book the tax" button stayed in a year
 * agreed with the accountant (where a journal changes nothing) or closed. Older SBC tables, 2023's
 * medical credits and VAT categories D and E were missing, and provisional tax paid had no place.
 * All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { companyTax, medicalCredit, vatPeriod } from '@shap/shared';
import { buildStatements } from '../../src/statements/build.js';
import { taxPack } from '../../src/modules/tax-pack.js';
import { balance, expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

const FY = '2026-02-28';
const lookOf = (s: Awaited<ReturnType<typeof buildStatements>>) => s.checks.find((c) => c.label.startsWith('The year’s income tax'))!;

async function company(env: TestEnv, revenueCents: number, costsCents = 0) {
  const me = await login(env.app, 'owner@example.co.za');
  const { settings } = await me.get('/api/reference');
  await me.post('/api/settings', { ...settings, businessType: 'company', fyEndMonth: 2, companyName: 'Fictional Sparks (Pty) Ltd', regNumber: '2021/654321/07', features: { ...settings.features, statements: true } }, 'PUT');
  const r = await ref(env.sql);
  await me.post('/api/journals', { date: '2025-06-30', description: 'Made-up income', lines: [{ accountId: await r.acc('bank'), debitCents: revenueCents }, { accountId: await r.acc('revenue_other'), creditCents: revenueCents }] });
  if (costsCents) {
    const sundry = (await env.sql<{ id: string }[]>`select id from accounts where type = 'expense' and system_key is null limit 1`)[0]!.id;
    await me.post('/api/journals', { date: '2025-07-31', description: 'Made-up costs', lines: [{ accountId: sundry, debitCents: costsCents }, { accountId: await r.acc('bank'), creditCents: costsCents }] });
  }
  return { me, r };
}

describe('a small business corporation’s tax, the same everywhere', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    env = await setup();
    ({ me } = await company(env, 40_000_000));
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql, FY);
    await env.close();
  });

  it('shows both figures until the business says whether it qualifies', async () => {
    const s = await buildStatements(env.sql, FY);
    expect(s.taxEstimate).toMatchObject({ sbc: null, sbcTaxCents: 2_619_800, standardTaxCents: 10_800_000 });
    expect(lookOf(s).detail).toMatch(/R\s?26 198,00|R\s?26 198\.00/);
    expect(lookOf(s).detail).toMatch(/R\s?108 000/);
    const t = await taxPack(env.sql, FY);
    expect(t.estimate).toMatchObject({ sbc: null, taxCents: 10_800_000, sbcTaxCents: 2_619_800 });
  });

  it('uses the answer in the statements, the tax pack and the IRP6 alike, whatever estimates were saved', async () => {
    await me.post('/api/settings/sbc', { sbc: true }, 'PUT');
    // A provisional estimate saved without the SBC table doesn't change what the business said.
    await me.post('/api/tax-estimates', { fyEnd: FY, period: 1, asAt: '2025-08-31', sbc: false, lines: [{ accountId: null, name: 'Made-up income', type: 'income', actualCents: 20_000_000, projectedCents: 40_000_000 }] });
    const s = await buildStatements(env.sql, FY);
    const t = await taxPack(env.sql, FY);
    expect(s.taxEstimate).toMatchObject({ sbc: true, taxCents: 2_619_800 });
    expect(t.estimate).toMatchObject({ sbc: true, taxCents: 2_619_800 });
    expect((await me.get(`/api/reports/provisional-tax?fyEnd=${FY}&asAt=${FY}`)).sbc).toBe(true);
    // And settings saved without it keep it.
    const { settings } = await me.get('/api/reference');
    const { sbc: _sbc, ...rest } = settings;
    await me.post('/api/settings', rest, 'PUT');
    expect((await me.get('/api/reference')).settings.sbc).toBe(true);
  });

  it('shows the SBC rates on a line of their own in the tax note, once the tax is booked', async () => {
    const r = await ref(env.sql);
    await me.post('/api/journals', { date: FY, description: 'Income tax for the year (made up)', lines: [{ accountId: await r.acc('income_tax'), debitCents: 2_619_800 }, { accountId: await r.acc('income_tax_payable'), creditCents: 2_619_800 }] });
    const s = await buildStatements(env.sql, FY);
    expect(lookOf(s).ok).toBe(true);
    const rec = s.notes.find((n) => n.key === 'tax')!.tables[1]!.rows.map((x) => [x.label, x.current]);
    expect(rec).toEqual([
      ['Profit before taxation', 40_000_000],
      ['Tax at the company rate (27%)', 10_800_000],
      ['Small business corporation rates (s12E)', 2_619_800 - 10_800_000],
      ['Items not deductible or not taxable, losses, and other differences', 0],
      ['Tax expense', 2_619_800],
    ]);
  });

  it('pays provisional tax off what’s owed to SARS, not into the expense', async () => {
    const r = await ref(env.sql);
    await me.post('/api/sars-payments', { kind: 'irp6', period: '2026-02', date: '2026-02-26', amountCents: 1_300_000, sourceId: await r.src('Business bank') });
    expect(await balance(env.sql, 'income_tax_payable')).toBe(-(2_619_800 - 1_300_000));
    expect((await taxPack(env.sql, FY)).paidToSarsCents).toBe(1_300_000);
  });
});

describe('the small business corporation limits and the look at the tax', () => {
  it('leaves the SBC table out above R20 million of gross income, whatever was said', async () => {
    const env = await setup();
    try {
      const { me } = await company(env, 2_500_000_000, 2_400_000_000);
      await me.post('/api/settings/sbc', { sbc: true }, 'PUT');
      const s = await buildStatements(env.sql, FY);
      expect(s.taxEstimate).toMatchObject({ sbc: false, taxCents: 27_000_000 });
      expect(lookOf(s).detail).toMatch(/over R20 million/);
      expect((await taxPack(env.sql, FY)).estimate).toMatchObject({ sbc: false, taxCents: 27_000_000 });
      await expectCleanAudit(env.sql, FY);
    } finally {
      await env.close();
    }
  });

  it('says when the tax booked is far from the estimate (provisional tax journalled to the expense)', async () => {
    const env = await setup();
    try {
      const { me, r } = await company(env, 40_000_000);
      await me.post('/api/settings/sbc', { sbc: false }, 'PUT');
      await me.post('/api/journals', { date: '2025-08-29', description: 'SARS provisional tax (made up)', lines: [{ accountId: await r.acc('income_tax'), debitCents: 1_000_000 }, { accountId: await r.acc('bank'), creditCents: 1_000_000 }] });
      const look = lookOf(await buildStatements(env.sql, FY));
      expect(look.ok).toBe(false);
      expect(look.detail).toMatch(/booked for the year; Shap estimates/);
      expect(look.detail).toMatch(/Income tax owed \(SARS\)/);
      await expectCleanAudit(env.sql, FY);
    } finally {
      await env.close();
    }
  });

  it('tells the screen when the year is agreed or closed, where booking the tax here would do nothing', async () => {
    const env = await setup();
    try {
      const { me } = await company(env, 40_000_000);
      expect(await me.get(`/api/statements/${FY}`)).toMatchObject({ yearAgreed: false, yearClosed: false });
      await me.post('/api/year-ends', { fyEnd: FY, note: 'Agreed with the accountant (made up)', lock: false, figures: [] }, 'PUT');
      expect(await me.get(`/api/statements/${FY}`)).toMatchObject({ yearAgreed: true, yearClosed: false });
      await env.sql`update settings set lock_date = ${FY}::date`;
      expect(await me.get(`/api/statements/${FY}`)).toMatchObject({ yearAgreed: true, yearClosed: true });
    } finally {
      await env.close();
    }
  });
});

describe('SARS’s tables for the older years, and VAT categories D and E', () => {
  it('takes the small business corporation tables back to 2021, the top band at the company rate', () => {
    // A year ending 31 March 2023: 58 013 + 27% of 150 000 = R98 513 (the company rate fell to 27%).
    expect(companyTax(70_000_000, '2023-03-31', true)).toBe(9_851_300);
    expect(companyTax(70_000_000, '2023-02-28', true)).toBe(10_001_300);
    // Year to 28 Feb 2022: 7% of (300 000 - 87 300) = R14 889. To 28 Feb 2021: 7% of (300 000 - 83 100) = R15 183.
    expect(companyTax(30_000_000, '2022-02-28', true)).toBe(1_488_900);
    expect(companyTax(30_000_000, '2021-02-28', true)).toBe(1_518_300);
  });

  it('has the medical scheme credits of the 2023 year', () => {
    expect(medicalCredit(1, '2023-02-28')).toBe(34_700);
    expect(medicalCredit(3, '2023-02-28')).toBe(69_400 + 23_400);
    expect(medicalCredit(1, '2025-02-28')).toBe(36_400);
  });

  it('works out six-monthly (D) and yearly (E) VAT periods', () => {
    expect(vatPeriod('2026-05-10', 'D')).toEqual({ start: '2026-03-01', end: '2026-08-31' });
    expect(vatPeriod('2026-10-15', 'D')).toEqual({ start: '2026-09-01', end: '2027-02-28' });
    expect(vatPeriod('2026-01-15', 'D')).toEqual({ start: '2025-09-01', end: '2026-02-28' });
    expect(vatPeriod('2026-10-15', 'E', 2)).toEqual({ start: '2026-03-01', end: '2027-02-28' });
    expect(vatPeriod('2026-10-15', 'E', 6)).toEqual({ start: '2026-07-01', end: '2027-06-30' });
    expect(vatPeriod('2026-10-15', 'B')).toEqual({ start: '2026-09-01', end: '2026-10-31' });
  });
});
