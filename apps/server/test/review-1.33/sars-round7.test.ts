import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addMonths, formatDate, vat201Due, vatPeriod, type VatCategory } from '@shap/shared';
import { today } from '../../src/lib/books.js';
import { cashForecast } from '../../src/modules/forecast.js';
import { expectCleanAudit, login, ref, setup } from '../helpers.js';

// The seventh round of 1.33's reviews (SARS): the sixth round's forecast VAT (refunds owed, paid
// ahead, a refund paid net of SARS's set-off) and the PAYE, UIF and SDL the books owe beyond the pay
// runs, or less than them. Made-up business, made-up figures.

const now = today();
const vatOf = (f: Awaited<ReturnType<typeof cashForecast>>) => f.items.filter((x) => x.kind === 'vat').map((x) => ({ date: x.date, cents: x.cents }));
const due = (d: string) => (d < now ? now : d);

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
  /** Output VAT of 15% of `cents`. */
  const invoice = async (date: string, cents: number) => {
    const inv = await owner.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: date, dueDate: addDays(now, 200), lines: [{ category: 'labour', description: 'Work', qty: 1, unitPriceCents: cents }] });
    await owner.post(`/api/documents/${inv.id}/issue`);
  };
  /** Input VAT of `vat` (a refund SARS owes when nothing else is in the period). */
  const cost = async (date: string, vat: number) =>
    owner.post('/api/costs', { date, description: 'Made-up parts', supplier: 'Made-up Supplies', amountCents: Math.round((vat * 115) / 15), vatCents: vat, categoryId: await r.cat('Parts'), sourceId: bank });
  /** A payment to SARS (cents > 0) or a refund from SARS (cents < 0), by journal against the bank. */
  const sars = async (date: string, cents: number) =>
    owner.post('/api/journals', {
      date,
      description: cents > 0 ? 'Made-up VAT paid to SARS' : 'Made-up VAT refund from SARS',
      lines: cents > 0 ? [{ accountId: await r.acc('vat'), debitCents: cents }, { accountId: await r.acc('bank'), creditCents: cents }] : [{ accountId: await r.acc('bank'), debitCents: -cents }, { accountId: await r.acc('vat'), creditCents: -cents }],
    });
  return { env, owner, r, current, last, before, invoice, cost, sars };
}

/** A two-monthly category whose last period's VAT201 is already past its due date today. */
const overdueTwoMonthly = (['A', 'B'] as const).find((c) => {
  const cur = vatPeriod(now, c, 2);
  return vat201Due(vatPeriod(addMonths(cur.start, -1), c, 2).end) < now;
})!;
/** A two-monthly category whose last period's VAT201 isn't due yet. */
const notYetDueTwoMonthly = overdueTwoMonthly === 'A' ? 'B' : 'A';

describe('MUST: a refund paid net of SARS’s set-off against VAT already overdue (TAA s191(1))', () => {
  it('two-monthly: the older period’s refund set off against last period’s overdue VAT isn’t forecast as owed again', async () => {
    const b = await vatBooks(overdueTwoMonthly);
    // Before last: R750 refund owed. Last: R600 output VAT, its VAT201 now past due and not paid.
    // SARS authorises the R750 refund, must set R600 off against the overdue R600 (s191(1)) and
    // pays the R150 rest. The books' VAT for ended periods is now nil.
    await b.cost(b.before.start, 75_000);
    await b.invoice(b.last.start, 400_000);
    await b.sars(b.current.start, -15_000);
    await b.invoice(b.current.start, 600_000);
    try {
      const vatBalance = (await b.env.sql<{ b: string }[]>`select coalesce(sum(l.amount_cents), 0)::bigint as b from ledger l join accounts a on a.id = l.account_id where a.system_key = 'vat' and l.date < ${b.current.start}::date`)[0]!.b;
      expect(Number(vatBalance) - 15_000).toBe(0); // ended periods' VAT, with the refund received, is nil
      expect(vatOf(await cashForecast(b.env.sql, now))).toEqual([{ date: vat201Due(b.current.end), cents: -90_000 }]);
      await expectCleanAudit(b.env.sql);
    } finally {
      await b.env.close();
    }
  });

  it('monthly: last period’s refund set off against an older period’s overdue VAT isn’t forecast as owed again', async () => {
    const b = await vatBooks('C');
    // Before last: R600 output VAT, overdue, not paid. Last: R750 refund. SARS sets off R600 and pays R150.
    await b.invoice(b.before.start, 400_000);
    await b.cost(b.last.start, 75_000);
    await b.sars(b.current.start, -15_000);
    await b.invoice(b.current.start, 600_000);
    try {
      expect(vatOf(await cashForecast(b.env.sql, now))).toEqual([{ date: vat201Due(b.current.end), cents: -90_000 }]);
      await expectCleanAudit(b.env.sql);
    } finally {
      await b.env.close();
    }
  });
});

