import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addMonths, monthEnd, vat201Due, vatPeriod } from '@shap/shared';
import { today } from '../../src/lib/books.js';
import { cashForecast } from '../../src/modules/forecast.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

// The fourth round of 1.33's reviews (SARS, accounting): a trial balance brought in is a balance,
// not a period's VAT; a VAT payment with SARS's interest beside it is still a payment; a refund SARS
// owes isn't netted against this period; someone who has left isn't paid again; and wages and
// dividends owed in the books beyond Shap's own records still go out. Made-up business and figures.

const now = today();
const thisMonth = `${now.slice(0, 8)}01`;
const out = (items: { cents: number }[]) => -items.reduce((t, x) => t + Math.min(0, x.cents), 0);
const vatOf = (f: Awaited<ReturnType<typeof cashForecast>>) => f.items.filter((x) => x.kind === 'vat').map((x) => ({ date: x.date, cents: x.cents }));

/** Made-up books on VAT category C (monthly), this period and the last. */
async function vatBooks() {
  const env = await setup();
  const owner = await login(env.app, 'owner@example.co.za');
  const r = await ref(env.sql);
  const bank = await r.src('Business bank');
  const { settings } = await owner.get('/api/reference');
  await owner.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4000000002', vatCategory: 'C' }, 'PUT');
  const current = vatPeriod(now, 'C', settings.fyEndMonth);
  const last = vatPeriod(addMonths(current.start, -1), 'C', settings.fyEndMonth);
  const client = await owner.post('/api/clients', { name: 'Made-up Client', address: '1 Made-up Street, Fictional Town' });
  const invoice = async (date: string, cents: number) => {
    const inv = await owner.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: date, dueDate: addDays(now, 200), lines: [{ category: 'labour', description: 'Work', qty: 1, unitPriceCents: cents }] });
    await owner.post(`/api/documents/${inv.id}/issue`);
  };
  return { env, owner, r, bank, current, last, invoice };
}

describe('VAT: a trial balance brought in', () => {
  let b: Awaited<ReturnType<typeof vatBooks>>;
  beforeAll(async () => {
    b = await vatBooks();
  });
  afterAll(async () => {
    await expectCleanAudit(b.env.sql);
    await b.env.close();
  });

  it('takes its VAT as owed for periods gone by, not as this period’s', async () => {
    // A made-up trial balance today with R30 000 on the VAT account.
    const [imp] = await b.env.sql<{ id: string }[]>`insert into ledger_imports (kind, source, filename, date_from, date_to, lines) values ('trialBalance', 'Made-up package', 'made-up-tb.csv', ${now}, ${now}, 2) returning id`;
    const j = await b.owner.post<{ id: string }>('/api/journals', { date: now, description: 'Made-up trial balance', lines: [{ accountId: await b.r.acc('retained_earnings'), debitCents: 3_000_000 }, { accountId: await b.r.acc('vat'), creditCents: 3_000_000 }] });
    await b.env.sql`update journals set kind = 'import', ledger_import_id = ${imp!.id} where id = ${j.id}`;
    const f = await cashForecast(b.env.sql, now);
    expect(vatOf(f)).toEqual([{ date: now, cents: -3_000_000 }]);
    // Said for what it is: Shap can't put a trial balance's VAT in a SARS period (SARS, fifth round).
    expect(f.items.find((x) => x.kind === 'vat')!.label).toMatch(/^VAT owing for periods before .+, or brought in with a trial balance \(VAT201, an estimate, as if paid now\)$/);
  });
});

