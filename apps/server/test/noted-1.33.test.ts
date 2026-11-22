/**
 * What the 1.33 CPD audit noted and didn't change (CPDAUDIT.md), now fixed: the figures, the
 * forecast's gaps, and the checks and logging. Each fails without its fix. Made-up business and
 * figures.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addBusinessDays, addDays, addMonths, vat201Due, vatPeriod, VAT_CATEGORIES, type VatCategory } from '@shap/shared';
import { today } from '../src/lib/books.js';
import { cashForecast } from '../src/modules/forecast.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from './helpers.js';

const now = today();
type F = Awaited<ReturnType<typeof cashForecast>>;
const vatOf = (f: F) => f.items.filter((x) => x.kind === 'vat').map((x) => ({ date: x.date, cents: x.cents }));
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

describe('the forecast’s VAT (figures)', () => {
  // An older refund (R10 500) came in during the last period, after the older debt beside it
  // (R4 500) was paid: the balance before the last period nets them (R6 000). The last period owes
  // R5 100, this one is a R2 100 refund. The R4 500 more that came in isn’t this period’s refund
  // (or the last period’s): the last period’s R5 100 is still owed.
  it('an older refund paid during the last period doesn’t come off what the last period owes', async () => {
    const b = await vatBooks('C');
    try {
      await b.output(b.older.start, 450_000);
      await b.input(b.before.start, 1_050_000);
      await b.sars(addDays(b.last.start, 2), 450_000);
      await b.sars(addDays(b.last.start, 4), -1_050_000);
      await b.output(b.last.start, 510_000);
      await b.input(b.current.start, 210_000);
      const f = await cashForecast(b.env.sql, now);
      expect(vatOf(f)).toEqual([{ date: due(vat201Due(b.last.end)), cents: -510_000 }]);
      await expectCleanAudit(b.env.sql);
    } finally {
      await b.env.close();
    }
  });

  // R6 000 overdue from before; the last period a R4 000 refund, nothing came in: once SARS has had
  // it to pay (21 business days after its VAT201 was due) it keeps the whole refund against the
  // debt (TAA s191), so R2 000 is owed, not R6 000.
  const kept = VAT_CATEGORIES.find((c) => {
    const cur = vatPeriod(now, c, 2);
    const last = vatPeriod(addMonths(cur.start, -1), c, 2);
    return addBusinessDays(vat201Due(last.end), 21) < now && vat201Due(vatPeriod(addMonths(last.start, -1), c, 2).end) < now;
  });
  it.skipIf(!kept)('a refund SARS keeps whole against an overdue debt comes off it', async () => {
    const b = await vatBooks(kept!);
    try {
      await b.output(b.before.start, 600_000);
      await b.input(b.last.start, 400_000);
      const f = await cashForecast(b.env.sql, now);
      expect(vatOf(f)).toEqual([{ date: now, cents: -200_000 }]);
      expect(f.items.find((x) => x.kind === 'vat')!.label).toMatch(/less the refund of R\s?4 000\.00 SARS keeps against it/);
      await expectCleanAudit(b.env.sql);
    } finally {
      await b.env.close();
    }
  });
});

describe('the forecast’s dividends tax and workers’ advances', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('forecasts dividends tax brought in, beyond the DTR01s', async () => {
    const owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const { settings: s } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...s, businessType: 'company' }, 'PUT');
    await owner.post('/api/journals', { date: addDays(now, -3), description: 'Made-up dividends tax brought in', lines: [{ accountId: await r.acc('retained_earnings'), debitCents: 150_000 }, { accountId: await r.acc('dwt_payable'), creditCents: 150_000 }] });
    const f = await cashForecast(env.sql, now);
    const dwt = f.items.filter((x) => x.kind === 'dwt');
    expect(dwt).toEqual([expect.objectContaining({ date: now, cents: -150_000 })]);
    expect(dwt[0]!.label).toMatch(/^Dividends tax owed in the books/);
  });

  it('nets an advance only when it was paid since the amount came onto the wages account', async () => {
    const owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    const { settings: s } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...s, features: { ...s.features, workers: true } }, 'PUT');
    const w = await owner.post('/api/workers', { name: 'Made-up Advanced', dayRateCents: 40_000, allowanceCents: 0 });
    // A R1 000 advance a month ago; R3 000 of wages brought in a week ago: the advance can't have paid it.
    await owner.post('/api/wage-payments', { date: addDays(now, -30), workerId: w.id, amountCents: 100_000, sourceId: bank });
    await owner.post('/api/journals', { date: addDays(now, -7), description: 'Made-up wages brought in', lines: [{ accountId: await r.acc('general_labour'), debitCents: 300_000 }, { accountId: await r.acc('wages_payable'), creditCents: 300_000 }] });
    const other = (f: F) => f.items.find((x) => x.label.startsWith('Other amounts owed on the wages account'))?.cents ?? 0;
    expect(other(await cashForecast(env.sql, now))).toBe(-300_000);
    // Another R500 paid to them since: it may have paid some of it.
    await owner.post('/api/wage-payments', { date: addDays(now, -2), workerId: w.id, amountCents: 50_000, sourceId: bank });
    expect(other(await cashForecast(env.sql, now))).toBe(-250_000);
  });
});

describe('checks and logging', () => {
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

  it('checks the cost’s own date when an asset is made from it (figures)', async () => {
    const lock = addDays(now, -40);
    const cost = await owner.post<{ id: string }>('/api/costs', { date: addDays(lock, -5), description: 'Made-up drill', supplier: 'Made-up Tools', amountCents: 230_000, categoryId: await r.cat('Parts'), sourceId: await r.src('Business bank') });
    await env.sql`update settings set lock_date = ${lock}::date where id`;
    try {
      const res = await owner.call({ method: 'POST', url: '/api/assets', payload: { name: 'Made-up drill', category: 'tools', purchaseDate: addDays(now, -1), costCents: 1, costId: cost.id, lifeMonths: 36 } });
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/The books are closed up to/);
    } finally {
      await env.sql`update settings set lock_date = null where id`;
    }
  });

  it('logs what a cost type’s change of kind moves out of work in progress', async () => {
    const [cat] = await env.sql<{ id: string; name: string; accountId: string }[]>`select id, name, account_id from cost_categories where kind = 'materials' order by sort limit 1`;
    const client = await owner.post<{ id: string }>('/api/clients', { name: 'Made-up Job Client', address: '2 Made-up Street, Fictional Town' });
    const job = await owner.post<{ id: string }>('/api/projects', { name: 'Made-up open job', clientId: client.id });
    await owner.post('/api/costs', { date: addDays(now, -3), description: 'Made-up timber', supplier: 'Made-up Timber', amountCents: 80_000, categoryId: cat!.id, projectId: job.id, sourceId: await r.src('Business bank') });
    const res = await owner.call({ method: 'PUT', url: `/api/categories/${cat!.id}`, payload: { name: cat!.name, kind: 'overhead', accountId: cat!.accountId, active: true } });
    expect(res.statusCode).toBe(200);
    const [row] = await env.sql<{ details: { kindFrom: string; kindTo: string; posted: { account: { name: string }; cents: number }[] } }[]>`
      select details from audit_log where action = 'kind_changed' and entity_id = ${cat!.id}`;
    expect(row!.details).toMatchObject({ kindFrom: 'materials', kindTo: 'overhead' });
    const wip = row!.details.posted.find((p) => /work in progress/i.test(p.account.name));
    expect(wip?.cents).toBe(-80_000);
    expect(row!.details.posted.reduce((t, p) => t + p.cents, 0)).toBe(0);
    await owner.call({ method: 'PUT', url: `/api/categories/${cat!.id}`, payload: { name: cat!.name, kind: 'materials', accountId: cat!.accountId, active: true } });
  });

  it('refuses moving a used payment account’s history between two lines off cash, or from cash to the overdraft line', async () => {
    const holding = await owner.post<{ id: string }>('/api/accounts', { code: '1081', name: 'Made-up Holding', type: 'asset', active: true, statementLine: 'other_current_assets' });
    const deposit = await owner.post<{ id: string }>('/api/accounts', { code: '1082', name: 'Made-up Deposit', type: 'asset', active: true, statementLine: 'investments' });
    const src = await owner.post<{ id: string }>('/api/sources', { name: 'Made-up holding account', kind: 'bank', accountId: holding.id });
    await owner.post('/api/costs', { date: addDays(now, -2), description: 'Made-up fee', supplier: 'Made-up Bank', amountCents: 5_000, categoryId: await r.cat('Bank'), sourceId: src.id });
    const move = async (id: string, accountId: string, name: string) => owner.call({ method: 'PUT', url: `/api/sources/${id}`, payload: { name, kind: 'bank', accountId } });
    const a = await move(src.id, deposit.id, 'Made-up holding account');
    expect(a.statusCode).toBe(400);
    expect(a.json().error).toMatch(/^What’s already captured with this would move from the statements’ .+ line to .+ with it\. If the account it’s on now is on the wrong line, change that account’s line instead/);
    const overdraft = await owner.post<{ id: string }>('/api/accounts', { code: '2091', name: 'Made-up Overdraft', type: 'liability', active: true, statementLine: 'bank_overdraft' });
    const bank = await r.src('Business bank');
    await owner.post('/api/costs', { date: addDays(now, -2), description: 'Made-up fuel', supplier: 'Made-up Garage', amountCents: 40_000, categoryId: await r.cat('Petrol'), sourceId: bank });
    const b = await move(bank, overdraft.id, 'Business bank');
    expect(b.statusCode).toBe(400);
    expect(b.json().error).toMatch(/would move from the statements’ .+ line to .+ with it/);
    // Nothing captured with it yet: it moves.
    const unused = await owner.post<{ id: string }>('/api/sources', { name: 'Made-up unused', kind: 'bank', accountId: holding.id });
    expect((await move(unused.id, deposit.id, 'Made-up unused')).statusCode).toBe(200);
  });
});
