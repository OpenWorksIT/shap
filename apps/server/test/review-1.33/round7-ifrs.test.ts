import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, financialYear } from '@shap/shared';
import { today } from '../../src/lib/books.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

// The seventh round of 1.33's reviews (IFRS): a company file listing accounts without their lines
// keeps each on the line it has, as Settings does; it keeps turnover tax and PBO approval to the
// kinds of business that have them; and a payment account or cost type moved logs how much of each
// year moved (3.12). Made-up business and figures.
const now = today();

describe('a company file that lists accounts without their lines (IFRS 7.2, 3.12)', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('keeps the bank on the cash line, with nothing logged and Home’s cash as it was', async () => {
    const owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    await owner.post('/api/costs', { date: now, description: 'Made-up fuel', supplier: 'Made-up Garage', amountCents: 50_000, categoryId: await r.cat('Petrol'), sourceId: bank });
    const [b] = await env.sql<{ code: string; name: string; line: string }[]>`select code, name, statement_line as line from accounts where system_key = 'bank'`;
    expect(b!.line).toBe('cash');
    const cashBefore = (await owner.get('/api/dashboard')).cash.inBankCents;
    const res = await owner.call({ method: 'POST', url: '/api/company-file', payload: { password: 'test-password-1', file: { format: 'shap-company/1', accounts: [{ code: b!.code, name: b!.name, type: 'asset' }] } } });
    expect(res.statusCode).toBe(200);
    const [after] = await env.sql<{ line: string }[]>`select statement_line as line from accounts where system_key = 'bank'`;
    const log = await env.sql<{ details: unknown }[]>`select details from audit_log where action = 'account_line_changed'`;
    expect({ line: after!.line, logged: log.map((l) => l.details), cash: (await owner.get('/api/dashboard')).cash.inBankCents }).toEqual({ line: 'cash', logged: [], cash: cashBefore });
  });

  it('keeps every account in the chart on its line', async () => {
    const owner = await login(env.app, 'owner@example.co.za');
    const before = await env.sql<{ code: string; name: string; type: string; line: string }[]>`select code, name, type, statement_line as line from accounts order by code`;
    const res = await owner.call({ method: 'POST', url: '/api/company-file', payload: { password: 'test-password-1', file: { format: 'shap-company/1', accounts: before.map((a) => ({ code: a.code, name: a.name, type: a.type })) } } });
    expect(res.statusCode).toBe(200);
    const after = await env.sql<{ code: string; line: string }[]>`select code, statement_line as line from accounts order by code`;
    expect(before.filter((b) => after.find((a) => a.code === b.code)!.line !== b.line).map((b) => b.code)).toEqual([]);
  });

  it('keeps turnover tax to the kinds of business that have it (not a trust)', async () => {
    const owner = await login(env.app, 'owner@example.co.za');
    const res = await owner.call({ method: 'POST', url: '/api/company-file', payload: { password: 'test-password-1', file: { format: 'shap-company/1', settings: { businessType: 'trust', fyEndMonth: 2, turnoverTax: true } } } });
    expect(res.statusCode).toBe(200);
    const [s] = await env.sql<{ businessType: string; turnoverTax: boolean }[]>`select business_type, turnover_tax from settings where id`;
    expect(s).toEqual({ businessType: 'trust', turnoverTax: false });
  });
});

describe('moving a cost type from an expense onto an asset (IFRS 3.12)', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('logs how much of each year moved, for the accountant to disclose', async () => {
    const owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    const { settings } = await owner.get('/api/reference');
    const fy = financialYear(now, settings.fyEndMonth);
    const petrol = await r.cat('Petrol');
    await owner.post('/api/costs', { date: addDays(fy.start, -20), description: 'Made-up fuel last year', supplier: 'Made-up Garage', amountCents: 30_000, categoryId: petrol, sourceId: bank });
    await owner.post('/api/costs', { date: now, description: 'Made-up fuel', supplier: 'Made-up Garage', amountCents: 50_000, categoryId: petrol, sourceId: bank });
    const prepaid = await owner.post<{ id: string }>('/api/accounts', { code: '1450', name: 'Made-up Prepaid', type: 'asset', statementLine: 'other_current_assets', active: true });
    const cat = (await env.sql<{ name: string; kind: string }[]>`select name, kind from cost_categories where id = ${petrol}`)[0]!;
    const res = await owner.call({ method: 'PUT', url: `/api/categories/${petrol}`, payload: { name: cat.name, kind: cat.kind, accountId: prepaid.id } });
    expect(res.statusCode).toBe(200);
    const [log] = await env.sql<{ details: Record<string, unknown> }[]>`select details from audit_log where action = 'moved_to_account'`;
    expect(log!.details.moved).toEqual({ thisYearCents: 50_000, lastYearCents: 30_000, earlierCents: 0 });
  });
});
