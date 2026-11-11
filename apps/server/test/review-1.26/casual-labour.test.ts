/**
 * 1.26, the owner's call: day labour and the law (docs/CASUAL_LABOUR.md), and what the five reviews
 * of it found (CPDAUDIT.md section 7). Shap records a worker's days and pay and reminds the owner
 * where the law comes in: the national minimum wage for every worker, PAYE (SARS's tables usually,
 * else 25%), and from 24 hours a month UIF and the BCEA's hours and leave. It never decides who's an
 * employee, and says it isn't advice, from free software whose makers aren't accountants or labour
 * lawyers. Each test failed before. All data made up.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  casualLabourNote,
  DEEMED_STANDARD_DAY,
  deemedStandardDayOn,
  labourLooks,
  lawMonthsNote,
  minimumWageOn,
  NATIONAL_MINIMUM_WAGE,
  SARS_CHECKED_TO,
  setupCautions,
  SUBCONTRACTOR_NOTE,
} from '@shap/shared';
import { buildStatements } from '../../src/statements/build.js';
import { today } from '../../src/lib/books.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

describe('where the law comes in for day labour', () => {
  it('24 hours logged in a month (three 8-hour days) for anyone but a subcontractor', () => {
    expect(labourLooks({ kind: 'casual', dayRateCents: 30_000, daysInMonth: 3, on: '2026-11-11' })).toMatchObject({ employee: true, hours: 24, lawApplies: true, belowMinimumWage: false });
    expect(labourLooks({ kind: 'permanent', dayRateCents: 30_000, daysInMonth: 2.99, on: '2026-11-11' })).toMatchObject({ hours: 23.9, lawApplies: false });
    expect(labourLooks({ kind: 'subcontractor', dayRateCents: 10_000, daysInMonth: 20, on: '2026-11-11' })).toMatchObject({ employee: false, lawApplies: false, belowMinimumWage: false });
  });

  it('the national minimum wage for an 8-hour day, from the day each rate applies', () => {
    expect(minimumWageOn('2026-02-28')).toBe(2_879);
    expect(minimumWageOn('2026-03-01')).toBe(3_023);
    expect(labourLooks({ kind: 'casual', dayRateCents: 24_000, daysInMonth: 0, on: '2026-03-01' })).toMatchObject({ minimumDayCents: 24_184, belowMinimumWage: true });
    expect(labourLooks({ kind: 'casual', dayRateCents: 24_000, daysInMonth: 0, on: '2026-02-28' }).belowMinimumWage).toBe(false);
    expect(labourLooks({ kind: 'casual', dayRateCents: 0, daysInMonth: 0, on: '2026-03-01' }).belowMinimumWage).toBe(false);
  });

  it('the minimum wage and the deemed standard employment day pay are checked with the SARS tables each year', () => {
    const from = `${Number(SARS_CHECKED_TO.slice(0, 4)) - 1}-03-01`;
    expect(NATIONAL_MINIMUM_WAGE.some((r) => r.from === from), `the national minimum wage from ${from}`).toBe(true);
    expect(DEEMED_STANDARD_DAY.some((r) => r.taxYearEnd === SARS_CHECKED_TO), `the deemed standard employment day pay for the year to ${SARS_CHECKED_TO}`).toBe(true);
    expect(deemedStandardDayOn('2026-11-11')).toBe(39_400);
  });

  it('cites its sources only from addresses on the privacy list', () => {
    const hosts = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../.github/hosts.json'), 'utf8')).hosts.map((h: { host: string }) => h.host);
    for (const r of [...NATIONAL_MINIMUM_WAGE, ...DEEMED_STANDARD_DAY]) expect(hosts, r.source).toContain(new URL(r.source).host);
  });

  it('says where the law comes in without deciding who’s an employee, and that it’s a reminder from free software', () => {
    const note = casualLabourNote('2026-11-11');
    expect(note).not.toMatch(/24 hours or more a month is your employee/);
    expect(note).toMatch(/usually your employee in the law, however few days they work/);
    expect(note).toMatch(/national minimum wage \(R 30\.23 an hour from 1 Mar 2026\) applies to every worker/);
    expect(note).not.toMatch(/'/);
    expect(note).toMatch(/from 24 hours a month with you, UIF/);
    // PAYE: SARS's tables for most day labour, not "often 25%".
    expect(note).not.toMatch(/often a flat 25%/);
    expect(note).toMatch(/SARS’s tables apply to someone working 22 hours a week or more for you, or at least 5 hours a day for under R 394 a day/);
    expect(note).not.toMatch(/usually apply/);
    expect(note).toMatch(/reminder worked out from the days logged, not advice/);
    expect(note).toMatch(/free software from OpenWorks IT, who are not accountants or labour lawyers/);
    expect(note).not.toMatch(/belongs on Payroll/);
    const months = lawMonthsNote('Fictional Helper', 2);
    expect(months).toMatch(/^From the days logged, Fictional Helper worked about 24 hours or more in 2 months/);
    expect(months).not.toMatch(/is your employee/);
    expect(months).toMatch(/A reminder, not advice/);
    expect(SUBCONTRACTOR_NOTE).toMatch(/Interpretation Note 17\) and for the labour laws \(LRA s200A\): check with your accountant or a labour practitioner/);
  });

  it('setup says it among the cautions before the terms, and SDL counts day wages', () => {
    const cautions = setupCautions({ vatRegistered: true, employees: true, casual: true, sdl: 'no' });
    const casual = cautions.find((c) => c.startsWith('You use casual labour'))!;
    expect(casual).toMatch(/doesn’t work out, deduct or pay PAYE, UIF or the Compensation Fund on day wages/);
    expect(casual).toMatch(/so these may apply: the national minimum wage to every worker, PAYE and the Compensation Fund to employees’ pay, and UIF/);
    expect(casual).toMatch(/check with your accountant or a labour practitioner/);
    expect(cautions.some((c) => /salaries and day wages together/.test(c))).toBe(true);
    // Casual labour without Payroll: SDL said too.
    expect(setupCautions({ vatRegistered: false, employees: false, casual: true }).some((c) => /^SDL: once everything you pay employees \(day wages included\)/.test(c))).toBe(true);
    expect(setupCautions({ vatRegistered: true, employees: false }).some((c) => /casual labour/.test(c))).toBe(false);
  });
});

describe('the workers list, Payroll and Home', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    await env.sql`delete from workers`;
  });
  afterAll(async () => {
    vi.useRealTimers();
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('flags three days this month, and a day rate under the minimum wage, never a subcontractor', async () => {
    const helper = await me.post('/api/workers', { name: 'Sipho Helper (made up)', kind: 'casual', dayRateCents: 20_000 });
    const sub = await me.post('/api/workers', { name: 'Fictional Tiling CC (made up)', kind: 'subcontractor', dayRateCents: 20_000 });
    const d = today();
    for (let i = 0; i < 3; i++) await me.post('/api/labour', { date: d, entries: [{ workerId: helper.id, days: 1, wageCents: 20_000 }, { workerId: sub.id, days: 1, wageCents: 20_000 }] });
    const list = await me.get('/api/workers');
    expect(list.find((w: { id: string }) => w.id === helper.id).law).toMatchObject({ employee: true, hours: 24, lawApplies: true, belowMinimumWage: true, minimumDayCents: minimumWageOn(d) * 8 });
    expect(list.find((w: { id: string }) => w.id === sub.id).law).toMatchObject({ employee: false, lawApplies: false, belowMinimumWage: false });
    await env.sql`delete from labour_entries`;
  });

  it('counts this month and last by South Africa’s day, and not days logged ahead', async () => {
    const w = await me.post('/api/workers', { name: 'Thandi Day (made up)', kind: 'casual', dayRateCents: 30_000 });
    await me.post('/api/labour', { date: '2026-11-30', entries: [{ workerId: w.id, days: 3, wageCents: 90_000 }] });
    await me.post('/api/labour', { date: '2027-01-04', entries: [{ workerId: w.id, days: 2, wageCents: 60_000 }] });
    // 22:30 UTC on 30 November is 00:30 on 1 December in South Africa.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-30T22:30:00Z') });
    const row = (await me.get('/api/workers')).find((x: { id: string }) => x.id === w.id);
    vi.useRealTimers();
    expect(row).toMatchObject({ daysThisMonth: 0, daysLastMonth: 3 });
    await env.sql`delete from labour_entries`;
  });

  it('Payroll’s EMP201 says when a month’s day wages aren’t in it; Home warns when SDL may be due', async () => {
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    await me.post('/api/employees', { name: 'Fictional Clerk', idNumber: '8001015009087', taxNumber: '0123456782', salaryCents: 3_000_000, startDate: '2026-01-01' });
    const run = await me.post('/api/pay-runs', { period: '2026-10', payDate: '2026-10-25', sourceId: bank });
    await me.post(`/api/pay-runs/${run.id}/finalise`);
    const w = await me.post('/api/workers', { name: 'Lungi Helper (made up)', kind: 'casual', dayRateCents: 50_000 });
    await me.post('/api/labour', { date: '2026-10-05', entries: [{ workerId: w.id, days: 1, wageCents: 50_000 }] });
    const sars = await me.get('/api/payroll/sars');
    expect(sars.emp201.find((x: { period: string }) => x.period === '2026-10').dayWagesCents).toBe(50_000);
    expect((await me.get('/api/dashboard')).sdlLine).toBeNull();
    // Day wages that take the year past R500 000 (made up, in one go).
    await me.post('/api/labour', { date: '2026-10-06', entries: [{ workerId: w.id, days: 30, wageCents: 49_000_000 }] });
    const sdl = (await me.get('/api/dashboard')).sdlLine;
    expect(sdl).toMatchObject({ payrollCents: 3_000_000, dayWagesCents: 49_050_000, sdlOn: false });
    // With SDL on, Payroll's SDL covers salaries only: the day wages are a reminder of their own.
    await env.sql`update settings set sdl = true`;
    expect((await me.get('/api/dashboard')).sdlLine).toMatchObject({ sdlOn: true, dayWagesCents: 49_050_000 });
    await env.sql`update settings set sdl = false`;
    // Someone who may see payroll but not wages doesn't get the day wages.
    await me.post('/api/users', { name: 'Payroll Clerk (made up)', email: 'payclerk@example.co.za', role: 'staff', profileId: null, access: ['payroll.view'], password: 'test-password-1' });
    const clerk = await login(env.app, 'payclerk@example.co.za');
    expect((await clerk.get('/api/payroll/sars')).emp201.find((x: { period: string }) => x.period === '2026-10').dayWagesCents).toBe(0);
    expect((await clerk.get('/api/dashboard')).sdlLine ?? null).toBeNull();
  });
});

describe('the statements: day labour under 24 hours a month', () => {
  it('PAYE and the Compensation Fund, and the employee benefits policy, whatever the hours; no leave item', async () => {
    const env = await setup();
    try {
      const me = await login(env.app, 'owner@example.co.za');
      const { settings } = await me.get('/api/reference');
      const { termsAcceptedAt: _t, logoId: _l, ...rest } = settings;
      await me.post('/api/settings', { ...rest, companyName: 'Fictional Works (made up)', businessType: 'company', fyEndMonth: 2, features: { ...settings.features, statements: true } }, 'PUT');
      await env.sql`delete from workers`;
      const helper = await me.post('/api/workers', { name: 'Sipho Helper (made up)', kind: 'casual', dayRateCents: 30_000 });
      for (const m of ['2025-04', '2025-05']) await me.post('/api/labour', { date: `${m}-10`, entries: [{ workerId: helper.id, days: 2, wageCents: 60_000 }] });
      const s = await buildStatements(env.sql, '2026-02-28');
      const item = s.checks.find((c) => c.label.startsWith('PAYE and the Compensation Fund on day wages'))!;
      expect(item.detail).toMatch(/^R\s?1 200\.00 of day wages in the year: PAYE and the Compensation Fund may apply to them\. Shap/);
      expect(s.checks.find((c) => c.label.startsWith('Leave pay and bonuses owed'))).toBeUndefined();
      expect(s.policyDefaults.employee_benefits).toMatch(/short-term employee benefits/);
      await expectCleanAudit(env.sql);
    } finally {
      await env.close();
    }
  });
});

describe('the statements: day labour that’s employment in the law, and subcontractors', () => {
  it('reminds the accountant of leave pay and of UIF, PAYE and the Compensation Fund; employee costs leave out subcontractors', async () => {
    const env = await setup();
    try {
      const me = await login(env.app, 'owner@example.co.za');
      const { settings } = await me.get('/api/reference');
      const { termsAcceptedAt: _t, logoId: _l, ...rest } = settings;
      await me.post('/api/settings', { ...rest, companyName: 'Fictional Works (made up)', businessType: 'company', fyEndMonth: 2, features: { ...settings.features, statements: true } }, 'PUT');
      await env.sql`delete from workers`;
      const helper = await me.post('/api/workers', { name: 'Sipho Helper (made up)', kind: 'casual', dayRateCents: 30_000 });
      const sub = await me.post('/api/workers', { name: 'Fictional Tiling CC (made up)', kind: 'subcontractor', dayRateCents: 200_000 });
      for (const m of ['2025-04', '2025-05', '2025-06']) await me.post('/api/labour', { date: `${m}-10`, entries: [{ workerId: helper.id, days: 3, wageCents: 90_000 }] });
      await me.post('/api/labour', { date: '2025-07-10', entries: [{ workerId: sub.id, days: 3, wageCents: 600_000 }] });
      const s = await buildStatements(env.sql, '2026-02-28');
      const look = (start: string) => s.checks.find((c) => c.label.startsWith(start));
      expect(look('Leave pay and bonuses owed to employees')!.detail).toMatch(/Workers doesn’t for day labour/);
      const uif = look('PAYE, UIF and the Compensation Fund on day wages')!;
      expect(uif.ok).toBe(false);
      expect(uif.detail).toMatch(/and UIF to the R\s?2 700\.00 earned in the 3 months a worker reached about 24 hours/);
      expect(s.policyDefaults.employee_benefits).toMatch(/short-term employee benefits/);
      const stated = s.notes.find((n) => n.key === 'operating_profit')!.tables[0]!.rows;
      expect(stated.find((r) => r.label === 'Employee costs')!.current).toBe(270_000);
      expect(stated.find((r) => r.label === 'Subcontractors')!.current).toBe(600_000);
      await expectCleanAudit(env.sql);
    } finally {
      await env.close();
    }
  });
});
