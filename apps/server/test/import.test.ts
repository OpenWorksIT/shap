import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDemoTracker } from '../src/db/demo-tracker.js';
import { today } from '../src/lib/books.js';
import { applyTracker, type ImportResult } from '../src/modules/import/apply.js';
import { readTracker, type TrackerPlan } from '../src/modules/import/tracker.js';
import { balance, ledgerTotal, login, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
let plan: TrackerPlan;
let result: ImportResult;
let totals: Awaited<ReturnType<typeof buildDemoTracker>>['totals'];

beforeAll(async () => {
  env = await setup();
  const built = await buildDemoTracker(today());
  totals = built.totals;
  plan = await readTracker(built.buffer);
  result = await applyTracker(env.sql, plan, { agreeTrialBalance: true });
});
afterAll(() => env.close());

describe('reading a tracker', () => {
  it('finds every job, cost, day and payment', () => {
    expect(plan.projects).toHaveLength(totals.projects);
    expect(plan.costs).toHaveLength(totals.costs);
    expect(plan.labour).toHaveLength(totals.labourDays);
    expect(plan.workers.map((w) => w.name).sort()).toEqual(['Lwazi', 'Sipho', 'Thabo']);
    expect(plan.markupBp).toBe(3500);
    expect(plan.trialBalance).toMatchObject({ bankCents: 1250000, ownerLoanCents: 2000000, shareCapitalCents: 10000 });
  });
  it('turns a casual row into a named casual worker', () => {
    expect(plan.workers.find((w) => w.name === 'Lwazi')?.kind).toBe('casual');
  });
});

describe('importing it', () => {
  it('keeps the ledger balanced', async () => {
    expect(await ledgerTotal(env.sql)).toBe(0);
  });

  it('agrees every job with the Per Project sheet', () => {
    expect(result.jobsChecked).toBe(totals.projects);
    expect(result.jobDifferences).toEqual([]);
  });

  it('agrees invoicing with the Trade Statement month by month', () => {
    for (const c of result.checks) expect(c.shap.invoicedCents).toBe(c.sheet.invoicedCents);
  });

  it('matches each worker’s earned and paid totals', async () => {
    const rows = await env.sql<{ name: string; earned: number; paid: number }[]>`
      select w.name, (select coalesce(sum(wage_cents + allowance_cents), 0) from labour_entries where worker_id = w.id)::bigint as earned,
             (select coalesce(sum(amount_cents), 0) from wage_payments where worker_id = w.id)::bigint as paid from workers w`;
    for (const r of rows) {
      const t = totals.wagesByWorker.get(r.name)!;
      expect(r.earned).toBe(Math.round(t.earned * 100));
      expect(r.paid).toBe(Math.round(t.paid * 100));
    }
  });

  it('agrees the closed year to its trial balance', async () => {
    const tb = plan.trialBalance!;
    expect(await balance(env.sql, 'bank', tb.date)).toBe(tb.bankCents);
    expect(await balance(env.sql, 'owner_loan', tb.date)).toBe(-tb.ownerLoanCents);
    expect(await balance(env.sql, 'share_capital', tb.date)).toBe(-tb.shareCapitalCents);
  });

  it('leaves costs with a blank account as not captured, instead of guessing what paid them', async () => {
    const blank = plan.costs.filter((c) => !c.account).length;
    expect(blank).toBeGreaterThan(0);
    const [r] = await env.sql<{ n: number; total: number }[]>`select count(*)::int as n, coalesce(sum(amount_cents), 0)::bigint as total from costs where source_id is null`;
    expect(r!.n).toBe(blank);
    expect(result.counts.uncapturedCosts).toBe(blank);
    expect(await balance(env.sql, 'uncaptured')).toBe(-r!.total);
  });

  it('continues invoice numbering after the last imported invoice', async () => {
    const [s] = await env.sql<{ invoiceNext: number; markupBp: number }[]>`select invoice_next, markup_bp from settings`;
    expect(s!.invoiceNext).toBe(totals.projects - 2 + 1);
    expect(s!.markupBp).toBe(3500);
  });

  it('puts labour without a job in the allocate list', async () => {
    const owner = await login(env.app, 'owner@example.co.za');
    const rows = await owner.get<unknown[]>('/api/labour/unallocated');
    expect(rows).toHaveLength(1);
  });

  it('refuses to import over existing data unless told to replace it', async () => {
    await expect(applyTracker(env.sql, plan)).rejects.toThrow(/already has jobs/);
    const again = await applyTracker(env.sql, plan, { replace: true });
    expect(again.counts.projects).toBe(totals.projects);
    expect(await ledgerTotal(env.sql)).toBe(0);
  });

  it('produces statements that balance', async () => {
    const owner = await login(env.app, 'owner@example.co.za');
    const tb = await owner.get(`/api/reports/trial-balance?date=${today()}`);
    expect(tb.totals.differenceCents).toBe(0);
    const bs = await owner.get(`/api/reports/balance-sheet?date=${today()}`);
    expect(bs.differenceCents).toBe(0);
  });
});
