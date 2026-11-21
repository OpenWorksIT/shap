import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addMonths, monthEnd, vat201Due, vatPeriod } from '@shap/shared';
import { handVat, today } from '../../src/lib/books.js';
import { cashForecast } from '../../src/modules/forecast.js';
import { expectCleanAudit, login, ref, sessionFor, setup, type TestEnv } from '../helpers.js';

// The sixth round of 1.33's reviews (accounting and arithmetic): typed-in VAT read once for each
// journal gives what reading it line by line gives; the forecast's VAT when VAT was paid ahead
// during the last period; leaving dates and the month cut; a cost type on the cash line; and
// payroll taxes brought in on SARS's own accounts. Made-up business, accounts and figures.

const now = today();
const thisMonth = `${now.slice(0, 8)}01`;
type Db = TestEnv['sql'];

/** handVat read line by line (as before 1.33's rewrite), with today's money accounts. */
async function oldHandVat(db: Db, start: string, end: string) {
  const [r] = await db<{ n: number; added: string; off: string }[]>`
    with money as (
      select id from accounts where statement_line in ('cash', 'bank_overdraft') or system_key in ('owner_loan', 'paye_payable', 'uif_payable', 'sdl_payable', 'income_tax_payable', 'dwt_payable')
      union select account_id from payment_sources where kind in ('bank', 'cash', 'card', 'owner')
    )
    select count(*)::int as n, coalesce(sum(jl.credit_cents), 0)::bigint as added, coalesce(sum(jl.debit_cents), 0)::bigint as off
    from journal_lines jl join journals j on j.id = jl.journal_id join accounts a on a.id = jl.account_id
    where a.system_key = 'vat' and j.kind in ('manual', 'adjustment') and j.date between ${start}::date and ${end}::date
      and not (
        exists (select 1 from journal_lines m where m.journal_id = j.id and m.account_id in (select id from money))
        and not exists (select 1 from journal_lines o join accounts oa on oa.id = o.account_id
                        where o.journal_id = j.id and oa.type not in ('expense', 'income') and coalesce(oa.system_key, '') <> 'vat' and o.account_id not in (select id from money))
        and coalesce((select sum(o.debit_cents + o.credit_cents) from journal_lines o join accounts oa on oa.id = o.account_id
                      where o.journal_id = j.id and oa.type in ('expense', 'income') and o.account_id not in (select id from money)), 0)
            < abs(jl.credit_cents - jl.debit_cents))`;
  return { lines: r?.n ?? 0, addedCents: Number(r?.added ?? 0), offCents: Number(r?.off ?? 0) };
}

