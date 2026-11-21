import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMonths, financialYear } from '@shap/shared';
import { today } from '../../src/lib/books.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

// The IFRS, accounting and words reviews of 1.33: a budget set before the year end changed still
// opens, last year's figures are changed by a percentage to the cent, and the screen says which
// months it compares. Made-up business, made-up figures.

describe('budgets after a change of year end, and rounding', () => {
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

  it('opens every year in the list after the year end moves, the old one as it was budgeted', async () => {
    const { settings } = await owner.get('/api/reference');
    const fy = financialYear(today(), settings.fyEndMonth);
    const [acc] = await env.sql<{ id: string }[]>`select id from accounts where code = '6040'`;
    await owner.post('/api/budgets', { fyEnd: fy.end, lines: [{ accountId: acc!.id, months: Array(12).fill(10_000) }] }, 'PUT');
    // The year end moves four months on.
    await owner.post('/api/settings', { ...settings, fyEndMonth: ((settings.fyEndMonth + 3) % 12) + 1 }, 'PUT');
    const r = await owner.get('/api/budgets');
    expect(r.years).toContain(fy.end);
    for (const y of r.years as string[]) {
      const one = await owner.call({ method: 'GET', url: `/api/budgets?fyEnd=${y}` });
      expect(one.statusCode, y).toBe(200);
    }
    const old = await owner.get(`/api/budgets?fyEnd=${fy.end}`);
    expect(old.fy).toMatchObject({ start: fy.start, end: fy.end });
    expect(old.lines.find((l: { id: string }) => l.id === acc!.id).budget).toEqual(Array(12).fill(10_000));
    // And it can still be changed.
    expect((await owner.call({ method: 'PUT', url: '/api/budgets', payload: { fyEnd: fy.end, lines: [{ accountId: acc!.id, months: Array(12).fill(20_000) }] } })).statusCode).toBe(200);
    // A date that's neither is still refused.
    expect((await owner.call({ method: 'GET', url: `/api/budgets?fyEnd=${addMonths(fy.end, 1).slice(0, 8)}15` })).statusCode).toBe(400);
    await owner.post('/api/settings', { ...settings }, 'PUT');
  });

  it('changes last year’s figures by a percentage to the cent, a half cent away from nothing', async () => {
    const r = await ref(env.sql);
    const { settings } = await owner.get('/api/reference');
    const fy = financialYear(today(), settings.fyEndMonth);
    const yearAgo = addMonths(today(), -12);
    // 10 cents of bank charges a year ago.
    await owner.post('/api/journals', { date: yearAgo, description: 'Made-up charge', lines: [{ accountId: await r.acc('bank'), creditCents: 10 }, { accountId: (await env.sql<{ id: string }[]>`select id from accounts where code = '6030'`)[0]!.id, debitCents: 10 }] });
    expect(await owner.post('/api/budgets/from-last-year', { fyEnd: fy.end, percent: 15 })).toEqual({ filled: 1 });
    const line = (await owner.get(`/api/budgets?fyEnd=${fy.end}`)).lines.find((l: { code: string }) => l.code === '6030');
    // 10 cents up 15% is 11.5 cents: 12.
    expect(line.budget.reduce((t: number, x: number) => t + x, 0)).toBe(12);
    expect((await owner.call({ method: 'POST', url: '/api/budgets/from-last-year', payload: { fyEnd: fy.end, percent: 2.5 } })).statusCode).toBe(400);
    const [a] = await env.sql<{ details: { accounts: string[] } }[]>`select details from audit_log where action = 'save_budget' order by id desc limit 1`;
    expect(a!.details.accounts).toHaveLength(1);
  });

  it('says which months it compares, and only the owner is told how to set it', () => {
    const page = readFileSync(join(__dirname, '..', '..', '..', 'web', 'src', 'pages', 'Budgets.tsx'), 'utf8');
    expect(page).toMatch(/So far: the months that have ended, to the end of/);
    expect(page).toMatch(/label="Budget so far"/);
    expect(page).toMatch(/What the owner expects each account to come to/);
    expect(page).toMatch(/account\$\{r\.filled === 1 \? '' : 's'\} started from last year’s figures/);
    expect(page).toMatch(/% \(a minus to go down\)/);
  });
});
