import { describe, expect, it } from 'vitest';
import { addDays, addMonths, vat201Due, vatPeriod, type VatCategory } from '@shap/shared';
import { today } from '../../src/lib/books.js';
import { cashForecast } from '../../src/modules/forecast.js';
import { expectCleanAudit, login, ref, setup } from '../helpers.js';

// The ninth round of 1.33's reviews (accounting and arithmetic): what the eighth round's forecast VAT fix causes, and the
// round-8 MUST it doesn't close. Made-up business, made-up figures.

const now = today();
type F = Awaited<ReturnType<typeof cashForecast>>;
const vatOf = (f: F) => f.items.filter((x) => x.kind === 'vat').map((x) => ({ date: x.date, cents: x.cents }));
const due = (d: string) => (d < now ? now : d);
const weeksAddUp = (f: F) => expect(f.weeks[f.weeks.length - 1]!.closingCents).toBe(f.openingCents + f.items.reduce((t, x) => t + x.cents, 0));
const twoMonthlyOverdue = (['A', 'B'] as const).find((c) => vat201Due(vatPeriod(addMonths(vatPeriod(now, c, 2).start, -1), c, 2).end) < now)!;

async function vatBooks(category: VatCategory) {
  const env = await setup();
  const owner = await login(env.app, 'owner@example.co.za');
  const r = await ref(env.sql);
  const bank = await r.src('Business bank');
  const { settings } = await owner.get('/api/reference');
  await owner.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4000000002', vatCategory: category }, 'PUT');
  const current = vatPeriod(now, category, settings.fyEndMonth);
  const last = vatPeriod(addMonths(current.start, -1), category, settings.fyEndMonth);
  const before = vatPeriod(addMonths(last.start, -1), category, settings.fyEndMonth);
  const client = await owner.post('/api/clients', { name: 'Made-up Client', address: '1 Made-up Street, Fictional Town' });
  const output = async (date: string, vat: number) => {
    const inv = await owner.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: date, dueDate: addDays(now, 200), lines: [{ category: 'labour', description: 'Work', qty: 1, unitPriceCents: (vat * 100) / 15 }] });
    await owner.post(`/api/documents/${inv.id}/issue`);
  };
  const input = async (date: string, vat: number) =>
    owner.post('/api/costs', { date, description: 'Made-up parts', supplier: 'Made-up Supplies', amountCents: Math.round((vat * 115) / 15), vatCents: vat, categoryId: await r.cat('Parts'), sourceId: bank });
  const sars = async (date: string, cents: number) =>
    owner.post('/api/journals', {
      date,
      description: cents > 0 ? 'Made-up VAT paid to SARS' : 'Made-up VAT refund from SARS',
      lines: cents > 0 ? [{ accountId: await r.acc('vat'), debitCents: cents }, { accountId: await r.acc('bank'), creditCents: cents }] : [{ accountId: await r.acc('bank'), debitCents: -cents }, { accountId: await r.acc('vat'), creditCents: -cents }],
    });
  return { env, current, last, before, output, input, sars };
}
type B = Awaited<ReturnType<typeof vatBooks>>;

async function vatCase(category: VatCategory, build: (b: B) => Promise<void>, expected: (b: B) => { date: string; cents: number }[]) {
  const b = await vatBooks(category);
  try {
    await build(b);
    const f = await cashForecast(b.env.sql, now);
    weeksAddUp(f);
    expect(vatOf(f)).toEqual(expected(b));
    await expectCleanAudit(b.env.sql);
  } finally {
    await b.env.close();
  }
}

describe('MUST (round 8 not closed): a refund part-paid before last period’s VAT was owed', () => {
  it('two-monthly: R100 of an older R750 refund paid before last’s VAT201 was due; last’s R600 now overdue', () =>
    // Round 8's own case with R100 in place of R250: when the R100 came in, last period's VAT
    // wasn't owed, so nothing could be set off against it. The R600 is still owed.
    vatCase(twoMonthlyOverdue, async (b) => {
      await b.input(b.before.start, 75_000);
      await b.output(b.last.start, 60_000);
      await b.sars(addDays(b.last.end, -5), -10_000);
      await b.output(b.current.start, 90_000);
    }, (b) => [
      { date: due(vat201Due(b.last.end)), cents: -60_000 },
      { date: vat201Due(b.current.end), cents: -90_000 },
    ]));
});

