import { describe, expect, it } from 'vitest';
import { addDays, addMonths, vat201Due, vatPeriod, type VatCategory } from '@shap/shared';
import { today } from '../../src/lib/books.js';
import { cashForecast } from '../../src/modules/forecast.js';
import { expectCleanAudit, login, ref, setup } from '../helpers.js';

// The tenth round of 1.33's reviews (SARS, accounting): the ninth round's set-off rule against
// TAA s191(1) (only a debt already overdue, the whole of it), Payroll → SARS payments dated after
// the 13 weeks counted once, and provisional tax left out. Made-up business, made-up figures.

const now = today();
type F = Awaited<ReturnType<typeof cashForecast>>;
const vatOf = (f: F) => f.items.filter((x) => x.kind === 'vat').map((x) => ({ date: x.date, cents: x.cents }));
const due = (d: string) => (d < now ? now : d);
const weeksAddUp = (f: F) => expect(f.weeks[f.weeks.length - 1]!.closingCents).toBe(f.openingCents + f.items.reduce((t, x) => t + x.cents, 0));

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
  const older = vatPeriod(addMonths(before.start, -1), category, settings.fyEndMonth);
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
  return { env, owner, r, current, last, before, older, output, input, sars };
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

const twoMonthlyOverdue = (['A', 'B'] as const).find((c) => vat201Due(vatPeriod(addMonths(vatPeriod(now, c, 2).start, -1), c, 2).end) < now)!;
const twoMonthlyNotDue = twoMonthlyOverdue === 'A' ? 'B' : 'A';

describe('holds: the round-9 set-off rule', () => {
  it('monthly: older R3 000 owed, R1 000 paid on it this period, then last’s R10 000 refund paid as R8 000', () =>
    vatCase('C', async (b) => {
      await b.output(b.before.start, 300_000);
      await b.input(b.last.start, 1_000_000);
      await b.sars(addDays(b.current.start, 1), 100_000);
      await b.sars(addDays(now, -1), -800_000);
      await b.output(b.current.start, 90_000);
    }, (b) => [{ date: vat201Due(b.current.end), cents: -90_000 }]));

  it('two-monthly: two refunds, R2 500 before last’s R3 000 fell due and R4 500 after (R3 000 set off)', () =>
    vatCase(twoMonthlyOverdue, async (b) => {
      await b.input(b.before.start, 1_000_000);
      await b.output(b.last.start, 300_000);
      await b.sars(addDays(b.last.end, -5), -250_000);
      await b.sars(addDays(now, -1), -450_000);
      await b.output(b.current.start, 90_000);
    }, (b) => [{ date: vat201Due(b.current.end), cents: -90_000 }]));

  it('two-monthly: a refund on the due date itself isn’t net of a set-off (the debt isn’t outstanding yet)', () =>
    vatCase(twoMonthlyOverdue, async (b) => {
      await b.input(b.before.start, 1_000_000);
      await b.output(b.last.start, 300_000);
      await b.sars(vat201Due(b.last.end), -700_000);
      await b.output(b.current.start, 90_000);
    }, (b) => [
      { date: due(vat201Due(b.last.end)), cents: -300_000 },
      { date: vat201Due(b.current.end), cents: -90_000 },
    ]));

  it('two-monthly: the day after, it is', () =>
    vatCase(twoMonthlyOverdue, async (b) => {
      await b.input(b.before.start, 1_000_000);
      await b.output(b.last.start, 300_000);
      await b.sars(addDays(vat201Due(b.last.end), 1), -700_000);
      await b.output(b.current.start, 90_000);
    }, (b) => [{ date: vat201Due(b.current.end), cents: -90_000 }]));

  it('two-monthly: older part-paid, last refund paid net, this period’s refund booked ahead', () =>
    vatCase(twoMonthlyNotDue, async (b) => {
      await b.output(b.before.start, 300_000);
      await b.sars(addDays(b.last.start, 5), 100_000);
      await b.input(b.last.start, 1_000_000);
      await b.sars(addDays(now, -1), -800_000);
      await b.input(b.current.start, 200_000);
      await b.sars(addDays(b.current.end, 20), -200_000);
    }, () => []));

  it('monthly: an older refund paid before the older debt fell due, then last’s refund paid net of the rest', () =>
    vatCase('C', async (b) => {
      await b.input(b.older.start, 450_000); // R4 500 refund owed
      await b.output(b.before.start, 600_000); // R6 000 owed, due within the last period
      await b.sars(addDays(b.last.start, 9), -450_000); // the R4 500 refund paid before that was due
      await b.input(b.last.start, 1_000_000); // R10 000 refund
      await b.sars(addDays(now, -1), -400_000); // R6 000 set off, R4 000 paid
      await b.output(b.current.start, 90_000);
    }, (b) => [{ date: vat201Due(b.current.end), cents: -90_000 }]));
});

