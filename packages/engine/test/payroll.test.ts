/** Payroll and dividends: SARS's sums, and what reaches the books. */
import { dividendTax, dwtDue, emp201Due, medicalCredit, payLine, taxYearEnd } from '@shap/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balance, login, ref, setup, type TestEnv } from './helpers.js';

describe('payroll sums (SARS 2027 tables)', () => {
  it('works out PAYE by annualising, with UIF capped', () => {
    // R20 000 a month: R240 000 a year → 18% = R43 200, less the R17 820 rebate = R25 380 → R2 115 a month.
    expect(payLine({ salaryCents: 2_000_000, payDate: '2026-11-25' })).toEqual({
      grossCents: 2_000_000,
      payeCents: 211_500,
      uifEmployeeCents: 17_712,
      uifEmployerCents: 17_712,
      sdlCents: 0,
      netCents: 2_000_000 - 211_500 - 17_712,
    });
    // Under the tax threshold (R99 000 a year): no PAYE, UIF 1%.
    expect(payLine({ salaryCents: 800_000, payDate: '2026-11-25' })).toMatchObject({ payeCents: 0, uifEmployeeCents: 8_000 });
  });

  it('taxes a bonus as the tax it adds to the year', () => {
    // Year with the bonus: R250 000 → R44 118 + 26% × R4 900 − R17 820 = R27 572; without: R25 380; so R2 192 more.
    expect(payLine({ salaryCents: 2_000_000, extraCents: 1_000_000, payDate: '2026-11-25' }).payeCents).toBe(211_500 + 219_200);
  });

  it('takes off medical scheme credits, adds SDL, skips UIF when it doesn’t apply', () => {
    expect(medicalCredit(1, '2027-02-28')).toBe(37_600);
    expect(medicalCredit(2, '2027-02-28')).toBe(75_200);
    expect(medicalCredit(4, '2027-02-28')).toBe(75_200 + 2 * 25_400);
    expect(payLine({ salaryCents: 2_000_000, payDate: '2026-11-25', medicalMembers: 2 }).payeCents).toBe(211_500 - 75_200);
    expect(payLine({ salaryCents: 3_000_000, payDate: '2026-11-25', sdl: true }).sdlCents).toBe(30_000);
    expect(payLine({ salaryCents: 3_000_000, payDate: '2026-11-25', uif: false }).uifEmployeeCents).toBe(0);
  });

  it('knows the tax year and the due dates', () => {
    expect(taxYearEnd('2026-11-25')).toBe('2027-02-28');
    expect(taxYearEnd('2027-02-10')).toBe('2027-02-28');
    expect(taxYearEnd('2027-03-01')).toBe('2028-02-29');
    expect(emp201Due('2026-11')).toBe('2026-12-07');
    expect(emp201Due('2027-02')).toBe('2027-03-05'); // the 7th is a Sunday
    expect(dwtDue('2026-11-15')).toBe('2026-12-31');
    expect(dividendTax(10_000_000)).toBe(2_000_000);
    expect(dividendTax(10_000_000, true)).toBe(0);
  });
});

