import { describe, expect, it } from 'vitest';
import { addDays, addMonths, emp201Due, vat201Due, vatPeriod } from '@shap/shared';
import { today } from '../../src/lib/books.js';
import { cashForecast } from '../../src/modules/forecast.js';
import { expectCleanAudit, login, ref, setup } from '../helpers.js';

// The seventh round of 1.33's reviews (accounting and arithmetic): the forecast's VAT across made-up cases, the new
// PAYE, UIF and SDL line beyond the pay runs, and the week totals. Made-up business and figures.

const now = today();
const thisMonth = `${now.slice(0, 8)}01`;
type F = Awaited<ReturnType<typeof cashForecast>>;
const vatOf = (f: F) => f.items.filter((x) => x.kind === 'vat').map((x) => ({ date: x.date, cents: x.cents }));
const due = (d: string) => (d < now ? now : d);
const weeksAddUp = (f: F) => expect(f.weeks[f.weeks.length - 1]!.closingCents).toBe(f.openingCents + f.items.reduce((t, x) => t + x.cents, 0));

async function vatBooks() {
  const env = await setup();
  const owner = await login(env.app, 'owner@example.co.za');
  const r = await ref(env.sql);
  const bank = await r.src('Business bank');
  const { settings } = await owner.get('/api/reference');
  await owner.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4000000002', vatCategory: 'C' }, 'PUT');
  const current = vatPeriod(now, 'C', settings.fyEndMonth);
  const last = vatPeriod(addMonths(current.start, -1), 'C', settings.fyEndMonth);
  const before = vatPeriod(addMonths(last.start, -1), 'C', settings.fyEndMonth);
  const client = await owner.post('/api/clients', { name: 'Made-up Client', address: '1 Made-up Street, Fictional Town' });
  // Output VAT: 15% of the price.
  const invoice = async (date: string, vatCents: number) => {
    const inv = await owner.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: date, dueDate: addDays(now, 200), lines: [{ category: 'labour', description: 'Work', qty: 1, unitPriceCents: (vatCents * 100) / 15 }] });
    await owner.post(`/api/documents/${inv.id}/issue`);
  };
  // Input VAT: a cost.
  const cost = async (date: string, vatCents: number) =>
    owner.post('/api/costs', { date, description: 'Made-up parts', supplier: 'Made-up Supplies', amountCents: (vatCents * 115) / 15, vatCents, categoryId: await r.cat('Parts'), sourceId: bank });
  const vat = await r.acc('vat');
  const bankAcc = await r.acc('bank');
  const pay = (date: string, cents: number) => owner.post('/api/journals', { date, description: 'Made-up VAT paid', lines: [{ accountId: vat, debitCents: cents }, { accountId: bankAcc, creditCents: cents }] });
  const refund = (date: string, cents: number) => owner.post('/api/journals', { date, description: 'Made-up VAT refund', lines: [{ accountId: bankAcc, debitCents: cents }, { accountId: vat, creditCents: cents }] });
  return { env, owner, r, current, last, before, invoice, cost, pay, refund };
}

async function vatCase(build: (b: Awaited<ReturnType<typeof vatBooks>>) => Promise<void>, expected: (b: Awaited<ReturnType<typeof vatBooks>>) => { date: string; cents: number }[]) {
  const b = await vatBooks();
  try {
    await build(b);
    const f = await cashForecast(b.env.sql, now);
    weeksAddUp(f);
    expect(vatOf(f)).toEqual(expected(b));
    await expectCleanAudit(b.env.sql);
    return f;
  } finally {
    await b.env.close();
  }
}

