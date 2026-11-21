import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LINK_WHAT_GOES, LINK_WHAT_GOES_VERSION, readLink, type DeadlineInputs } from '@shap/shared';
import { LINK_BEARER } from '../../src/modules/links.js';
import { healthForLink, type ClientHealth } from '../../src/lib/practice.js';
import { expectCleanAudit, login, setup, type TestEnv } from '../helpers.js';

// The security review of 1.33: the date of incorporation and the Compensation Fund went to a linked
// practice without being in what its owner was told goes. Made-up business.

const goes = LINK_WHAT_GOES.join(' ');
// Each field of what the returns are worked out from, and the words that tell the owner it goes.
const named: Record<keyof DeadlineInputs, RegExp> = {
  businessType: /the kind of business/,
  vatRegistered: /VAT registration/,
  vatCategory: /VAT registration and category/,
  fyEndMonth: /the year-end month/,
  turnoverTax: /turnover tax/,
  employer: /whether you employ people/,
  approvedPbo: /public benefit organisation approval/,
  dividendsPaid: /the days dividends were paid lately/,
  incorporatedOn: /the date of incorporation/,
  coidaRegistered: /whether you’re registered with the Compensation Fund/,
};
const every: Required<DeadlineInputs> = {
  businessType: 'company',
  vatRegistered: true,
  vatCategory: 'B',
  fyEndMonth: 2,
  turnoverTax: false,
  employer: true,
  approvedPbo: false,
  dividendsPaid: ['2026-05-31'],
  incorporatedOn: '2020-07-01',
  coidaRegistered: true,
};
const health = (d: DeadlineInputs & Record<string, unknown>): ClientHealth => ({ at: '2026-11-21T08:00:00.000Z', company: 'Made-up', setupDone: true, vatRegistered: true, audit: { fail: 0, warn: 0, items: [] }, statements: null, lockedThrough: null, pocket: null, deadlineInputs: d });

describe('what goes to a linked practice', () => {
  it('sends only the fields its owner is told go, each named', () => {
    const sent = healthForLink(health({ ...every, somethingElse: 'made-up' }), LINK_WHAT_GOES_VERSION);
    expect(Object.keys(sent.deadlineInputs!).sort()).toEqual(Object.keys(named).sort());
    for (const k of Object.keys(sent.deadlineInputs!)) expect(goes, k).toMatch(named[k as keyof DeadlineInputs]);
    expect(LINK_WHAT_GOES_VERSION).toBe(2);
  });

  it('sends a link made under the earlier list only what that list named', () => {
    const sent = healthForLink(health(every), 1);
    expect(sent.deadlineInputs).not.toHaveProperty('incorporatedOn');
    expect(sent.deadlineInputs).not.toHaveProperty('coidaRegistered');
    expect(sent.deadlineInputs).toMatchObject({ businessType: 'company', dividendsPaid: ['2026-05-31'] });
  });
});

describe('a link keeps the list its owner agreed to', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('a new link is made under this list; one made before 1.33 is under the first', async () => {
    const owner = await login(env.app, 'owner@example.co.za');
    const made = await owner.post<{ id: string }>('/api/accountant-links', { level: 'books', password: 'test-password-1' });
    const [row] = await env.sql<{ whatGoes: number }[]>`select what_goes from accountant_links where id = ${made.id}`;
    expect(row!.whatGoes).toBe(LINK_WHAT_GOES_VERSION);
    const [old] = await env.sql<{ whatGoes: number }[]>`insert into accountant_links (level, code_hash, code_expires_at) values ('books', 'made-up-hash', now()) returning what_goes`;
    expect(old!.whatGoes).toBe(1);
  });

  it('the practice’s Shap is sent the new fields only for a link made under this list', async () => {
    const owner = await login(env.app, 'owner@example.co.za');
    const { settings } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...settings, businessType: 'company', incorporatedOn: '2020-07-01', coidaRegistered: true }, 'PUT');
    const made = await owner.post<{ id: string; link: string }>('/api/accountant-links', { level: 'books', password: 'test-password-1' });
    const { code } = readLink(made.link)!;
    const redeemed = await env.app.inject({ method: 'POST', url: '/api/link/redeem', payload: { code, practice: { name: 'Made-up Practice' } } });
    const { credential } = redeemed.json() as { credential: string };
    const health = async () => (await env.app.inject({ method: 'GET', url: '/api/link/health', headers: { authorization: `Bearer ${LINK_BEARER}${credential}` } })).json().health.deadlineInputs;
    expect(await health()).toMatchObject({ incorporatedOn: '2020-07-01', coidaRegistered: true });
    // The same link as if made before 1.33.
    await env.sql`update accountant_links set what_goes = 1 where id = ${made.id}`;
    const older = await health();
    expect(older).not.toHaveProperty('incorporatedOn');
    expect(older).not.toHaveProperty('coidaRegistered');
    expect(older).toMatchObject({ businessType: 'company' });
  });
});
