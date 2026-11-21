import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addBusinessDays, addMonths, cipcAnnualReturns, cipcKind, deadlinesFor, ROE_SEASONS, type DeadlineInputs } from '@shap/shared';
import { today } from '../src/lib/books.js';
import { taxDue } from '../src/modules/dashboard.js';
import { expectCleanAudit, login, setup, type TestEnv } from './helpers.js';

const base: DeadlineInputs = { businessType: 'company', vatRegistered: false, vatCategory: 'B', fyEndMonth: 2, turnoverTax: false, employer: false };

describe('CIPC’s annual return, from the date of incorporation', () => {
  it('a company: within 30 business days after the anniversary (public holidays aren’t business days)', () => {
    // 1 July 2027 is a Thursday; Women's Day (9 August, a Monday) isn't counted.
    expect(addBusinessDays('2027-07-01', 30)).toBe('2027-08-13');
    expect(cipcAnnualReturns('company', '2020-07-01', '2027-07-01', '2027-09-30')).toEqual([
      { key: 'cipc-2027', label: 'CIPC annual return (2027, within 30 business days after the anniversary of incorporation)', due: '2027-08-13' },
    ]);
  });

  it('a close corporation: by the end of the month after its anniversary month', () => {
    expect(cipcAnnualReturns('cc', '2015-02-10', '2027-01-01', '2027-05-31').map((d) => d.due)).toEqual(['2027-03-31']);
    // Incorporated on 29 February: in a year without one, the anniversary is the 28th.
    expect(cipcAnnualReturns('cc', '2016-02-29', '2027-01-01', '2027-05-31').map((d) => d.due)).toEqual(['2027-03-31']);
    expect(cipcAnnualReturns('company', '2016-02-29', '2027-01-01', '2027-05-31').map((d) => d.due)).toEqual([addBusinessDays('2027-02-28', 30)]);
  });

  it('the first return is a year after incorporation, and only companies (Pty, Inc, NPC) and CCs file one', () => {
    expect(cipcAnnualReturns('company', '2026-10-01', '2026-09-01', '2026-12-31')).toEqual([]);
    expect(cipcKind('company')).toBe('company');
    expect(cipcKind('inc')).toBe('company');
    expect(cipcKind('npc')).toBe('company');
    expect(cipcKind('cc')).toBe('cc');
    for (const t of ['sole_prop', 'partnership', 'trust', 'coop'] as const) expect(cipcKind(t)).toBeNull();
  });

  it('shows in the practice’s list of returns, and on Home five weeks ahead', () => {
    const d = deadlinesFor({ ...base, incorporatedOn: '2020-07-01' }, '2027-07-20');
    expect(d.find((x) => x.key === 'cipc-2027')).toMatchObject({ due: '2027-08-13', past: false });
    expect(deadlinesFor({ ...base, businessType: 'sole_prop', incorporatedOn: '2020-07-01' }, '2027-07-20').some((x) => x.key.startsWith('cipc'))).toBe(false);
    expect(deadlinesFor({ ...base }, '2027-07-20').some((x) => x.key.startsWith('cipc'))).toBe(false);
    const home = taxDue({ vatRegistered: false, vatCategory: 'B', turnoverTax: false, fyEndMonth: 2, businessType: 'company', incorporatedOn: '2020-07-01' }, '2027-07-20');
    expect(home).toContainEqual(expect.objectContaining({ key: 'cipc-2027', due: '2027-08-13', to: '/settings?tab=company' }));
    expect(taxDue({ vatRegistered: false, vatCategory: 'B', turnoverTax: false, fyEndMonth: 2, businessType: 'company', incorporatedOn: '2020-07-01' }, '2027-05-01')).toEqual([]);
  });
});