describe('VAT: a payment with SARS’s interest beside it', () => {
  let b: Awaited<ReturnType<typeof vatBooks>>;
  beforeAll(async () => {
    b = await vatBooks();
  });
  afterAll(async () => {
    await expectCleanAudit(b.env.sql);
    await b.env.close();
  });

  it('is still a payment, not this period’s VAT', async () => {
    const [fin] = await b.env.sql<{ id: string }[]>`insert into accounts (code, name, type, statement_line) values ('6910', 'Made-up SARS interest', 'expense', 'finance_costs') returning id`;
    // Last period: R2 250 VAT invoiced. This period: R1 500. Last period's paid at the start of
    // this one, with R50 interest beside it.
    await b.invoice(b.last.start, 1_500_000);
    await b.invoice(b.current.start, 1_000_000);
    await b.owner.post('/api/journals', { date: b.current.start, description: 'Made-up VAT paid, with interest', lines: [{ accountId: await b.r.acc('vat'), debitCents: 225_000 }, { accountId: fin!.id, debitCents: 5_000 }, { accountId: await b.r.acc('bank'), creditCents: 230_000 }] });
    const f = await cashForecast(b.env.sql, now);
    expect(vatOf(f)).toEqual([{ date: vat201Due(b.current.end), cents: -150_000 }]);
  });

  it('the VAT201 and the books audit say when a journal typed in moved VAT otherwise (a cash sale)', async () => {
    const vat = () => b.owner.get<{ handVatAddedCents: number; handVatOffCents: number; handVatLines: number; fields: { field20: number } }>(`/api/vat/return?on=${b.current.start}`);
    // The payment with interest is a payment: nothing to say. So is one paid by card (fifth round).
    expect(await vat()).toMatchObject({ handVatAddedCents: 0, handVatOffCents: 0, handVatLines: 0 });
    const [cardAcc] = await b.env.sql<{ id: string }[]>`insert into accounts (code, name, type) values ('2311', 'Made-up business card', 'liability') returning id`;
    await b.owner.post('/api/sources', { name: 'Made-up card', kind: 'card', accountId: cardAcc!.id });
    await b.owner.post('/api/journals', { date: b.current.start, description: 'Made-up VAT paid by card', lines: [{ accountId: await b.r.acc('vat'), debitCents: 50_000 }, { accountId: cardAcc!.id, creditCents: 50_000 }] });
    expect(await vat()).toMatchObject({ handVatLines: 0 });
    // And the forecast takes it as a payment (R1 500 less R500 for this period), not input VAT.
    expect(vatOf(await cashForecast(b.env.sql, now))).toEqual([{ date: vat201Due(b.current.end), cents: -100_000 }]);
    await b.owner.post('/api/journals', { date: b.current.start, description: 'Made-up cash sale', lines: [{ accountId: await b.r.acc('bank'), debitCents: 115_000 }, { accountId: await b.r.acc('revenue_other'), creditCents: 100_000 }, { accountId: await b.r.acc('vat'), creditCents: 15_000 }] });
    // A correction taking R40 off the VAT owed, against an expense: said apart from what's added.
    await b.owner.post('/api/journals', { date: b.current.start, description: 'Made-up VAT correction', lines: [{ accountId: await b.r.acc('vat'), debitCents: 4_000 }, { accountId: await b.r.acc('sundry'), creditCents: 4_000 }] });
    const v = await vat();
    expect(v).toMatchObject({ handVatAddedCents: 15_000, handVatOffCents: 4_000, handVatLines: 2 });
    // Not in the boxes: R1 500 on the invoice only.
    expect(v.fields.field20).toBe(150_000);
    const items = await expectCleanAudit(b.env.sql);
    expect(items.some((i) => i.level === 'warn' && /^journals by hand moved the VAT account in \S+ to \S+ \(R\s?150\.00 added to the VAT owed and R\s?40\.00 taken off it\), apart from what Shap can tell is a payment to or refund from SARS \(VAT against money or SARS’s other taxes; import VAT journalled against the bank, cash, a card or your own money looks the same, so it’s left out too\): Shap’s VAT201 is worked out from invoices, costs and assets, so it leaves them out/.test(i.text))).toBe(true);
    const screen = readFileSync(join(__dirname, '..', '..', '..', 'web', 'src', 'components', 'TaxForms.tsx'), 'utf8');
    expect(screen).toMatch(/added <Money cents=\{data\.handVatAddedCents!\} \/> to the VAT owed/);
    expect(screen).toMatch(/and took <Money cents=\{data\.handVatOffCents!\} \/> off it/);
    expect(screen).toMatch(/took <Money cents=\{data\.handVatOffCents!\} \/> off the VAT owed/);
    expect(screen).toMatch(/\(VAT against the bank, cash, a card, your own money or SARS’s other taxes, such as PAYE\), and import VAT journalled against the bank looks the same, so it isn’t counted here either\./);
    expect(screen).not.toMatch(/one paid together with other tax may still be counted/);
  });
});