describe('handVat: the one-pass query against the old one (made-up books)', () => {
  let env: TestEnv;
  let acc: Record<'vat' | 'bank' | 'ownerLoan' | 'revenue' | 'sundry' | 'retained' | 'cos' | 'interestExp' | 'interestInc' | 'card' | 'savings' | 'dual' | 'loan' | 'cashToo' | 'paye', string>;
  let userId: string;
  const start = addDays(now, -60);
  const end = addDays(now, -31);
  beforeAll(async () => {
    env = await setup();
    const owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const { settings } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4000000002', vatCategory: 'C' }, 'PUT');
    userId = (await env.sql<{ id: string }[]>`select id from users where email = 'owner@example.co.za'`)[0]!.id;
    const mk = async (code: string, name: string, type: string, line?: string) =>
      (await owner.post<{ id: string }>('/api/accounts', { code, name, type, ...(line ? { statementLine: line } : {}), active: true })).id;
    acc = {
      vat: await r.acc('vat'),
      bank: await r.acc('bank'),
      ownerLoan: await r.acc('owner_loan'),
      revenue: await r.acc('revenue_other'),
      sundry: await r.acc('sundry'),
      retained: await r.acc('retained_earnings'),
      cos: await r.acc('cos_materials'),
      interestExp: await mk('6955', 'Made-up SARS interest', 'expense', 'finance_costs'),
      interestInc: await mk('4955', 'Made-up interest received', 'income', 'finance_income'),
      card: await mk('2955', 'Made-up business card', 'liability'),
      savings: await mk('1955', 'Made-up savings', 'asset'),
      dual: await mk('1956', 'Made-up account paid from two ways', 'asset'),
      loan: await mk('2956', 'Made-up loan', 'liability', 'borrowings_current'),
      cashToo: await mk('1957', 'Made-up second current account', 'asset', 'cash'),
      paye: await r.acc('paye_payable'),
    };
    await owner.post('/api/sources', { name: 'Made-up card', kind: 'card', accountId: acc.card });
    await owner.post('/api/sources', { name: 'Made-up savings', kind: 'bank', accountId: acc.savings });
    // One account, a payment source of two kinds.
    await owner.post('/api/sources', { name: 'Made-up two-way bank', kind: 'bank', accountId: acc.dual });
    await owner.post('/api/sources', { name: 'Made-up two-way card', kind: 'card', accountId: acc.dual });
    // An account on the cash line that's also a payment source (twice, of two kinds).
    await owner.post('/api/sources', { name: 'Made-up current', kind: 'bank', accountId: acc.cashToo });
    await owner.post('/api/sources', { name: 'Made-up current till', kind: 'cash', accountId: acc.cashToo });
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  const journal = async (date: string, kind: string, lines: [string, number][]) => {
    const [j] = await env.sql<{ id: string }[]>`insert into journals (date, description, reference, kind, created_by) values (${date}, 'Made-up', '', ${kind}, ${userId}) returning id`;
    await env.sql`insert into journal_lines ${env.sql(lines.map(([a, c]) => ({ journalId: j!.id, accountId: a, debitCents: c > 0 ? c : 0, creditCents: c < 0 ? -c : 0, memo: '' })))}`;
    expect(lines.reduce((t, [, c]) => t + c, 0)).toBe(0);
  };
  const same = async (s = start, e = end) => {
    const [a, b] = [await oldHandVat(env.sql, s, e), await handVat(env.sql, s, e)];
    expect(b).toEqual(a);
    return b;
  };

  it('agrees on each kind of journal, and each gives what it should', async () => {
    const d = addDays(start, 3);
    const cases: { what: string; lines: [string, number][]; counted: { lines: number; added: number; off: number } }[] = [
      { what: 'VAT paid from the bank', lines: [[acc.vat, 100_000], [acc.bank, -100_000]], counted: { lines: 0, added: 0, off: 0 } },
      { what: 'several VAT lines paid at once', lines: [[acc.vat, 30_000], [acc.vat, 20_000], [acc.bank, -50_000]], counted: { lines: 0, added: 0, off: 0 } },
      // Per line: R100 interest is under the R300 line but not under the R50 one.
      { what: 'several VAT lines with SARS interest', lines: [[acc.vat, 30_000], [acc.vat, 5_000], [acc.interestExp, 10_000], [acc.bank, -45_000]], counted: { lines: 1, added: 0, off: 5_000 } },
      { what: 'VAT on both sides, against the bank', lines: [[acc.vat, 80_000], [acc.vat, -30_000], [acc.bank, -50_000]], counted: { lines: 0, added: 0, off: 0 } },
      { what: 'VAT on both sides, alone', lines: [[acc.vat, 40_000], [acc.vat, -40_000]], counted: { lines: 2, added: 40_000, off: 40_000 } },
      { what: 'from an account on the cash line that is two payment sources', lines: [[acc.vat, 60_000], [acc.interestExp, 1_000], [acc.cashToo, -61_000]], counted: { lines: 0, added: 0, off: 0 } },
      { what: 'from an account that is a payment source of two kinds', lines: [[acc.vat, 70_000], [acc.interestExp, 2_000], [acc.dual, -72_000]], counted: { lines: 0, added: 0, off: 0 } },
      { what: 'refund with interest', lines: [[acc.bank, 78_000], [acc.vat, -75_000], [acc.interestInc, -3_000]], counted: { lines: 0, added: 0, off: 0 } },
      { what: 'income and expense beside the VAT (a cash sale with a fee)', lines: [[acc.bank, 113_000], [acc.sundry, 2_000], [acc.revenue, -100_000], [acc.vat, -15_000]], counted: { lines: 1, added: 15_000, off: 0 } },
      { what: 'paid by card', lines: [[acc.vat, 9_000], [acc.card, -9_000]], counted: { lines: 0, added: 0, off: 0 } },
      { what: 'paid personally', lines: [[acc.vat, 8_000], [acc.ownerLoan, -8_000]], counted: { lines: 0, added: 0, off: 0 } },
      { what: 'paid with PAYE (SARS, sixth round)', lines: [[acc.vat, 8_000], [acc.paye, 2_000], [acc.bank, -10_000]], counted: { lines: 0, added: 0, off: 0 } },
      { what: 'a refund set off against PAYE (SARS, sixth round)', lines: [[acc.bank, 2_000], [acc.paye, 5_000], [acc.vat, -7_000]], counted: { lines: 0, added: 0, off: 0 } },
      { what: 'something else beside it (a loan)', lines: [[acc.vat, 7_000], [acc.bank, -3_000], [acc.loan, -4_000]], counted: { lines: 1, added: 0, off: 7_000 } },
      { what: 'cost of sales beside it (not expense or income)', lines: [[acc.vat, 6_000], [acc.cos, 100], [acc.bank, -6_100]], counted: { lines: 1, added: 0, off: 6_000 } },
      { what: 'against an expense, no money', lines: [[acc.vat, 4_000], [acc.sundry, -4_000]], counted: { lines: 1, added: 0, off: 4_000 } },
    ];
    for (const c of cases) {
      await env.sql`delete from journals where kind in ('manual', 'adjustment')`;
      await journal(d, 'manual', c.lines);
      const got = await same();
      expect({ what: c.what, lines: got.lines, added: got.addedCents, off: got.offCents }).toEqual({ what: c.what, ...c.counted });
    }
    // An adjustment counts; opening balances and imports don't; a journal outside the period doesn't.
    await env.sql`delete from journals where kind in ('manual', 'adjustment')`;
    await journal(d, 'adjustment', [[acc.vat, -1_000], [acc.retained, 1_000]]);
    await journal(d, 'opening', [[acc.vat, -2_000], [acc.retained, 2_000]]);
    await journal(d, 'import', [[acc.vat, -3_000], [acc.retained, 3_000]]);
    await journal(addDays(start, -1), 'manual', [[acc.vat, -4_000], [acc.retained, 4_000]]);
    await journal(addDays(end, 1), 'manual', [[acc.vat, -5_000], [acc.retained, 5_000]]);
    expect(await same()).toEqual({ lines: 1, addedCents: 1_000, offCents: 0 });
    await env.sql`delete from journals where kind in ('manual', 'adjustment', 'opening', 'import')`;
  });

  it('agrees on 400 made-up journals of random lines, over many periods', async () => {
    // A seeded generator: the same made-up books every run.
    let seed = 20261121;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
    const pool = Object.values(acc);
    const kinds = ['manual', 'manual', 'manual', 'adjustment', 'opening', 'import'];
    for (let i = 0; i < 400; i++) {
      const lines: [string, number][] = [];
      const n = 1 + Math.floor(rnd() * 5);
      // Most journals have VAT on them, some on both sides.
      if (rnd() < 0.85) lines.push([acc.vat, (rnd() < 0.5 ? 1 : -1) * (1 + Math.floor(rnd() * 100_000))]);
      if (rnd() < 0.2) lines.push([acc.vat, (rnd() < 0.5 ? 1 : -1) * (1 + Math.floor(rnd() * 100_000))]);
      for (let k = 0; k < n; k++) lines.push([pick(pool), (rnd() < 0.5 ? 1 : -1) * (1 + Math.floor(rnd() * (rnd() < 0.3 ? 2_000 : 200_000)))]);
      const t = lines.reduce((s, [, c]) => s + c, 0);
      if (t !== 0) lines.push([pick(pool.filter((a) => a !== acc.vat)), -t]);
      if (lines.length < 2) continue;
      await journal(addDays(now, -Math.floor(rnd() * 240)), pick(kinds), lines);
    }
    let counted = 0;
    for (let m = 0; m < 8; m++) {
      const p = vatPeriod(addMonths(thisMonth, -m), 'C', 2);
      counted += (await same(p.start, p.end)).lines;
    }
    await same(addDays(now, -240), now);
    await same(addDays(now, -100), addDays(now, -100));
    expect(counted).toBeGreaterThan(50);
  });
});

/** Made-up books on VAT category C (monthly). */
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
  const invoice = async (date: string, cents: number) => {
    const inv = await owner.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: date, dueDate: addDays(now, 200), lines: [{ category: 'labour', description: 'Work', qty: 1, unitPriceCents: cents }] });
    await owner.post(`/api/documents/${inv.id}/issue`);
  };
  const payVat = async (date: string, cents: number) =>
    owner.post('/api/journals', { date, description: 'Made-up VAT paid', lines: [{ accountId: await r.acc('vat'), debitCents: cents }, { accountId: await r.acc('bank'), creditCents: cents }] });
  return { env, owner, r, bank, current, last, before, invoice, payVat };
}
const vatOf = (f: Awaited<ReturnType<typeof cashForecast>>) => f.items.filter((x) => x.kind === 'vat').map((x) => ({ date: x.date, cents: x.cents }));

