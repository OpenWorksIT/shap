/**
 * 1.26, the owner's call: a VAT vendor that doesn't sell closes its books VAT period by VAT period
 * (docs/LOCKS.md), as a business that sells closes each month: by hand, or each period locks itself
 * on a day of the month after it ends. A business neither selling nor registered for VAT still
 * closes its years. Each test failed before. All data made up.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closesBy, nextPeriodLock, periodLockDue, vatLockDayLate } from '@shap/shared';
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

/** The five reviews of 1.26 (CPDAUDIT.md section 7): how the books close never changes under the owner. */
describe('changing how the books close locks nothing at once', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  const cost = async (date: string) => {
    const r = await ref(env.sql);
    return me.call({ method: 'POST', url: '/api/costs', payload: { date, description: 'Stationery (made up)', amountCents: 11_500, vatCents: 1_500, vatCode: 'standard', categoryId: await r.cat('Sundry'), sourceId: await r.src('Business bank') } });
  };
  const settings = async (change: Record<string, unknown>) => {
    const { settings: s } = await me.get('/api/reference');
    const { termsAcceptedAt: _t, logoId: _l, ...rest } = s;
    return me.post('/api/settings', { ...rest, ...change, features: { ...s.features, ...((change.features as object) ?? {}) } }, 'PUT');
  };
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
  });
  afterAll(async () => {
    vi.useRealTimers();
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('books from 1.25 that kept month end “by itself” after switching Sales off close their VAT periods by hand', async () => {
    await settings({ vatRegistered: true, vatNumber: '4740101508', vatCategory: 'B', fyEndMonth: 2 });
    // As 1.25 left them: by itself on the 7th, chosen while selling; April locked by itself.
    await env.sql`update settings set month_end_mode = 'auto', month_end_day = 7, lock_date = '2026-04-30', month_locked_through = '2026-04-30'`;
    await env.sql.unsafe(readFileSync(join(import.meta.dirname, '../../migrations/045_vat_period_locks.sql'), 'utf8'));
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-11T08:00:00Z') });
    expect((await cost('2026-06-15')).statusCode).toBe(200);
    expect((await me.get('/api/periods')).lockDate).toBe('2026-04-30');
    expect((await env.sql`select month_end_mode from settings`)[0]!.monthEndMode).toBe('manual');
    vi.useRealTimers();
  });

  it('switching Sales on or off starts the new way by hand, logged', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-11T08:00:00Z') });
    await settings({ features: { sales: true } });
    await me.post('/api/periods/month-end', { mode: 'auto', day: 7, closeYears: true }, 'PUT');
    await settings({ features: { sales: false, inventory: false } });
    expect((await env.sql`select month_end_mode from settings`)[0]!.monthEndMode).toBe('manual');
    const [logged] = await env.sql<{ details: { sales?: unknown; lock?: { closes: unknown } } }[]>`select details from audit_log where entity = 'settings' and action = 'update' order by id desc limit 1`;
    expect(logged!.details).toMatchObject({ sales: { was: true, now: false }, lock: { closes: { was: 'month', now: 'vat' } } });
    vi.useRealTimers();
  });

  it('a new VAT category while the books are reopened doesn’t lock them again under whoever’s putting them right', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-09T08:00:00Z') });
    await settings({ vatCategory: 'D' });
    await me.post('/api/periods/month-end', { mode: 'auto', day: 7, closeYears: true }, 'PUT');
    // (Closed to 31 October by the months before: category D's six months to August are within it.)
    expect((await me.get('/api/periods')).lockDate).toBe('2026-10-31');
    await me.post('/api/periods/reopen', { to: '2026-02-28', reason: 'A cost on the wrong date (made up)' });
    await settings({ vatCategory: 'B' });
    expect((await cost('2026-06-11')).statusCode).toBe(200);
    const p = await me.get('/api/periods');
    expect(p.lockDate).toBe('2026-02-28');
    expect(p.reopened).toMatchObject({ relockDate: '2026-10-31' });
    vi.useRealTimers();
  });
});

describe('locking by itself asks before it closes a year not yet agreed or approved', () => {
  it('names the year, and locks once asked again', async () => {
    const env = await setup();
    try {
      const me = await login(env.app, 'owner@example.co.za');
      const { settings } = await me.get('/api/reference');
      await me.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4740101508', vatCategory: 'B', fyEndMonth: 2 }, 'PUT');
      const r = await ref(env.sql);
      await me.post('/api/costs', { date: '2025-06-01', description: 'Stationery (made up)', amountCents: 11_500, vatCents: 1_500, vatCode: 'standard', categoryId: await r.cat('Sundry'), sourceId: await r.src('Business bank') });
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-11T08:00:00Z') });
      const asked = await me.call({ method: 'PUT', url: '/api/periods/month-end', payload: { mode: 'auto', day: 7 } });
      expect(asked.statusCode).toBe(400);
      expect(asked.json()).toMatchObject({ code: 'closes_year' });
      expect(asked.json().error).toMatch(/closes the year to 28 Feb 2026, not yet agreed with your accountant or approved/);
      expect((await me.get('/api/periods')).monthEnd.mode).toBe('manual');
      // The statements' page sees a period that has locked itself, before anything is saved.
      await me.post('/api/periods/month-end', { mode: 'auto', day: 7, closeYears: true }, 'PUT');
      expect((await env.sql`select lock_date::text as d from settings`)[0]!.d).toBeNull();
      expect((await me.get('/api/statements/2026-02-28')).yearClosed).toBe(true);
      vi.useRealTimers();
      await expectCleanAudit(env.sql);
    } finally {
      vi.useRealTimers();
      await env.close();
    }
  });
});

describe('month end for a business that sells: an older month still open is due', () => {
  it('reminds before this month’s day when the month before last is open', async () => {
    const env = await setup();
    try {
      const me = await login(env.app, 'owner@example.co.za');
      const { settings } = await me.get('/api/reference');
      await me.post('/api/settings', { ...settings, features: { ...settings.features, sales: true } }, 'PUT');
      await me.post('/api/periods/lock', { through: '2026-08-31' });
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-03T08:00:00Z') });
      expect((await me.get('/api/dashboard')).periods.monthDue).toBe('2026-09-30');
      vi.useRealTimers();
      await me.post('/api/periods/lock', { through: '2026-09-30' });
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-03T08:00:00Z') });
      expect((await me.get('/api/dashboard')).periods.monthDue).toBeNull();
      vi.useRealTimers();
      await expectCleanAudit(env.sql);
    } finally {
      vi.useRealTimers();
      await env.close();
    }
  });

  it('a lock day after the 25th can come after the VAT201', () => {
    expect(vatLockDayLate(25)).toBe(false);
    expect(vatLockDayLate(26)).toBe(true);
  });
});
