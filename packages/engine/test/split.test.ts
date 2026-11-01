/** One purchase paid two ways: split the cost, one part per payment. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balance, ledgerTotal, login, ref, setup, type TestEnv } from './helpers.js';

describe('splitting a cost', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  let bank: string;
  let cash: string;
  let demo: string;
  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    bank = await r.src('Business bank');
    cash = await r.src('Cash');
    demo = await r.cat('Parts');
  });
  afterAll(() => env.close());

  it('turns R1,300 not yet paid into R650 cash and R650 from the bank, on the same job', async () => {
    const job = await owner.post('/api/projects', { name: 'Garden wall', startDate: '2026-10-01' });
    const c = await owner.post('/api/costs', { date: '2026-10-12', description: 'Demo & removal', amountCents: 130000, vatCents: 0, supplier: 'Freddie Rubble', categoryId: demo, sourceId: null, projectId: job.id });
    expect(await balance(env.sql, 'uncaptured')).toBeLessThan(0);
    const r = await owner.post(`/api/costs/${c.id}/split`, { parts: [{ amountCents: 65000, sourceId: cash }, { amountCents: 65000, sourceId: bank }] });
    expect(r.ids).toHaveLength(2);
    const rows = await env.sql<{ amountCents: number; sourceId: string; projectId: string; supplier: string; note: string }[]>`
      select amount_cents, source_id, project_id, supplier, note from costs where id = any(${r.ids}::uuid[]) order by amount_cents, source_id = ${cash} desc`;
    expect(rows.map((x) => [x.amountCents, x.sourceId, x.projectId, x.supplier])).toEqual([
      [65000, cash, job.id, 'Freddie Rubble'],
      [65000, bank, job.id, 'Freddie Rubble'],
    ]);
    expect(rows[0]!.note).toMatch(/Split from R1300.00/);
    expect(await balance(env.sql, 'uncaptured')).toBe(0);
    expect(await ledgerTotal(env.sql)).toBe(0);
  });

  it('shares the VAT out and checks the parts add up', async () => {
    const c = await owner.post('/api/costs', { date: '2026-10-13', description: 'Timber', amountCents: 100000, vatCents: 0, supplier: 'Timber City', categoryId: demo, sourceId: null });
    // As if VAT-registered: R130.43 claimable on the slip.
    await env.sql`update costs set vat_cents = 13043 where id = ${c.id}`;
    const bad = await owner.call({ method: 'POST', url: `/api/costs/${c.id}/split`, payload: { parts: [{ amountCents: 60000, sourceId: cash }, { amountCents: 30000, sourceId: bank }] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/add up to R900.00, not R1000.00/);
    const r = await owner.post(`/api/costs/${c.id}/split`, { parts: [{ amountCents: 70000, sourceId: cash }, { amountCents: 30000, sourceId: null }] });
    const vats = await env.sql<{ vatCents: number }[]>`select vat_cents from costs where id = any(${r.ids}::uuid[]) order by amount_cents desc`;
    expect(vats.map((v) => v.vatCents)).toEqual([9130, 3913]);
  });

  it('won’t split one matched to the bank or before the lock date', async () => {
    const c = await owner.post('/api/costs', { date: '2026-10-14', description: 'Fee', amountCents: 6900, supplier: 'FNB', categoryId: demo, sourceId: null });
    await owner.post('/api/bank/statements', { sourceId: bank, csv: ['Date,Amount,Balance,Description', '2026/10/14,-69.00,,FNB FEE'].join('\n') });
    const line = (await owner.get(`/api/bank/recon?sourceId=${bank}`)).lines[0];
    await owner.post(`/api/bank/lines/${line.id}/match`, { items: [{ kind: 'cost', id: c.id }] });
    const r = await owner.call({ method: 'POST', url: `/api/costs/${c.id}/split`, payload: { parts: [{ amountCents: 3000, sourceId: cash }, { amountCents: 3900, sourceId: bank }] } });
    expect(r.json().error).toMatch(/Unmatch it there first/);
  });
});