describe('MUST (caused by round 9): provisional tax paid on Payroll → SARS after the 13 weeks', () => {
  // An IRP6 (the top-up for the year just ended) recorded with its date after the forecast's end.
  // The new add-back reads every kind on sars_payments, so it comes back as "Dividends tax (DTR01)"
  // owed now. Provisional tax isn't in the forecast at all (said on screen).
  it('isn’t forecast as dividends tax, or at all', async () => {
    const env = await setup();
    try {
      const owner = await login(env.app, 'owner@example.co.za');
      const r = await ref(env.sql);
      const bank = await r.src('Business bank');
      const { settings } = await owner.get('/api/reference');
      await owner.post('/api/settings', { ...settings, businessType: 'company' }, 'PUT');
      const fy = settings.fyEndMonth as number;
      // The last year end gone by.
      let y = Number(now.slice(0, 4));
      if (Number(now.slice(5, 7)) <= fy) y -= 1;
      const period = `${y}-${String(fy).padStart(2, '0')}`;
      const before = await cashForecast(env.sql, now);
      const res = await owner.call({ method: 'POST', url: '/api/sars-payments', payload: { kind: 'irp6', period, date: addDays(now, 120), amountCents: 1_234_500, sourceId: bank } });
      expect(res.statusCode).toBe(200);
      const f = await cashForecast(env.sql, now);
      weeksAddUp(f);
      expect(f.items.filter((x) => x.kind === 'dwt' || /Dividends tax/.test(x.label))).toEqual([]);
      expect(f.weeks.at(-1)!.closingCents).toBe(before.weeks.at(-1)!.closingCents);
      await expectCleanAudit(env.sql);
    } finally {
      await env.close();
    }
  });
});

describe('holds: Payroll → SARS payments after the 13 weeks, no double count', () => {
  const thisMonth = `${now.slice(0, 8)}01`;
  async function payroll() {
    const env = await setup();
    const owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    const { settings: s } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...s, businessType: 'company', features: { ...s.features, payroll: true } }, 'PUT');
    await owner.post('/api/employees', { name: 'Made-up One', salaryCents: 3_000_000, startDate: addMonths(thisMonth, -6) });
    const lastMonth = addMonths(thisMonth, -1);
    const run = await owner.post('/api/pay-runs', { period: lastMonth.slice(0, 7), payDate: addDays(lastMonth, 24), sourceId: bank });
    await owner.post(`/api/pay-runs/${run.id}/finalise`);
    const [m] = await env.sql<{ t: string }[]>`select sum(paye_cents + uif_employee_cents + uif_employer_cents + sdl_cents)::bigint as t from pay_lines where run_id = ${run.id}`;
    const pay = async (date: string, amountCents: number) => {
      const res = await owner.call({ method: 'POST', url: '/api/sars-payments', payload: { kind: 'emp201', period: lastMonth.slice(0, 7), date, amountCents, sourceId: bank } });
      expect(res.statusCode).toBe(200);
    };
    return { env, owner, r, bank, total: Number(m!.t), pay };
  }
  const sarsOut = (f: F) => -f.items.filter((x) => (x.kind === 'emp201' && !/as your recent pay runs/.test(x.label)) || (x.kind === 'booked')).reduce((t, x) => t + x.cents, 0);

  it('part paid within the weeks (booked), the rest after them: the whole EMP201 once', async () => {
    const p = await payroll();
    try {
      const first = Math.round(p.total * 0.4);
      await p.pay(addDays(now, 10), first);
      await p.pay(addDays(now, 120), p.total - first);
      const f = await cashForecast(p.env.sql, now);
      weeksAddUp(f);
      expect(sarsOut(f)).toBe(p.total);
      expect(f.items.filter((x) => /owed in the books/.test(x.label))).toEqual([]);
      await expectCleanAudit(p.env.sql);
    } finally {
      await p.env.close();
    }
  });

  it('paid in full now, and a second (duplicate) payment dated after the weeks: nothing more', async () => {
    const p = await payroll();
    try {
      await p.pay(addDays(now, -1), p.total);
      await p.pay(addDays(now, 120), p.total);
      const f = await cashForecast(p.env.sql, now);
      weeksAddUp(f);
      expect(f.items.filter((x) => x.kind === 'emp201' && !/as your recent pay runs/.test(x.label))).toEqual([]);
      await expectCleanAudit(p.env.sql);
    } finally {
      await p.env.close();
    }
  });

  it('PAYE brought in beyond the runs, with the run’s EMP201 paid after the weeks: both, once each', async () => {
    const p = await payroll();
    try {
      await p.owner.post('/api/journals', { date: addDays(now, -3), description: 'Made-up PAYE from before', lines: [{ accountId: await p.r.acc('cos_labour'), debitCents: 50_000 }, { accountId: await p.r.acc('paye_payable'), creditCents: 50_000 }] });
      await p.pay(addDays(now, 120), p.total);
      const f = await cashForecast(p.env.sql, now);
      weeksAddUp(f);
      const emp = f.items.filter((x) => x.kind === 'emp201' && !/as your recent pay runs/.test(x.label));
      expect(emp.reduce((t, x) => t - x.cents, 0)).toBe(p.total + 50_000);
      expect(emp.filter((x) => /owed in the books/.test(x.label)).map((x) => x.cents)).toEqual([-50_000]);
      await expectCleanAudit(p.env.sql);
    } finally {
      await p.env.close();
    }
  });
});