describe('the brief’s cases that hold (SARS, round 7)', () => {
  it('a refund owed for last period and a payment ahead for this one: neither netted nor forecast again', async () => {
    const b = await vatBooks('C');
    await b.cost(b.last.start, 75_000);
    await b.invoice(b.current.start, 600_000);
    await b.sars(b.current.start, 90_000);
    try {
      expect(vatOf(await cashForecast(b.env.sql, now))).toEqual([]);
      await expectCleanAudit(b.env.sql);
    } finally {
      await b.env.close();
    }
  });

  it('a refund received part-way, no VAT overdue: the rest isn’t netted off this period', async () => {
    const b = await vatBooks('C');
    await b.cost(b.last.start, 75_000);
    await b.sars(b.current.start, -30_000);
    await b.invoice(b.current.start, 600_000);
    try {
      expect(vatOf(await cashForecast(b.env.sql, now))).toEqual([{ date: vat201Due(b.current.end), cents: -90_000 }]);
      await expectCleanAudit(b.env.sql);
    } finally {
      await b.env.close();
    }
  });

  it('two refund periods in a row: neither netted off this period', async () => {
    const b = await vatBooks('C');
    await b.cost(b.before.start, 75_000);
    await b.cost(b.last.start, 45_000);
    await b.invoice(b.current.start, 600_000);
    try {
      expect(vatOf(await cashForecast(b.env.sql, now))).toEqual([{ date: vat201Due(b.current.end), cents: -90_000 }]);
      await expectCleanAudit(b.env.sql);
    } finally {
      await b.env.close();
    }
  });

  it('two-monthly: a refund owed for the older period while last period is overdue; then paid late', async () => {
    const b = await vatBooks(overdueTwoMonthly);
    await b.cost(b.before.start, 75_000);
    await b.invoice(b.last.start, 2_000_000);
    await b.invoice(b.current.start, 600_000);
    try {
      expect(vatOf(await cashForecast(b.env.sql, now))).toEqual([
        { date: due(vat201Due(b.last.end)), cents: -300_000 },
        { date: vat201Due(b.current.end), cents: -90_000 },
      ]);
      await b.sars(now, 300_000);
      expect(vatOf(await cashForecast(b.env.sql, now))).toEqual([{ date: vat201Due(b.current.end), cents: -90_000 }]);
      await expectCleanAudit(b.env.sql);
    } finally {
      await b.env.close();
    }
  });

  it('two-monthly: the older period’s and last period’s own paid during the last period aren’t taken off this one', async () => {
    const b = await vatBooks(notYetDueTwoMonthly);
    await b.invoice(b.before.start, 400_000);
    await b.invoice(b.last.start, 2_000_000);
    await b.sars(addDays(b.last.start, 20), 60_000);
    await b.sars(b.last.end, 300_000);
    await b.invoice(b.current.start, 600_000);
    try {
      expect(vatOf(await cashForecast(b.env.sql, now))).toEqual([{ date: vat201Due(b.current.end), cents: -90_000 }]);
      await expectCleanAudit(b.env.sql);
    } finally {
      await b.env.close();
    }
  });
});