describe('forecast VAT: paid ahead during the last period, then last period paid in full again', () => {
  let b: Awaited<ReturnType<typeof vatBooks>>;
  beforeAll(async () => {
    b = await vatBooks();
  });
  afterAll(async () => {
    await expectCleanAudit(b.env.sql);
    await b.env.close();
  });

  it('takes what was paid beyond what was owed at this period’s start off this period', async () => {
    // Before last: R1 500 VAT. Last: R1 500 VAT, and R2 500 paid during it (R1 500 for the period
    // before, R1 000 on account). So R500 is owed when this period begins. This period: R1 500 paid
    // at its start (last period's in full, again), and R900 invoiced. The business is R100 ahead:
    // nothing more to pay for this period (as forecast.ts's own words say: a payment beyond what
    // the ended periods owed comes off this period's).
    await b.invoice(b.before.start, 1_000_000);
    await b.invoice(b.last.start, 1_000_000);
    await b.payVat(addDays(b.last.start, 1), 250_000);
    await b.payVat(b.current.start, 150_000);
    await b.invoice(b.current.start, 600_000);
    const owed = -(await b.env.sql<{ t: number }[]>`select coalesce(sum(l.amount_cents), 0)::bigint as t from ledger l join accounts a on a.id = l.account_id where a.system_key = 'vat' and l.date <= ${now}::date`)[0]!.t;
    expect(Number(owed)).toBe(-10_000);
    expect(vatOf(await cashForecast(b.env.sql, now))).toEqual([]);
  });
});