describe('forecast VAT against the VAT account and VAT201s (made-up cases)', () => {
  it('a payment booked ahead for this period, with last period a refund owed: nothing more out', async () => {
    const f = await vatCase(
      async (b) => {
        await b.cost(b.last.start, 75_000);
        await b.invoice(b.current.start, 90_000);
        await b.pay(addDays(now, 3), 90_000);
      },
      () => [],
    );
    expect(f.items.filter((x) => x.kind === 'booked').reduce((t, x) => t + x.cents, 0)).toBe(-90_000);
  });

  it('paid less than the older debt during last period: the rest of it this week, last and this on their returns', async () => {
    await vatCase(
      async (b) => {
        await b.invoice(b.before.start, 150_000);
        await b.pay(addDays(b.last.start, 2), 100_000);
        await b.invoice(b.last.start, 150_000);
        await b.invoice(b.current.start, 90_000);
      },
      (b) => [
        { date: now, cents: -50_000 },
        { date: due(vat201Due(b.last.end)), cents: -150_000 },
        { date: vat201Due(b.current.end), cents: -90_000 },
      ].sort((x, y) => x.date.localeCompare(y.date) || y.cents - x.cents),
    );
  });

  it('nothing paid: each period on its own', async () => {
    await vatCase(
      async (b) => {
        await b.invoice(b.before.start, 150_000);
        await b.invoice(b.last.start, 150_000);
        await b.invoice(b.current.start, 90_000);
      },
      (b) => [
        { date: now, cents: -150_000 },
        { date: due(vat201Due(b.last.end)), cents: -150_000 },
        { date: vat201Due(b.current.end), cents: -90_000 },
      ].sort((x, y) => x.date.localeCompare(y.date) || y.cents - x.cents),
    );
  });

  it('a refund received in part: the rest still isn’t netted off this period', async () => {
    await vatCase(
      async (b) => {
        await b.cost(b.last.start, 75_000);
        await b.refund(b.current.start, 50_000);
        await b.invoice(b.current.start, 90_000);
      },
      (b) => [{ date: vat201Due(b.current.end), cents: -90_000 }],
    );
  });

  it('a refund owed bigger than the older debt: the debt still goes out', async () => {
    await vatCase(
      async (b) => {
        await b.invoice(b.before.start, 30_000);
        await b.cost(b.last.start, 75_000);
        await b.invoice(b.current.start, 90_000);
      },
      (b) => [
        { date: now, cents: -30_000 },
        { date: vat201Due(b.current.end), cents: -90_000 },
      ],
    );
  });

  it('this period a refund, received on a day booked ahead: nothing goes out for VAT', async () => {
    // This period: R750 input VAT, and its refund booked for a day after the period ends (the
    // forecast shows it coming in). No period owes anything.
    const f = await vatCase(
      async (b) => {
        await b.cost(b.current.start, 75_000);
        await b.refund(addDays(b.current.end, 30), 75_000);
      },
      () => [],
    );
    expect(f.items.filter((x) => x.kind === 'booked').reduce((t, x) => t + x.cents, 0)).toBe(75_000);
  });
});

describe('moveToAccount: a closed year that nothing of this payment account is in', () => {
  it('lets an unused payment account on the main bank move, though the bank has a closed year', async () => {
    const env = await setup();
    try {
      const owner = await login(env.app, 'owner@example.co.za');
      const r = await ref(env.sql);
      const { settings } = await owner.get('/api/reference');
      const { financialYear } = await import('@shap/shared');
      const fy = financialYear(now, settings.fyEndMonth);
      // Last year: a cost paid from the business bank, then that year closed.
      await owner.post('/api/costs', { date: addDays(fy.start, -30), description: 'Made-up fuel last year', supplier: 'Made-up Garage', amountCents: 20_000, categoryId: await r.cat('Petrol'), sourceId: await r.src('Business bank') });
      await env.sql`update settings set lock_date = ${addDays(fy.start, -1)}::date where id`;
      // A second payment account on the same bank account, never used, moved to another account
      // on the cash line: nothing captured with it is anywhere, let alone in the closed year.
      const spare = await owner.post<{ id: string }>('/api/sources', { name: 'Made-up spare', kind: 'bank', accountId: await r.acc('bank') });
      const two = await owner.post<{ id: string }>('/api/accounts', { code: '1074', name: 'Made-up Second Bank', type: 'asset', statementLine: 'cash', active: true });
      const res = await owner.call({ method: 'PUT', url: `/api/sources/${spare.id}`, payload: { name: 'Made-up spare', kind: 'bank', accountId: two.id } });
      expect(res.statusCode, res.body).toBe(200);
      await expectCleanAudit(env.sql);
    } finally {
      await env.close();
    }
  });
});

