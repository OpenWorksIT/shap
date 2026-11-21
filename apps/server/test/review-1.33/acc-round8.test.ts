import { describe, expect, it } from 'vitest';
import { addDays, addMonths, financialYear, vat201Due, vatPeriod, type VatCategory } from '@shap/shared';
import { today } from '../../src/lib/books.js';
import { cashForecast } from '../../src/modules/forecast.js';
import { expectCleanAudit, login, ref, setup } from '../helpers.js';

// Round 8 (accounting and arithmetic): what the seventh round's fixes cause. Made-up business,
// made-up figures.

const now = today();
type F = Awaited<ReturnType<typeof cashForecast>>;
const vatOf = (f: F) => f.items.filter((x) => x.kind === 'vat').map((x) => ({ date: x.date, cents: x.cents }));
const due = (d: string) => (d < now ? now : d);
const weeksAddUp = (f: F) => expect(f.weeks[f.weeks.length - 1]!.closingCents).toBe(f.openingCents + f.items.reduce((t, x) => t + x.cents, 0));

const overdueTwoMonthly = (['A', 'B'] as const).find((c) => {
  const cur = vatPeriod(now, c, 2);
  return vat201Due(vatPeriod(addMonths(cur.start, -1), c, 2).end) < now;
})!;

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
  const invoice = async (date: string, cents: number) => {
    const inv = await owner.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: date, dueDate: addDays(now, 200), lines: [{ category: 'labour', description: 'Work', qty: 1, unitPriceCents: cents }] });
    await owner.post(`/api/documents/${inv.id}/issue`);
  };
  const cost = async (date: string, vat: number) =>
    owner.post('/api/costs', { date, description: 'Made-up parts', supplier: 'Made-up Supplies', amountCents: Math.round((vat * 115) / 15), vatCents: vat, categoryId: await r.cat('Parts'), sourceId: bank });
  const sars = async (date: string, cents: number) =>
    owner.post('/api/journals', {
      date,
      description: cents > 0 ? 'Made-up VAT paid to SARS' : 'Made-up VAT refund from SARS',
      lines: cents > 0 ? [{ accountId: await r.acc('vat'), debitCents: cents }, { accountId: await r.acc('bank'), creditCents: cents }] : [{ accountId: await r.acc('bank'), debitCents: -cents }, { accountId: await r.acc('vat'), creditCents: -cents }],
    });
  return { env, owner, r, current, last, before, invoice, cost, sars };
}

describe('MUST: a refund paid before last period’s VAT was owed isn’t net of a set-off against it', () => {
  it('two-monthly: part of the older refund paid during the last period; last period’s VAT now overdue', async () => {
    const b = await vatBooks(overdueTwoMonthly);
    try {
      // Before last: R750 refund owed. SARS pays R250 of it near the end of the last period (its
      // checks on the rest still open). Last: R600 output VAT, its VAT201 now past due, not paid.
      // When the R250 came in, last period's VAT wasn't owed yet, so nothing could be set off
      // against it (s191(1)): the R600 is still owed, and the R500 refund still isn't netted.
      await b.cost(b.before.start, 75_000);
      await b.invoice(b.last.start, 400_000);
      await b.sars(addDays(b.last.end, -5), -25_000);
      await b.invoice(b.current.start, 600_000);
      const f = await cashForecast(b.env.sql, now);
      weeksAddUp(f);
      // As with no refund paid at all (the R600 in full): not R100.
      expect(vatOf(f)).toEqual([
        { date: due(vat201Due(b.last.end)), cents: -60_000 },
        { date: vat201Due(b.current.end), cents: -90_000 },
      ]);
      await expectCleanAudit(b.env.sql);
    } finally {
      await b.env.close();
    }
  });
});