describe('forecast VAT: arithmetic that holds', () => {
  it('a payment larger than what was owed, and a period with nothing in it', async () => {
    const b = await vatBooks();
    try {
      // Nothing at all: nothing said.
      expect(vatOf(await cashForecast(b.env.sql, now))).toEqual([]);
      // Last: R1 500 owed; paid R2 000 at this period's start; this period R900: R500 comes off it.
      await b.invoice(b.last.start, 1_000_000);
      await b.payVat(b.current.start, 200_000);
      await b.invoice(b.current.start, 600_000);
      expect(vatOf(await cashForecast(b.env.sql, now))).toEqual([{ date: vat201Due(b.current.end), cents: -40_000 }]);
      await expectCleanAudit(b.env.sql);
    } finally {
      await b.env.close();
    }
  });

  it('a refund owed for the period before last, and that period’s older debt paid', async () => {
    const b = await vatBooks();
    try {
      // Before last: R1 500 owed. Last: a R750 refund (input VAT only). This period: the R1 500 paid,
      // and R900 invoiced. The refund isn't set off by Shap: R900 on this period's VAT201.
      await b.invoice(b.before.start, 1_000_000);
      await b.owner.post('/api/costs', { date: b.last.start, description: 'Made-up parts', supplier: 'Made-up Supplies', amountCents: 575_000, vatCents: 75_000, categoryId: await b.r.cat('Parts'), sourceId: b.bank });
      await b.payVat(b.current.start, 150_000);
      await b.invoice(b.current.start, 600_000);
      expect(vatOf(await cashForecast(b.env.sql, now))).toEqual([{ date: vat201Due(b.current.end), cents: -90_000 }]);
      await expectCleanAudit(b.env.sql);
    } finally {
      await b.env.close();
    }
  });
});