describe('NOTE: VAT overpaid during the last period', () => {
  it('isn’t taken off this period’s (only payments since it began are: as docs/SARS.md says)', async () => {
    const b = await vatBooks('C');
    await b.invoice(b.last.start, 400_000);
    await b.sars(b.last.end, 90_000); // R600 owed, R900 paid: R300 ahead
    await b.invoice(b.current.start, 600_000);
    try {
      // Shown in full: conservative (SARS holds the R300 as a credit on the VAT account).
      expect(vatOf(await cashForecast(b.env.sql, now))).toEqual([{ date: vat201Due(b.current.end), cents: -90_000 }]);
    } finally {
      await b.env.close();
    }
  });
});

describe('SHOULD: PAYE, UIF and SDL the books show paid, beyond what Payroll knows', () => {
  async function payrollBooks() {
    const env = await setup();
    const owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    const { settings } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...settings, features: { ...settings.features, payroll: true } }, 'PUT');
    const thisMonth = `${now.slice(0, 7)}-01`;
    const lastMonth = addMonths(thisMonth, -1);
    await owner.post('/api/employees', { name: 'Made-up Employee', salaryCents: 3_000_000, startDate: addMonths(thisMonth, -10) });
    // Last month's run, paid on its 25th: its EMP201 was due by the 7th of this month.
    const run = await owner.post('/api/pay-runs', { period: lastMonth.slice(0, 7), payDate: `${lastMonth.slice(0, 8)}25`, sourceId: bank });
    await owner.post(`/api/pay-runs/${run.id}/finalise`);
    const [t] = await env.sql<{ paye: string; uif: string; sdl: string }[]>`select sum(paye_cents)::bigint as paye, sum(uif_employee_cents + uif_employer_cents)::bigint as uif, sum(sdl_cents)::bigint as sdl from pay_lines where run_id = ${run.id}`;
    const label = `EMP201 for ${formatDate(lastMonth, 'long').replace(/^1 /, '')}`;
    const emp201 = async () => 0 - (await cashForecast(env.sql, now)).items.filter((x) => x.kind === 'emp201' && x.date <= addDays(now, 6)).reduce((s, x) => s + x.cents, 0);
    return { env, owner, r, paye: Number(t!.paye), uif: Number(t!.uif), sdl: Number(t!.sdl), label, emp201 };
  }

  it('an EMP201 paid by a journal by hand isn’t forecast as owed again', async () => {
    const b = await payrollBooks();
    try {
      const total = b.paye + b.uif + b.sdl;
      expect(await b.emp201()).toBe(total);
      await b.owner.post('/api/journals', {
        date: now,
        description: 'Made-up EMP201 paid by hand',
        lines: [
          { accountId: await b.r.acc('paye_payable'), debitCents: b.paye },
          { accountId: await b.r.acc('uif_payable'), debitCents: b.uif },
          ...(b.sdl ? [{ accountId: await b.r.acc('sdl_payable'), debitCents: b.sdl }] : []),
          { accountId: await b.r.acc('bank'), creditCents: total },
        ],
      });
      // The bank already shows it paid; the books owe SARS nothing for payroll.
      expect(await b.emp201()).toBe(0);
      await expectCleanAudit(b.env.sql);
    } finally {
      await b.env.close();
    }
  });

  it('a VAT refund SARS set off against that overdue EMP201 (sixth round: a refund) comes off it', async () => {
    const b = await payrollBooks();
    try {
      const total = b.paye + b.uif + b.sdl;
      await b.owner.post('/api/journals', {
        date: now,
        description: 'Made-up VAT refund set off against PAYE',
        lines: [{ accountId: await b.r.acc('paye_payable'), debitCents: 50_000 }, { accountId: await b.r.acc('vat'), creditCents: 50_000 }],
      });
      expect(await b.emp201()).toBe(total - 50_000);
      await expectCleanAudit(b.env.sql);
    } finally {
      await b.env.close();
    }
  });
});
