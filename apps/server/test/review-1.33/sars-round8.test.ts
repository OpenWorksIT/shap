import { describe, expect, it } from 'vitest';
import { addDays, addMonths, vat201Due, vatPeriod, type VatCategory } from '@shap/shared';
import { today } from '../../src/lib/books.js';
import { cashForecast } from '../../src/modules/forecast.js';
import { suggestAccount } from '../../src/modules/movein.js';
import { expectCleanAudit, login, ref, setup } from '../helpers.js';

// Round 8 (SARS): the seventh round's forecast VAT (set-off, refunds booked ahead), EMP201s less what
// the books show paid, and move-in's guesses. Made-up business, made-up figures.

const now = today();
const thisMonth = `${now.slice(0, 8)}01`;
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
  const client = await owner.post('/api/clients', { name: 'Made-up Client', address: '1 Made-up Street, Fictional Town' });
  /** Output VAT of `vat`. */
  const output = async (date: string, vat: number) => {
    const inv = await owner.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: date, dueDate: addDays(now, 200), lines: [{ category: 'labour', description: 'Work', qty: 1, unitPriceCents: (vat * 100) / 15 }] });
    await owner.post(`/api/documents/${inv.id}/issue`);
  };
  /** Input VAT of `vat`. */
  const input = async (date: string, vat: number) =>
    owner.post('/api/costs', { date, description: 'Made-up parts', supplier: 'Made-up Supplies', amountCents: Math.round((vat * 115) / 15), vatCents: vat, categoryId: await r.cat('Parts'), sourceId: bank });
  /** A payment to SARS (cents > 0) or a refund from SARS (cents < 0), by journal against the bank. */
  const sars = async (date: string, cents: number) =>
    owner.post('/api/journals', {
      date,
      description: cents > 0 ? 'Made-up VAT paid to SARS' : 'Made-up VAT refund from SARS',
      lines: cents > 0 ? [{ accountId: await r.acc('vat'), debitCents: cents }, { accountId: await r.acc('bank'), creditCents: cents }] : [{ accountId: await r.acc('bank'), debitCents: -cents }, { accountId: await r.acc('vat'), creditCents: -cents }],
    });
  return { env, owner, r, current, last, before, output, input, sars };
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

describe('holds: the s191(1) set-off, as round 7 meant it', () => {
  it('monthly, last period not yet due: a refund paid net of a set-off against older VAT overdue', () =>
    vatCase('C', async (b) => {
      await b.output(b.before.start, 300_000); // R3 000 owed, overdue
      await b.input(b.last.start, 1_000_000); // R10 000 refund
      await b.sars(addDays(now, -1), -700_000); // R7 000 paid, R3 000 set off
      await b.output(b.current.start, 90_000);
    }, (b) => [{ date: vat201Due(b.current.end), cents: -90_000 }]));

  it('two-monthly, last period not yet due: the same', () =>
    vatCase(twoMonthlyNotDue, async (b) => {
      await b.output(b.before.start, 300_000);
      await b.input(b.last.start, 1_000_000);
      await b.sars(addDays(now, -1), -700_000);
      await b.output(b.current.start, 90_000);
    }, (b) => [{ date: vat201Due(b.current.end), cents: -90_000 }]));

  it('two-monthly, last not yet due: an older refund paid short isn’t set off against VAT not yet overdue', () =>
    vatCase(twoMonthlyNotDue, async (b) => {
      await b.input(b.before.start, 1_000_000);
      await b.output(b.last.start, 300_000); // due on its VAT201, not overdue
      await b.sars(addDays(now, -1), -700_000);
      await b.output(b.current.start, 90_000);
    }, (b) => [
      { date: due(vat201Due(b.last.end)), cents: -300_000 },
      { date: vat201Due(b.current.end), cents: -90_000 },
    ]));

  it('a refund bigger than everything overdue, paid part-way: nothing more out for ended periods', () =>
    vatCase('C', async (b) => {
      await b.output(b.before.start, 300_000);
      await b.input(b.last.start, 1_000_000);
      await b.sars(addDays(now, -1), -500_000); // R3 000 set off, R2 000 still owed by SARS
      await b.output(b.current.start, 90_000);
    }, (b) => [{ date: vat201Due(b.current.end), cents: -90_000 }]));

  it('two-monthly, last overdue: an older refund bigger than it, paid part-way', () =>
    vatCase(twoMonthlyOverdue, async (b) => {
      await b.input(b.before.start, 1_000_000);
      await b.output(b.last.start, 300_000);
      await b.sars(addDays(now, -1), -500_000);
      await b.output(b.current.start, 90_000);
    }, (b) => [{ date: vat201Due(b.current.end), cents: -90_000 }]));

  it('this period’s refund booked ahead beside an older refund still owed (nothing overdue): nothing out', () =>
    vatCase('C', async (b) => {
      await b.input(b.last.start, 600_000); // R6 000 owed by SARS, not received
      await b.input(b.current.start, 200_000); // this period a R2 000 refund
      await b.sars(addDays(b.current.end, 30), -200_000); // booked ahead
    }, () => []));
});

