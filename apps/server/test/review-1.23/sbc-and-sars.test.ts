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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { companyTax, medicalCredit, vatPeriod } from '@shap/shared';
import { buildStatements } from '../../src/statements/build.js';
import { taxPack } from '../../src/modules/tax-pack.js';
import { stillSigned } from '../../src/modules/financial-statements.js';
import { balance, expectCleanAudit, login, ref, sessionFor, setup, type TestEnv } from '../helpers.js';
import { exportCompanyFile, restoreCompanyFile } from '../../src/modules/company-file.js';

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
    await me.post('/api/tax/sbc', { fyEnd: FY, sbc: true }, 'PUT');
    // A provisional estimate saved without the SBC table doesn't change what the business said.
    await me.post('/api/tax-estimates', { fyEnd: FY, period: 1, asAt: '2025-08-31', sbc: false, lines: [{ accountId: null, name: 'Made-up income', type: 'income', actualCents: 20_000_000, projectedCents: 40_000_000 }] });
    const s = await buildStatements(env.sql, FY);
    const t = await taxPack(env.sql, FY);
    expect(s.taxEstimate).toMatchObject({ sbc: true, taxCents: 2_619_800 });
    expect(t.estimate).toMatchObject({ sbc: true, taxCents: 2_619_800 });
    expect((await me.get(`/api/reports/provisional-tax?fyEnd=${FY}&asAt=${FY}`)).sbc).toBe(true);
    // The answer carries into the next year until it's given for that year.
    expect((await me.get(`/api/reports/provisional-tax?fyEnd=2027-02-28&asAt=2026-10-31`)).sbc).toBe(true);
    expect((await me.call({ method: 'PUT', url: '/api/tax/sbc', payload: { fyEnd: '2026-03-31', sbc: true } })).statusCode).toBe(400);
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
    // The IRP6 screen sees it, for what's still to pay.
    expect((await me.get(`/api/reports/provisional-tax?fyEnd=${FY}&asAt=${FY}`)).payments.map((x: { amountCents: number }) => Number(x.amountCents))).toEqual([1_300_000]);
  });
});