/** Made-up payroll: two employees, last month's run final and paid on the 25th. */
async function payBooks() {
  const env = await setup();
  const owner = await login(env.app, 'owner@example.co.za');
  const r = await ref(env.sql);
  const bank = await r.src('Business bank');
  const { settings: s } = await owner.get('/api/reference');
  await owner.post('/api/settings', { ...s, businessType: 'company', features: { ...s.features, payroll: true } }, 'PUT');
  await owner.post('/api/employees', { name: 'Made-up One', salaryCents: 3_000_000, startDate: addMonths(thisMonth, -6) });
  await owner.post('/api/employees', { name: 'Made-up Two', salaryCents: 2_500_000, startDate: addMonths(thisMonth, -6) });
  const lastMonth = addMonths(thisMonth, -1);
  const run = await owner.post('/api/pay-runs', { period: lastMonth.slice(0, 7), payDate: addDays(lastMonth, 24), sourceId: bank });
  await owner.post(`/api/pay-runs/${run.id}/finalise`);
  const [m] = await env.sql<{ paye: string; uif: string; sdl: string }[]>`
    select sum(paye_cents)::bigint as paye, sum(uif_employee_cents + uif_employer_cents)::bigint as uif, sum(sdl_cents)::bigint as sdl from pay_lines where run_id = ${run.id}`;
  const emp201 = { paye: Number(m!.paye), uif: Number(m!.uif), sdl: Number(m!.sdl) };
  const total = emp201.paye + emp201.uif + emp201.sdl;
  const period = addDays(lastMonth, 24).slice(0, 7);
  return { env, owner, r, bank, emp201, total, period };
}

