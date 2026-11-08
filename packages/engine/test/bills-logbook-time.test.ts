/** Supplier bills, the VAT201 layout, turnover tax, the travel logbook and the time tracker. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { turnoverTax, vatPeriod } from '@shap/shared';
import { balance, login, ref, setup, type TestEnv } from './helpers.js';

describe('more of the books', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app);
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4000000002', vatCategory: 'B', features: { ...settings.features, bills: true } }, 'PUT');
  });
  afterAll(() => env.close());

  it('keeps a bill owed until it is paid', async () => {
    const r = await ref(env.sql);
    const { sources } = await me.get('/api/reference');
    const billSource = sources.find((s: { role: string | null }) => s.role === 'bills');
    expect(billSource).toBeTruthy();
    const bill = await me.post('/api/costs', { date: '2026-10-03', description: 'Cable', supplier: 'Wholesaler', amountCents: 115000, vatCents: 15000, categoryId: await r.cat('Parts'), sourceId: billSource.id, billNumber: 'W-881', dueDate: '2026-11-02' });
    expect(await balance(env.sql, 'payables')).toBe(-115000);
    let list = await me.get('/api/bills');
    expect(list[0]).toMatchObject({ billNumber: 'W-881', owingCents: 115000 });
    expect((await me.get('/api/dashboard')).billsDue).toHaveLength(1);
    const bank = await r.src('Business bank');
    expect((await me.call({ method: 'POST', url: `/api/costs/${bill.id}/bill-payments`, payload: { date: '2026-10-20', amountCents: 200000, sourceId: bank } })).statusCode).toBe(400);
    await me.post(`/api/costs/${bill.id}/bill-payments`, { date: '2026-10-20', amountCents: 115000, sourceId: bank });
    expect(await balance(env.sql, 'payables')).toBe(0);
    list = await me.get('/api/bills');
    expect(list).toHaveLength(0);
    expect((await me.get('/api/bills?state=paid'))[0].payments).toHaveLength(1);
  });

  it('lays out the VAT201 for a two-month period', async () => {
    expect(vatPeriod('2026-10-15', 'B')).toEqual({ start: '2026-09-01', end: '2026-10-31' });
    expect(vatPeriod('2026-10-15', 'A')).toEqual({ start: '2026-10-01', end: '2026-11-30' });
    expect(vatPeriod('2026-10-15', 'C')).toEqual({ start: '2026-10-01', end: '2026-10-31' });
    const inv = await me.post('/api/documents', { kind: 'invoice', issueDate: '2026-10-10', lines: [{ category: 'labour', description: 'Labour', qty: 1, unitPriceCents: 100000 }] });
    await me.post(`/api/documents/${inv.id}/issue`);
    const v = await me.get('/api/vat/return?on=2026-10-10');
    expect(v.period).toEqual({ start: '2026-09-01', end: '2026-10-31' });
    expect(v.due).toBe('2026-11-30');
    expect(v.fields).toMatchObject({ field1: 115000, field4: 15000, field15: 15000, field19: 15000, field20: 0 });
  });

  it('works out turnover tax on SARS’s bands', async () => {
    expect(turnoverTax(500_000_00, '2027-02-28')).toBe(0);
    expect(turnoverTax(800_000_00, '2027-02-28')).toBe(2_000_00); // 1% of 200 000
    expect(turnoverTax(1_000_000_00, '2027-02-28')).toBe(4_500_00); // 3 500 + 2% of 50 000
    expect(turnoverTax(1_500_000_00, '2027-02-28')).toBe(15_500_00); // 12 500 + 3% of 100 000
    expect(turnoverTax(400_000_00, '2026-02-28')).toBe(650_00); // older table: 1% of 65 000
    const t = await me.get('/api/reports/turnover-tax?fyEnd=2027-02-28');
    expect(t.interim.map((i: { due: string }) => i.due)).toEqual(['2026-08-31', '2027-02-26']);
  });

  it('keeps a SARS logbook with the business share', async () => {
    await me.post('/api/logbook/2027-02-28', { vehicle: 'Toyota Hilux CA 123-456', odometerStart: 100000, odometerEnd: 130000 }, 'PUT');
    await me.post('/api/trips', { date: '2026-04-02', fromPlace: 'Walmer', toPlace: 'Summerstrand', reason: 'Quote at Bayview Guesthouse', km: 18 });
    await me.post('/api/trips', { date: '2026-04-05', fromPlace: 'Home', toPlace: 'Mall', reason: 'Shopping', km: 12, business: false });
    const lb = await me.get('/api/logbook?yearEnd=2027-02-28');
    expect(lb).toMatchObject({ totalKm: 30000, businessKm: 18, loggedKm: 30 });
    expect(lb.businessShare).toBeCloseTo(18 / 30000);
    const csv = await me.call({ method: 'GET', url: '/api/logbook?yearEnd=2027-02-28&format=csv' });
    expect(csv.body).toContain('Quote at Bayview Guesthouse');
    expect(await me.get('/api/trips/places')).toContain('Summerstrand');
  });

  it('times a job and puts the hours on an invoice at the job’s rate', async () => {
    const job = await me.post('/api/projects', { name: 'Logo for Bloom', hourlyRateCents: 45000 });
    await me.post('/api/time', { projectId: job.id, startedAt: '2026-10-01T08:00:00+02:00', endedAt: '2026-10-01T10:30:00+02:00' });
    const started = await me.post('/api/time/start', { projectId: job.id });
    expect((await me.get('/api/time')).running.id).toBe(started.id);
    await me.post('/api/time/stop');
    const unbilled = await me.get(`/api/time?project=${job.id}&unbilled=1`);
    expect(unbilled.entries).toHaveLength(2);
    const inv = await me.post('/api/documents', { kind: 'invoice', issueDate: '2026-10-31', projectId: job.id, lines: [] });
    await me.post('/api/time/bill', { documentId: inv.id, ids: unbilled.entries.map((e: { id: string }) => e.id) });
    const d = await me.get(`/api/documents/${inv.id}`);
    expect(d.lines[0]).toMatchObject({ description: 'Time: Logo for Bloom', unit: 'hour', unitPriceCents: 45000, qty: 2.5 });
    expect(d.doc.subtotalCents).toBe(112500);
    expect((await me.get(`/api/time?project=${job.id}&unbilled=1`)).entries).toHaveLength(0);
  });

  it('bills time with no job (or a job without a rate) at the usual hourly rate', async () => {
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, hourlyRateCents: 60000 }, 'PUT');
    const t = await me.post('/api/time', { projectId: null, startedAt: '2026-10-05T08:00:00+02:00', endedAt: '2026-10-05T09:30:00+02:00', note: 'Admin for client' });
    const { entries } = await me.get('/api/time?unbilled=1');
    expect(entries.find((e: { id: string }) => e.id === t.id).hourlyRateCents).toBe(60000);
    const inv = await me.post('/api/documents', { kind: 'invoice', issueDate: '2026-10-06', lines: [] });
    await me.post('/api/time/bill', { documentId: inv.id, ids: [t.id] });
    const d = await me.get(`/api/documents/${inv.id}`);
    expect(d.lines[0]).toMatchObject({ qty: 1.5, unitPriceCents: 60000, lineTotalCents: 90000 });
  });
});
