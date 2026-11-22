/** Leave (docs/LEAVE.md): the BCEA's rules, balances from the records, pay runs and the books. Made-up people and figures. */
import { annualCycle, bceaAnnualDays, bceaSickDays, dailyRateCents, leaveBalances, sickCycle, workingDays, type LeaveEmployee } from '@shap/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditBooks } from '../src/audit/books.js';
import { leavePayAddBack } from '../src/lib/leave.js';
import { balance, expectCleanAudit, login, ref, setup, type TestEnv } from './helpers.js';

const terms = (over: Partial<LeaveEmployee> = {}): LeaveEmployee => ({
  startDate: '2025-03-01',
  endDate: null,
  daysPerWeek: 5,
  annualDays: 15,
  familyDays: 3,
  openingDate: null,
  openingAnnualDays: 0,
  openingSickDays: 0,
  openingFamilyDays: 0,
  ...over,
});

describe('the BCEA’s leave, worked out', () => {
  it('gives three weeks’ annual leave and six weeks’ sick leave in working days, and a day’s pay as s35 does', () => {
    expect(bceaAnnualDays(5)).toBe(15);
    expect(bceaAnnualDays(6)).toBe(18);
    expect(bceaSickDays(5)).toBe(30);
    expect(bceaSickDays(6)).toBe(36);
    // R20 000 a month: a month is 4⅓ weeks, so a week is R4 615.38 and a day on five days R923.08.
    expect(Math.round(dailyRateCents(2_000_000, 5))).toBe(92_308);
  });

  it('counts working days without weekends and public holidays', () => {
    // 21 December 2026 to 1 January 2027: Christmas (Friday 25th) and New Year’s Day are holidays; the
    // Day of Goodwill is a Saturday.
    expect(workingDays('2026-12-21', '2027-01-01', 5)).toBe(8);
    // On six days a week the Saturday would count, but the Day of Goodwill is a holiday too.
    expect(workingDays('2026-12-21', '2027-01-01', 6)).toBe(8);
    expect(workingDays('2026-11-23', '2026-11-28', 6)).toBe(6);
    expect(workingDays('2026-11-23', '2026-11-27', 5)).toBe(5);
  });

  it('runs the annual cycle from the start date, and the sick cycle over 36 months', () => {
    expect(annualCycle('2025-03-15', '2026-11-22')).toEqual({ start: '2026-03-15', end: '2027-03-14' });
    expect(sickCycle('2025-03-15', '2026-11-22')).toEqual({ start: '2025-03-15', end: '2028-03-14' });
    expect(sickCycle('2020-01-31', '2026-11-22')).toEqual({ start: '2026-01-31', end: '2029-01-30' });
  });

  it('earns annual leave through the cycle, less what’s taken, adjusted and paid out', () => {
    const b = leaveBalances(terms(), [{ kind: 'annual', fromDate: '2026-01-12', toDate: '2026-01-16', days: 5, paid: true }], [], '2026-02-28');
    expect(b.annual.earnedDays).toBe(15);
    expect(b.annual.owedDays).toBe(10);
    // Half way through the next cycle, with two days added and three paid out.
    const later = leaveBalances(
      terms(),
      [
        { kind: 'annual', fromDate: '2026-01-12', toDate: '2026-01-16', days: 5, paid: true },
        { kind: 'annual', fromDate: '2026-05-01', toDate: '2026-05-01', days: 2, paid: true, adjustment: true },
      ],
      [{ date: '2026-08-31', days: 3 }],
      '2026-08-31',
    );
    expect(later.annual.owedDays).toBeCloseTo(15 + (15 * 184) / 365 - 5 + 2 - 3, 2);
    // Leave owed from a cycle that ended more than six months ago is pointed out.
    const late = leaveBalances(terms(), [], [], '2026-11-30');
    expect(late.annual.overdueDays).toBeCloseTo(15, 0);
  });

  it('gives a day’s sick leave for every 26 worked in the first six months, then the cycle’s', () => {
    const early = leaveBalances(terms({ startDate: '2026-01-05' }), [{ kind: 'sick', fromDate: '2026-03-02', toDate: '2026-03-02', days: 1, paid: true }], [], '2026-03-31');
    expect(early.sick.firstSixMonths).toBe(true);
    expect(early.sick.allowedDays).toBe(Math.floor(workingDays('2026-01-05', '2026-03-31', 5) / 26));
    expect(early.sick.takenDays).toBe(1);
    const after = leaveBalances(terms({ startDate: '2026-01-05' }), [{ kind: 'sick', fromDate: '2026-03-02', toDate: '2026-03-02', days: 1, paid: true }, { kind: 'sick', fromDate: '2026-09-01', toDate: '2026-09-04', days: 4, paid: false }], [], '2026-09-30');
    // Taken in the first six months counts against the first cycle; unpaid days don't use it.
    expect(after.sick).toMatchObject({ firstSixMonths: false, allowedDays: 30, takenDays: 1, leftDays: 29 });
  });

  it('gives family responsibility leave after four months to someone working four days a week or more', () => {
    expect(leaveBalances(terms({ startDate: '2026-06-01' }), [], [], '2026-08-31').family.eligible).toBe(false);
    expect(leaveBalances(terms({ startDate: '2026-01-01', daysPerWeek: 3 }), [], [], '2026-08-31').family.eligible).toBe(false);
    const b = leaveBalances(terms(), [{ kind: 'family', fromDate: '2026-04-06', toDate: '2026-04-07', days: 2, paid: true }], [], '2026-08-31');
    expect(b.family).toMatchObject({ eligible: true, allowedDays: 3, takenDays: 2, leftDays: 1 });
  });

  it('starts from the opening balances when Shap’s records start later', () => {
    const b = leaveBalances(terms({ openingDate: '2026-03-01', openingAnnualDays: 4, openingSickDays: 6 }), [], [], '2026-03-01');
    expect(b.annual.owedDays).toBeCloseTo(4 + 15 / 365, 2);
    expect(b.sick.takenDays).toBe(6);
  });
});

