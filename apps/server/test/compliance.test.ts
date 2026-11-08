/**
 * The accountant's review: reference numbers in the right shape, the terms of use accepted and
 * recorded, tax invoices and credit notes carrying what the VAT Act asks, the audit log, the
 * EMP501, dividends always on for a company, and OpenWorks' notices.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { idNumberProblem, noticesFor, payeRefProblem, regNumberProblem, settingsNumberProblem, taxNumberProblem, TERMS_VERSION, tidyNumbers, uifRefProblem, vatNumberProblem } from '@shap/shared';
import { login, ref, setup, type TestEnv, expectCleanAudit } from './helpers.js';

describe('reference numbers', () => {
  it('knows a VAT number, an income tax number and a PAYE reference by their shape and check digit', () => {
    expect(vatNumberProblem('4740101508')).toBeNull();
    expect(vatNumberProblem('4740 101 508')).toBeNull();
    expect(vatNumberProblem('4740101509')).toMatch(/doesn’t add up/);
    expect(vatNumberProblem('5740101508')).toMatch(/starts with 4/);
    expect(vatNumberProblem('474010150')).toMatch(/10 digits/);
    expect(taxNumberProblem('0001339050')).toBeNull();
    expect(taxNumberProblem('4001339050')).toMatch(/starts with 0, 1, 2, 3 or 9/);
    expect(payeRefProblem('7230767891')).toBeNull();
    expect(payeRefProblem('7230767892')).toMatch(/doesn’t add up/);
    expect(uifRefProblem('1916733/3')).toBeNull();
    expect(uifRefProblem('U230767891')).toBeNull();
    expect(uifRefProblem('1916733')).toMatch(/1234567\/8/);
    expect(idNumberProblem('8001015009087')).toBeNull();
    expect(idNumberProblem('8001015009088')).toMatch(/doesn’t add up/);
    expect(idNumberProblem('A1234567')).toBeNull(); // a passport
  });

  it('checks a registration number against the kind of business', () => {
    expect(regNumberProblem('2024/733128/07', 'company')).toBeNull();
    expect(regNumberProblem('2024 733128 07', 'company')).toBeNull();
    expect(regNumberProblem('2024/733128/23', 'company')).toMatch(/ends in \/07/);
    expect(regNumberProblem('1999/012345/23', 'cc')).toBeNull();
    expect(regNumberProblem('CK1999/012345/23', 'cc')).toBeNull();
    expect(regNumberProblem('2015/123456/08', 'npc')).toBeNull();
    expect(regNumberProblem('IT 1234/2015', 'trust')).toBeNull();
    expect(regNumberProblem('2999/123456/07', 'company', 2026)).toMatch(/year it was registered/);
    expect(regNumberProblem('anything', 'sole_prop')).toBeNull();
    expect(tidyNumbers({ vatRegistered: true, vatNumber: '4740 101 508', regNumber: '2024 733128 07', businessType: 'company' })).toMatchObject({ vatNumber: '4740101508', regNumber: '2024/733128/07' });
  });

  it('only checks what changed, but switching VAT on always needs a number', () => {
    const old = { vatRegistered: false, vatNumber: '123', regNumber: 'old', businessType: 'company' };
    expect(settingsNumberProblem({ ...old }, old)).toBeNull();
    expect(settingsNumberProblem({ ...old, vatRegistered: true, vatNumber: '' }, old)?.field).toBe('vatNumber');
    expect(settingsNumberProblem({ ...old, vatRegistered: true }, old)?.message).toMatch(/10 digits/);
    expect(settingsNumberProblem({ ...old, vatRegistered: true, vatNumber: '4740101508' }, old)).toBeNull();
  });
});

describe('notices from OpenWorks', () => {
  const file = {
    notices: [
      { id: 'tip', title: 'A tip', body: 'Hello', apps: ['pocket'] },
      { id: 'old-only', level: 'update', title: 'Please update', belowVersion: '1.17.0', apps: ['shap'] },
      { id: 'later', title: 'Not yet', from: '2027-01-01' },
      { id: 'phish', title: 'Click', link: 'https://evil.example/login' },
      { id: 'end', level: 'sunset', title: 'Support ends', supportEndsOn: '2027-12-31', link: 'https://github.com/OpenWorksIT/shap/blob/main/SUNSET.md' },
      'rubbish',
      { title: 'no id' },
    ],
  };
  it('shows only what applies to this app, version and day, sunset first, with safe links', () => {
    const shap = noticesFor(file, 'shap', '1.16.1', '2026-11-09');
    expect(shap.map((n) => n.id)).toEqual(['end', 'old-only', 'phish']);
    expect(shap[0]).toMatchObject({ level: 'sunset', supportEndsOn: '2027-12-31', link: 'https://github.com/OpenWorksIT/shap/blob/main/SUNSET.md' });
    expect(shap.find((n) => n.id === 'phish')!.link).toBeUndefined();
    expect(noticesFor(file, 'shap', '1.17.0', '2026-11-09').map((n) => n.id)).not.toContain('old-only');
    expect(noticesFor(file, 'pocket', '1.1.0', '2027-02-01').map((n) => n.id)).toEqual(['end', 'tip', 'later', 'phish']);
    expect(noticesFor(null, 'shap', '1.0.0', '2026-11-09')).toEqual([]);
  });
});

describe('in the books', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let settings: Record<string, unknown>;
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    settings = (await me.get('/api/reference')).settings;
  });
  afterAll(() => env.close());
  const save = (changes: Record<string, unknown>) => me.call({ method: 'PUT', url: '/api/settings', payload: { ...settings, ...changes } as never });

  it('won’t switch VAT on without a well-formed VAT number, and tidies the numbers it keeps', async () => {
    expect((await save({ vatRegistered: true, vatNumber: '' })).json().error).toMatch(/Add your VAT number/);
    expect((await save({ vatRegistered: true, vatNumber: '4123456789' })).json().error).toMatch(/doesn’t add up/);
    expect((await save({ regNumber: '2024/733128/23' })).json().error).toMatch(/ends in \/07/);
    const ok = await save({ vatRegistered: true, vatNumber: '4740 101 508', regNumber: '2024 733128 07', taxNumber: '0001339050', payeRegistered: true, payeRef: '7230767891' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ vatNumber: '4740101508', regNumber: '2024/733128/07', payeRef: '7230767891', payeRegistered: true });
    settings = ok.json();
  });

  it('keeps the dividends section on for a company', async () => {
    const r = await save({ features: { ...(settings.features as object), dividends: false } });
    expect(r.json().features.dividends).toBe(true);
    const trust = await save({ businessType: 'trust', regNumber: '', features: { ...(settings.features as object), dividends: false } });
    expect(trust.json().features.dividends).toBe(false);
    settings = (await save({ businessType: 'company', regNumber: '2024/733128/07' })).json();
  });

  it('records the terms accepted: the version, when, and in the audit log', async () => {
    expect(settings.termsVersion).toBe('');
    const r = (await save({ termsVersion: TERMS_VERSION })).json();
    expect(r.termsVersion).toBe(TERMS_VERSION);
    expect(r.termsAcceptedAt).toBeTruthy();
    const log = await me.get('/api/audit?entity=settings');
    expect(log.items.find((e: { action: string }) => e.action === 'accept_terms')).toMatchObject({ details: { version: TERMS_VERSION } });
    settings = r;
  });

  it('won’t issue a tax invoice over R5 000 without the client’s address, or a credit note without a reason', async () => {
    const walkIn = await me.post('/api/clients', { name: 'Walk-in' });
    const small = await me.post('/api/documents', { kind: 'invoice', clientId: walkIn.id, issueDate: '2026-11-02', lines: [{ category: 'labour', description: 'Call-out', qty: 1, unitPriceCents: 400_000 }] });
    await me.post(`/api/documents/${small.id}/issue`); // R4 600 with VAT: an abridged tax invoice is fine
    const big = await me.post('/api/documents', { kind: 'invoice', clientId: walkIn.id, issueDate: '2026-11-02', lines: [{ category: 'labour', description: 'Rewiring', qty: 1, unitPriceCents: 500_000 }] });
    expect((await me.call({ method: 'POST', url: `/api/documents/${big.id}/issue` })).json().error).toMatch(/name and address/);
    await me.post(`/api/clients/${walkIn.id}`, { name: 'Walk-in', address: '3 Example Lane, Gqeberha', vatNumber: '4740101508' }, 'PUT');
    await me.post(`/api/documents/${big.id}/issue`);
    const cn = await me.post(`/api/documents/${big.id}/credit-note`);
    expect((await me.call({ method: 'POST', url: `/api/documents/${cn.id}/issue` })).json().error).toMatch(/why the credit note/);
    const draft = (await me.get(`/api/documents/${cn.id}`)).doc;
    // The reason is kept when the draft is edited (it wasn't, before).
    await me.post(`/api/documents/${cn.id}`, { ...draft, clientId: null, creditReason: 'Charged a day too many', lines: [{ category: 'labour', description: 'One day', qty: 1, unitPriceCents: 100_000 }] }, 'PUT');
    const after = (await me.get(`/api/documents/${cn.id}`)).doc;
    expect(after).toMatchObject({ creditReason: 'Charged a day too many', clientName: 'Walk-in' });
    await me.post(`/api/documents/${cn.id}/issue`);
  });

  it('keeps what was deleted in the audit log, a page at a time, and exports it safely', async () => {
    const q = await me.post('/api/documents', { kind: 'quote', issueDate: '2026-11-03', lines: [{ category: 'labour', description: '=HYPERLINK("x")', qty: 1, unitPriceCents: 12_345 }] });
    await me.post(`/api/documents/${q.id}`, {}, 'DELETE');
    const log = await me.get('/api/audit?entity=quote&limit=1');
    expect(log.items[0]).toMatchObject({ action: 'delete', entity: 'quote', details: { number: q.number, totalCents: 14_197 } }); // R123.45 and VAT
    expect(log.more).toBe(true);
    const older = await me.get(`/api/audit?entity=quote&limit=1&before=${log.items[0].id}`);
    expect(older.items[0]).toMatchObject({ action: 'create' });
    expect(log.entities).toContain('quote');
    await me.post('/api/clients', { name: '=cmd|calc' });
    const csv = await me.call({ method: 'GET', url: '/api/audit.csv' });
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.body.split('\r\n')[0]).toBe('When,Who,Action,Record,Record id,Details');
    expect(csv.body).not.toMatch(/(^|,)=/m);
  });

  it('reconciles the EMP501: EMP201s, payments and each employee’s certificate', async () => {
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    await save({ features: { ...(settings.features as object), payroll: true } });
    const thandi = await me.post('/api/employees', { name: 'Thandi Mokoena', salaryCents: 2_500_000, startDate: '2026-03-01', idNumber: '8001015009087', taxNumber: '0001339050' });
    await me.post('/api/employees', { name: 'Sipho (no tax number)', salaryCents: 600_000, startDate: '2026-03-01' });
    expect((await me.call({ method: 'POST', url: '/api/employees', payload: { name: 'Typo', salaryCents: 1, startDate: '2026-03-01', taxNumber: '12345' } })).json().error).toMatch(/10 digits/);
    for (const m of ['03', '04', '09']) {
      const run = await me.post('/api/pay-runs', { period: `2026-${m}`, payDate: `2026-${m}-25`, sourceId: bank });
      await me.post(`/api/pay-runs/${run.id}/finalise`);
    }
    const march = (await me.get('/api/payroll/sars')).emp201.find((x: { period: string }) => x.period === '2026-03');
    await me.post('/api/sars-payments', { kind: 'emp201', period: '2026-03', date: '2026-04-05', amountCents: march.totalCents, sourceId: bank });
    const e = await me.get('/api/payroll/emp501?year=2027&kind=interim');
    expect(e).toMatchObject({ from: '2026-03-01', to: '2026-08-31', window: { opens: '2026-09-21', closes: '2026-10-31' } });
    // September's run is after the interim period.
    expect(e.months.map((x: { period: string }) => x.period)).toEqual(['2026-03', '2026-04']);
    expect(e.differences.unpaidCents).toBe(e.months[1].totalCents);
    expect(e.differences).toMatchObject({ payeCents: 0, uifCents: 0, sdlCents: 0 });
    const t = e.employees.find((x: { id: string }) => x.id === thandi.id);
    expect(t).toMatchObject({ certificate: 'IRP5', problems: [] });
    expect(t.codes['3601']).toBe(5_000_000);
    expect(t.codes['4149']).toBe(t.codes['4102'] + t.codes['4141'] + t.codes['4142']);
    const sipho = e.employees.find((x: { name: string }) => x.name.startsWith('Sipho'));
    expect(sipho.certificate).toBe('IT3(a)'); // R6 000 a month: no PAYE
    expect(sipho.problems.join(' ')).toMatch(/income tax number/);
    expect(e.employer.problems).toEqual([]);
    const annual = await me.get('/api/payroll/emp501?year=2027&kind=annual');
    expect(annual.months).toHaveLength(3);
    const csv = await me.call({ method: 'GET', url: '/api/payroll/emp501?year=2027&kind=interim&format=csv' });
    expect(csv.body).toMatch(/3601 Income/);
    expect(csv.body).toMatch(/IT3\(a\)/);
  });

  it('passes the books audit: nothing to fix', async () => {
    await expectCleanAudit(env.sql, '2027-02-28');
  });
});
