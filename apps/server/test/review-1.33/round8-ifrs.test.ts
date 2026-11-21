import { describe, expect, it } from 'vitest';
import { addDays, financialYear } from '@shap/shared';
import { today } from '../../src/lib/books.js';
import { expectCleanAudit, login, ref, setup } from '../helpers.js';

// The eighth round of 1.33's reviews (IFRS): what the seventh round's fixes left. Made-up business and figures.
const now = today();
const bringOf = (owner: Awaited<ReturnType<typeof login>>) => (file: unknown) =>
  owner.call({ method: 'POST', url: '/api/company-file', payload: { password: 'test-password-1', file: { format: 'shap-company/1', ...(file as object) } } });

/** Each account's figure for the year to fyEnd (the ledger, year-end adjustments included). */
async function yearFigures(sql: Awaited<ReturnType<typeof setup>>['sql'], start: string, end: string) {
  const rows = await sql<{ code: string; cents: string }[]>`
    select a.code, sum(l.amount_cents)::bigint as cents from ledger l join accounts a on a.id = l.account_id
    where l.date between ${start}::date and ${end}::date group by a.code having sum(l.amount_cents) <> 0 order by a.code`;
  return Object.fromEntries(rows.map((r) => [r.code, Number(r.cents)]));
}

describe('moveToAccount in an agreed, closed year (section 10: the lock)', () => {
  it('refuses moving a cost type whose one cost is in the closed year', async () => {
    const env = await setup();
    try {
      const owner = await login(env.app, 'owner@example.co.za');
      const r = await ref(env.sql);
      const { settings } = await owner.get('/api/reference');
      const fy = financialYear(now, settings.fyEndMonth);
      const last = financialYear(addDays(fy.start, -1), settings.fyEndMonth);
      const petrol = await r.cat('Petrol');
      await owner.post('/api/costs', { date: addDays(fy.start, -30), description: 'Made-up fuel last year', supplier: 'Made-up Garage', amountCents: 30_000, categoryId: petrol, sourceId: await r.src('Business bank') });
      // The accountant's figures agreed for last year (as the books are), and the year closed.
      const agreed = await owner.call({ method: 'PUT', url: '/api/year-ends', payload: { fyEnd: last.end, note: 'Made-up sign-off', lock: true, figures: [] } });
      expect(agreed.statusCode, agreed.body).toBe(200);
      const closedBefore = await yearFigures(env.sql, last.start, last.end);
      // A new expense account, made after the year was agreed.
      const fuel = await owner.post<{ id: string }>('/api/accounts', { code: '6950', name: 'Made-up Fuel', type: 'expense', active: true });
      const cat = (await env.sql<{ name: string; kind: string }[]>`select name, kind from cost_categories where id = ${petrol}`)[0]!;
      const res = await owner.call({ method: 'PUT', url: `/api/categories/${petrol}`, payload: { name: cat.name, kind: cat.kind, accountId: fuel.id } });
      const closedAfter = await yearFigures(env.sql, last.start, last.end);
      // Today: 200, and the closed year's figures changed (the new account and suspense).
      expect({ status: res.statusCode, closed: closedAfter }).toEqual({ status: 400, closed: closedBefore });
      await expectCleanAudit(env.sql);
    } finally {
      await env.close();
    }
  });

  it('refuses moving a payment account whose one payment is in the closed year', async () => {
    const env = await setup();
    try {
      const owner = await login(env.app, 'owner@example.co.za');
      const r = await ref(env.sql);
      const { settings } = await owner.get('/api/reference');
      const fy = financialYear(now, settings.fyEndMonth);
      const last = financialYear(addDays(fy.start, -1), settings.fyEndMonth);
      const till = await owner.post<{ id: string }>('/api/sources', { name: 'Made-up till', kind: 'cash', accountId: await r.acc('bank') });
      await owner.post('/api/costs', { date: addDays(fy.start, -30), description: 'Made-up fuel last year', supplier: 'Made-up Garage', amountCents: 20_000, categoryId: await r.cat('Petrol'), sourceId: till.id });
      const agreed = await owner.call({ method: 'PUT', url: '/api/year-ends', payload: { fyEnd: last.end, note: 'Made-up sign-off', lock: true, figures: [] } });
      expect(agreed.statusCode, agreed.body).toBe(200);
      const closedBefore = await yearFigures(env.sql, last.start, last.end);
      const two = await owner.post<{ id: string }>('/api/accounts', { code: '1074', name: 'Made-up Second Bank', type: 'asset', statementLine: 'cash', active: true });
      const res = await owner.call({ method: 'PUT', url: `/api/sources/${till.id}`, payload: { name: 'Made-up till', kind: 'cash', accountId: two.id } });
      const closedAfter = await yearFigures(env.sql, last.start, last.end);
      // Today: 200; last year's cash counts the R200 twice (pinned on the bank, and on 1074), suspense +R200.
      expect({ status: res.statusCode, closed: closedAfter }).toEqual({ status: 400, closed: closedBefore });
      await expectCleanAudit(env.sql);
    } finally {
      await env.close();
    }
  });
});

