/**
 * Kinds of business (entities.ts): each names its owners' accounts its own way, has its own year
 * end and payouts, a partnership shares each year's profit between its partners, and the tax
 * estimate follows who actually pays.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMonths, ENTITIES, financialYear, individualTax, splitByShares } from '@shap/shared';
import { today } from '../src/lib/books.js';
import { login, setup, type TestEnv } from './helpers.js';

type Client = Awaited<ReturnType<typeof login>>;

describe('sharing by shares', () => {
  it('adds up to the cent, the odd cent to the biggest share', () => {
    const parts = splitByShares(100_01, [
      { id: 'a', name: 'Thandi', shareBp: 3333 },
      { id: 'b', name: 'Pieter', shareBp: 3334 },
      { id: 'c', name: 'Aisha', shareBp: 3333 },
    ]);
    expect(parts.reduce((s, p) => s + p.cents, 0)).toBe(100_01);
    expect(parts.find((p) => p.partner.id === 'b')!.cents).toBeGreaterThanOrEqual(parts[0]!.cents);
    // A loss shares the same way.
    expect(splitByShares(-1000, [{ id: 'a', name: 'A', shareBp: 6000 }, { id: 'b', name: 'B', shareBp: 4000 }]).map((p) => p.cents)).toEqual([-600, -400]);
  });
});

describe('kinds of business', () => {
  let env: TestEnv;
  let owner: Client;
  const setType = async (businessType: string, extra: Record<string, unknown> = {}) => {
    const { settings } = await owner.get('/api/reference');
    return owner.post('/api/settings', { ...settings, businessType, ...extra }, 'PUT');
  };
  const accountName = async (key: string) => (await env.sql<{ name: string; type: string }[]>`select name, type from accounts where system_key = ${key}`)[0]!;

  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
  });
  afterAll(() => env.close());

  it('names the owners’ accounts for each kind, and keeps a name someone chose', async () => {
    await setType('cc');
    expect((await accountName('share_capital')).name).toBe('Members’ contributions');
    expect((await accountName('retained_earnings')).name).toBe('Retained income');
    expect(await accountName('owner_loan')).toEqual({ name: 'Members’ loan accounts', type: 'liability' });
    expect((await accountName('dividends')).name).toBe('Distributions to members');
    await setType('trust');
    expect((await accountName('retained_earnings')).name).toBe('Accumulated profit');
    expect((await accountName('director_salary')).name).toBe('Trustees’ fees');
    await setType('sole_prop');
    expect(await accountName('owner_loan')).toEqual({ name: 'Owner’s capital and drawings', type: 'equity' });
    // Someone's own name for an account survives every change.
    await env.sql`update accounts set name = 'Shareholders’ funds' where system_key = 'share_capital'`;
    await setType('coop');
    expect((await accountName('share_capital')).name).toBe('Shareholders’ funds');
    expect((await accountName('retained_earnings')).name).toBe('Reserves');
    await setType('company');
    expect((await accountName('retained_earnings')).name).toBe('Retained earnings');
    expect(await accountName('owner_loan')).toEqual({ name: 'Owner’s loan account', type: 'liability' });
  });

  it('keeps sole proprietors, partnerships and trusts on a February year end, and turnover tax and PBO to who can have them', async () => {
    for (const t of ['sole_prop', 'partnership', 'trust']) expect((await setType(t, { fyEndMonth: 6 })).fyEndMonth).toBe(2);
    expect((await setType('company', { fyEndMonth: 6 })).fyEndMonth).toBe(6);
    expect((await setType('trust', { turnoverTax: true })).turnoverTax).toBe(false);
    expect((await setType('cc', { turnoverTax: true })).turnoverTax).toBe(true);
    expect((await setType('company', { approvedPbo: true })).approvedPbo).toBe(false);
    expect((await setType('npc', { approvedPbo: true, turnoverTax: true })).approvedPbo).toBe(true);
    await setType('company', { turnoverTax: false, fyEndMonth: 2 });
  });

  it('pays out profit the way each kind does', async () => {
    const pay = (shareholder: string) => owner.call({ method: 'POST', url: '/api/dividends', payload: { declaredOn: today(), shareholder, grossCents: 1_000_000 } });
    for (const t of ['sole_prop', 'partnership']) {
      await setType(t);
      const r = await pay('Thandi Mokoena');
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(/drawings/);
    }
    await setType('npc');
    expect((await pay('Anyone')).json().error).toMatch(/can’t pay out its profits/);
    // A CC's distribution to a member carries dividends tax; a trust's to a beneficiary doesn't.
    await setType('cc');
    expect((await pay('Pieter Botha')).statusCode).toBe(200);
    await setType('trust');
    expect((await pay('Aisha Patel')).statusCode).toBe(200);
    const rows = await env.sql<{ shareholder: string; dwtCents: number; exempt: boolean }[]>`select shareholder, dwt_cents, exempt from dividends order by created_at`;
    expect([...rows]).toEqual([
      { shareholder: 'Pieter Botha', dwtCents: 200_000, exempt: false },
      { shareholder: 'Aisha Patel', dwtCents: 0, exempt: true },
    ]);
    const journals = await env.sql<{ description: string }[]>`select description from journals where kind = 'dividend' order by created_at`;
    expect(journals.map((j) => j.description)).toEqual(['Distribution declared to Pieter Botha', 'Distribution declared to Aisha Patel']);
  });

  it('only takes this year’s income given to South African beneficiaries off a trust’s tax', async () => {
    await setType('trust');
    const before = (await owner.get('/api/reports/provisional-tax')).distributedCents;
    // Given to a beneficiary living abroad (or out of capital): taxed in the trust, so it doesn't count.
    expect((await owner.call({ method: 'POST', url: '/api/dividends', payload: { declaredOn: today(), shareholder: 'Sipho Dlamini (London)', grossCents: 500_000, conduit: false } })).statusCode).toBe(200);
    expect((await owner.get('/api/reports/provisional-tax')).distributedCents).toBe(before);
  });

  it('needs a February year end for a company on turnover tax (SARS’s rule)', async () => {
    const r = await owner.call({ method: 'PUT', url: '/api/settings', payload: { ...(await owner.get('/api/reference')).settings, businessType: 'cc', turnoverTax: true, fyEndMonth: 6 } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/February/);
    await setType('company', { turnoverTax: false });
  });

  it('works out a trust’s tax on what it keeps, and none for an approved PBO', async () => {
    await setType('trust');
    const p = await owner.get('/api/reports/provisional-tax');
    expect(p.kind).toBe('trust');
    // The R10 000 given to a beneficiary this year (above) isn't the trust's to pay tax on.
    const fy = financialYear(today(), 2);
    const inYear = (await env.sql<{ t: number }[]>`select coalesce(sum(gross_cents),0)::bigint as t from dividends where conduit and declared_on between ${fy.start}::date and ${fy.end}::date`)[0]!.t;
    expect(p.distributedCents).toBe(Number(inYear));
    const save = (lines: unknown[]) => owner.post('/api/tax-estimates', { fyEnd: p.fy.end, period: 1, asAt: p.asAt, lines, kind: 'company' });
    const income = [{ accountId: null, name: 'Sales', type: 'income', actualCents: 0, projectedCents: 10_000_000 }];
    const trust = await save(income);
    expect(trust.taxableCents).toBe(10_000_000 - Number(inYear));
    expect(trust.taxCents).toBe(Math.round((10_000_000 - Number(inYear)) * 0.45));
    await setType('npc', { approvedPbo: true });
    expect((await save(income)).taxCents).toBe(0);
    await setType('npc', { approvedPbo: false });
    expect((await save(income)).taxCents).toBe(Math.round(10_000_000 * 0.27));
  });

  it('describes every kind it offers', () => {
    for (const e of Object.values(ENTITIES)) {
      expect(e.label.length).toBeGreaterThan(3);
      expect(e.description.length).toBeGreaterThan(30);
    }
  });
});

describe('a partnership', () => {
  let env: TestEnv;
  let owner: Client;
  // The last whole financial year (March to February), with R100 000 of profit in it.
  const lastFy = financialYear(addMonths(financialYear(today(), 2).start, -1), 2);

  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
    const { settings } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...settings, businessType: 'partnership' }, 'PUT');
    const [income] = await env.sql<{ id: string }[]>`select id from accounts where type = 'income' order by code limit 1`;
    const [bank] = await env.sql<{ id: string }[]>`select account_id as id from payment_sources order by name limit 1`;
    await owner.post('/api/journals', { date: `${lastFy.end.slice(0, 7)}-10`, description: 'Work done', lines: [{ accountId: bank!.id, debitCents: 10_000_000 }, { accountId: income!.id, creditCents: 10_000_000 }] });
  });
  afterAll(() => env.close());

  it('gives each partner a capital and a current account', async () => {
    await owner.post('/api/partners', { name: 'Thandi Mokoena', shareBp: 6000 });
    await owner.post('/api/partners', { name: 'Pieter Botha', shareBp: 3000 });
    const { partners } = await owner.get('/api/partners');
    expect(partners.map((p: { name: string }) => p.name)).toEqual(['Thandi Mokoena', 'Pieter Botha']);
    const names = await env.sql<{ code: string; name: string; type: string }[]>`select code, name, type from accounts where code between '3300' and '3499' order by code`;
    expect([...names]).toEqual([
      { code: '3300', name: 'Capital: Thandi Mokoena', type: 'equity' },
      { code: '3301', name: 'Capital: Pieter Botha', type: 'equity' },
      { code: '3400', name: 'Current account: Thandi Mokoena', type: 'equity' },
      { code: '3401', name: 'Current account: Pieter Botha', type: 'equity' },
    ]);
  });

  it('gives each partner their own “Paid personally”, onto their current account', async () => {
    const rows = await env.sql<{ name: string; account: string }[]>`select s.name, a.name as account from payment_sources s join accounts a on a.id = s.account_id where s.name like 'Paid personally (%' and s.name <> 'Paid personally (owner)' order by s.name`;
    expect([...rows]).toEqual([
      { name: 'Paid personally (Pieter Botha)', account: 'Current account: Pieter Botha' },
      { name: 'Paid personally (Thandi Mokoena)', account: 'Current account: Thandi Mokoena' },
    ]);
  });

  it('shares only a finished year, between shares that add up to 100%', async () => {
    const share = (fyEnd: string) => owner.call({ method: 'POST', url: '/api/partners/profit-share', payload: { fyEnd } });
    expect((await share(lastFy.end)).json().error).toMatch(/add up to 100%/);
    const { partners } = await owner.get('/api/partners');
    await owner.post(`/api/partners/${partners[1].id}`, { name: 'Pieter Botha', shareBp: 4000 }, 'PUT');
    expect((await share(financialYear(today(), 2).end)).json().error).toMatch(/hasn’t ended/);
  });

  it('moves the year’s profit into the partners’ current accounts, 60/40', async () => {
    const preview = await owner.get(`/api/partners/profit-share?fyEnd=${lastFy.end}`);
    expect(preview).toMatchObject({ profitCents: 10_000_000, totalBp: 10000, posted: null });
    expect(preview.parts.map((p: { cents: number }) => p.cents)).toEqual([6_000_000, 4_000_000]);
    await owner.post('/api/partners/profit-share', { fyEnd: lastFy.end });
    // Shared again (the figures changed), it replaces the first journal rather than doubling up.
    await owner.post('/api/partners/profit-share', { fyEnd: lastFy.end });
    expect((await env.sql`select count(*)::int as n from journals where kind = 'profit_share'`)[0]!.n).toBe(1);
    const { partners } = await owner.get('/api/partners');
    expect(partners.map((p: { currentCents: number }) => p.currentCents)).toEqual([6_000_000, 4_000_000]);
    // The shares it was split by are kept with it, and the journal can only be changed from here.
    const shared = await owner.get(`/api/partners/profit-share?fyEnd=${lastFy.end}`);
    expect(shared.posted.shares.map((x: { name: string; cents: number }) => [x.name, x.cents])).toEqual([['Thandi Mokoena', 6_000_000], ['Pieter Botha', 4_000_000]]);
    const edit = await owner.call({ method: 'DELETE', url: `/api/journals/${shared.posted.journalId}` });
    expect(edit.statusCode).toBe(400);
    // At the year end the balance sheet shows it as theirs, and nothing left unshared.
    const bs = await owner.get(`/api/reports/balance-sheet?date=${lastFy.end}`);
    const lines = bs.equity.items.map((i: { name: string; amountCents: number }) => [i.name, i.amountCents]);
    expect(lines).toContainEqual(['Current account: Thandi Mokoena', 6_000_000]);
    expect(lines).toContainEqual(['Current account: Pieter Botha', 4_000_000]);
    expect(lines.find((l: [string]) => l[0] === 'Profit not yet shared between partners')).toBeUndefined();
    expect(bs.differenceCents).toBe(0);
  });

  it('estimates each partner’s tax on their share, with no assessed loss of the partnership’s own', async () => {
    const p = await owner.get('/api/reports/provisional-tax');
    expect(p.kind).toBe('partners');
    expect(p.assessedLossCents).toBe(0);
    expect(p.partners).toEqual([{ name: 'Thandi Mokoena', shareBp: 6000 }, { name: 'Pieter Botha', shareBp: 4000 }]);
    const est = await owner.post('/api/tax-estimates', { fyEnd: p.fy.end, period: 1, asAt: p.asAt, lines: [{ accountId: null, name: 'Sales', type: 'income', actualCents: 0, projectedCents: 50_000_000 }] });
    expect(est.taxCents).toBe(individualTax(30_000_000, p.fy.end) + individualTax(20_000_000, p.fy.end));
  });

  it('works out turnover tax on each partner’s share, not the whole', async () => {
    const t = await owner.get('/api/reports/turnover-tax');
    expect(t.partners.map((x: { shareBp: number }) => x.shareBp)).toEqual([6000, 4000]);
    expect(t.taxCents).toBe(t.partners.reduce((s: number, x: { taxCents: number }) => s + x.taxCents, 0));
  });

  it('undoes a year’s share', async () => {
    await owner.post(`/api/partners/profit-share/${lastFy.end}`, {}, 'DELETE');
    const { partners } = await owner.get('/api/partners');
    expect(partners.map((p: { currentCents: number }) => p.currentCents)).toEqual([0, 0]);
    const bs = await owner.get(`/api/reports/balance-sheet?date=${lastFy.end}`);
    expect(bs.equity.items.find((i: { name: string }) => i.name === 'Profit not yet shared between partners')?.amountCents).toBe(10_000_000);
  });
});
