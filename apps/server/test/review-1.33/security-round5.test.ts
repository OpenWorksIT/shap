import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addMonths, journalInput, vatPeriod } from '@shap/shared';
import { auditBooks } from '../../src/audit/books.js';
import { today } from '../../src/lib/books.js';
import { expectCleanAudit, login, ref, sessionFor, setup, type TestEnv } from '../helpers.js';

// The fifth round of 1.33's reviews (security and privacy): VAT on journals typed in is read once
// for each journal, not once for each of its VAT lines (one very long journal made the VAT201 and
// the books audit take tens of seconds), a journal takes up to 1 000 lines, and the forecast
// doesn't say who's leaving to someone who doesn't see payroll. Made-up business and figures.

const root = join(__dirname, '..', '..', '..', '..');
const now = today();
const thisMonth = `${now.slice(0, 8)}01`;

describe('VAT on journals typed in, on one very long journal', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('the VAT201 and the books audit answer in good time, and count only the cash sale', async () => {
    const owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const { settings } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4000000002', vatCategory: 'C' }, 'PUT');
    const p = vatPeriod(now, 'C', settings.fyEndMonth);
    // One made-up journal of 4 000 one-cent VAT lines paid from the bank (as journals took before
    // the cap: one may already be in the books), and a cash sale journalled beside it.
    const [u] = await env.sql<{ id: string }[]>`select id from users where email = 'owner@example.co.za'`;
    const [j] = await env.sql<{ id: string }[]>`insert into journals (date, description, reference, kind, created_by) values (${p.start}, 'Made-up long journal', '', 'manual', ${u!.id}) returning id`;
    await env.sql`insert into journal_lines (journal_id, account_id, debit_cents, credit_cents, memo)
      select ${j!.id}::uuid, ${await r.acc('vat')}::uuid, 1, 0, '' from generate_series(1, 4000)
      union all select ${j!.id}::uuid, ${await r.acc('bank')}::uuid, 0, 4000, ''`;
    await owner.post('/api/journals', { date: p.start, description: 'Made-up cash sale', lines: [{ accountId: await r.acc('bank'), debitCents: 115_000 }, { accountId: await r.acc('revenue_other'), creditCents: 100_000 }, { accountId: await r.acc('vat'), creditCents: 15_000 }] });
    let t = Date.now();
    const v = await owner.get<{ handVatAddedCents: number; handVatOffCents: number; handVatLines: number }>(`/api/vat/return?on=${p.start}`);
    expect(Date.now() - t).toBeLessThan(1500);
    expect(v).toMatchObject({ handVatAddedCents: 15_000, handVatOffCents: 0, handVatLines: 1 });
    t = Date.now();
    await auditBooks(env.sql);
    expect(Date.now() - t).toBeLessThan(3000);
    await env.sql`delete from journals where id = ${j!.id}`;
  });

  it('takes a journal of up to 1 000 lines, and says to split a longer one', async () => {
    const owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const [bank, other] = [await r.acc('bank'), await r.acc('revenue_other')];
    const lines = (n: number) => [...Array.from({ length: n - 1 }, () => ({ accountId: other, creditCents: 1 })), { accountId: bank, debitCents: n - 1 }];
    expect(journalInput.safeParse({ date: now, description: 'Made-up', lines: lines(1000) }).success).toBe(true);
    const res = await owner.call({ method: 'POST', url: '/api/journals', payload: { date: now, description: 'Made-up long journal', lines: lines(1001) } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/A journal takes up to 1 000 lines: split a longer one into journals that each balance/);
  });
});

describe('the forecast and a leaving date still to come', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
    const owner = await login(env.app, 'owner@example.co.za');
    const bank = await (await ref(env.sql)).src('Business bank');
    const { settings: s } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...s, features: { ...s.features, payroll: true } }, 'PUT');
    await owner.post('/api/employees', { name: 'Made-up Stays', salaryCents: 2_000_000, startDate: addMonths(thisMonth, -10) });
    await owner.post('/api/employees', { name: 'Made-up Going', salaryCents: 1_500_000, startDate: addMonths(thisMonth, -10) });
    for (const i of [-2, -1, 0]) {
      const run = await owner.post('/api/pay-runs', { period: addMonths(thisMonth, i).slice(0, 7), payDate: addDays(addMonths(thisMonth, i), 24), sourceId: bank });
      await owner.post(`/api/pay-runs/${run.id}/finalise`);
    }
    // Going leaves at the end of next month: set ahead, not announced yet.
    await env.sql`update employees set end_date = (date_trunc('month', ${thisMonth}::date) + interval '2 months' - interval '1 day')::date where name = 'Made-up Going'`;
    await owner.post('/api/users', { name: 'Reports only (made up)', email: 'reports@example.co.za', role: 'staff', profileId: null, access: ['labour.view', 'reports.view'], password: 'test-password-1' });
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  type F = { items: { kind: string; cents: number }[]; leavingAhead: boolean };
  const salaries = (f: F) => f.items.filter((x) => x.kind === 'payroll').map((x) => x.cents);

  it('counts it for the owner, and not for someone who doesn’t see payroll, saying so', async () => {
    const owner = await login(env.app, 'owner@example.co.za');
    const reports = await sessionFor(env, 'reports@example.co.za');
    const mine = await owner.get<F>('/api/forecast');
    const theirs = await reports.get<F>('/api/forecast');
    expect(mine.leavingAhead).toBe(true);
    expect(theirs.leavingAhead).toBe(false);
    const [a, b] = [salaries(mine), salaries(theirs)];
    expect(a.length).toBeGreaterThanOrEqual(2);
    // The owner's drop after next month; theirs stays the same each month, as if no one leaves.
    expect(a[1]!).toBeGreaterThan(a[0]!);
    expect(new Set(b).size).toBe(1);
    expect(b[0]).toBe(a[0]);
    expect((await reports.call({ method: 'GET', url: '/api/employees' })).statusCode).toBe(403);
    expect(readFileSync(join(root, 'apps/web/src/pages/Forecast.tsx'), 'utf8')).toMatch(/data\.leavingAhead === false && <p className="xs muted">\{LEAVING_NOTE\}<\/p>/);
  });
});
