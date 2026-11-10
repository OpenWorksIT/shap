/**
 * From the accountant bot's review of the tax and SARS rules (Shap 1.23.2 / Pocket 1.7.2; each
 * failed before its fix): a small business corporation estimated at 27% unless a provisional
 * estimate said otherwise, the R20 million limit unchecked, any tax in the books hiding the
 * estimate, booking offered in an agreed year, older SBC tables, 2023's medical credits, VAT
 * categories D and E, and provisional tax paid with nowhere to go. All data made up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { companyTax, medicalCredit, vatPeriod } from '@shap/shared';
import { buildStatements } from '../src/statements/build.js';
import { taxPack } from '../src/modules/tax-pack.js';
import { stillSigned } from '../src/modules/financial-statements.js';
import { exportCompanyFile, restoreCompanyFile } from '../src/modules/company-file.js';
import { balance, expectCleanAudit, login, ref, setup, type TestEnv } from './helpers.js';

const FY = '2026-02-28';
const lookOf = (s: Awaited<ReturnType<typeof buildStatements>>) => s.checks.find((c) => c.label.startsWith('The year’s income tax'))!;
let env: TestEnv;
let open = false;
afterEach(async () => {
  if (open) await env.close();
  open = false;
});
const company = async (revenueCents: number, costsCents = 0) => {
  env = await setup();
  open = true;
  const me = await login(env.app);
  const { settings } = await me.get('/api/reference');
  await me.post('/api/settings', { ...settings, businessType: 'company', fyEndMonth: 2, companyName: 'Fictional Sparks (Pty) Ltd', features: { ...settings.features, statements: true } }, 'PUT');
  const r = await ref(env.sql);
  await me.post('/api/journals', { date: '2025-06-30', description: 'Made-up income', lines: [{ accountId: await r.acc('bank'), debitCents: revenueCents }, { accountId: await r.acc('revenue_other'), creditCents: revenueCents }] });
  if (costsCents) {
    const sundry = (await env.sql<{ id: string }[]>`select id from accounts where type = 'expense' and system_key is null limit 1`)[0]!.id;
    await me.post('/api/journals', { date: '2025-07-31', description: 'Made-up costs', lines: [{ accountId: sundry, debitCents: costsCents }, { accountId: await r.acc('bank'), creditCents: costsCents }] });
  }
  return { me, r };
};

describe('a small business corporation’s tax in Shap Pocket', () => {
  it('shows both figures until it’s said, then goes by the answer everywhere, with its own line in the tax note', async () => {
    const { me, r } = await company(40_000_000);
    expect((await buildStatements(env.sql, FY)).taxEstimate).toMatchObject({ sbc: null, sbcTaxCents: 2_619_800, standardTaxCents: 10_800_000 });
    await me.post('/api/tax/sbc', { fyEnd: FY, sbc: true }, 'PUT');
    expect((await buildStatements(env.sql, FY)).taxEstimate).toMatchObject({ sbc: true, taxCents: 2_619_800 });
    expect((await taxPack(env.sql, FY)).estimate).toMatchObject({ sbc: true, taxCents: 2_619_800 });
    await me.post('/api/journals', { date: FY, description: 'Income tax for the year (made up)', lines: [{ accountId: await r.acc('income_tax'), debitCents: 2_619_800 }, { accountId: await r.acc('income_tax_payable'), creditCents: 2_619_800 }] });
    const s = await buildStatements(env.sql, FY);
    expect(lookOf(s).ok).toBe(true);
    expect(s.notes.find((n) => n.key === 'tax')!.tables[1]!.rows.find((x) => x.label.startsWith('Small business corporation'))?.current).toBe(2_619_800 - 10_800_000);
    await me.post('/api/sars-payments', { kind: 'irp6', period: '2026-02', date: '2026-02-26', amountCents: 1_300_000, sourceId: await r.src('Business bank') });
    expect(await balance(env.sql, 'income_tax_payable')).toBe(-(2_619_800 - 1_300_000));
    await expectCleanAudit(env.sql, FY);
  });

  it('leaves the table out above R20 million, and says when the tax booked is far from the estimate', async () => {
    const { me, r } = await company(2_500_000_000, 2_400_000_000);
    await me.post('/api/tax/sbc', { fyEnd: FY, sbc: true }, 'PUT');
    expect((await buildStatements(env.sql, FY)).taxEstimate).toMatchObject({ sbc: false, taxCents: 27_000_000 });
    await me.post('/api/journals', { date: '2025-08-29', description: 'SARS provisional tax (made up)', lines: [{ accountId: await r.acc('income_tax'), debitCents: 1_000_000 }, { accountId: await r.acc('bank'), creditCents: 1_000_000 }] });
    expect(lookOf(await buildStatements(env.sql, FY)).ok).toBe(false);
    await me.post('/api/year-ends', { fyEnd: FY, note: 'Agreed with the accountant (made up)', lock: false, figures: [] }, 'PUT');
    expect(await me.get(`/api/statements/${FY}`)).toMatchObject({ yearAgreed: true, yearClosed: false });
  });

  it('has the older SBC tables, 2023’s medical credits and VAT categories D and E', () => {
    expect(companyTax(70_000_000, '2023-03-31', true)).toBe(9_851_300);
    expect(companyTax(30_000_000, '2022-02-28', true)).toBe(1_488_900);
    expect(medicalCredit(1, '2023-02-28')).toBe(34_700);
    expect(vatPeriod('2026-10-15', 'D')).toEqual({ start: '2026-09-01', end: '2027-02-28' });
    expect(vatPeriod('2026-10-15', 'E', 6)).toEqual({ start: '2026-07-01', end: '2027-06-30' });
  });

});

describe('the four reviews of Shap 1.23.2 / Pocket 1.7.2 (each failed before its fix)', () => {
  it('keeps each year’s answer to itself, carried forward until changed; saving an estimate doesn’t answer it; the company file carries it', async () => {
    const { me } = await company(40_000_000);
    await me.post('/api/tax-estimates', { fyEnd: FY, period: 1, asAt: '2025-08-31', sbc: true, lines: [{ accountId: null, name: 'Made-up income', type: 'income', actualCents: 20_000_000, projectedCents: 40_000_000 }] });
    expect((await buildStatements(env.sql, FY)).taxEstimate).toMatchObject({ sbc: null });
    await me.post('/api/tax/sbc', { fyEnd: FY, sbc: true }, 'PUT');
    expect((await me.get('/api/reports/provisional-tax?fyEnd=2027-02-28&asAt=2026-10-31')).sbc).toBe(true);
    await me.post('/api/tax/sbc', { fyEnd: '2027-02-28', sbc: false }, 'PUT');
    expect((await buildStatements(env.sql, FY)).taxEstimate).toMatchObject({ sbc: true });
    expect((await me.get('/api/reports/provisional-tax?fyEnd=2027-02-28&asAt=2026-10-31')).sbc).toBe(false);
    expect((await me.call({ method: 'PUT', url: '/api/tax/sbc', payload: { fyEnd: '2026-03-31', sbc: true } })).statusCode).toBe(400);
    const file = await exportCompanyFile(env.sql);
    expect([...(file.sbcYears ?? [])]).toEqual([{ fyEnd: FY, sbc: true }, { fyEnd: '2027-02-28', sbc: false }]);
    await env.sql`delete from sbc_years`;
    await env.sql.begin((tx) => restoreCompanyFile(tx as never, file));
    expect((await buildStatements(env.sql, FY)).taxEstimate).toMatchObject({ sbc: true });
    await expectCleanAudit(env.sql, FY);
  });

  it('nothing due on the SBC table is nothing due, and the SBC line follows the tax booked', async () => {
    const small = await company(8_000_000);
    await small.me.post('/api/tax/sbc', { fyEnd: FY, sbc: true }, 'PUT');
    const s = await buildStatements(env.sql, FY);
    expect(lookOf(s).ok).toBe(true);
    expect(s.taxEstimate).toBeNull();
    await env.close();
    open = false;
    const { me, r } = await company(40_000_000);
    await me.post('/api/journals', { date: FY, description: 'Income tax (made up)', lines: [{ accountId: await r.acc('income_tax'), debitCents: 10_800_000 }, { accountId: await r.acc('income_tax_payable'), creditCents: 10_800_000 }] });
    await me.post('/api/tax/sbc', { fyEnd: FY, sbc: true }, 'PUT');
    const rows = (await buildStatements(env.sql, FY)).notes.find((n) => n.key === 'tax')!.tables[1]!.rows.map((x) => x.label);
    expect(rows).not.toContain('Small business corporation rates (s12E)');
    expect(rows).toContain('Small business corporation rates, items not deductible or not taxable, and other differences');
  });

  it('names both years’ company rates when they differ, and tells of an assessed loss carried forward', async () => {
    const { me, r } = await company(10_000_000);
    await me.post('/api/journals', { date: '2023-06-30', description: 'Made-up income', lines: [{ accountId: await r.acc('bank'), debitCents: 10_000_000 }, { accountId: await r.acc('revenue_other'), creditCents: 10_000_000 }] });
    await me.post('/api/journals', { date: '2022-06-30', description: 'Made-up income', lines: [{ accountId: await r.acc('bank'), debitCents: 10_000_000 }, { accountId: await r.acc('revenue_other'), creditCents: 10_000_000 }] });
    for (const [d, c] of [['2023-02-28', 2_800_000], ['2024-02-29', 2_700_000]] as const)
      await me.post('/api/journals', { date: d, description: 'Income tax (made up)', lines: [{ accountId: await r.acc('income_tax'), debitCents: c }, { accountId: await r.acc('income_tax_payable'), creditCents: c }] });
    expect((await buildStatements(env.sql, '2024-02-29')).notes.find((n) => n.key === 'tax')!.tables[1]!.rows.map((x) => x.label)).toContain('Tax at the company rate (27%; the previous year 28%)');
    await env.close();
    open = false;
    await company(1_000_000, 4_000_000);
    expect((await buildStatements(env.sql, FY)).notes.find((n) => n.key === 'tax')!.paragraphs.join(' ')).toMatch(/assessed loss of R\s?30 000/);
    await expectCleanAudit(env.sql, FY);
  });

  it('leaves a company on turnover tax out of the income tax, and a later agreed year counts as agreed', async () => {
    const { me } = await company(40_000_000);
    await me.post('/api/year-ends', { fyEnd: '2027-02-28', note: 'Agreed with the accountant (made up)', lock: false, figures: [] }, 'PUT');
    expect(await me.get(`/api/statements/${FY}`)).toMatchObject({ yearAgreed: true });
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, turnoverTax: true }, 'PUT');
    const s = await buildStatements(env.sql, FY);
    expect(s.taxEstimate).toBeNull();
    expect(s.checks.find((c) => c.label.startsWith('The year’s income tax'))).toBeUndefined();
  });

  it('keeps the tax pack’s paid and booked apart on the same day; provisional tax only for a business taxed itself; deleting a payment is logged', async () => {
    const { me, r } = await company(40_000_000);
    const bank = await r.src('Business bank');
    const p = await me.post('/api/sars-payments', { kind: 'irp6', period: '2026-02', date: '2025-08-29', amountCents: 700_000, sourceId: bank });
    await me.post('/api/sars-payments', { kind: 'irp6', period: '2026-02', date: FY, amountCents: 800_000, sourceId: bank });
    await me.post('/api/journals', { date: FY, description: 'Income tax (made up)', lines: [{ accountId: await r.acc('income_tax'), debitCents: 1_466_272 }, { accountId: await r.acc('income_tax_payable'), creditCents: 1_466_272 }] });
    const t = await taxPack(env.sql, FY);
    expect([t.paidToSarsCents, t.taxBookedCents]).toEqual([1_500_000, 1_466_272]);
    expect((await me.get(`/api/reports/provisional-tax?fyEnd=${FY}&asAt=${FY}`)).payments.map((x: { amountCents: number }) => Number(x.amountCents)).sort()).toEqual([700_000, 800_000]);
    expect((await me.call({ method: 'POST', url: '/api/sars-payments', payload: { kind: 'irp6', period: '2026-08', date: '2025-08-29', amountCents: 1, sourceId: bank } })).statusCode).toBe(400);
    expect((await me.call({ method: 'POST', url: '/api/sars-payments', payload: { kind: 'emp201', period: '2026-13', date: '2025-08-29', amountCents: 1, sourceId: bank } })).statusCode).toBe(400);
    await me.call({ method: 'DELETE', url: `/api/sars-payments/${p.id}` });
    expect((await env.sql`select action from audit_log where entity = 'sars_payment' and action = 'delete'`).length).toBe(1);
    await expectCleanAudit(env.sql, FY);
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, businessType: 'sole_prop' }, 'PUT');
    expect((await me.call({ method: 'POST', url: '/api/sars-payments', payload: { kind: 'irp6', period: '2026-02', date: '2025-08-29', amountCents: 500_000, sourceId: bank } })).statusCode).toBe(400);
    expect((await me.call({ method: 'GET', url: '/api/vat/return?on=9999-07-15' })).statusCode).toBe(400);
  });

  it('keeps a set approved before the SBC line approved, and tells of SARS’s new tax year', async () => {
    const { me, r } = await company(40_000_000);
    await me.post('/api/journals', { date: FY, description: 'Income tax (made up)', lines: [{ accountId: await r.acc('income_tax'), debitCents: 10_800_000 }, { accountId: await r.acc('income_tax_payable'), creditCents: 10_800_000 }] });
    const now = await buildStatements(env.sql, FY);
    const old = structuredClone(now);
    delete (old as { builder?: number }).builder;
    delete (old as { books?: string }).books;
    const oldTax = old.notes.find((n) => n.key === 'tax')!;
    oldTax.tables[1] = { ...oldTax.tables[1]!, rows: [{ label: 'Tax at 27%, less the small business corporation rates', current: 1, prior: null }] as never };
    expect(stillSigned({ snapshot: old, snapshotHash: 'legacy' }, now)).toBe(true);
    expect((await me.get('/api/dashboard')).sarsCheckedTo).toBeNull();
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2027-03-02T08:00:00Z') });
    try {
      expect((await me.get('/api/dashboard')).sarsCheckedTo).toBe('2027-02-28');
    } finally {
      vi.useRealTimers();
    }
  });
});
