/**
 * From the independent review of 1.22 (it failed before the fix): a stock take dated inside a compiled year is invisible to the approval's hash
 * check (ledger_totals stale), so the year is approved, agreed and closed at figures the books no
 * longer give. Made-up data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildStatements } from '../../src/statements/build.js';
import { figuresHash } from '../../src/modules/financial-statements.js';
import { login, ref, setup, type TestEnv, expectCleanAudit } from '../helpers.js';

const Y = '2026-02-28';

describe('approval after a stock take in the compiled year', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let item: { id: string };

  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, companyName: 'Made-up Shop (Pty) Ltd', vatRegistered: true, vatNumber: '4740101508', features: { ...settings.features, statements: true, inventory: true } }, 'PUT');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    await me.post('/api/journals', { date: '2025-03-02', description: 'Shares (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 5_000_000 }, { accountId: await r.acc('share_capital'), creditCents: 5_000_000 }] });
    item = await me.post('/api/items', { description: 'Made-up widget', unitPriceCents: 23_000, priceIncludesVat: true, stocked: true });
    await me.post('/api/stock/purchases', { date: '2025-06-01', supplier: 'Made-up Supplier', reference: 'MS-1', sourceId: bank, lines: [{ itemId: item.id, qtyInvoiced: 100, unitCostCents: 10_000 }] });
  });
  afterAll(() => env.close());

  it('refuses to approve when the books changed after compiling (a stock take in the year)', async () => {
    const file = await me.post('/api/attachments', { filename: 'report.pdf', mime: 'application/pdf', dataBase64: Buffer.from('%PDF-1.4\n% made up\n').toString('base64') });
    await me.post(`/api/statements/${Y}/compiler-report`, { attachmentId: file.id, compilerName: 'Made-up Accountant', date: '2026-04-01' });
    const [row] = await env.sql<{ snapshotHash: string }[]>`select snapshot_hash from financial_statements where fy_end = ${Y}`;
    const snapshotHash = row!.snapshotHash;
    // After compiling: ten units written off at a count dated in the year (R1 000 of stock losses).
    await me.post('/api/stock/takes', { date: '2026-01-15', lines: [{ itemId: item.id, countedQty: 90, reason: 'Ten stolen (made up)' }] });
    const view = await me.get(`/api/statements/${Y}`);
    const res = await me.call({ method: 'POST', url: `/api/statements/${Y}/approve`, payload: { name: 'Made-up Director', date: '2026-04-02' } });
    // Force the totals to be rebuilt, then compare with what was signed.
    await env.sql`update books_version set changed = changed + 1`;
    const now = await buildStatements(env.sql, Y);
    const loss = now.sci.costOfSales.reduce((t, l) => t + l.current, 0);
    // What it should do: refuse, the books no longer give the signed figures.
    expect(res.statusCode).toBe(400);
  });

  it('leaves the books clean', async () => {
    await expectCleanAudit(env.sql, '2026-07-31');
  });
});
