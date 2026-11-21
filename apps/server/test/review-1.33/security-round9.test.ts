/**
 * The ninth round of 1.33's reviews (security and privacy), against the eighth round's fixes. All data made up.
 *
 * 1. shareProblem now calls String() and JSON.stringify() on a share's values. A value JSON.parse
 *    can make but neither can turn into text ({"toString": 1}, or arrays nested deep) throws a
 *    TypeError or RangeError out of readPocketShare: the route answers 500 (an unhandled error in
 *    the log) where it answered 400 before (the insert's try/catch caught the driver's throw).
 * 2. An array of empty objects measures 3 characters each as JSON but reaches a text column as
 *    "[object Object]," (16 each): past MAX_SHARE_TEXT about five times over.
 * 3. The company file's 200-character names refuse a file Shap made: the tracker makes a cost
 *    type and a payment account of whatever the spreadsheet's Type and Account cells say.
 */
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_SHARE_TEXT, POCKET_SHARE_FORMAT, shareProblem, type PocketShare } from '@shap/shared';
import { buildDemoTracker } from '../../src/db/demo-tracker.js';
import { today } from '../../src/lib/books.js';
import { applyTracker } from '../../src/modules/import/apply.js';
import { readTracker } from '../../src/modules/import/tracker.js';
import { readPocketShare } from '../../src/modules/import/pocket-share.js';
import { expectCleanAudit, login, setup, type TestEnv } from '../helpers.js';

const share = (journalLines: unknown[], costs: unknown[] = []) => ({
  format: POCKET_SHARE_FORMAT,
  stamp: { number: 1, madeAt: '2026-11-10T08:00:00.000Z', through: '2026-11-10', previous: null, app: 'Shap Pocket', books: '6c8e0a2d-4f6b-4c8d-8e2f-3a4b5c6d7e8f', version: '1.11.4' },
  records: { settings: [{ company_name: 'Made-up Edge (Pty) Ltd' }], journal_lines: journalLines, costs },
  entries: [],
  changes: { added: 0, changed: 0, removed: 0 },
});
const statusOf = (text: string) => {
  try {
    readPocketShare('made-up.json', Buffer.from(text));
    return 200;
  } catch (e) {
    return (e as { statusCode?: number }).statusCode ?? `${(e as Error).constructor.name} (500)`;
  }
};
const ID = '4a6c8e0b-2d4f-4a6b-8c0d-1e2f3a4b5c6d';

describe('a share whose values can’t be turned into text', () => {
  it('is refused (400), not a 500', () => {
    const own = JSON.stringify(share([{ journal_id: '@@' }])).replace('"@@"', '{"toString":1}');
    expect(statusOf(own)).toBe(400);
    const deepId = JSON.stringify(share([{ journal_id: '@@' }])).replace('"@@"', '['.repeat(50_000) + JSON.stringify(ID) + ']'.repeat(50_000));
    expect(statusOf(deepId)).toBe(400);
    const deepMemo = JSON.stringify(share([], [{ description: '@@' }])).replace('"@@"', '['.repeat(50_000) + ']'.repeat(50_000));
    expect(statusOf(deepMemo)).toBe(400);
  });

  it('measures an array as the driver sends it', () => {
    const objs = Array.from({ length: 16_000 }, () => ({}));
    expect(('' + objs).length).toBeGreaterThan(5 * MAX_SHARE_TEXT);
    expect(shareProblem(share([], [{ description: objs }]) as unknown as PocketShare)?.kind).toBe('too_big');
  });
});

describe('a company file of books brought in from a tracker with a long Type', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('loads back as Shap made it', async () => {
    const built = await buildDemoTracker(today());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(built.buffer as never);
    const costs = wb.getWorksheet('Costs')!;
    const longType = 'Made-up consumables for the made-up site ' + 'abcdefghij'.repeat(20); // 241 characters
    costs.getRow(2).getCell(5).value = longType;
    const plan = await readTracker(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(plan.types).toContain(longType);
    await applyTracker(env.sql, plan, { agreeTrialBalance: true });
    const owner = await login(env.app, 'owner@example.co.za');
    const { url } = await owner.post('/api/company-file/link', { password: 'test-password-1' });
    const file = (await owner.call({ method: 'GET', url })).json();
    // Named as Settings takes a name (80 characters): the file carries it so, and loads back.
    expect(file.categories.some((c: { name: string }) => c.name === longType.slice(0, 80).trim())).toBe(true);
    const res = await owner.call({ method: 'POST', url: '/api/company-file', payload: { file, password: 'test-password-1' } });
    expect(res.statusCode, res.body).toBe(200);
  });
});

/**
 * 4. moveToAccount now reads a cost type's closed-period costs from ledger_detail twice on every
 *    save, moved or not (the list PUT; each of a company file's cost types, however often it
 *    lists one). On made-up books with 150 000 costs of one type over ten years, closed to
 *    2025-02-28: a save that changes nothing took 13 ms before the eighth round, seconds now.
 */
describe('saving a big cost type that stays where it is', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup({ demo: true });
  }, 300_000);
  afterAll(async () => {
    await env.close();
  });

  it('is quick', async () => {
    const [c] = await env.sql<{ id: string; name: string; kind: string; accountId: string }[]>`select id, name, kind, account_id from cost_categories where name = 'Parts'`;
    await env.sql`insert into costs (date, description, supplier, amount_cents, vat_cents, category_id, source_id, no_job, vat_code)
      select date '2016-03-01' + (g % 3650), 'Made-up cost ' || g, 'Made-up Supplier', 10000 + (g % 997), 0, ${c!.id}::uuid,
        (select id from payment_sources where kind = 'bank' order by sort limit 1), true, 'no_vat' from generate_series(1, 150000) g`;
    await env.sql`update settings set lock_date = '2025-02-28' where id`;
    await env.sql`analyze`;
    const owner = await login(env.app, 'owner@example.co.za');
    const started = Date.now();
    const res = await owner.call({ method: 'PUT', url: `/api/categories/${c!.id}`, payload: { name: c!.name, kind: c!.kind, accountId: c!.accountId, active: true } });
    const took = Date.now() - started;
    expect(res.statusCode, res.body).toBe(200);
    expect(took).toBeLessThan(300);
  }, 120_000);
});