describe('the small business corporation limits and the look at the tax', () => {
  it('leaves the SBC table out above R20 million of gross income, whatever was said', async () => {
    const env = await setup();
    try {
      const { me } = await company(env, 2_500_000_000, 2_400_000_000);
      await me.post('/api/tax/sbc', { fyEnd: FY, sbc: true }, 'PUT');
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
      await me.post('/api/tax/sbc', { fyEnd: FY, sbc: false }, 'PUT');
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

describe('the four reviews of 1.23.2 (each failed before its fix)', () => {
  it('never answers the SBC question for the business: saving an estimate on the table doesn’t, and only owner or accountant may', async () => {
    const env = await setup();
    try {
      const { me } = await company(env, 40_000_000);
      await me.post('/api/tax-estimates', { fyEnd: FY, period: 1, asAt: '2025-08-31', sbc: true, lines: [{ accountId: null, name: 'Made-up income', type: 'income', actualCents: 20_000_000, projectedCents: 40_000_000 }] });
      expect((await buildStatements(env.sql, FY)).taxEstimate).toMatchObject({ sbc: null });
      expect((await env.sql`select count(*)::int as n from sbc_years`)[0]!.n).toBe(0);
      const acc = await login(env.app, 'accountant@example.co.za');
      expect((await acc.call({ method: 'PUT', url: '/api/tax/sbc', payload: { fyEnd: FY, sbc: true } })).statusCode).toBe(200);
      expect((await buildStatements(env.sql, FY)).taxEstimate).toMatchObject({ sbc: true });
      // Carried in the company file.
      const file = await exportCompanyFile(env.sql);
      expect(file.sbcYears).toEqual([{ fyEnd: FY, sbc: true }]);
      await env.sql`delete from sbc_years`;
      await env.sql.begin((tx) => restoreCompanyFile(tx as never, file));
      expect((await buildStatements(env.sql, FY)).taxEstimate).toMatchObject({ sbc: true });
    } finally {
      await env.close();
    }
  });

  it('nothing due on the SBC table is nothing due: no "Book R0,00"', async () => {
    const env = await setup();
    try {
      const { me } = await company(env, 8_000_000);
      await me.post('/api/tax/sbc', { fyEnd: FY, sbc: true }, 'PUT');
      const s = await buildStatements(env.sql, FY);
      expect(lookOf(s).ok).toBe(true);
      expect(s.taxEstimate).toBeNull();
    } finally {
      await env.close();
    }
  });

  it('puts the SBC line in the tax note by the tax booked, whatever was said', async () => {
    const env = await setup();
    try {
      const { me, r } = await company(env, 40_000_000);
      // Not said, but the accountant booked it on the SBC table: the line shows.
      await me.post('/api/journals', { date: FY, description: 'Income tax (made up)', lines: [{ accountId: await r.acc('income_tax'), debitCents: 2_619_800 }, { accountId: await r.acc('income_tax_payable'), creditCents: 2_619_800 }] });
      const rows = (await buildStatements(env.sql, FY)).notes.find((n) => n.key === 'tax')!.tables[1]!.rows.map((x) => x.label);
      expect(rows).toContain('Small business corporation rates (s12E)');
      // Said it qualifies, booked at 27%: no SBC line, and the last line still names the rates.
      await me.post('/api/journals', { date: FY, description: 'Income tax, at 27% (made up)', lines: [{ accountId: await r.acc('income_tax'), debitCents: 10_800_000 - 2_619_800 }, { accountId: await r.acc('income_tax_payable'), creditCents: 10_800_000 - 2_619_800 }] });
      await me.post('/api/tax/sbc', { fyEnd: FY, sbc: true }, 'PUT');
      const at27 = (await buildStatements(env.sql, FY)).notes.find((n) => n.key === 'tax')!.tables[1]!.rows.map((x) => x.label);
      expect(at27).not.toContain('Small business corporation rates (s12E)');
      expect(at27).toContain('Small business corporation rates, items not deductible or not taxable, and other differences');
      await expectCleanAudit(env.sql, FY);
    } finally {
      await env.close();
    }
  });

  it('names both years’ company rates when they differ (29.41(d))', async () => {
    const env = await setup();
    try {
      const me = await login(env.app, 'owner@example.co.za');
      const { settings } = await me.get('/api/reference');
      await me.post('/api/settings', { ...settings, businessType: 'company', fyEndMonth: 2, features: { ...settings.features, statements: true } }, 'PUT');
      const r = await ref(env.sql);
      const tax = async (date: string, cents: number) => me.post('/api/journals', { date, description: 'Income tax (made up)', lines: [{ accountId: await r.acc('income_tax'), debitCents: cents }, { accountId: await r.acc('income_tax_payable'), creditCents: cents }] });
      for (const [d, c] of [['2022-06-30', 10_000_000], ['2023-06-30', 10_000_000]] as const) await me.post('/api/journals', { date: d, description: 'Made-up income', lines: [{ accountId: await r.acc('bank'), debitCents: c }, { accountId: await r.acc('revenue_other'), creditCents: c }] });
      await tax('2023-02-28', 2_800_000);
      await tax('2024-02-29', 2_700_000);
      const rows = (await buildStatements(env.sql, '2024-02-29')).notes.find((n) => n.key === 'tax')!.tables[1]!.rows.map((x) => x.label);
      expect(rows).toContain('Tax at the company rate (27%; the previous year 28%)');
    } finally {
      await env.close();
    }
  });

  it('leaves a company on turnover tax out of the income tax, and tells of an assessed loss carried forward', async () => {
    const env = await setup();
    try {
      const me = await login(env.app, 'owner@example.co.za');
      const { settings } = await me.get('/api/reference');
      await me.post('/api/settings', { ...settings, businessType: 'company', fyEndMonth: 2, turnoverTax: true, features: { ...settings.features, statements: true } }, 'PUT');
      const r = await ref(env.sql);
      await me.post('/api/journals', { date: '2025-06-30', description: 'Made-up income', lines: [{ accountId: await r.acc('bank'), debitCents: 40_000_000 }, { accountId: await r.acc('revenue_other'), creditCents: 40_000_000 }] });
      const s = await buildStatements(env.sql, FY);
      expect(s.taxEstimate).toBeNull();
      expect(s.checks.find((c) => c.label.startsWith('The year’s income tax'))).toBeUndefined();
    } finally {
      await env.close();
    }
    const loss = await setup();
    try {
      const { me } = await company(loss, 1_000_000, 4_000_000);
      void me;
      const s = await buildStatements(loss.sql, FY);
      expect(s.notes.find((n) => n.key === 'tax')!.paragraphs.join(' ')).toMatch(/assessed loss of R\s?30 000/);
      await expectCleanAudit(loss.sql, FY);
    } finally {
      await loss.close();
    }
  });

  it('treats a year as agreed when a later one is, where booking its tax would move the later year', async () => {
    const env = await setup();
    try {
      const { me } = await company(env, 40_000_000);
      await me.post('/api/year-ends', { fyEnd: '2027-02-28', note: 'Agreed with the accountant (made up)', lock: false, figures: [] }, 'PUT');
      expect(await me.get(`/api/statements/${FY}`)).toMatchObject({ yearAgreed: true });
    } finally {
      await env.close();
    }
  });

  it('keeps the tax pack’s paid and booked apart when both fall on the same day', async () => {
    const env = await setup();
    try {
      const { me, r } = await company(env, 40_000_000);
      const bank = await r.src('Business bank');
      await me.post('/api/sars-payments', { kind: 'irp6', period: '2026-02', date: '2025-08-29', amountCents: 700_000, sourceId: bank });
      await me.post('/api/sars-payments', { kind: 'irp6', period: '2026-02', date: FY, amountCents: 800_000, sourceId: bank });
      await me.post('/api/journals', { date: FY, description: 'Income tax (made up)', lines: [{ accountId: await r.acc('income_tax'), debitCents: 1_466_272 }, { accountId: await r.acc('income_tax_payable'), creditCents: 1_466_272 }] });
      const t = await taxPack(env.sql, FY);
      expect([t.paidToSarsCents, t.taxBookedCents]).toEqual([1_500_000, 1_466_272]);
      await expectCleanAudit(env.sql, FY);
    } finally {
      await env.close();
    }
  });

  it('keeps provisional tax the owner’s, and for a business taxed itself; logs deleting a SARS payment', async () => {
    const env = await setup();
    try {
      const { me, r } = await company(env, 40_000_000);
      const bank = await r.src('Business bank');
      await me.post('/api/users', { name: 'Payroll (made up)', email: 'payroll@example.co.za', role: 'staff', profileId: null, access: ['payroll.run'], password: 'test-password-1' });
      const payroll = await sessionFor(env, 'payroll@example.co.za');
      expect((await payroll.call({ method: 'POST', url: '/api/sars-payments', payload: { kind: 'irp6', period: '2026-02', date: '2025-08-29', amountCents: 9_999_900, sourceId: bank } })).statusCode).toBe(403);
      const p = await me.post('/api/sars-payments', { kind: 'irp6', period: '2026-02', date: '2025-08-29', amountCents: 500_000, sourceId: bank });
      expect((await payroll.get('/api/sars-payments')).map((x: { kind: string }) => x.kind)).not.toContain('irp6');
      expect((await payroll.call({ method: 'DELETE', url: `/api/sars-payments/${p.id}` })).statusCode).toBe(403);
      // The year end's month only, and a real month.
      expect((await me.call({ method: 'POST', url: '/api/sars-payments', payload: { kind: 'irp6', period: '2026-08', date: '2025-08-29', amountCents: 1, sourceId: bank } })).statusCode).toBe(400);
      expect((await me.call({ method: 'POST', url: '/api/sars-payments', payload: { kind: 'emp201', period: '2026-13', date: '2025-08-29', amountCents: 1, sourceId: bank } })).statusCode).toBe(400);
      await me.call({ method: 'DELETE', url: `/api/sars-payments/${p.id}` });
      expect((await env.sql`select action from audit_log where entity = 'sars_payment' order by id`).map((x) => x.action)).toEqual(['create', 'delete']);
      // A sole proprietor's provisional tax is the owner's own.
      const { settings } = await me.get('/api/reference');
      await me.post('/api/settings', { ...settings, businessType: 'sole_prop' }, 'PUT');
      expect((await me.call({ method: 'POST', url: '/api/sars-payments', payload: { kind: 'irp6', period: '2026-02', date: '2025-08-29', amountCents: 500_000, sourceId: bank } })).statusCode).toBe(400);
      // And a VAT201 for a date no return can be for is refused, not a crash.
      expect((await me.call({ method: 'GET', url: '/api/vat/return?on=9999-07-15' })).statusCode).toBe(400);
    } finally {
      await env.close();
    }
  });

  it('keeps each year’s answer to itself: answering the next year leaves the last as it was', async () => {
    const env = await setup();
    try {
      const { me } = await company(env, 40_000_000);
      await me.post('/api/tax/sbc', { fyEnd: FY, sbc: true }, 'PUT');
      await me.post('/api/tax/sbc', { fyEnd: '2027-02-28', sbc: false }, 'PUT');
      expect((await buildStatements(env.sql, FY)).taxEstimate).toMatchObject({ sbc: true });
      expect((await me.get(`/api/reports/provisional-tax?fyEnd=2027-02-28&asAt=2026-10-31`)).sbc).toBe(false);
      // Taking the answer back leaves the year unsaid again (the year before carries no further).
      await me.post('/api/tax/sbc', { fyEnd: FY, sbc: null }, 'PUT');
      expect((await buildStatements(env.sql, FY)).taxEstimate).toMatchObject({ sbc: null });
      await expectCleanAudit(env.sql, FY);
    } finally {
      await env.close();
    }
  });

  it('keeps a set approved on 1.22 approved, though the tax note’s reconciliation is drawn differently now', async () => {
    const env = await setup();
    try {
      const { me, r } = await company(env, 40_000_000);
      await me.post('/api/journals', { date: FY, description: 'Income tax (made up)', lines: [{ accountId: await r.acc('income_tax'), debitCents: 10_800_000 }, { accountId: await r.acc('income_tax_payable'), creditCents: 10_800_000 }] });
      const now = await buildStatements(env.sql, FY);
      const tax = now.notes.find((n) => n.key === 'tax')!;
      expect(tax.tables.length).toBeGreaterThan(1);
      // As 1.22 drew it: no builder or books, the reconciliation worded its own way.
      const old = structuredClone(now) as typeof now;
      delete (old as { builder?: number }).builder;
      delete (old as { books?: string }).books;
      const oldTax = old.notes.find((n) => n.key === 'tax')!;
      oldTax.tables[1] = { ...oldTax.tables[1]!, rows: [{ label: 'Tax at 27%, less the small business corporation rates', current: 1, prior: null }] as never };
      expect(stillSigned({ snapshot: old, snapshotHash: 'legacy' }, now)).toBe(true);
      // But not when the current tax itself differs.
      const moved = structuredClone(old);
      moved.notes.find((n) => n.key === 'tax')!.tables[0]!.rows[0] = { ...moved.notes.find((n) => n.key === 'tax')!.tables[0]!.rows[0]!, current: 1 } as never;
      expect(stillSigned({ snapshot: moved, snapshotHash: 'legacy' }, now)).toBe(false);
    } finally {
      await env.close();
    }
  });

  it('tells the owner on the home page when the tax year is past what this version checked against SARS', async () => {
    const env = await setup();
    try {
      const me = await login(env.app, 'owner@example.co.za');
      expect((await me.get('/api/dashboard')).sarsCheckedTo).toBeNull();
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2027-03-02T08:00:00Z') });
      try {
        expect((await me.get('/api/dashboard')).sarsCheckedTo).toBe('2027-02-28');
      } finally {
        vi.useRealTimers();
      }
    } finally {
      await env.close();
    }
  });
});