describe('VAT: a refund SARS owes', () => {
  let b: Awaited<ReturnType<typeof vatBooks>>;
  beforeAll(async () => {
    b = await vatBooks();
  });
  afterAll(async () => {
    await expectCleanAudit(b.env.sql);
    await b.env.close();
  });

  it('isn’t taken off this period’s VAT', async () => {
    // Last period: R750 input VAT on parts, nothing invoiced (a R750 refund). This period: R900 invoiced. Nothing paid.
    await b.owner.post('/api/costs', { date: b.last.start, description: 'Made-up parts', supplier: 'Made-up Supplies', amountCents: 575_000, vatCents: 75_000, categoryId: await b.r.cat('Parts'), sourceId: b.bank });
    await b.invoice(b.current.start, 600_000);
    const f = await cashForecast(b.env.sql, now);
    expect(vatOf(f)).toEqual([{ date: vat201Due(b.current.end), cents: -90_000 }]);
  });

  it('while a payment made ahead for this period still comes off it', async () => {
    const j = await b.owner.post<{ id: string }>('/api/journals', { date: b.current.start, description: 'Made-up VAT paid ahead', lines: [{ accountId: await b.r.acc('vat'), debitCents: 40_000 }, { accountId: await b.r.acc('bank'), creditCents: 40_000 }] });
    const f = await cashForecast(b.env.sql, now);
    expect(vatOf(f)).toEqual([{ date: vat201Due(b.current.end), cents: -50_000 }]);
    await b.owner.call({ method: 'DELETE', url: `/api/journals/${j.id}` });
  });
});

describe('salaries, someone who has left', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
    const owner = await login(env.app, 'owner@example.co.za');
    const bank = await (await ref(env.sql)).src('Business bank');
    const { settings: s } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...s, features: { ...s.features, payroll: true } }, 'PUT');
    await owner.post('/api/employees', { name: 'Made-up Stays', salaryCents: 2_000_000, startDate: addMonths(thisMonth, -10) });
    await owner.post('/api/employees', { name: 'Made-up Leaves', salaryCents: 1_500_000, startDate: addMonths(thisMonth, -10) });
    for (const i of [-2, -1, 0]) {
      const run = await owner.post('/api/pay-runs', { period: addMonths(thisMonth, i).slice(0, 7), payDate: addDays(addMonths(thisMonth, i), 24), sourceId: bank });
      await owner.post(`/api/pay-runs/${run.id}/finalise`);
    }
    // The second leaves at the end of this month.
    await env.sql`update employees set end_date = ${monthEnd(thisMonth)}, active = false where name = 'Made-up Leaves'`;
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('projects only those a run for the month would take', async () => {
    const [stays] = await env.sql<{ net: number; sars: number }[]>`
      select l.net_cents::bigint as net, (l.paye_cents + l.uif_employee_cents + l.uif_employer_cents + l.sdl_cents)::bigint as sars
      from pay_lines l join pay_runs r on r.id = l.run_id join employees e on e.id = l.employee_id where r.period = ${thisMonth.slice(0, 7)} and e.name = 'Made-up Stays'`;
    const f = await cashForecast(env.sql, now);
    const pay = f.items.filter((x) => x.kind === 'payroll');
    expect(pay.length).toBeGreaterThan(0);
    for (const p of pay) expect(p.cents).toBe(-Number(stays!.net));
    const projected = f.items.filter((x) => x.kind === 'emp201' && /as your recent pay runs/.test(x.label));
    for (const p of projected) expect(p.cents).toBe(-Number(stays!.sars));
  });
});

