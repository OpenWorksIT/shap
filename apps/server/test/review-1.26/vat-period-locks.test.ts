/**
 * 1.26, the owner's call: a VAT vendor that doesn't sell closes its books VAT period by VAT period
 * (docs/LOCKS.md), as a business that sells closes each month: by hand, or each period locks itself
 * on a day of the month after it ends. A business neither selling nor registered for VAT still
 * closes its years. Each test failed before. All data made up.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closesBy, nextPeriodLock, periodLockDue } from '@shap/shared';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

describe('when each kind of VAT period locks itself', () => {
  it('locks on the day of the month after the period ends, the last period ended before that', () => {
    expect(closesBy({ sells: true, vatRegistered: true })).toBe('month');
    expect(closesBy({ sells: false, vatRegistered: true })).toBe('vat');
    expect(closesBy({ sells: false, vatRegistered: false })).toBe('year');
    // Category B (two months, ending Feb, Apr…): Sep–Oct locks on 7 November.
    expect(periodLockDue('2026-11-06', 7, 'vat', 'B', 2)).toBe('2026-08-31');
    expect(periodLockDue('2026-11-07', 7, 'vat', 'B', 2)).toBe('2026-10-31');
    expect(periodLockDue('2026-12-20', 7, 'vat', 'B', 2)).toBe('2026-10-31');
    expect(nextPeriodLock('2026-11-07', 7, 'vat', 'B', 2)).toEqual({ through: '2026-12-31', on: '2027-01-07' });
    expect(nextPeriodLock('2026-11-06', 7, 'vat', 'B', 2)).toEqual({ through: '2026-10-31', on: '2026-11-07' });
    // A (ending Jan, Mar…), C (monthly), D (six months, ending Feb and Aug), E (the year).
    expect(periodLockDue('2026-11-07', 7, 'vat', 'A', 2)).toBe('2026-09-30');
    expect(periodLockDue('2026-11-07', 7, 'vat', 'C', 2)).toBe('2026-10-31');
    expect(periodLockDue('2026-11-07', 7, 'vat', 'D', 2)).toBe('2026-08-31');
    expect(periodLockDue('2026-11-07', 7, 'vat', 'E', 6)).toBe('2026-06-30');
    expect(nextPeriodLock('2026-11-07', 7, 'vat', 'E', 6)).toEqual({ through: '2027-06-30', on: '2027-07-07' });
    // A business that sells: months, as before.
    expect(periodLockDue('2026-11-07', 7, 'month', 'B', 2)).toBe('2026-10-31');
  });
});

describe('a VAT vendor that doesn’t sell closes each VAT period', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  const cost = async (date: string) => {
    const r = await ref(env.sql);
    return me.call({ method: 'POST', url: '/api/costs', payload: { date, description: 'Stationery (made up)', amountCents: 11_500, vatCents: 1_500, vatCode: 'standard', categoryId: await r.cat('Sundry'), sourceId: await r.src('Business bank') } });
  };
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4740101508', vatCategory: 'B', fyEndMonth: 2 }, 'PUT');
  });
  afterAll(async () => {
    vi.useRealTimers();
    await expectCleanAudit(env.sql, '2026-10-31');
    await env.close();
  });

  it('lists its VAT periods, two months each, newest first', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-05T08:00:00Z') });
    const p = await me.get('/api/periods');
    expect(p.closes).toBe('vat');
    expect(p.periods.map((x: { start: string; end: string }) => `${x.start} ${x.end}`).slice(0, 3)).toEqual(['2026-11-01 2026-12-31', '2026-09-01 2026-10-31', '2026-07-01 2026-08-31']);
    expect(p.periods).toHaveLength(8);
    expect(p.periods[0]).toMatchObject({ ended: false, locked: false });
  });

  it('by hand: nothing locks by itself; Home says when the last VAT period is due, from its day', async () => {
    vi.setSystemTime(new Date('2026-11-09T08:00:00Z'));
    expect((await me.get('/api/dashboard')).periods).toMatchObject({ monthDue: '2026-10-31', closes: 'vat', lockDate: null });
    expect((await cost('2026-10-20')).statusCode).toBe(200);
    // Closed by hand, up to a VAT period's end.
    expect((await me.post('/api/periods/lock', { through: '2026-08-31' })).lockDate).toBe('2026-08-31');
    expect((await cost('2026-08-20')).statusCode).toBe(400);
  });

  it('by itself: each VAT period locks on its day of the month after, once', async () => {
    vi.setSystemTime(new Date('2026-11-05T08:00:00Z'));
    const s = await me.post('/api/periods/month-end', { mode: 'auto', day: 7 }, 'PUT');
    expect(s.monthEnd.next).toEqual({ through: '2026-10-31', on: '2026-11-07' });
    expect((await cost('2026-10-21')).statusCode).toBe(200);
    vi.setSystemTime(new Date('2026-11-07T08:00:00Z'));
    const r = await cost('2026-10-22');
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/closed up to 2026-10-31/);
    expect((await me.get('/api/periods')).lockDate).toBe('2026-10-31');
    const [locked] = await env.sql<{ details: { by: string; through: string } }[]>`select details from audit_log where entity = 'period' and action = 'lock' and actor = 'system'`;
    expect(locked!.details).toMatchObject({ by: 'VAT period end, by itself', through: '2026-10-31' });
    // The VAT period under way is open.
    expect((await cost('2026-11-02')).statusCode).toBe(200);
    vi.useRealTimers();
  });
});

describe('a business neither selling nor registered for VAT', () => {
  it('still closes its years, with no period end', async () => {
    const env = await setup();
    try {
      const me = await login(env.app, 'owner@example.co.za');
      const p = await me.get('/api/periods');
      expect(p.closes).toBe('year');
      const r = await me.call({ method: 'PUT', url: '/api/periods/month-end', payload: { mode: 'auto', day: 7 } });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(/registered for VAT/);
      await expectCleanAudit(env.sql);
    } finally {
      await env.close();
    }
  });
});