describe('PAYE, UIF and SDL beyond the pay runs (made-up payroll)', () => {
  it('an EMP201 paid by a journal by hand (a bank line put on the three accounts) isn’t forecast again', async () => {
    const b = await payBooks();
    try {
      // Paid from the bank by a journal (as a bank line posted to PAYE, UIF and SDL owed would be),
      // not through Payroll → SARS. The books owe SARS nothing now.
      await b.owner.post('/api/journals', {
        date: addDays(now, -1),
        description: 'Made-up SARS EMP201',
        lines: [
          { accountId: await b.r.acc('paye_payable'), debitCents: b.emp201.paye },
          { accountId: await b.r.acc('uif_payable'), debitCents: b.emp201.uif },
          { accountId: await b.r.acc('sdl_payable'), debitCents: b.emp201.sdl },
          { accountId: await b.r.acc('bank'), creditCents: b.total },
        ].filter((l) => (l.debitCents ?? l.creditCents) > 0),
      });
      const [owed] = await b.env.sql<{ t: string }[]>`select coalesce(-sum(l.amount_cents), 0)::bigint as t from ledger l join accounts a on a.id = l.account_id where a.system_key in ('paye_payable', 'uif_payable', 'sdl_payable')`;
      expect(Number(owed!.t)).toBe(0);
      await expectCleanAudit(b.env.sql);
      const f = await cashForecast(b.env.sql, now);
      weeksAddUp(f);
      // The last run's EMP201 is paid (the bank has already gone down by it): not out again, as a
      // wages or dividends journal paying Shap's own records is taken as paid (forecast.ts 143, 162).
      expect(f.items.filter((x) => x.kind === 'emp201' && !/as your recent pay runs/.test(x.label)).map((x) => ({ label: x.label, cents: x.cents }))).toEqual([]);
    } finally {
      await b.env.close();
    }
  });

  it('a VAT refund SARS set off against the EMP201 (round six’s own case) comes off it', async () => {
    const b = await payBooks();
    try {
      const { settings } = await b.owner.get('/api/reference');
      await b.owner.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4000000002', vatCategory: 'C' }, 'PUT');
      const last = vatPeriod(addMonths(vatPeriod(now, 'C', settings.fyEndMonth).start, -1), 'C', settings.fyEndMonth);
      await b.owner.post('/api/costs', { date: last.start, description: 'Made-up parts', supplier: 'Made-up Supplies', amountCents: 575_000, vatCents: 75_000, categoryId: await b.r.cat('Parts'), sourceId: b.bank });
      // SARS pays R250 of the R750 refund and sets R500 off against last month's EMP201.
      await b.owner.post('/api/journals', { date: addDays(now, -1), description: 'Made-up VAT refund, part set off against PAYE', lines: [{ accountId: await b.r.acc('paye_payable'), debitCents: 50_000 }, { accountId: await b.r.acc('bank'), debitCents: 25_000 }, { accountId: await b.r.acc('vat'), creditCents: 75_000 }] });
      await expectCleanAudit(b.env.sql);
      const f = await cashForecast(b.env.sql, now);
      weeksAddUp(f);
      const emp = -f.items.filter((x) => x.kind === 'emp201' && !/as your recent pay runs/.test(x.label)).reduce((t, x) => t + x.cents, 0);
      // What the three accounts owe SARS now.
      expect(emp).toBe(b.total - 50_000);
    } finally {
      await b.env.close();
    }
  });

  it('brought in, beside an EMP201 partly paid and one paid ahead: each counted once', async () => {
    const b = await payBooks();
    try {
      const [u] = await b.env.sql<{ id: string }[]>`select id from users where email = 'owner@example.co.za'`;
      const [j] = await b.env.sql<{ id: string }[]>`insert into journals (date, description, reference, kind, created_by) values (${addDays(now, -40)}, 'Made-up opening balances', 'Moved in', 'opening', ${u!.id}) returning id`;
      await b.env.sql`insert into journal_lines ${b.env.sql([
        { journalId: j!.id, accountId: await b.r.acc('retained_earnings'), debitCents: 1_500_000, creditCents: 0, memo: '' },
        { journalId: j!.id, accountId: await b.r.acc('paye_payable'), debitCents: 0, creditCents: 1_200_000, memo: '' },
        { journalId: j!.id, accountId: await b.r.acc('uif_payable'), debitCents: 0, creditCents: 200_000, memo: '' },
        { journalId: j!.id, accountId: await b.r.acc('sdl_payable'), debitCents: 0, creditCents: 100_000, memo: '' },
      ])}`;
      const sum = (f: F) => -f.items.filter((x) => x.kind === 'emp201' && !/as your recent pay runs/.test(x.label)).reduce((t, x) => t + x.cents, 0);
      const booked = (f: F) => -f.items.filter((x) => x.kind === 'booked').reduce((t, x) => t + x.cents, 0);
      let f = await cashForecast(b.env.sql, now);
      weeksAddUp(f);
      expect(sum(f)).toBe(b.total + 1_500_000);
      // Partly paid (half, yesterday): half of it, and the R15 000.
      await b.owner.post('/api/sars-payments', { kind: 'emp201', period: b.period, date: addDays(now, -1), amountCents: Math.floor(b.total / 2), sourceId: b.bank });
      f = await cashForecast(b.env.sql, now);
      expect(sum(f)).toBe(b.total - Math.floor(b.total / 2) + 1_500_000);
      // The rest paid on a day ahead: booked, not owed again.
      await b.owner.post('/api/sars-payments', { kind: 'emp201', period: b.period, date: addDays(now, 4), amountCents: b.total - Math.floor(b.total / 2), sourceId: b.bank });
      f = await cashForecast(b.env.sql, now);
      weeksAddUp(f);
      expect(sum(f)).toBe(1_500_000);
      expect(booked(f)).toBe(b.total - Math.floor(b.total / 2));
      // This month's run paid on a day ahead: its own EMP201 once, not again as beyond the runs.
      const run = await b.owner.post('/api/pay-runs', { period: thisMonth.slice(0, 7), payDate: addDays(now, 2), sourceId: b.bank });
      await b.owner.post(`/api/pay-runs/${run.id}/finalise`);
      const [n] = await b.env.sql<{ t: string }[]>`select sum(paye_cents + uif_employee_cents + uif_employer_cents + sdl_cents)::bigint as t from pay_lines where run_id = ${run.id}`;
      f = await cashForecast(b.env.sql, now);
      weeksAddUp(f);
      expect(sum(f)).toBe(1_500_000 + Number(n!.t));
      expect(f.items.some((x) => x.kind === 'emp201' && x.date === emp201Due(addDays(now, 2).slice(0, 7)) && x.cents === -Number(n!.t))).toBe(true);
      expect(f.items.filter((x) => /^Other PAYE, UIF and SDL owed in the books/.test(x.label)).map((x) => x.cents)).toEqual([-1_500_000]);
      await expectCleanAudit(b.env.sql);
    } finally {
      await b.env.close();
    }
  });
});