describe('wages and dividends owed in the books beyond Shap’s own records', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
    const owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    const { settings: s } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...s, businessType: 'company', features: { ...s.features, workers: true } }, 'PUT');
    // Worker A is owed a day (R450); worker B was advanced R500.
    const a = await owner.post('/api/workers', { name: 'Made-up Worker A', dayRateCents: 40_000, allowanceCents: 5_000 });
    const b = await owner.post('/api/workers', { name: 'Made-up Worker B', dayRateCents: 40_000, allowanceCents: 5_000 });
    await owner.post('/api/labour', { date: addDays(now, -1), entries: [{ workerId: a.id, days: 1, wageCents: 40_000, allowanceCents: 5_000 }] });
    await owner.post('/api/wage-payments', { date: addDays(now, -1), workerId: b.id, amountCents: 50_000, sourceId: bank });
    // The accountant's journals: R300 of wages accrued, and a R50 000 dividend declared.
    await owner.post('/api/journals', { date: addDays(now, -1), description: 'Made-up wages accrued', lines: [{ accountId: await r.acc('general_labour'), debitCents: 30_000 }, { accountId: await r.acc('wages_payable'), creditCents: 30_000 }] });
    await owner.post('/api/journals', { date: addDays(now, -1), description: 'Made-up dividend declared', lines: [{ accountId: await r.acc('dividends'), debitCents: 5_000_000 }, { accountId: await r.acc('dividends_payable'), creditCents: 5_000_000 }] });
    // And a R1 000 dividend declared in Shap, not paid: counted once, not again as "other".
    await owner.post('/api/dividends', { declaredOn: addDays(now, -2), shareholder: 'Made-up Shareholder', grossCents: 100_000 });
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('puts them out this week, as if paid now', async () => {
    const f = await cashForecast(env.sql, now);
    // The books owe R250 in all (R450 + R300 − B's R500 advance, which may have paid the R300): A's
    // own R450 still goes out (round 3), and the R300 is taken as paid by the advance (fifth round).
    expect(out(f.items.filter((x) => x.kind === 'wages_owed'))).toBe(45_000);
    expect(out(f.items.filter((x) => x.kind === 'dividends'))).toBe(5_000_000 + 100_000);
    expect(f.items.filter((x) => x.kind === 'wages_owed' || x.kind === 'dividends').every((x) => x.date === now)).toBe(true);
    expect(f.items.find((x) => x.label.startsWith('Other dividends owed in the books'))!.cents).toBe(-5_000_000);
  });

  it('counts each worker’s wages with casual workers switched off too', async () => {
    const owner = await login(env.app, 'owner@example.co.za');
    const { settings: s } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...s, features: { ...s.features, workers: false } }, 'PUT');
    expect(out((await cashForecast(env.sql, now)).items.filter((x) => x.kind === 'wages_owed'))).toBe(45_000);
    await owner.post('/api/settings', { ...s, features: { ...s.features, workers: true } }, 'PUT');
  });
});

/** Made-up company books with casual workers on, for one scenario each. */
async function payoutBooks() {
  const env = await setup();
  const owner = await login(env.app, 'owner@example.co.za');
  const r = await ref(env.sql);
  const bank = await r.src('Business bank');
  const { settings: s } = await owner.get('/api/reference');
  await owner.post('/api/settings', { ...s, businessType: 'company', features: { ...s.features, workers: true } }, 'PUT');
  return { env, owner, r, bank };
}

