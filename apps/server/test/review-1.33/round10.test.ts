/**
 * The tenth round of 1.33's reviews (security, IFRS, words): two long tracker types that start the
 * same are one cost type, and a cost type's kind can't move a closed period's VAT between boxes 14
 * and 15. All data made up.
 */
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, financialYear, vatPeriod, addMonths } from '@shap/shared';
import { buildDemoTracker } from '../../src/db/demo-tracker.js';
import { today } from '../../src/lib/books.js';
import { applyTracker } from '../../src/modules/import/apply.js';
import { readTracker } from '../../src/modules/import/tracker.js';
import { vat201 } from '../../src/modules/taxforms.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

describe('a tracker with two long Types that share their first 80 characters', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await env.close();
  });

  it('is brought in (not refused by the unique name)', async () => {
    const built = await buildDemoTracker(today());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(built.buffer as never);
    const costs = wb.getWorksheet('Costs')!;
    const stem = 'Made-up consumables for the made-up site, phase one of the made-up contract, ';
    expect(stem.length).toBeLessThan(80);
    const a = (stem + 'x'.repeat(80)).slice(0, 80) + ' gravel';
    const b = (stem + 'x'.repeat(80)).slice(0, 80) + ' cement';
    costs.getRow(2).getCell(5).value = a;
    costs.getRow(3).getCell(5).value = b;
    const plan = await readTracker(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(plan.types).toContain(a);
    expect(plan.types).toContain(b);
    let err: unknown = null;
    try {
      await applyTracker(env.sql, plan, { agreeTrialBalance: true });
    } catch (e) {
      err = e;
    }
    // Fails now: 23505 (cost_categories_name_key), which the route answers as a 500.
    expect((err as { code?: string } | null)?.code ?? null).toBeNull();
    await expectCleanAudit(env.sql);
  });
});

describe('a cost type’s kind and a closed VAT period’s VAT201', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('keeps the closed period’s boxes 14 and 15 as they were', async () => {
    const owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const { settings } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4000000002', vatCategory: 'C' }, 'PUT');
    const now = today();
    const fy = financialYear(now, settings.fyEndMonth);
    const p = vatPeriod(addMonths(fy.start, -3), 'C', settings.fyEndMonth);
    const cats = await env.sql<{ id: string; name: string; kind: string; accountId: string }[]>`select id, name, kind, account_id from cost_categories where kind = 'overhead' order by sort limit 1`;
    const cat = cats[0]!;
    await owner.post('/api/costs', { date: p.start, description: 'Made-up tools', supplier: 'Made-up Supplies', amountCents: 115_000, vatCents: 15_000, categoryId: cat.id, sourceId: await r.src('Business bank') });
    await env.sql`update settings set lock_date = ${p.end}::date where id`;
    const before = await vat201(env.sql, p.start, p.end);
    const res = await owner.call({ method: 'PUT', url: `/api/categories/${cat.id}`, payload: { name: cat.name, kind: 'asset', accountId: cat.accountId, active: true } });
    const after = await vat201(env.sql, p.start, p.end);
    expect(res.statusCode).toBe(400);
    expect(after).toEqual(before);
    await env.sql`update settings set lock_date = null where id`;
  });
});