describe('SHOULD: a DTR01 paid by a journal by hand', () => {
  it('isn’t forecast as owed again (as an EMP201 paid by a journal now isn’t)', async () => {
    const env = await setup();
    try {
      const owner = await login(env.app, 'owner@example.co.za');
      const r = await ref(env.sql);
      const bank = await r.src('Business bank');
      const { settings } = await owner.get('/api/reference');
      await owner.post('/api/settings', { ...settings, businessType: 'company' }, 'PUT');
      // Profit to pay it from: a made-up invoice, paid.
      const client = await owner.post('/api/clients', { name: 'Made-up Client', address: '1 Made-up Street, Fictional Town' });
      const inv = await owner.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: addDays(now, -40), dueDate: addDays(now, -10), lines: [{ category: 'labour', description: 'Work', qty: 1, unitPriceCents: 5_000_000 }] });
      await owner.post(`/api/documents/${inv.id}/issue`);
      // A dividend paid yesterday: R2 000 dividends tax withheld, its DTR01 due at the end of next month.
      const paidOn = addDays(now, -1);
      await owner.post('/api/dividends', { declaredOn: paidOn, paidOn, shareholder: 'Made-up Shareholder', grossCents: 1_000_000, sourceId: bank });
      const dtr = (f: F) => 0 - f.items.filter((x) => x.kind === 'dwt').reduce((t, x) => t + x.cents, 0) || 0;
      expect(dtr(await cashForecast(env.sql, now))).toBe(200_000);
      // Paid from the bank by a journal (a bank line put on dividends tax payable), not through
      // Payroll → SARS: the books owe SARS nothing for it, and the bank has already gone down.
      await owner.post('/api/journals', { date: now, description: 'Made-up DTR01 paid', lines: [{ accountId: await r.acc('dwt_payable'), debitCents: 200_000 }, { accountId: await r.acc('bank'), creditCents: 200_000 }] });
      const [owed] = await env.sql<{ t: string }[]>`select coalesce(-sum(l.amount_cents), 0)::bigint as t from ledger l join accounts a on a.id = l.account_id where a.system_key = 'dwt_payable'`;
      expect(Number(owed!.t)).toBe(0);
      const f = await cashForecast(env.sql, now);
      weeksAddUp(f);
      expect(dtr(f)).toBe(0);
      await expectCleanAudit(env.sql);
    } finally {
      await env.close();
    }
  });
});

describe('MUST: moving a cost type and changing its kind at once, with job costs in a closed year', () => {
  it('is refused: the closed year’s work in progress would go to an expense', async () => {
    const env = await setup();
    try {
      const owner = await login(env.app, 'owner@example.co.za');
      const r = await ref(env.sql);
      const bank = await r.src('Business bank');
      const { settings } = await owner.get('/api/reference');
      const fy = financialYear(now, settings.fyEndMonth);
      const job = await owner.post<{ id: string }>('/api/projects', { name: 'Made-up Job', status: 'active' });
      const parts = await r.cat('Parts');
      // Last year: R10 000 of parts on a job not invoiced yet (work in progress at the year end).
      await owner.post('/api/costs', { date: addDays(fy.start, -30), description: 'Made-up parts', supplier: 'Made-up Supplies', amountCents: 1_000_000, categoryId: parts, projectId: job.id, sourceId: bank });
      await env.sql`update settings set lock_date = ${addDays(fy.start, -1)}::date where id`;
      const closedYear = async () =>
        env.sql<{ code: string; t: string }[]>`select a.code, sum(l.amount_cents)::bigint as t from ledger l join accounts a on a.id = l.account_id
          where l.date <= ${addDays(fy.start, -1)}::date and a.type <> 'equity' group by a.code having sum(l.amount_cents) <> 0 order by a.code`;
      const before = await closedYear();
      const other = await owner.post<{ id: string }>('/api/accounts', { code: '6995', name: 'Made-up Sundry Costs', type: 'expense', active: true });
      const res = await owner.call({ method: 'PUT', url: `/api/categories/${parts}`, payload: { name: 'Parts', kind: 'overhead', accountId: other.id } });
      const after = await closedYear();
      // The closed year's figures are what they were, or the change was refused.
      expect({ status: res.statusCode, changed: JSON.stringify(after) !== JSON.stringify(before) }).toEqual({ status: 400, changed: false });
      await expectCleanAudit(env.sql);
    } finally {
      await env.close();
    }
  });
});

describe('NOTE: the round-7 NOTE suite on VAT overpaid', () => {
  it('builds books, so ends with the books audit (sars-round7.test.ts 162-175 doesn’t)', async () => {
    const b = await vatBooks('C');
    try {
      await b.invoice(b.last.start, 400_000);
      await b.sars(b.last.end, 90_000);
      await b.invoice(b.current.start, 600_000);
      expect(vatOf(await cashForecast(b.env.sql, now))).toEqual([{ date: vat201Due(b.current.end), cents: -90_000 }]);
      await expectCleanAudit(b.env.sql);
    } finally {
      await b.env.close();
    }
  });
});