describe('owed beyond Shap’s records, nothing counted twice (accounting, fifth round)', () => {
  it('names the wages account’s other amounts for the account', async () => {
    const b = await payoutBooks();
    try {
      await b.owner.post('/api/journals', { date: addDays(now, -1), description: 'Made-up wages accrued', lines: [{ accountId: await b.r.acc('general_labour'), debitCents: 30_000 }, { accountId: await b.r.acc('wages_payable'), creditCents: 30_000 }] });
      const f = await cashForecast(b.env.sql, now);
      // Named for the account, as a move-in may put PAYE or UIF owed on it (words review, fifth round).
      expect(f.items.filter((x) => x.kind === 'wages_owed')).toEqual([expect.objectContaining({ cents: -30_000, label: 'Other amounts owed on the wages account (from a journal or balances brought in, which may include PAYE or UIF), as if paid now' })]);
      await expectCleanAudit(b.env.sql);
    } finally {
      await b.env.close();
    }
  });

  it('takes a dividend declared in Shap and paid by a journal (ahead or already) as paid', async () => {
    const b = await payoutBooks();
    try {
      for (const sh of ['Made-up Paid Ahead', 'Made-up Paid Yesterday']) await b.owner.post('/api/dividends', { declaredOn: addDays(now, -5), shareholder: sh, grossCents: 1_000_000, exempt: true });
      await b.owner.post('/api/journals', { date: addDays(now, 5), description: 'Made-up dividend paid ahead', lines: [{ accountId: await b.r.acc('dividends_payable'), debitCents: 1_000_000 }, { accountId: await b.r.acc('bank'), creditCents: 1_000_000 }] });
      await b.owner.post('/api/journals', { date: addDays(now, -1), description: 'Made-up dividend paid yesterday', lines: [{ accountId: await b.r.acc('dividends_payable'), debitCents: 1_000_000 }, { accountId: await b.r.acc('bank'), creditCents: 1_000_000 }] });
      const f = await cashForecast(b.env.sql, now);
      expect(f.items.filter((x) => x.kind === 'dividends')).toEqual([]);
      expect(out(f.items.filter((x) => x.kind === 'booked'))).toBe(1_000_000);
      await expectCleanAudit(b.env.sql);
    } finally {
      await b.env.close();
    }
  });

  it('takes a day’s wages paid by a journal dated ahead as paid', async () => {
    const b = await payoutBooks();
    try {
      const w = await b.owner.post('/api/workers', { name: 'Made-up Worker C', dayRateCents: 40_000, allowanceCents: 5_000 });
      await b.owner.post('/api/labour', { date: addDays(now, -1), entries: [{ workerId: w.id, days: 1, wageCents: 40_000, allowanceCents: 5_000 }] });
      await b.owner.post('/api/journals', { date: addDays(now, 3), description: 'Made-up wages paid ahead', lines: [{ accountId: await b.r.acc('wages_payable'), debitCents: 45_000 }, { accountId: await b.r.acc('bank'), creditCents: 45_000 }] });
      const f = await cashForecast(b.env.sql, now);
      expect(f.items.filter((x) => x.kind === 'wages_owed')).toEqual([]);
      expect(out(f.items.filter((x) => x.kind === 'booked'))).toBe(45_000);
      await expectCleanAudit(b.env.sql);
    } finally {
      await b.env.close();
    }
  });

  it('takes wages brought in and then paid to the worker as paid', async () => {
    const b = await payoutBooks();
    try {
      await b.owner.post('/api/journals', { date: addDays(now, -10), description: 'Made-up wages brought in', lines: [{ accountId: await b.r.acc('retained_earnings'), debitCents: 30_000 }, { accountId: await b.r.acc('wages_payable'), creditCents: 30_000 }] });
      const w = await b.owner.post('/api/workers', { name: 'Made-up Worker D', dayRateCents: 40_000, allowanceCents: 5_000 });
      await b.owner.post('/api/wage-payments', { date: addDays(now, -2), workerId: w.id, amountCents: 30_000, sourceId: b.bank });
      const f = await cashForecast(b.env.sql, now);
      expect(f.items.filter((x) => x.kind === 'wages_owed')).toEqual([]);
      expect((await b.owner.get('/api/dashboard')).owedToWorkersCents).toBe(0);
      await expectCleanAudit(b.env.sql);
    } finally {
      await b.env.close();
    }
  });
});