describe('NOTE: a set-off with no refund paid out at all (SARS kept all of it)', () => {
  it('monthly: the older VAT is forecast in full (R3 000), though the books owe R1 000', () =>
    vatCase('C', async (b) => {
      await b.output(b.before.start, 300_000);
      await b.input(b.last.start, 200_000);
    }, () => [{ date: now, cents: -300_000 }]));
  it('two-monthly, last overdue: the same', () =>
    vatCase(twoMonthlyOverdue, async (b) => {
      await b.input(b.before.start, 200_000);
      await b.output(b.last.start, 300_000);
    }, () => [{ date: now, cents: -300_000 }]));
});

describe('MUST: a refund booked ahead (not come in) is taken as SARS having set off VAT overdue', () => {
  it('monthly: older VAT overdue, last period’s refund not paid, this period’s refund booked ahead: the overdue VAT still goes out', () =>
    vatCase('C', async (b) => {
      await b.output(b.before.start, 300_000); // R3 000 overdue, nothing has come in from SARS
      await b.input(b.last.start, 600_000); // R6 000 refund owed, not paid
      await b.input(b.current.start, 200_000); // this period a R2 000 refund
      await b.sars(addDays(b.current.end, 30), -200_000); // this period’s refund booked ahead
    }, () => [{ date: now, cents: -300_000 }]));

  it('two-monthly, last overdue: older refund not paid, this period’s booked ahead: last period’s VAT still goes out', () =>
    vatCase(twoMonthlyOverdue, async (b) => {
      await b.input(b.before.start, 600_000);
      await b.output(b.last.start, 300_000);
      await b.input(b.current.start, 200_000);
      await b.sars(addDays(b.current.end, 30), -200_000);
    }, () => [{ date: now, cents: -300_000 }]));

  it('monthly: the set-off made when SARS paid (R3 000 net, R3 000 set off) isn’t undone by this period’s refund booked ahead', () =>
    vatCase('C', async (b) => {
      await b.output(b.before.start, 300_000);
      await b.input(b.last.start, 600_000);
      await b.sars(addDays(now, -1), -300_000); // R6 000 refund: R3 000 set off, R3 000 paid
      await b.input(b.current.start, 200_000);
      await b.sars(addDays(b.current.end, 30), -200_000); // this period’s own, booked ahead
    }, () => []));
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
  const journal = async (date: string, lines: { key: string; cents: number }[]) =>
    owner.post('/api/journals', {
      date,
      description: 'Made-up EMP201 paid by hand',
      lines: [
        ...(await Promise.all(lines.filter((l) => l.cents > 0).map(async (l) => ({ accountId: await r.acc(l.key), debitCents: l.cents })))),
        { accountId: await r.acc('bank'), creditCents: lines.reduce((t, l) => t + l.cents, 0) },
      ],
    });
  /** Last month's EMP201 as forecast (not the months projected from the pay runs). */
  const listed = (f: F) => 0 - f.items.filter((x) => x.kind === 'emp201' && !/as your recent pay runs/.test(x.label)).reduce((t, x) => t + x.cents, 0);
  const booked = (f: F) => 0 - f.items.filter((x) => x.kind === 'booked').reduce((t, x) => t + x.cents, 0);
  return { env, owner, r, emp201, total, journal, listed, booked };
}

describe('EMP201s less what the books show paid', () => {
  it('holds: overpaid by a journal: nothing listed, nothing beyond, the excess not forecast as money in', async () => {
    const b = await payBooks();
    try {
      await b.journal(addDays(now, -1), [{ key: 'paye_payable', cents: b.emp201.paye + 100_000 }, { key: 'uif_payable', cents: b.emp201.uif }, { key: 'sdl_payable', cents: b.emp201.sdl }]);
      const f = await cashForecast(b.env.sql, now);
      weeksAddUp(f);
      expect(b.listed(f)).toBe(0);
      expect(f.items.filter((x) => x.kind === 'emp201' && x.cents > 0)).toEqual([]);
      await expectCleanAudit(b.env.sql);
    } finally {
      await b.env.close();
    }
  });

  it('holds: paid on the wrong one of the three accounts (all on UIF): still taken as paid', async () => {
    const b = await payBooks();
    try {
      await b.journal(addDays(now, -1), [{ key: 'uif_payable', cents: b.total }]);
      const f = await cashForecast(b.env.sql, now);
      weeksAddUp(f);
      expect(b.listed(f)).toBe(0);
    } finally {
      await b.env.close();
    }
  });

  it('holds: paid ahead by a journal dated within the forecast: out once, on its day', async () => {
    const b = await payBooks();
    try {
      await b.journal(addDays(now, 10), [{ key: 'paye_payable', cents: b.emp201.paye }, { key: 'uif_payable', cents: b.emp201.uif }, { key: 'sdl_payable', cents: b.emp201.sdl }]);
      const f = await cashForecast(b.env.sql, now);
      weeksAddUp(f);
      expect(b.listed(f) + b.booked(f)).toBe(b.total);
      await expectCleanAudit(b.env.sql);
    } finally {
      await b.env.close();
    }
  });

  it('MUST: paid by a journal dated after the forecast ends: the EMP201 goes out of the 13 weeks altogether', async () => {
    const b = await payBooks();
    try {
      // A slip of the year, or paid much later: the bank doesn't go down within the 13 weeks.
      await b.journal(addDays(now, 120), [{ key: 'paye_payable', cents: b.emp201.paye }, { key: 'uif_payable', cents: b.emp201.uif }, { key: 'sdl_payable', cents: b.emp201.sdl }]);
      const f = await cashForecast(b.env.sql, now);
      weeksAddUp(f);
      // Overdue and unpaid within the forecast: it should still go out (this week), once.
      expect(b.listed(f) + b.booked(f)).toBe(b.total);
      await expectCleanAudit(b.env.sql);
    } finally {
      await b.env.close();
    }
  });
});

describe('move-in: dividends tax by other names', () => {
  const acc = (systemKey: string, type: 'asset' | 'liability' | 'expense' = 'liability') => ({ id: systemKey, code: '', name: `Made-up ${systemKey}`, type, systemKey });
  const accounts = ['paye_payable', 'uif_payable', 'sdl_payable', 'wages_payable', 'payables', 'vat', 'income_tax_payable', 'dwt_payable'].map((k) => acc(k)).concat([acc('general_labour', 'expense'), acc('income_tax', 'expense')]);
  const guess = (name: string, cents: number) => suggestAccount({ code: '', name, cents } as never, accounts);
  it('holds: UIF owed by its owed word first; the expense isn’t', () => {
    expect(guess('UIF - employer contribution control', -120_000)).toBe('uif_payable');
    expect(guess('Accrued UIF (company)', -120_000)).toBe('uif_payable');
    expect(guess('UIF employer cost', 120_000)).not.toBe('uif_payable');
    expect(guess('Dividends tax payable', -300_000)).toBe('dwt_payable');
  });
  it('SHOULD: "Withholding tax on dividends" and "Dividends WHT" payable are SARS’s, not a trade creditor', () => {
    expect(guess('Withholding tax on dividends payable', -300_000)).toBe('dwt_payable');
    expect(guess('Dividends WHT payable', -300_000)).toBe('dwt_payable');
  });
});
