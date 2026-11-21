import { describe, expect, it } from 'vitest';
import { addDays, addMonths } from '@shap/shared';
import { today } from '../../src/lib/books.js';
import { cashForecast } from '../../src/modules/forecast.js';
import { expectCleanAudit, login, ref, setup } from '../helpers.js';

// The ninth round of 1.33's reviews (SARS): EMP201s and DTR01s paid on Payroll → SARS with a date after the forecast's 13
// weeks (the round-8 fix covers journals). Made-up business, made-up figures.

const now = today();
const thisMonth = `${now.slice(0, 8)}01`;
type F = Awaited<ReturnType<typeof cashForecast>>;
const weeksAddUp = (f: F) => expect(f.weeks[f.weeks.length - 1]!.closingCents).toBe(f.openingCents + f.items.reduce((t, x) => t + x.cents, 0));

describe('EMP201 paid on Payroll → SARS, dated after the 13 weeks', () => {
  it('goes out once, and is said as the EMP201 (not "a journal, or balances brought in")', async () => {
    const env = await setup();
    try {
      const owner = await login(env.app, 'owner@example.co.za');
      const r = await ref(env.sql);
      const bank = await r.src('Business bank');
      const { settings: s } = await owner.get('/api/reference');
      await owner.post('/api/settings', { ...s, businessType: 'company', features: { ...s.features, payroll: true } }, 'PUT');
      await owner.post('/api/employees', { name: 'Made-up One', salaryCents: 3_000_000, startDate: addMonths(thisMonth, -6) });
      const lastMonth = addMonths(thisMonth, -1);
      const run = await owner.post('/api/pay-runs', { period: lastMonth.slice(0, 7), payDate: addDays(lastMonth, 24), sourceId: bank });
      await owner.post(`/api/pay-runs/${run.id}/finalise`);
      const [m] = await env.sql<{ t: string }[]>`select sum(paye_cents + uif_employee_cents + uif_employer_cents + sdl_cents)::bigint as t from pay_lines where run_id = ${run.id}`;
      const total = Number(m!.t);
      const res = await owner.call({ method: 'POST', url: '/api/sars-payments', payload: { kind: 'emp201', period: lastMonth.slice(0, 7), date: addDays(now, 120), amountCents: total, sourceId: bank } });
      expect(res.statusCode).toBe(200);
      const f = await cashForecast(env.sql, now);
      weeksAddUp(f);
      const out = f.items.filter((x) => x.kind === 'emp201' && !/as your recent pay runs/.test(x.label));
      expect(out.reduce((t, x) => t - x.cents, 0)).toBe(total);
      expect(out.map((x) => x.label)).toEqual([expect.stringMatching(/^EMP201 for /)]);
      await expectCleanAudit(env.sql);
    } finally {
      await env.close();
    }
  });
});

describe('DTR01 paid on Payroll → SARS, dated after the 13 weeks', () => {
  it('still goes out within them (as one paid by a journal dated then does)', async () => {
    const env = await setup();
    try {
      const owner = await login(env.app, 'owner@example.co.za');
      const r = await ref(env.sql);
      const bank = await r.src('Business bank');
      const { settings } = await owner.get('/api/reference');
      await owner.post('/api/settings', { ...settings, businessType: 'company' }, 'PUT');
      const client = await owner.post('/api/clients', { name: 'Made-up Client', address: '1 Made-up Street, Fictional Town' });
      const inv = await owner.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: addDays(now, -40), dueDate: addDays(now, -10), lines: [{ category: 'labour', description: 'Work', qty: 1, unitPriceCents: 5_000_000 }] });
      await owner.post(`/api/documents/${inv.id}/issue`);
      const paidOn = addDays(now, -1);
      await owner.post('/api/dividends', { declaredOn: paidOn, paidOn, shareholder: 'Made-up Shareholder', grossCents: 1_000_000, sourceId: bank });
      const dtr = (f: F) => 0 - f.items.filter((x) => x.kind === 'dwt').reduce((t, x) => t + x.cents, 0) || 0;
      expect(dtr(await cashForecast(env.sql, now))).toBe(200_000);
      const res = await owner.call({ method: 'POST', url: '/api/sars-payments', payload: { kind: 'dwt', period: paidOn.slice(0, 7), date: addDays(now, 120), amountCents: 200_000, sourceId: bank } });
      expect(res.statusCode).toBe(200);
      const f = await cashForecast(env.sql, now);
      weeksAddUp(f);
      expect(dtr(f)).toBe(200_000);
      await expectCleanAudit(env.sql);
    } finally {
      await env.close();
    }
  });
});
