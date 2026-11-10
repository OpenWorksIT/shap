/**
 * From the independent review of 1.23 (each failed before the fix): what staff who read the books
 * learn of people's pay. The tax pack printed every employee's name, gross pay and PAYE (EMP501)
 * for "Reports" without "See payroll", and so did the books audit's names; logging days handed back
 * the worker's wage; and "Reports" read each casual worker's wages in the ledger and its exports
 * without saying so (it now comes with "See days worked and wages"). All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withNeeds } from '@shap/shared';
import { expectCleanAudit, ref, sessionFor, setup, type TestEnv } from '../helpers.js';

const FY = '2026-02-28';

const pdfText = async (buf: Buffer) => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  let out = '';
  for (let n = 1; n <= doc.numPages; n++) out += (await (await doc.getPage(n)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ') + '\n';
  return out.replace(/\s+/g, ' ');
};

describe('people’s pay, for staff who read the books', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof sessionFor>>;
  let worker: { id: string };
  beforeAll(async () => {
    env = await setup();
    owner = await sessionFor(env, 'owner@example.co.za');
    const bank = await (await ref(env.sql)).src('Business bank');
    // An employee without a tax number (so the books audit names her), paid in November 2025.
    await owner.post('/api/employees', { name: 'Zodwa Fictional', salaryCents: 3_456_700, startDate: '2025-03-01' });
    const run = await owner.post('/api/pay-runs', { period: '2025-11', payDate: '2025-11-25', sourceId: bank });
    await owner.post(`/api/pay-runs/${run.id}/finalise`);
    // And in this tax year, for the books audit (which looks at the tax year to date).
    const m = (await env.sql<{ m: string }[]>`select to_char(current_date, 'YYYY-MM') as m`)[0]!.m;
    const now = await owner.post('/api/pay-runs', { period: m, payDate: `${m}-01`, sourceId: bank });
    await owner.post(`/api/pay-runs/${now.id}/finalise`);
    worker = await owner.post('/api/workers', { name: 'Fictional Helper', kind: 'casual', dayRateCents: 43_210 });
    const admin = (await owner.get('/api/profiles')).find((p: { name: string }) => p.name === 'Admin');
    await owner.post('/api/users', { name: 'Admin (made up)', email: 'admin@example.co.za', role: 'staff', profileId: admin.id, password: 'test-password-1' });
    await owner.post('/api/users', { name: 'Logger (made up)', email: 'logger@example.co.za', role: 'staff', profileId: null, access: ['labour.log'], password: 'test-password-1' });
  });
  afterAll(() => env.close());

  it('keeps each employee’s pay out of the tax pack without “See payroll”, and in it for the owner', async () => {
    const admin = await sessionFor(env, 'admin@example.co.za');
    expect((await admin.call({ method: 'GET', url: '/api/employees' })).statusCode).toBe(403);
    const theirs = await admin.call({ method: 'GET', url: `/api/tax-pack?fyEnd=${FY}` });
    expect(theirs.statusCode).toBe(200);
    const text = await pdfText(theirs.rawPayload);
    // No one's certificate: their name, ID or pay. (The salaries account is the books' own total.)
    expect(text).not.toContain('Zodwa Fictional');
    expect(text).not.toContain('Gross (3699)');
    expect(text).toContain('left out of this copy');
    // The monthly totals (what the books show anyway) stay.
    expect(text).toContain('Month (EMP201)');
    const owners = await pdfText((await owner.call({ method: 'GET', url: `/api/tax-pack?fyEnd=${FY}` })).rawPayload);
    expect(owners).toContain('Zodwa Fictional');
  });

  it('counts rather than names employees in the books audit without “See payroll”', async () => {
    const admin = await sessionFor(env, 'admin@example.co.za');
    const theirs = (await admin.get('/api/audit/books')).items.map((i: { text: string }) => i.text).join('\n');
    expect(theirs).not.toContain('Zodwa Fictional');
    expect(theirs).toContain('1 employee (Payroll names them)');
    const owners = (await owner.get('/api/audit/books')).items.map((i: { text: string }) => i.text).join('\n');
    expect(owners).toContain('Zodwa Fictional');
  });

  it('gives reading the books with seeing workers’ wages, since the ledger names them', async () => {
    expect(withNeeds(['reports.view'])).toContain('labour.view');
    await owner.post('/api/users', { name: 'Reports (made up)', email: 'reports@example.co.za', role: 'staff', profileId: null, access: ['reports.view'], password: 'test-password-1' });
    const who = await sessionFor(env, 'reports@example.co.za');
    expect((await who.get('/api/auth/me')).user.access).toEqual(['labour.view', 'reports.view']);
  });

  it('doesn’t hand a day’s wage back to someone who only logs days', async () => {
    const logger = await sessionFor(env, 'logger@example.co.za');
    const { ids } = await logger.post('/api/labour', { date: '2026-07-01', entries: [{ workerId: worker.id, days: 1, wageCents: 0, allowanceCents: 0 }] });
    const changed = await logger.post(`/api/labour/${ids[0]}`, { date: '2026-07-01', workerId: worker.id, days: 0.5, wageCents: 0, allowanceCents: 0, note: 'Half a day (made up)' }, 'PUT');
    expect(changed.days).toBe(0.5);
    expect(Object.keys(changed).filter((k) => /wage|allowance/i.test(k))).toEqual([]);
    await expectCleanAudit(env.sql);
  });
});