describe('a company file’s accounts, against Settings’ rules', () => {
  it('doesn’t take an account off cash for a line that doesn’t fit its type', async () => {
    const env = await setup();
    try {
      const owner = await login(env.app, 'owner@example.co.za');
      const call = await owner.post<{ id: string }>('/api/accounts', { code: '1075', name: 'Made-up Call Account', type: 'asset', statementLine: 'cash', active: true });
      // Settings refuses the line.
      const put = await owner.call({ method: 'PUT', url: `/api/accounts/${call.id}`, payload: { code: '1075', name: 'Made-up Call Account', type: 'asset', statementLine: 'bank_overdraft', active: true } });
      expect(put.statusCode).toBe(400);
      const res = await bringOf(owner)({ accounts: [{ code: '1075', name: 'Made-up Call Account', type: 'asset', statementLine: 'bank_overdraft' }] });
      const [a] = await env.sql<{ line: string }[]>`select statement_line as line from accounts where code = '1075'`;
      // Today: 200 and the account is on other_current_assets (off cash), neither the file's line nor its own.
      expect(res.statusCode === 400 || a!.line === 'cash', `${res.statusCode} ${a!.line}`).toBe(true);
      await expectCleanAudit(env.sql);
    } finally {
      await env.close();
    }
  });

  it('a type the file changes: done as Settings would, or refused (not a third line)', async () => {
    const env = await setup();
    try {
      const owner = await login(env.app, 'owner@example.co.za');
      await owner.post('/api/accounts', { code: '1460', name: 'Made-up Deposit', type: 'asset', statementLine: 'investments', active: true });
      const res = await bringOf(owner)({ accounts: [{ code: '1460', name: 'Made-up Deposit', type: 'liability', statementLine: 'borrowings_current' }] });
      const [a] = await env.sql<{ type: string; line: string }[]>`select type, statement_line as line from accounts where code = '1460'`;
      // Today: 200 and { asset, other_current_assets }: the type ignored, the line reset to its default.
      expect(res.statusCode === 400 || (a!.type === 'liability' && a!.line === 'borrowings_current') || (a!.type === 'asset' && a!.line === 'investments'), `${res.statusCode} ${a!.type} ${a!.line}`).toBe(true);
      await expectCleanAudit(env.sql);
    } finally {
      await env.close();
    }
  });

  it('keeps turnover tax to a February year end, as Settings does', async () => {
    const env = await setup();
    try {
      const owner = await login(env.app, 'owner@example.co.za');
      const { settings } = await owner.get('/api/reference');
      const put = await owner.call({ method: 'PUT', url: '/api/settings', payload: { ...settings, businessType: 'company', fyEndMonth: 6, turnoverTax: true } });
      expect(put.statusCode).toBe(400);
      const res = await bringOf(owner)({ settings: { businessType: 'company', fyEndMonth: 6, turnoverTax: true } });
      const [s] = await env.sql<{ fyEndMonth: number; turnoverTax: boolean }[]>`select fy_end_month, turnover_tax from settings where id`;
      // Today: 200 with { fyEndMonth: 6, turnoverTax: true }.
      expect(res.statusCode === 400 || !(s!.turnoverTax && s!.fyEndMonth !== 2), `${res.statusCode} ${JSON.stringify(s)}`).toBe(true);
      await expectCleanAudit(env.sql);
    } finally {
      await env.close();
    }
  });
});

describe('the amounts a move logs (3.12): the comparative year apart', () => {
  it('a move after the year end, before its statements: last year’s comparatives aren’t lumped with older years', async () => {
    const env = await setup();
    try {
      const owner = await login(env.app, 'owner@example.co.za');
      const r = await ref(env.sql);
      const { settings } = await owner.get('/api/reference');
      // A company whose year ended last month: its statements are being drawn up now.
      const fyEndMonth = Number(addDays(now.slice(0, 8) + '01', -1).slice(5, 7));
      const put = await owner.call({ method: 'PUT', url: '/api/settings', payload: { ...settings, businessType: 'company', fyEndMonth } });
      expect(put.statusCode, put.body).toBe(200);
      const fy = financialYear(now, fyEndMonth); // started this month
      const justEnded = financialYear(addDays(fy.start, -1), fyEndMonth);
      const comparative = financialYear(addDays(justEnded.start, -1), fyEndMonth);
      const older = financialYear(addDays(comparative.start, -1), fyEndMonth);
      const petrol = await r.cat('Petrol');
      const bank = await r.src('Business bank');
      for (const [date, cents] of [[addDays(justEnded.end, -10), 40_000], [addDays(comparative.end, -10), 30_000], [addDays(older.end, -10), 10_000]] as const)
        await owner.post('/api/costs', { date, description: 'Made-up fuel', supplier: 'Made-up Garage', amountCents: cents, categoryId: petrol, sourceId: bank });
      const fuel = await owner.post<{ id: string }>('/api/accounts', { code: '6950', name: 'Made-up Fuel', type: 'expense', active: true });
      const cat = (await env.sql<{ name: string; kind: string }[]>`select name, kind from cost_categories where id = ${petrol}`)[0]!;
      const res = await owner.call({ method: 'PUT', url: `/api/categories/${petrol}`, payload: { name: cat.name, kind: cat.kind, accountId: fuel.id } });
      expect(res.statusCode, res.body).toBe(200);
      const [log] = await env.sql<{ details: { moved: { fyEnd: string; cents: number }[] } }[]>`select details from audit_log where action = 'moved_to_account'`;
      // Today: { thisYearCents: 0, lastYearCents: 40 000, earlierCents: 40 000 }: the year just
      // ended's comparative (R300) is lumped with the year before it (R100), unnamed by date.
      expect(log!.details.moved).toContainEqual({ fyEnd: comparative.end, cents: 30_000 });
      await expectCleanAudit(env.sql);
    } finally {
      await env.close();
    }
  });
});