describe('leave in Shap', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let bank: string;
  let stays: string;
  let going: string;
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    bank = await (await ref(env.sql)).src('Business bank');
    const { settings: s } = await me.get('/api/reference');
    await me.post('/api/settings', { ...s, features: { ...s.features, payroll: true } }, 'PUT');
    stays = (await me.post<{ id: string }>('/api/employees', { name: 'Made-up Stays', salaryCents: 2_000_000, startDate: '2025-03-01' })).id;
    going = (await me.post<{ id: string }>('/api/employees', { name: 'Made-up Going', salaryCents: 1_300_000, startDate: '2025-03-01', endDate: '2026-10-31' })).id;
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('refuses leave that doesn’t fit, and less annual leave than the BCEA’s', async () => {
    const bad = async (body: Record<string, unknown>) => (await me.call({ method: 'POST', url: '/api/leave', payload: { employeeId: stays, kind: 'annual', fromDate: '2026-09-07', toDate: '2026-09-08', days: 2, ...body } })).body;
    expect(await bad({ fromDate: '2025-02-20', toDate: '2025-02-21' })).toMatch(/They started on 1 March 2025/);
    expect(await bad({ days: 5 })).toMatch(/won’t fit in 2 days/);
    expect(await bad({ kind: 'family' })).toMatch(/a sick child, or a death in the family/);
    expect(await bad({ adjustment: true, days: 2, note: '' })).toMatch(/an adjustment needs its reason/);
    expect(await bad({ kind: 'sick', adjustment: true, days: 1, note: 'x' })).toMatch(/Only annual leave is adjusted/);
    const res = await me.call({ method: 'POST', url: '/api/employees', payload: { name: 'Made-up Short', salaryCents: 1_000_000, startDate: '2026-01-01', annualLeaveDays: 10 } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/at least three weeks’ annual leave a year: 15 working days for 5 days a week/);
    await me.post('/api/leave', { employeeId: stays, kind: 'annual', fromDate: '2026-09-07', toDate: '2026-09-11', days: 5 });
    const clash = await me.call({ method: 'POST', url: '/api/leave', payload: { employeeId: stays, kind: 'sick', fromDate: '2026-09-10', toDate: '2026-09-10', days: 1 } });
    expect(clash.statusCode).toBe(409);
    expect(clash.body).toMatch(/already on annual leave from 7 September 2026/);
  });

  it('suggests the working days, and keeps the balances', async () => {
    expect((await me.get<{ days: number }>(`/api/leave/days?employeeId=${stays}&from=2026-12-21&to=2027-01-01`)).days).toBe(8);
    await me.post('/api/leave', { employeeId: stays, kind: 'sick', fromDate: '2026-08-03', toDate: '2026-08-05', days: 3 });
    const l = await me.get<{ people: { id: string; balances: { annual: { takenDays: number }; sick: { takenDays: number } }; warnings: string[] }[] }>('/api/leave?on=2026-09-30');
    const p = l.people.find((x) => x.id === stays)!;
    expect(p.balances.annual.takenDays).toBe(5);
    expect(p.balances.sick.takenDays).toBe(3);
    expect(p.warnings.join(' ')).toMatch(/more than two days in a row without a medical certificate/);
  });

  it('takes unpaid leave off a draft pay run, and pays out leave owed on leaving', async () => {
    const run = await me.post<{ id: string }>('/api/pay-runs', { period: '2026-10', payDate: '2026-10-25', sourceId: bank });
    // Unpaid leave recorded after the run is started: the draft picks it up.
    await me.post('/api/leave', { employeeId: stays, kind: 'unpaid', fromDate: '2026-10-05', toDate: '2026-10-09', days: 5 });
    const { lines } = await me.get<{ lines: { employeeId: string; unpaidLeaveCents: string; grossCents: number; leavePaidOutDays: string; leavePaidOutCents: string; extraCents: number }[] }>(`/api/pay-runs/${run.id}`);
    const s = lines.find((x) => x.employeeId === stays)!;
    expect(Number(s.unpaidLeaveCents)).toBe(Math.round(5 * dailyRateCents(2_000_000, 5)));
    expect(Number(s.grossCents)).toBe(2_000_000 - Number(s.unpaidLeaveCents));
    // Going leaves on 31 October: the annual leave owed then is paid out (nothing taken).
    const g = lines.find((x) => x.employeeId === going)!;
    const owed = leaveBalances(terms(), [], [], '2026-10-31').annual.owedDays;
    expect(Number(g.leavePaidOutDays)).toBeCloseTo(owed, 2);
    expect(Number(g.leavePaidOutCents)).toBe(Math.round(Number(g.leavePaidOutDays) * dailyRateCents(1_300_000, 5)));
    expect(Number(g.grossCents)).toBe(1_300_000 + Number(g.leavePaidOutCents));
    // The owner can give the days instead.
    await me.post(`/api/pay-runs/${run.id}/lines/${going}`, { salaryCents: 1_300_000, leavePaidOutDays: 10 }, 'PUT');
    const again = (await me.get<{ lines: { employeeId: string; leavePaidOutDays: string }[] }>(`/api/pay-runs/${run.id}`)).lines.find((x) => x.employeeId === going)!;
    expect(Number(again.leavePaidOutDays)).toBe(10);
    const slip = await me.call({ method: 'GET', url: `/api/pay-runs/${run.id}/payslip/${going}` });
    expect(slip.statusCode).toBe(200);
    await me.post(`/api/pay-runs/${run.id}/finalise`, {});
    // Paid out: none owed to them afterwards, and the IRP5's annual payments carry it.
    const after = await me.get<{ people: { id: string; balances: { annual: { owedDays: number; paidOutDays: number } } }[] }>('/api/leave?on=2026-11-30');
    expect(after.people.find((x) => x.id === going)!.balances.annual.paidOutDays).toBe(10);
    const emp501 = await me.get<{ employees: { name: string; codes: Record<string, number> }[] }>('/api/payroll/emp501?year=2027&kind=interim');
    expect(emp501.employees).toEqual([]);
    const year = await me.get<{ employees: { name: string; codes: Record<string, number> }[] }>('/api/payroll/emp501?year=2027&kind=annual');
    const gc = year.employees.find((x) => x.name === 'Made-up Going')!.codes;
    expect(gc[3605]).toBe(Math.round(10 * dailyRateCents(1_300_000, 5)));
    expect(year.employees.find((x) => x.name === 'Made-up Stays')!.codes[3601]).toBe(2_000_000 - Number(s.unpaidLeaveCents));
  });

  it('books the leave pay owed at a year end, says when the records changed, and adds it back for tax', async () => {
    const owed = await me.get<{ owed: { cents: number; people: { name: string; days: number }[] }; booked: unknown; ended: boolean }>('/api/leave/pay-owed?fyEnd=2026-02-28');
    expect(owed.ended).toBe(true);
    expect(owed.booked).toBeNull();
    // A full year each by then, no leave taken: 15 days each at their day’s pay.
    const want = Math.round(15 * dailyRateCents(2_000_000, 5)) + Math.round(15 * dailyRateCents(1_300_000, 5));
    expect(owed.owed.cents).toBe(want);
    // The last year end that has passed, with leave owed and nothing booked: the audit says so.
    const last = (await me.get<{ fy: { end: string }; owed: { cents: number } }>('/api/leave/pay-owed')).fy.end;
    const missing = (await auditBooks(env.sql)).some((i) => i.level === 'warn' && /isn’t in the books for that year end/.test(i.text));
    expect(missing).toBe(last === '2026-02-28');
    await me.post('/api/leave/pay-owed', { fyEnd: '2026-02-28' });
    expect(await balance(env.sql, 'leave_payable')).toBe(-want);
    expect(await leavePayAddBack(env.sql, '2025-03-01', '2026-02-28')).toBe(want);
    // Leave recorded in the year afterwards: the audit says so, and booking again puts it right.
    await me.post('/api/leave', { employeeId: stays, kind: 'annual', fromDate: '2026-02-09', toDate: '2026-02-10', days: 2 });
    expect((await auditBooks(env.sql)).some((i) => i.level === 'warn' && /since the leave pay owed was booked/.test(i.text))).toBe(true);
    await me.post('/api/leave/pay-owed', { fyEnd: '2026-02-28' });
    const now = want - Math.round(15 * dailyRateCents(2_000_000, 5)) + Math.round(13 * dailyRateCents(2_000_000, 5));
    expect(await balance(env.sql, 'leave_payable')).toBe(-now);
    expect((await auditBooks(env.sql)).some((i) => /since the leave pay owed was booked/.test(i.text))).toBe(false);
    // A journal made by the app: changed only from Leave.
    const [j] = await env.sql<{ id: string }[]>`select id from journals where kind = 'leave_pay'`;
    const res = await me.call({ method: 'DELETE', url: `/api/journals/${j!.id}` });
    expect(res.body).toMatch(/the leave pay owed at the year end \(Payroll → Leave\)/);
    // Not a year that hasn't ended.
    const early = await me.call({ method: 'POST', url: '/api/leave/pay-owed', payload: { fyEnd: '2027-02-28' } });
    expect(early.body).toMatch(/hasn’t ended yet/);
  });
});