describe('the forecast and a leaving date of today, and the month cut', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
    const owner = await login(env.app, 'owner@example.co.za');
    const bank = await (await ref(env.sql)).src('Business bank');
    const { settings: s } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...s, features: { ...s.features, payroll: true } }, 'PUT');
    await owner.post('/api/employees', { name: 'Made-up Stays', salaryCents: 2_000_000, startDate: addMonths(thisMonth, -10) });
    await owner.post('/api/employees', { name: 'Made-up Going', salaryCents: 1_500_000, startDate: addMonths(thisMonth, -10) });
    for (const i of [-3, -2, -1]) {
      const run = await owner.post('/api/pay-runs', { period: addMonths(thisMonth, i).slice(0, 7), payDate: addDays(addMonths(thisMonth, i), 24), sourceId: bank });
      await owner.post(`/api/pay-runs/${run.id}/finalise`);
    }
    await owner.post('/api/users', { name: 'Reports only (made up)', email: 'reports@example.co.za', role: 'staff', profileId: null, access: ['labour.view', 'reports.view'], password: 'test-password-1' });
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });
  const salaries = (f: { items: { kind: string; cents: number; label: string }[] }) => f.items.filter((x) => x.kind === 'payroll').map((x) => x.cents);

  it('leaving today: the owner and someone without payroll see the same', async () => {
    await env.sql`update employees set end_date = ${now} where name = 'Made-up Going'`;
    const a = salaries(await cashForecast(env.sql, now, { people: true }));
    const b = salaries(await cashForecast(env.sql, now, { people: false }));
    expect(b).toEqual(a);
    // This month's run (the next) still takes them; later ones don't.
    expect(Math.abs(a[1]!)).toBeLessThan(Math.abs(a[0]!));
    expect(new Set(a.slice(1)).size).toBe(1);
  });

  it('leaving later this month: counted to the end for the one who can’t see payroll', async () => {
    const later = monthEnd(thisMonth) > now ? monthEnd(thisMonth) : null;
    if (!later) return;
    await env.sql`update employees set end_date = ${later} where name = 'Made-up Going'`;
    const a = salaries(await cashForecast(env.sql, now, { people: true }));
    const b = salaries(await cashForecast(env.sql, now, { people: false }));
    expect(b[0]).toBe(a[0]);
    expect(new Set(b).size).toBe(1);
    expect(Math.abs(a[1]!)).toBeLessThan(Math.abs(a[0]!));
  });
});

