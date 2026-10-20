/** Telling Shap a suggestion is wrong: it goes, stays gone, and can be brought back. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, ref, setup, type TestEnv } from './helpers.js';

describe('suggestions you say are wrong', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  let bank: string;
  let parts: string;
  const lineOf = async (desc: string) =>
    (await owner.get(`/api/bank/recon?sourceId=${bank}`)).lines.find((l: { description: string }) => l.description === desc);

  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    bank = await r.src('Business bank');
    parts = await r.cat('Parts');
  });
  afterAll(() => env.close());

  it('“Not this” on a bank suggestion sticks, offers the next best, and can be undone', async () => {
    const first = await owner.post('/api/costs', { date: '2026-03-02', description: 'Cement', amountCents: 25000, supplier: 'Cashbuild', categoryId: parts, sourceId: null });
    const second = await owner.post('/api/costs', { date: '2026-03-04', description: 'Sand', amountCents: 25000, supplier: 'Cashbuild', categoryId: parts, sourceId: null });
    await owner.post('/api/bank/statements', { sourceId: bank, csv: ['Date,Amount,Balance,Description', '2026/03/09,-250.00,,CASHBUILD WALMER'].join('\n') });
    let line = await lineOf('CASHBUILD WALMER');
    expect(line.suggestion.ids).toEqual([second.id]);
    await owner.post(`/api/bank/lines/${line.id}/reject`, { kind: 'cost', ids: [second.id] });
    line = await lineOf('CASHBUILD WALMER');
    expect(line).toMatchObject({ state: 'suggested', rejected: 1, suggestion: { ids: [first.id] } });
    await owner.post(`/api/bank/lines/${line.id}/reject`, { kind: 'cost', ids: [first.id] });
    line = await lineOf('CASHBUILD WALMER');
    expect(line).toMatchObject({ state: 'open', rejected: 2, suggestion: null });
    // Turned down twice, it's added as a new cost without being held back as "already captured".
    const r = await owner.post('/api/bank/lines/create-costs', { items: [{ lineId: line.id, categoryId: parts }] });
    expect(r).toMatchObject({ created: 1, skipped: [] });
    // And the duplicate check doesn't pair it with the costs you turned down.
    const dups = await owner.get('/api/costs/duplicates');
    expect(dups.some((d: { keepId: string }) => [first.id, second.id].includes(d.keepId))).toBe(false);
    await owner.post(`/api/bank/lines/${line.id}/match`, {}, 'DELETE');
    // Bring them back.
    await owner.post(`/api/bank/lines/${line.id}/reject`, {}, 'DELETE');
    expect((await lineOf('CASHBUILD WALMER')).rejected).toBe(0);
  });

  it('“Not the same” on costs counted twice sticks, and can be brought back', async () => {
    const slip = await owner.post('/api/costs', { date: '2026-04-24', description: 'Paint', amountCents: 80000, supplier: 'Mica', categoryId: parts, sourceId: null });
    await owner.post('/api/bank/statements', { sourceId: bank, csv: ['Date,Amount,Balance,Description', '2026/05/03,-800.00,,MICA HARDWARE'].join('\n') });
    const line = await lineOf('MICA HARDWARE');
    await owner.post('/api/bank/lines/create-costs', { items: [{ lineId: line.id, categoryId: parts, force: true }] });
    let dups = await owner.get('/api/costs/duplicates');
    const before = (await owner.get('/api/dashboard')).duplicateCosts;
    const pair = dups.find((d: { keepId: string }) => d.keepId === slip.id);
    expect(pair).toBeTruthy();
    await owner.post('/api/costs/duplicates/reject', { pairs: [{ removeId: pair.removeId, keepId: pair.keepId }] });
    dups = await owner.get('/api/costs/duplicates');
    expect(dups.some((d: { keepId: string }) => d.keepId === slip.id)).toBe(false);
    expect((await owner.get('/api/dashboard')).duplicateCosts).toBe(before - 1);
    const rejected = await owner.get('/api/costs/duplicates/rejected');
    expect(rejected[0]).toMatchObject({ aId: pair.removeId, bId: slip.id, bDescription: 'Paint' });
    await owner.post(`/api/costs/duplicates/rejected/${rejected[0].id}`, {}, 'DELETE');
    expect((await owner.get('/api/costs/duplicates')).some((d: { keepId: string }) => d.keepId === slip.id)).toBe(true);
  });

  it('a statement flagged as also on another account can be marked as fine', async () => {
    const [st] = await owner.get('/api/bank/statements');
    await owner.post(`/api/bank/statements/${st.id}/elsewhere-ok`, { ok: true });
    expect((await owner.get('/api/bank/statements'))[0].elsewhereOk).toBe(true);
  });
});
