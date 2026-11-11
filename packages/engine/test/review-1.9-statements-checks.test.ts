/**
 * The statements' checks Shap 1.25's IFRS review asked for, in Shap Pocket (Shap's CPDAUDIT.md section 7; the same accounting code here): going concern for
 * every kind of business (IFRS for SMEs 3.8), distributions declared after the year end (32.8,
 * 32.10), stock on hand when Shap doesn't keep the stock (13.4), and the statement of changes in
 * equity naming a CC's, trust's or co-op's capital for what it is. All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildStatements } from '../src/statements/build.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from './helpers.js';

const FY = '2026-02-28';

async function business(env: TestEnv, businessType: string, features: Record<string, boolean> = {}) {
  const me = await login(env.app);
  const { settings } = await me.get('/api/reference');
  const { termsAcceptedAt: _t, logoId: _l, ...rest } = settings;
  await me.post('/api/settings', { ...rest, companyName: 'Fictional Works (made up)', businessType, fyEndMonth: 2, features: { ...settings.features, statements: true, dividends: true, ...features } }, 'PUT');
  return me;
}

describe('a company in deficit and overdrawn, with a dividend declared after the year end', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
    const me = await business(env, 'company', { sales: true, inventory: false });
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    await me.post('/api/journals', { date: '2025-03-01', description: 'Shares issued (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 100_000 }, { accountId: await r.acc('share_capital'), creditCents: 100_000 }] });
    await me.post('/api/costs', { date: '2025-06-01', description: 'Rent (made up)', amountCents: 5_000_000, vatCents: 0, vatCode: 'exempt', categoryId: await r.cat('Sundry'), sourceId: bank });
    // After the year end: money in, then a dividend.
    await me.post('/api/journals', { date: '2026-04-01', description: 'Loan from the shareholder (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 10_000_000 }, { accountId: await r.acc('owner_loan'), creditCents: 10_000_000 }] });
    await me.post('/api/dividends', { declaredOn: '2026-05-15', paidOn: '2026-05-15', shareholder: 'Fictional Owner', grossCents: 1_000_000, sourceId: bank });
  });
  afterAll(async () => env.close());

  it('asks the directors to assess going concern, mentions the later dividend, and the stock count', async () => {
    const s = await buildStatements(env.sql, FY);
    const look = (start: string) => s.checks.find((c) => c.label.startsWith(start));
    const gc = look('The business is a going concern')!;
    expect(gc.ok).toBe(false);
    expect(gc.detail).toMatch(/Liabilities exceed assets.*the bank is overdrawn/);
    expect(gc.detail).toMatch(/s128/);
    const later = look('Distributions declared after the year end')!;
    expect(later.ok).toBe(false);
    expect(later.detail).toMatch(/R\s?10 000/);
    expect(look('Stock on hand at the year end is in the books')!.ok).toBe(false);
    expect(gc.detail).toMatch(/check, not an opinion.*accountant/);
    // The year before: that dividend is more than a year after its end, so not this year's to mention.
    const before = await buildStatements(env.sql, '2025-02-28');
    expect(before.checks.find((c) => c.label.startsWith('Distributions declared after the year end'))).toBeUndefined();
    await expectCleanAudit(env.sql);
  });
});

describe('a sole proprietor overdrawn, and a CC in deficit with money in the bank', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => env.close());

  it('the owner assesses it (and a sole proprietor has no business rescue)', async () => {
    const me = await business(env, 'sole_prop');
    const r = await ref(env.sql);
    await me.post('/api/costs', { date: '2025-06-01', description: 'Rent (made up)', amountCents: 2_000_000, vatCents: 0, vatCode: 'exempt', categoryId: await r.cat('Sundry'), sourceId: await r.src('Business bank') });
    const gc = (await buildStatements(env.sql, FY)).checks.find((c) => c.label.startsWith('The business is a going concern'))!;
    expect(gc.ok).toBe(false);
    expect(gc.detail).toMatch(/The owner assesses whether/);
    expect(gc.detail).not.toMatch(/s128/);
    await expectCleanAudit(env.sql);
  });

  it('a CC in deficit, not overdrawn: the going-concern look, with business rescue (CC Act s66(1A))', async () => {
    await env.sql`delete from costs`;
    const me = await business(env, 'cc');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    await me.post('/api/journals', { date: '2025-03-01', description: 'Members’ contributions (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 1_000_000 }, { accountId: await r.acc('share_capital'), creditCents: 1_000_000 }] });
    await me.post('/api/journals', { date: '2025-03-02', description: 'Loan from a member (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 5_000_000 }, { accountId: await r.acc('owner_loan'), creditCents: 5_000_000 }] });
    await me.post('/api/costs', { date: '2025-06-01', description: 'Rent (made up)', amountCents: 5_500_000, vatCents: 0, vatCode: 'exempt', categoryId: await r.cat('Sundry'), sourceId: bank });
    const s = await buildStatements(env.sql, FY);
    const gc = s.checks.find((c) => c.label.startsWith('The business is a going concern'))!;
    expect(gc.ok).toBe(false);
    expect(gc.detail).toMatch(/^Liabilities exceed assets at the year end\. The members assess/);
    expect(gc.detail).toMatch(/close corporation is financially distressed.*s128\(1\)\(f\), with CC Act s66\(1A\).*s129\(7\)/);
    expect(s.checks.find((c) => c.label.startsWith('The members’ interest is not in deficit'))!.ok).toBe(false);
    await expectCleanAudit(env.sql);
  });
});

describe('a CC and a trust: their capital by its own name', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => env.close());

  it('a CC’s members’ contributions; healthy books pass the going-concern look', async () => {
    const me = await business(env, 'cc');
    const r = await ref(env.sql);
    await me.post('/api/journals', { date: '2025-03-01', description: 'Members’ contributions (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 1_000_000 }, { accountId: await r.acc('share_capital'), creditCents: 1_000_000 }] });
    const s = await buildStatements(env.sql, FY);
    const rows = s.soce.rows.map((x) => x.label);
    expect(rows).toContain('Members’ contributions');
    expect(rows).not.toContain('Issue of shares');
    // Healthy books pass the going-concern look, and the accounting officer's deficit check (s62(3)).
    expect(s.checks.find((c) => c.label.startsWith('The business is a going concern'))!.ok).toBe(true);
    expect(s.checks.find((c) => c.label.startsWith('The members’ interest is not in deficit'))!.ok).toBe(true);
    await expectCleanAudit(env.sql);
  });

  it('a trust’s capital contributed', async () => {
    const me = await business(env, 'trust');
    void me;
    const s = await buildStatements(env.sql, FY);
    const rows = s.soce.rows.map((x) => x.label);
    expect(rows).toContain('Capital contributed');
    const gc = s.checks.find((c) => c.label.startsWith('The business is a going concern'))!;
    expect(gc.ok).toBe(true);
    await expectCleanAudit(env.sql);
  });
});