describe('MUST (caused by round 8): the overdue debt isn’t net of what was paid on it', () => {
  it('two-monthly: last’s R450 part-paid (R150), then SARS sets off the R300 left against an older R1 000 refund and pays R700', () =>
    vatCase(twoMonthlyOverdue, async (b) => {
      await b.input(b.before.start, 100_000); // R1 000 refund owed by SARS
      await b.output(b.last.start, 45_000); // R450 owed, now overdue
      const paidOn = vat201Due(b.last.end) < addDays(now, -2) ? vat201Due(b.last.end) : addDays(now, -2);
      await b.sars(paidOn, 15_000); // R150 paid on it: R300 left overdue
      await b.sars(addDays(now, -1), -70_000); // R300 set off, R700 paid
      await b.output(b.current.start, 90_000);
    }, (b) => [{ date: vat201Due(b.current.end), cents: -90_000 }]));

  it('monthly: older R450 owed, R150 paid on it in the last period, last’s R1 000 refund paid as R700 after a R300 set-off', () =>
    vatCase('C', async (b) => {
      await b.output(b.before.start, 45_000);
      await b.sars(b.last.start, 15_000);
      await b.input(b.last.start, 100_000);
      await b.sars(addDays(now, -1), -70_000);
      await b.output(b.current.start, 90_000);
    }, (b) => [{ date: vat201Due(b.current.end), cents: -90_000 }]));
});

describe('SHOULD: EMP201 and DTR01 paid through Payroll → SARS, dated after the forecast ends', () => {
  it('the EMP201 shows as owed in the books now (a journal’s words), the DTR01 not at all', async () => {
    const env = await setup();
    try {
      const owner = await login(env.app, 'owner@example.co.za');
      const r = await ref(env.sql);
      const bank = await r.src('Business bank');
      const { settings: s } = await owner.get('/api/reference');
      await owner.post('/api/settings', { ...s, businessType: 'company', features: { ...s.features, payroll: true } }, 'PUT');
      const thisMonth = `${now.slice(0, 8)}01`;
      const client = await owner.post('/api/clients', { name: 'Made-up Client', address: '1 Made-up Street, Fictional Town' });
      const inv = await owner.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: addDays(now, -40), dueDate: addDays(now, -10), lines: [{ category: 'labour', description: 'Work', qty: 1, unitPriceCents: 5_000_000 }] });
      await owner.post(`/api/documents/${inv.id}/issue`);
      await owner.post('/api/employees', { name: 'Made-up One', salaryCents: 3_000_000, startDate: addMonths(thisMonth, -6) });
      const lastMonth = addMonths(thisMonth, -1);
      const run = await owner.post('/api/pay-runs', { period: lastMonth.slice(0, 7), payDate: addDays(lastMonth, 24), sourceId: bank });
      await owner.post(`/api/pay-runs/${run.id}/finalise`);
      const paidOn = addDays(now, -1);
      await owner.post('/api/dividends', { declaredOn: paidOn, paidOn, shareholder: 'Made-up Shareholder', grossCents: 1_000_000, sourceId: bank });
      const f0 = await cashForecast(env.sql, now);
      const emp = (f: F) => f.items.filter((x) => x.kind === 'emp201' && !/as your recent pay runs/.test(x.label)).map((x) => ({ date: x.date, cents: x.cents, label: x.label }));
      const dwt = (f: F) => f.items.filter((x) => x.kind === 'dwt').map((x) => ({ date: x.date, cents: x.cents }));
      const empBefore = emp(f0);
      const dwtBefore = dwt(f0);
      const total = -empBefore.reduce((t, x) => t + x.cents, 0);
      const later = addDays(now, 120);
      await owner.post('/api/sars-payments', { kind: 'emp201', period: lastMonth.slice(0, 7), date: later, amountCents: total, sourceId: bank });
      await owner.post('/api/sars-payments', { kind: 'dwt', period: paidOn.slice(0, 7), date: later, amountCents: 200_000, sourceId: bank });
      const f = await cashForecast(env.sql, now);
      weeksAddUp(f);
      expect(emp(f)[0]?.label).toMatch(/^EMP201 for /); // not "owed in the books (a journal, or balances brought in)"
      void empBefore; void dwtBefore;
      expect({ emp: -emp(f).reduce((t, x) => t + x.cents, 0), dwt: -dwt(f).reduce((t, x) => t + x.cents, 0) }).toEqual({ emp: total, dwt: 200_000 });
      await expectCleanAudit(env.sql);
    } finally {
      await env.close();
    }
  });
});

