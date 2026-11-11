/**
 * 1.26, the owner's call: day labour and the law (docs/CASUAL_LABOUR.md). Shap records a worker's
 * days and pay and says where the law starts to apply: 24 hours a month (UIF, UICA s4(1)(a); the
 * BCEA's working-time chapter, s6(1)(c)), the national minimum wage for a full day, and that UIF
 * and tax on day wages are the business's to handle, from free software whose makers aren't
 * accountants or labour lawyers. Each test failed before. All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { casualLabourNote, labourLooks, minimumWageOn, NATIONAL_MINIMUM_WAGE, SARS_CHECKED_TO, SUBCONTRACTOR_NOTE } from '@shap/shared';
import { today } from '../../src/lib/books.js';
import { expectCleanAudit, login, setup, type TestEnv } from '../helpers.js';

describe('where the law starts for day labour', () => {
  it('24 hours a month (three full days) for anyone but a subcontractor', () => {
    expect(labourLooks({ kind: 'casual', dayRateCents: 30_000, daysInMonth: 3, on: '2026-11-11' })).toMatchObject({ employee: true, hours: 24, lawApplies: true, belowMinimumWage: false });
    expect(labourLooks({ kind: 'permanent', dayRateCents: 30_000, daysInMonth: 2.5, on: '2026-11-11' }).lawApplies).toBe(false);
    expect(labourLooks({ kind: 'subcontractor', dayRateCents: 10_000, daysInMonth: 20, on: '2026-11-11' })).toMatchObject({ employee: false, lawApplies: false, belowMinimumWage: false });
  });

  it('the national minimum wage for a full day, from the day each rate applies', () => {
    expect(minimumWageOn('2026-02-28')).toBe(2_879);
    expect(minimumWageOn('2026-03-01')).toBe(3_023);
    expect(labourLooks({ kind: 'casual', dayRateCents: 24_000, daysInMonth: 0, on: '2026-03-01' })).toMatchObject({ minimumDayCents: 24_184, belowMinimumWage: true });
    expect(labourLooks({ kind: 'casual', dayRateCents: 24_000, daysInMonth: 0, on: '2026-02-28' }).belowMinimumWage).toBe(false);
    // No rate set: nothing to compare.
    expect(labourLooks({ kind: 'casual', dayRateCents: 0, daysInMonth: 0, on: '2026-03-01' }).belowMinimumWage).toBe(false);
  });

  it('the minimum wage is checked with the SARS tables each year', () => {
    // The tax year SARS_CHECKED_TO ends has its minimum wage (moved on together: CPDAUDIT.md section 2).
    const from = `${Number(SARS_CHECKED_TO.slice(0, 4)) - 1}-03-01`;
    expect(NATIONAL_MINIMUM_WAGE.some((r) => r.from === from), `the national minimum wage from ${from}`).toBe(true);
  });

  it('says whose the law is, and who Shap’s makers are', () => {
    const note = casualLabourNote('2026-11-11');
    expect(note).toMatch(/24 hours or more a month is your employee in the law/);
    expect(note).toMatch(/R30\.23 an hour/);
    expect(note).toMatch(/doesn't work out or pay UIF or tax/);
    expect(note).toMatch(/free software from OpenWorks IT, who are not accountants or labour lawyers/);
    expect(SUBCONTRACTOR_NOTE).toMatch(/Interpretation Note 17/);
  });
});

describe('the workers list says where the law applies', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('flags three days this month, and a day rate under the minimum wage', async () => {
    const me = await login(env.app, 'owner@example.co.za');
    await env.sql`delete from workers`;
    const helper = await me.post('/api/workers', { name: 'Sipho Helper (made up)', kind: 'casual', dayRateCents: 20_000 });
    const sub = await me.post('/api/workers', { name: 'Fictional Tiling CC (made up)', kind: 'subcontractor', dayRateCents: 20_000 });
    const d = today();
    for (let i = 0; i < 3; i++) await me.post('/api/labour', { date: d, entries: [{ workerId: helper.id, days: 1, wageCents: 20_000 }, { workerId: sub.id, days: 1, wageCents: 20_000 }] });
    const list = await me.get('/api/workers');
    const h = list.find((w: { id: string }) => w.id === helper.id);
    expect(h.law).toMatchObject({ employee: true, hours: 24, lawApplies: true, belowMinimumWage: true, minimumDayCents: minimumWageOn(d) * 8 });
    expect(list.find((w: { id: string }) => w.id === sub.id).law).toMatchObject({ employee: false, lawApplies: false, belowMinimumWage: false });
  });
});