describe('payroll in the books', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let bank: string;
  let runId: string;
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app);
    bank = await (await ref(env.sql)).src('Business bank');
  });
  afterAll(() => env.close());

  it('pays employees, posts the journal and says what SARS is owed', async () => {
    await me.post('/api/employees', { name: 'Thandi Mokoena', salaryCents: 2_000_000, startDate: '2026-01-01' });
    await me.post('/api/employees', { name: 'You (director)', salaryCents: 3_000_000, isDirector: true, startDate: '2026-01-01' });
    await me.post('/api/employees', { name: 'Starts next year', salaryCents: 1_000_000, startDate: '2027-01-01' });
    runId = (await me.post('/api/pay-runs', { period: '2026-11', payDate: '2026-11-25', sourceId: bank })).id;
    const { lines } = await me.get(`/api/pay-runs/${runId}`);
    expect(lines.map((l: { name: string }) => l.name)).toEqual(['Thandi Mokoena', 'You (director)']);
    // A bonus for Thandi this month.
    const thandi = lines.find((l: { name: string }) => l.name === 'Thandi Mokoena');
    const after = await me.post(`/api/pay-runs/${runId}/lines/${thandi.employeeId}`, { salaryCents: 2_000_000, extraCents: 1_000_000, note: 'Year-end bonus' }, 'PUT');
    expect(after.lines.find((l: { name: string }) => l.name === 'Thandi Mokoena').payeCents).toBe(430_700);
    await me.post(`/api/pay-runs/${runId}/finalise`);
    const director = payLine({ salaryCents: 3_000_000, payDate: '2026-11-25' });
    expect(await balance(env.sql, 'salaries')).toBe(3_000_000);
    expect(await balance(env.sql, 'director_salary')).toBe(3_000_000);
    expect(await balance(env.sql, 'paye_payable')).toBe(-(430_700 + director.payeCents));
    expect(await balance(env.sql, 'uif_payable')).toBe(-(4 * 17_712));
    expect(await balance(env.sql, 'payroll_levies')).toBe(2 * 17_712);
    const sars = await me.get('/api/payroll/sars');
    expect(sars.emp201[0]).toMatchObject({ period: '2026-11', dueOn: '2026-12-07', paidCents: 0, totalCents: 430_700 + director.payeCents + 4 * 17_712 });
    expect((await me.get('/api/dashboard')).sarsDue[0]).toMatchObject({ kind: 'emp201', period: '2026-11' });
  });

  it('won’t change a final run until it’s reopened, and reopening takes it out of the books', async () => {
    const r = await me.call({ method: 'PUT', url: `/api/pay-runs/${runId}`, payload: { payDate: '2026-11-26', sourceId: bank } });
    expect(r.statusCode).toBe(400);
    const journals = await me.get('/api/journals');
    const payroll = journals.find((j: { kind: string }) => j.kind === 'payroll');
    expect((await me.call({ method: 'DELETE', url: `/api/journals/${payroll.id}` })).json().error).toMatch(/pay run/);
    await me.post(`/api/pay-runs/${runId}/reopen`);
    expect(await balance(env.sql, 'salaries')).toBe(0);
    await me.post(`/api/pay-runs/${runId}/finalise`);
  });

  it('pays SARS and clears what’s owed', async () => {
    const owed = (await me.get('/api/payroll/sars')).emp201[0].totalCents;
    await me.post('/api/sars-payments', { kind: 'emp201', period: '2026-11', date: '2026-12-05', amountCents: owed, sourceId: bank, reference: 'EMP201 Nov' });
    expect(await balance(env.sql, 'paye_payable')).toBe(0);
    expect(await balance(env.sql, 'uif_payable')).toBe(0);
    expect((await me.get('/api/dashboard')).sarsDue).toHaveLength(0);
    const slip = await me.call({ method: 'GET', url: `/api/pay-runs/${runId}/payslip/${(await me.get(`/api/pay-runs/${runId}`)).lines[0].employeeId}` });
    expect(slip.headers['content-type']).toBe('application/pdf');
    const year = await me.get('/api/payroll/year?date=2026-11-25');
    expect(year.rows).toHaveLength(2);
  });

  it('pays the director a dividend with 20% dividends tax', async () => {
    const before = await balance(env.sql, 'bank');
    const { availableCents } = await me.get('/api/dividends');
    expect(typeof availableCents).toBe('number');
    await me.post('/api/dividends', { declaredOn: '2026-11-28', paidOn: '2026-11-30', shareholder: 'You', grossCents: 10_000_000, sourceId: bank });
    expect(await balance(env.sql, 'dividends')).toBe(10_000_000);
    expect(await balance(env.sql, 'dwt_payable')).toBe(-2_000_000);
    expect(await balance(env.sql, 'dividends_payable')).toBe(0);
    expect((await balance(env.sql, 'bank')) - before).toBe(-8_000_000);
    const sars = await me.get('/api/payroll/sars');
    expect(sars.dividendsTax[0]).toMatchObject({ period: '2026-11', dwtCents: 2_000_000, dueOn: '2026-12-31' });
    // Declared now, paid later.
    const later = await me.post('/api/dividends', { declaredOn: '2026-11-29', shareholder: 'Holding Co (Pty) Ltd', grossCents: 5_000_000, exempt: true });
    expect(await balance(env.sql, 'dividends_payable')).toBe(-5_000_000);
    await me.post(`/api/dividends/${later.id}/pay`, { paidOn: '2026-12-02', sourceId: bank });
    expect(await balance(env.sql, 'dividends_payable')).toBe(0);
    const bs = await me.get('/api/reports/balance-sheet');
    expect(bs.differenceCents).toBe(0);
  });

  it('doesn’t let a sole proprietor declare dividends', async () => {
    await env.sql`update settings set business_type = 'sole_prop'`;
    const r = await me.call({ method: 'POST', url: '/api/dividends', payload: { declaredOn: '2026-11-28', shareholder: 'Me', grossCents: 100 } });
    expect(r.json().error).toMatch(/drawings/);
    await env.sql`update settings set business_type = 'company'`;
  });
});
