/**
 * From the accountant bot's review of the tax and SARS rules (Shap 1.23.2 / Pocket 1.7.2; each
 * failed before its fix): a small business corporation estimated at 27% unless a provisional
 * estimate said otherwise, the R20 million limit unchecked, any tax in the books hiding the
 * estimate, booking offered in an agreed year, older SBC tables, 2023's medical credits, VAT
 * categories D and E, and provisional tax paid with nowhere to go. All data made up.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { companyTax, medicalCredit, vatPeriod } from '@shap/shared';
import { buildStatements } from '../src/statements/build.js';
import { taxPack } from '../src/modules/tax-pack.js';
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
    await me.post('/api/settings/sbc', { sbc: true }, 'PUT');
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
    await me.post('/api/settings/sbc', { sbc: true }, 'PUT');
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