describe('the Compensation Fund’s return of earnings', () => {
  it('is the season the Fund announced (Notice 3894 of 2026: 1 April to 30 June 2026)', () => {
    expect(ROE_SEASONS).toContainEqual({ key: 'roe-2025', label: 'Return of earnings to the Compensation Fund (March 2025 to February 2026)', opens: '2026-04-01', due: '2026-06-30' });
  });

  it('has the next season in by 1 June of the year after the last (the standard update, CPDAUDIT.md section 2)', () => {
    const last = [...ROE_SEASONS].sort((a, b) => a.opens.localeCompare(b.opens)).pop()!;
    // The Fund gazettes each season in March or April: by June, it's time it was in Shap.
    expect(today() < addMonths(last.opens, 14), `the Compensation Fund's season after ${last.key} isn't in ROE_SEASONS yet`).toBe(true);
  });

  it('for an employer registered with the Fund only, on the list and on Home', () => {
    expect(deadlinesFor({ ...base, coidaRegistered: true }, '2026-06-10').find((x) => x.key === 'roe-2025')).toMatchObject({ due: '2026-06-30' });
    expect(deadlinesFor({ ...base, coidaRegistered: false }, '2026-06-10').some((x) => x.key.startsWith('roe'))).toBe(false);
    expect(taxDue({ vatRegistered: false, vatCategory: 'B', turnoverTax: false, fyEndMonth: 2, coidaRegistered: true }, '2026-06-01')).toContainEqual(expect.objectContaining({ key: 'roe-2025', to: '/payroll' }));
    // A season long past, and none announced since: nothing is guessed.
    expect(taxDue({ vatRegistered: false, vatCategory: 'B', turnoverTax: false, fyEndMonth: 2, coidaRegistered: true }, '2026-11-21')).toEqual([]);
  });
});

describe('the date of incorporation and the Fund in Settings and setup', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('keeps a company’s date and the Fund registration; refuses a date in the future; drops a sole proprietor’s date', async () => {
    const { settings } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...settings, businessType: 'company', incorporatedOn: '2020-07-01', coidaRegistered: true }, 'PUT');
    let s = (await owner.get('/api/reference')).settings;
    expect(s).toMatchObject({ incorporatedOn: '2020-07-01', coidaRegistered: true });
    // Not sent: left as it was.
    const { incorporatedOn: _i, coidaRegistered: _c, ...without } = s;
    await owner.post('/api/settings', without, 'PUT');
    s = (await owner.get('/api/reference')).settings;
    expect(s).toMatchObject({ incorporatedOn: '2020-07-01', coidaRegistered: true });
    const future = await owner.call({ method: 'PUT', url: '/api/settings', payload: { ...s, incorporatedOn: '2999-01-01' } as never });
    expect(future.statusCode).toBe(400);
    await owner.post('/api/settings', { ...s, businessType: 'sole_prop', incorporatedOn: '2020-07-01' }, 'PUT');
    expect((await owner.get('/api/reference')).settings.incorporatedOn).toBeNull();
  });

  it('asks in setup: the date for a company or CC, and the Fund for an employer (casual workers too)', () => {
    const welcome = readFileSync(join(__dirname, '..', '..', 'web', 'src', 'pages', 'Welcome.tsx'), 'utf8');
    expect(welcome).toMatch(/\{cipcKind\(f\.businessType\) && \(\s+<Field label="Date of incorporation \(optional\)"/);
    expect(welcome).toMatch(/\{\(employees \|\| casual\) && \(\s+<div className="panel panel-pad stack" style=\{\{ gap: 12 \}\}>\s+<Answer q="Are you registered with the Compensation Fund \(COIDA\)\?"/);
    expect(welcome).toMatch(/coidaRegistered: employees \|\| casual \? coida === 'yes' : null/);
    const settingsPage = readFileSync(join(__dirname, '..', '..', 'web', 'src', 'pages', 'Settings.tsx'), 'utf8');
    expect(settingsPage).toMatch(/Registered with the Compensation Fund \(COIDA\): remind me of the return of earnings each year, once the Fund announces its dates/);
  });
});
