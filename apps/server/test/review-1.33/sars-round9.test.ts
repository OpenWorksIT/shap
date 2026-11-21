import { describe, expect, it } from 'vitest';
import { addDays, addMonths, vat201Due, vatPeriod, type VatCategory } from '@shap/shared';
import { today } from '../../src/lib/books.js';
import { cashForecast } from '../../src/modules/forecast.js';
import { expectCleanAudit, login, ref, setup } from '../helpers.js';

// The ninth round of 1.33's reviews (SARS): the eighth round's set-off rule (all of the overdue debt, or none). Made-up
// business, made-up figures.

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

describe('MUST (caused by round 8): the overdue debt is measured before what was paid on it', () => {
  // R3 000 overdue for the period before last; R1 000 of it paid during the last period. The last
  // period is a R10 000 refund: SARS sets off the R2 000 still overdue and pays R8 000. Nothing is
  // owed for ended periods. Round 7's rule gave that; round 8's compares R8 000 + R3 000 (not
  // R2 000) with R10 000, takes no set-off, and forecasts R2 000 as owed now.
  it('monthly: older VAT part-paid, then a refund paid net of the rest', () =>
    vatCase('C', async (b) => {
      await b.output(b.before.start, 300_000);
      await b.sars(addDays(b.last.start, 5), 100_000);
      await b.input(b.last.start, 1_000_000);
      await b.sars(addDays(now, -1), -800_000);
      await b.output(b.current.start, 90_000);
    }, (b) => [{ date: vat201Due(b.current.end), cents: -90_000 }]));

  it('two-monthly: the same', () =>
    vatCase(twoMonthlyNotDue, async (b) => {
      await b.output(b.before.start, 300_000);
      await b.sars(addDays(b.last.start, 5), 100_000);
      await b.input(b.last.start, 1_000_000);
      await b.sars(addDays(now, -1), -800_000);
      await b.output(b.current.start, 90_000);
    }, (b) => [{ date: vat201Due(b.current.end), cents: -90_000 }]));
});

describe('MUST (round 8 accounting, not closed): a refund that came in before the debt was overdue', () => {
  // R10 000 refund owed for the period before last. SARS pays R2 500 of it near the end of the last
  // period, when the last period's R3 000 wasn't owed yet: nothing could be set off (s191(1)). The
  // R3 000 is overdue now and still owed. R2 500 + R3 000 is under R10 000, so round 8 takes it as
  // set off and forecasts nothing for the last period.
  it('two-monthly, last overdue: paid part-way during the last period', () =>
    vatCase(twoMonthlyOverdue, async (b) => {
      await b.input(b.before.start, 1_000_000);
      await b.output(b.last.start, 300_000);
      await b.sars(addDays(b.last.end, -5), -250_000);
      await b.output(b.current.start, 90_000);
    }, (b) => [
      { date: due(vat201Due(b.last.end)), cents: -300_000 },
      { date: vat201Due(b.current.end), cents: -90_000 },
    ]));

  it('two-monthly, last overdue: paid part-way after the last period, before its VAT201 was due', () =>
    vatCase(twoMonthlyOverdue, async (b) => {
      await b.input(b.before.start, 1_000_000);
      await b.output(b.last.start, 300_000);
      await b.sars(addDays(vat201Due(b.last.end), -3), -250_000);
      await b.output(b.current.start, 90_000);
    }, (b) => [
      { date: due(vat201Due(b.last.end)), cents: -300_000 },
      { date: vat201Due(b.current.end), cents: -90_000 },
    ]));
});

describe('holds', () => {
  it('a refund paid in full, nothing overdue: nothing more for ended periods', () =>
    vatCase('C', async (b) => {
      await b.input(b.last.start, 1_000_000);
      await b.sars(addDays(now, -1), -1_000_000);
      await b.output(b.current.start, 90_000);
    }, (b) => [{ date: vat201Due(b.current.end), cents: -90_000 }]));

  it('two-monthly: older VAT overdue, last refund paid net, this period’s refund booked ahead', () =>
    vatCase(twoMonthlyNotDue, async (b) => {
      await b.output(b.before.start, 300_000);
      await b.input(b.last.start, 1_000_000);
      await b.sars(addDays(now, -1), -700_000);
      await b.input(b.current.start, 200_000);
      await b.sars(addDays(b.current.end, 20), -200_000);
    }, () => []));
});