describe('holds: moveToAccount’s closed-period check for a cost type (round 8)', () => {
  it('refuses exactly what moves a closed period’s figures, and logs what left the old account by year', async () => {
    const env = await setup();
    try {
      const owner = await login(env.app, 'owner@example.co.za');
      const r = await ref(env.sql);
      const bank = await r.src('Business bank');
      const { settings } = await owner.get('/api/reference');
      const { financialYear } = await import('@shap/shared');
      const fy = financialYear(now, settings.fyEndMonth);
      const lastFy = financialYear(addDays(fy.start, -1), settings.fyEndMonth);
      const job = await owner.post<{ id: string }>('/api/projects', { name: 'Made-up Job', status: 'active' });
      const client = await owner.post('/api/clients', { name: 'Made-up Client', address: '1 Made-up Street, Fictional Town' });
      const parts = await r.cat('Parts');
      const partsAcc = (await env.sql<{ a: string }[]>`select account_id as a from cost_categories where id = ${parts}`)[0]!.a;
      const petrol = await r.cat('Petrol');
      // Last year: R100 of parts on the job (work in progress at the year end), R70 of fuel (no job).
      await owner.post('/api/costs', { date: addDays(fy.start, -30), description: 'Made-up parts', supplier: 'Made-up Supplies', amountCents: 10_000, categoryId: parts, projectId: job.id, sourceId: bank });
      await owner.post('/api/costs', { date: addDays(fy.start, -20), description: 'Made-up fuel', supplier: 'Made-up Garage', amountCents: 7_000, categoryId: petrol, sourceId: bank });
      // This year: the job invoiced (its parts to cost of sales now), R40 more of parts with no job.
      const inv = await owner.post('/api/documents', { kind: 'invoice', clientId: client.id, projectId: job.id, issueDate: addDays(fy.start, 3), dueDate: addDays(fy.start, 33), lines: [{ category: 'labour', description: 'Work', qty: 1, unitPriceCents: 50_000 }] });
      await owner.post(`/api/documents/${inv.id}/issue`);
      await owner.post('/api/costs', { date: addDays(fy.start, 4), description: 'Made-up parts', supplier: 'Made-up Supplies', amountCents: 4_000, categoryId: parts, sourceId: bank });
      // A journal line on the parts account this year: it stays.
      await owner.post('/api/journals', { date: addDays(fy.start, 5), description: 'Made-up reclass', lines: [{ accountId: partsAcc, debitCents: 1_500 }, { accountId: await r.acc('bank'), creditCents: 1_500 }] });
      await env.sql`update settings set lock_date = ${addDays(fy.start, -1)}::date where id`;
      const closedFigures = async () => JSON.stringify(await env.sql`select account_id, sum(amount_cents)::bigint as t from ledger where date <= ${addDays(fy.start, -1)}::date group by 1 having sum(amount_cents) <> 0 order by 1`);
      const before = await closedFigures();
      const put = (id: string, name: string, kind: string, accountId: string) => owner.call({ method: 'PUT', url: `/api/categories/${id}`, payload: { name, kind, accountId } });
      const petrolAcc = (await env.sql<{ a: string; k: string }[]>`select account_id as a, kind as k from cost_categories where id = ${petrol}`)[0]!;
      // Fuel's kind alone (no job, nothing in work in progress): its closed figures don't move.
      expect((await put(petrol, 'Petrol', petrolAcc.k === 'overhead' ? 'personal' : 'overhead', petrolAcc.a)).statusCode).toBe(200);
      expect((await put(petrol, 'Petrol', petrolAcc.k, petrolAcc.a)).statusCode).toBe(200);
      // Parts' kind alone: last year's work in progress would go to the expense.
      expect((await put(parts, 'Parts', 'overhead', partsAcc)).statusCode).toBe(400);
      expect(await closedFigures()).toBe(before);
      // Parts' account alone: last year's is in work in progress (not on the account), so it can.
      const other = await owner.post<{ id: string }>('/api/accounts', { code: '5095', name: 'Made-up Parts Two', type: 'cost_of_sales', active: true });
      const res = await put(parts, 'Parts', 'materials', other.id);
      expect(res.statusCode, res.body).toBe(200);
      expect(await closedFigures()).toBe(before);
      const [log] = await env.sql<{ details: { moved: { fyEnd: string; cents: number }[] } }[]>`select details from audit_log where action = 'moved_to_account'`;
      // This year: the job's R100 (recognised) and R40 left the old account; the R15 journal stayed.
      expect(log!.details.moved).toEqual([{ fyEnd: fy.end, cents: 14_000 }]);
      expect(lastFy.end < fy.end).toBe(true);
      await expectCleanAudit(env.sql);
    } finally {
      await env.close();
    }
  });
});