describe('VAT: a refund SARS owes, with last period paid on time (SARS, fifth round)', () => {
  let b: Awaited<ReturnType<typeof vatBooks>>;
  beforeAll(async () => {
    b = await vatBooks();
  });
  afterAll(async () => {
    await expectCleanAudit(b.env.sql);
    await b.env.close();
  });

  it('isn’t taken off this period’s VAT by paying last period’s', async () => {
    // The period before last: a R750 refund SARS hasn't paid. Last: R3 000, paid at this period's
    // start. This period: R900. VAT201 field 20: −R750, R3 000, R900.
    const before = vatPeriod(addMonths(b.last.start, -1), 'C', (await b.owner.get('/api/reference')).settings.fyEndMonth);
    await b.owner.post('/api/costs', { date: before.start, description: 'Made-up parts', supplier: 'Made-up Supplies', amountCents: 575_000, vatCents: 75_000, categoryId: await b.r.cat('Parts'), sourceId: b.bank });
    await b.invoice(b.last.start, 2_000_000);
    await b.owner.post('/api/journals', { date: b.current.start, description: 'Made-up VAT paid on time', lines: [{ accountId: await b.r.acc('vat'), debitCents: 300_000 }, { accountId: await b.r.acc('bank'), creditCents: 300_000 }] });
    await b.invoice(b.current.start, 600_000);
    expect(vatOf(await cashForecast(b.env.sql, now))).toEqual([{ date: vat201Due(b.current.end), cents: -90_000 }]);
  });
});

describe('VAT: a refund SARS paid with interest (accounting, fifth round)', () => {
  let b: Awaited<ReturnType<typeof vatBooks>>;
  beforeAll(async () => {
    b = await vatBooks();
  });
  afterAll(async () => {
    await expectCleanAudit(b.env.sql);
    await b.env.close();
  });

  it('is a refund, not this period’s VAT, and not typed-in VAT on the VAT201', async () => {
    // Last period: R750 input VAT (a refund). Received at this period's start with R30 interest. This period: R900 invoiced.
    await b.owner.post('/api/costs', { date: b.last.start, description: 'Made-up parts', supplier: 'Made-up Supplies', amountCents: 575_000, vatCents: 75_000, categoryId: await b.r.cat('Parts'), sourceId: b.bank });
    await b.owner.post('/api/journals', { date: b.current.start, description: 'Made-up VAT refund with interest', lines: [{ accountId: await b.r.acc('bank'), debitCents: 78_000 }, { accountId: await b.r.acc('vat'), creditCents: 75_000 }, { accountId: await b.r.acc('interest_income'), creditCents: 3_000 }] });
    await b.invoice(b.current.start, 600_000);
    expect(vatOf(await cashForecast(b.env.sql, now))).toEqual([{ date: vat201Due(b.current.end), cents: -90_000 }]);
    expect(await b.owner.get(`/api/vat/return?on=${b.current.start}`)).toMatchObject({ handVatLines: 0 });
  });
});

describe('the forecast’s VAT on a busy year (security, fourth round)', () => {
  let b: Awaited<ReturnType<typeof vatBooks>>;
  beforeAll(async () => {
    b = await vatBooks();
  });
  afterAll(async () => {
    await expectCleanAudit(b.env.sql);
    await b.env.close();
  });

  it('reads the VAT lines in one pass, in good time, even before the database has counted them', async () => {
    // 4 000 made-up costs with VAT this period and last, paid from the bank.
    const parts = await b.r.cat('Parts');
    await b.env.sql`
      insert into costs (date, description, supplier, amount_cents, vat_cents, category_id, source_id)
      select (${b.last.start}::date + (g % 50)), 'Made-up part ' || g, 'Made-up Supplies', 11_500, 1_500, ${parts}, ${b.bank} from generate_series(1, 4000) g`;
    const t = Date.now();
    const f = await cashForecast(b.env.sql, now);
    // Freshly put in (the planner's counts not yet updated): a look-up per line took 20 s or more here.
    expect(Date.now() - t).toBeLessThan(3000);
    expect(f.items.some((x) => x.kind === 'vat')).toBe(false);
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'modules', 'forecast.ts'), 'utf8');
    expect(src).toMatch(/window w as \(partition by l\.source, l\.source_id, l\.date\)/);
    expect(src).not.toMatch(/where m\.source = l\.source and m\.source_id = l\.source_id/);
  });
});
