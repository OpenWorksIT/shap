/**
 * Costs counted twice, replaying what actually happens: a card's statement imported under the
 * card, then the same file again under the bank, its lines captured as new costs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findDuplicates } from '../src/modules/duplicates.js';
import { ledgerTotal, login, ref, setup, type TestEnv } from './helpers.js';

const CARD_CSV = [
  'Date,Amount,Balance,Description',
  '2026/10/09,-310.00,,MR BUILDER WALMER',
  '2026/10/10,-350.00,,BUILDERS WAREHOUSE WALMER',
  '2026/10/11,-120.00,,NETFLIX.COM',
  '2026/10/12,-45.00,,SASOL WALKER DRIVE',
  '2026/10/15,500.00,,PAYMENT RECEIVED THANK YOU',
].join('\n');

describe('costs counted twice', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  let bank: string;
  let card: string;
  let cats: Record<string, string>;
  let job: { id: string };
  const ids = {} as Record<"sand" | "bricks" | "trowel" | "adaptor" | "drill", string>;

  const cost = (date: string, description: string, amountCents: number, supplier: string, extra: Record<string, unknown> = {}) =>
    owner.post('/api/costs', { date, description, amountCents, supplier, categoryId: cats.parts, sourceId: null, ...extra });
  const recon = async (sourceId: string) => (await owner.get(`/api/bank/recon?sourceId=${sourceId}`)).lines as { id: string; description: string; state: string }[];
  const costRow = async (id: string) =>
    (await env.sql<{ amountCents: number; sourceId: string | null; projectId: string | null; note: string }[]>`select amount_cents, source_id, project_id, note from costs where id = ${id}`)[0];

  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    bank = await r.src('Business bank');
    card = (await owner.post('/api/sources', { name: 'Discovery card', kind: 'card', accountId: (await env.sql<{ id: string }[]>`select id from accounts where code = '2300'`)[0]!.id })).id;
    cats = { parts: await r.cat('Parts'), bank: await r.cat('Bank') };
    job = await owner.post('/api/projects', { name: 'Garden wall', startDate: '2026-10-01' });
    // Captured from slips: one on the job, one slip item by item.
    ids.sand = (await cost('2026-10-09', 'Sand, cement', 31000, 'Mr Builder', { projectId: job.id })).id;
    ids.bricks = (await cost('2026-10-10', 'Bricks', 20000, 'Builders')).id;
    ids.trowel = (await cost('2026-10-10', 'Trowel', 15000, 'Builders')).id;
    // Hand-captured items at the same shop, nearly the same price: not the same purchase.
    ids.adaptor = (await cost('2025-05-12', '2 Pin adaptor', 7000, 'Builders')).id;
    ids.drill = (await cost('2025-05-14', 'Drillbits', 7050, 'Builders')).id;
  });
  afterAll(() => env.close());

  it('imports the card statement under the card and matches what was captured', async () => {
    const r = await owner.post('/api/bank/statements', { sourceId: card, csv: CARD_CSV, filename: 'discovery.csv' });
    expect(r.added).toBe(5);
    const lines = await recon(card);
    const state = (d: string) => lines.find((l) => l.description === d)!.state;
    expect(state('MR BUILDER WALMER')).toBe('matched');
    expect(state('BUILDERS WAREHOUSE WALMER')).toBe('matched');
    // Netflix and Sasol were never captured: added from the statement.
    const open = lines.filter((l) => ['NETFLIX.COM', 'SASOL WALKER DRIVE'].includes(l.description));
    expect((await owner.post('/api/bank/lines/create-costs', { items: open.map((l) => ({ lineId: l.id, categoryId: cats.parts })) })).created).toBe(2);
    expect((await costRow(ids.sand))!.sourceId).toBe(card);
  });

  it('refuses the same file under another account, unless you say so', async () => {
    const preview = await owner.post('/api/bank/preview', { sourceId: bank, csv: CARD_CSV, filename: 'discovery.csv' });
    expect(preview.elsewhere).toMatchObject({ sourceName: 'Discovery card', lines: 5, of: 5, sameFile: true });
    const refused = await owner.call({ method: 'POST', url: '/api/bank/statements', payload: { sourceId: bank, csv: CARD_CSV, filename: 'discovery.csv' } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/already imported under Discovery card/);
    // A different file name with the same transactions is caught by its contents.
    const renamed = await owner.call({ method: 'POST', url: '/api/bank/statements', payload: { sourceId: bank, csv: CARD_CSV, filename: 'other.csv' } });
    expect(renamed.json().error).toMatch(/5 of these 5 transactions are already imported under Discovery card/);
    // An ordinary bank statement sharing one transfer with the card is fine.
    const fine = await owner.post('/api/bank/preview', { sourceId: bank, csv: ['Date,Amount,Balance,Description', '2026/10/15,500.00,,PAYMENT RECEIVED THANK YOU', '2026/10/16,-80.00,,FNB FEE', '2026/10/17,-90.00,,FNB FEE', '2026/10/18,-95.00,,SPAR'].join('\n') });
    expect(fine.elsewhere).toBeNull();
  });

  it('finds every purchase the double import counted twice, and nothing else', async () => {
    // What older versions let happen: imported under the bank too, every line added as a cost.
    const r = await owner.post('/api/bank/statements', { sourceId: bank, csv: CARD_CSV, filename: 'discovery.csv', otherAccountOk: true });
    expect(r).toMatchObject({ added: 5, autoMatched: 0 });
    const outs = (await recon(bank)).filter((l) => l.description !== 'PAYMENT RECEIVED THANK YOU');
    expect((await owner.post('/api/bank/lines/create-costs', { items: outs.map((l) => ({ lineId: l.id, categoryId: cats.parts, force: true })) })).created).toBe(4);

    const dups = await owner.get('/api/costs/duplicates');
    const by = Object.fromEntries(dups.map((d: { description: string }) => [d.description, d]));
    expect(dups).toHaveLength(4);
    expect(by['MR Builder Walmer']).toMatchObject({ kind: 'imported_twice', keepId: ids.sand, keepProjectName: 'Garden wall', lineAccount: 'Business bank', keepLineAccount: 'Discovery card' });
    expect(by['Netflix.com'] ?? by['NETFLIX.COM'] ?? dups.find((d: { amountCents: number }) => d.amountCents === 12000)).toMatchObject({ kind: 'imported_twice' });
    // The slip captured item by item: nothing to fold the copy into, it just goes.
    expect(dups.find((d: { amountCents: number }) => d.amountCents === 35000)).toMatchObject({ kind: 'imported_twice', keepId: null });
    // Two different things from the same shop are never paired.
    expect(dups.some((d: { removeId: string; keepId: string }) => [d.removeId, d.keepId].includes(ids.adaptor))).toBe(false);
    expect((await owner.get('/api/dashboard')).duplicateCosts).toBe(4);

    const st = (await owner.get('/api/bank/statements')).find((s: { sourceId: string }) => s.sourceId === bank);
    expect(st).toMatchObject({ lineCount: 5, elsewhereCount: 5, elsewhereName: 'Discovery card', addedCosts: 4 });
  });

  it('merges each on its own, keeps the job, and drops the copy of the line', async () => {
    const dups = await owner.get('/api/costs/duplicates');
    const res = await owner.post('/api/costs/merge', {
      pairs: [...dups.map((d: { removeId: string; keepId: string | null }) => ({ removeId: d.removeId, keepId: d.keepId })), { removeId: ids.sand, keepId: null }],
      byHand: true,
    });
    expect(res.merged).toBe(4);
    expect(res.results.at(-1)).toMatchObject({ removeId: ids.sand, ok: false, reason: expect.stringMatching(/imported twice/) });
    expect(await owner.get('/api/costs/duplicates')).toHaveLength(0);
    const left = await recon(bank);
    expect(left.map((l) => l.description)).toEqual(['PAYMENT RECEIVED THANK YOU']);
    expect(await costRow(ids.sand)).toMatchObject({ sourceId: card, projectId: job.id, amountCents: 31000 });
    expect(await ledgerTotal(env.sql)).toBe(0);
  });

  it('undoes a merge exactly, and it can be done again', async () => {
    const merges = await owner.get('/api/costs/merges');
    const m = merges.find((x: { amountCents: number }) => x.amountCents === 31000);
    expect(m).toMatchObject({ keptDescription: 'Sand, cement', linesDropped: 1, undoneAt: null });
    await owner.post(`/api/costs/merges/${m.id}/undo`);
    const lines = await recon(bank);
    expect(lines.find((l) => l.description === 'MR BUILDER WALMER')!.state).toBe('matched');
    expect(await costRow(ids.sand)).toMatchObject({ sourceId: card, projectId: job.id });
    const again = await owner.call({ method: 'POST', url: `/api/costs/merges/${m.id}/undo` });
    expect(again.statusCode).toBe(400);
    const dups = await owner.get('/api/costs/duplicates');
    expect(dups).toHaveLength(1);
    expect((await owner.post('/api/costs/merge', { pairs: [{ removeId: dups[0].removeId, keepId: dups[0].keepId }], byHand: true })).merged).toBe(1);
    expect(await ledgerTotal(env.sql)).toBe(0);
  });

  it('takes a wrong import out again with what was added from it, and costs get their account back', async () => {
    // Undo the last merge so the bank statement has a cost added from it again.
    const [last] = await owner.get('/api/costs/merges');
    await owner.post(`/api/costs/merges/${last.id}/undo`);
    const st = (await owner.get('/api/bank/statements')).find((s: { sourceId: string }) => s.sourceId === bank);
    const r = await owner.post(`/api/bank/statements/${st.id}?removeAdded=true`, {}, 'DELETE');
    expect(r.removed).toMatchObject({ costs: 1 });
    expect((await owner.get('/api/bank/statements')).some((s: { sourceId: string }) => s.sourceId === bank)).toBe(false);
    expect(await costRow(ids.sand)).toMatchObject({ sourceId: card, projectId: job.id });
    expect(await ledgerTotal(env.sql)).toBe(0);
  });

  it('finds a slip captured and then added from the statement, and unmatching puts the slip back as it was', async () => {
    const tiles = (await cost('2026-09-01', 'Tiles', 30000, 'Tile Africa', { projectId: job.id })).id;
    await owner.post('/api/bank/statements', { sourceId: bank, csv: ['Date,Amount,Balance,Description', '2026/09/03,-300.01,,TILE AFRICA WALMER'].join('\n') });
    let line = (await recon(bank)).find((l) => l.description === 'TILE AFRICA WALMER')!;
    expect(line.state).toBe('suggested');
    await owner.post('/api/bank/lines/create-costs', { items: [{ lineId: line.id, categoryId: cats.parts, force: true }] });
    const [d] = await owner.get('/api/costs/duplicates');
    expect(d).toMatchObject({ kind: 'captured_twice', keepId: tiles, amountCents: 30001, keepAmountCents: 30000 });
    await owner.post('/api/costs/merge', { pairs: [{ removeId: d.removeId, keepId: d.keepId }], byHand: true });
    expect(await costRow(tiles)).toMatchObject({ sourceId: bank, amountCents: 30001, note: expect.stringMatching(/Rounded/) });
    line = (await recon(bank)).find((l) => l.description === 'TILE AFRICA WALMER')!;
    expect(line.state).toBe('matched');
    await owner.post(`/api/bank/lines/${line.id}/match`, {}, 'DELETE');
    expect(await costRow(tiles)).toMatchObject({ sourceId: null, amountCents: 30000, note: '' });
    expect(await ledgerTotal(env.sql)).toBe(0);
  });

  it('lets you merge any two by hand from a cost, and says why when it can’t', async () => {
    const twins = await owner.get(`/api/costs/${ids.adaptor}/twins`);
    expect(twins.map((t: { id: string }) => t.id)).toContain(ids.drill);
    const r = await owner.post('/api/costs/merge', { pairs: [{ removeId: ids.drill, keepId: ids.adaptor }], byHand: true });
    expect(r.merged).toBe(1);
    expect(await costRow(ids.drill)).toBeUndefined();
    const far = (await cost('2025-05-20', 'Paint', 90000, 'Builders')).id;
    const no = await owner.post('/api/costs/merge', { pairs: [{ removeId: far, keepId: ids.adaptor }], byHand: true });
    expect(no.results[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/more than R1/) });
    // One in the closed period is refused on its own; the others in the batch still merge.
    const a2 = (await cost('2025-01-10', 'Cable ties', 4000, 'Builders')).id;
    const b2 = (await cost('2025-01-11', 'Cable ties', 4000, 'Builders')).id;
    const c2 = (await cost('2025-06-10', 'Glue', 5000, 'Builders')).id;
    const d2 = (await cost('2025-06-11', 'Glue', 5000, 'Builders')).id;
    await env.sql`update settings set lock_date = '2025-02-28'`;
    const mixed = await owner.post('/api/costs/merge', { pairs: [{ removeId: b2, keepId: a2 }, { removeId: d2, keepId: c2 }], byHand: true });
    expect(mixed.merged).toBe(1);
    expect(mixed.results[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/closed/) });
    await env.sql`update settings set lock_date = null`;
  });
});