describe('moving payment sources and cost types: what the cash-line count catches', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  let r: Awaited<ReturnType<typeof ref>>;
  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
    r = await ref(env.sql);
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });
  const cash = async () => (await owner.get('/api/dashboard')).cash.inBankCents as number;
  const put = (path: string, id: string, body: unknown) => owner.call({ method: 'PUT', url: `/api/${path}/${id}`, payload: body as never });

  it('lets a used one move between two accounts on the cash line, and an unused one anywhere', async () => {
    const bank = await r.src('Business bank');
    await owner.post('/api/costs', { date: addDays(now, -3), description: 'Made-up fuel', supplier: 'Made-up Garage', amountCents: 50_000, categoryId: await r.cat('Petrol'), sourceId: bank });
    const before = await cash();
    const two = await owner.post<{ id: string }>('/api/accounts', { code: '1074', name: 'Made-up Second Bank', type: 'asset', statementLine: 'cash', active: true });
    expect((await put('sources', bank, { name: 'Business bank', kind: 'bank', accountId: two.id })).statusCode).toBe(200);
    expect(await cash()).toBe(before);
    const off = await owner.post<{ id: string }>('/api/accounts', { code: '1079', name: 'Made-up Fixed Deposit', type: 'asset', active: true });
    const unused = await owner.post<{ id: string }>('/api/sources', { name: 'Made-up unused', kind: 'bank', accountId: await r.acc('bank') });
    expect((await put('sources', unused.id, { name: 'Made-up unused', kind: 'bank', accountId: off.id })).statusCode).toBe(200);
    await env.sql`delete from payment_sources where id = ${unused.id}`;
    // Back where it was, for what follows.
    expect((await put('sources', bank, { name: 'Business bank', kind: 'bank', accountId: await r.acc('bank') })).statusCode).toBe(200);
  });

  it('a cost type on an account on the cash line can’t move its history off it unasked', async () => {
    // A made-up cost type for topping up the petty cash from the bank: Cash on hand (1050) is on the cash line.
    const [petty] = await env.sql<{ id: string; line: string }[]>`select id, statement_line as line from accounts where code = '1050'`;
    expect(petty!.line).toBe('cash');
    const cat = await owner.post<{ id: string }>('/api/categories', { name: 'Made-up petty cash top-up', kind: 'overhead', accountId: petty!.id });
    await owner.post('/api/costs', { date: addDays(now, -2), description: 'Made-up top-up', supplier: '', amountCents: 20_000, categoryId: cat.id, sourceId: await r.src('Business bank') });
    const before = await cash();
    const res = await put('categories', cat.id, { name: 'Made-up petty cash top-up', kind: 'overhead', accountId: await r.acc('sundry') });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/otherwise add a new one under Cost types for what’s coming\.$/);
    expect(await cash()).toBe(before);
  });
});

describe('payroll taxes owed when moving in, now on SARS’s own accounts (fifth round’s move-in change)', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
    const owner = await login(env.app, 'owner@example.co.za');
    const { settings: s } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...s, businessType: 'company', features: { ...s.features, payroll: true } }, 'PUT');
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('still forecasts last month’s EMP201 brought in on PAYE, UIF and SDL payable', async () => {
    const r = await ref(env.sql);
    const [u] = await env.sql<{ id: string }[]>`select id from users where email = 'owner@example.co.za'`;
    // Made-up opening balances ten days ago, as move-in now suggests them: last month's EMP201 of
    // R15 000 owed (R12 000 PAYE, R2 000 UIF, R1 000 SDL), not paid yet.
    const [j] = await env.sql<{ id: string }[]>`insert into journals (date, description, reference, kind, created_by) values (${addDays(now, -10)}, 'Made-up opening balances', 'Moved in', 'opening', ${u!.id}) returning id`;
    await env.sql`insert into journal_lines ${env.sql([
      { journalId: j!.id, accountId: await r.acc('retained_earnings'), debitCents: 1_500_000, creditCents: 0, memo: '' },
      { journalId: j!.id, accountId: await r.acc('paye_payable'), debitCents: 0, creditCents: 1_200_000, memo: '' },
      { journalId: j!.id, accountId: await r.acc('uif_payable'), debitCents: 0, creditCents: 200_000, memo: '' },
      { journalId: j!.id, accountId: await r.acc('sdl_payable'), debitCents: 0, creditCents: 100_000, memo: '' },
    ])}`;
    const f = await cashForecast(env.sql, now);
    const out = -f.items.filter((x) => x.cents < 0).reduce((t, x) => t + x.cents, 0);
    // Before the fifth round, move-in put these on Wages owed, and the forecast paid them this week.
    expect(out).toBe(1_500_000);
  });
});
