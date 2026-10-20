import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guessCategory, suggestMatches, supplierFrom } from '../src/modules/bank/match.js';
import { parseStatementAmount, parseStatementCsv, parseStatementDate } from '../src/modules/bank/parse.js';
import { balance, ledgerTotal, login, ref, setup, type TestEnv } from './helpers.js';

describe('reading statements', () => {
  it('reads dates and amounts the way SA banks write them', () => {
    expect(parseStatementDate('2026/10/01')).toBe('2026-10-01');
    expect(parseStatementDate('01/10/2026')).toBe('2026-10-01');
    expect(parseStatementDate('1 Oct 2026')).toBe('2026-10-01');
    expect(parseStatementDate('01 Sept 26')).toBe('2026-09-01');
    expect(parseStatementDate('20261001')).toBe('2026-10-01');
    expect(parseStatementDate('31/02/2026')).toBeNull();
    expect(parseStatementAmount('R 1 234.56')).toBe(123456);
    expect(parseStatementAmount('-1,234.56')).toBe(-123456);
    expect(parseStatementAmount('1234,56')).toBe(123456);
    expect(parseStatementAmount('(120.00)')).toBe(-12000);
    expect(parseStatementAmount('120.00 Dr')).toBe(-12000);
    expect(parseStatementAmount('120.00Cr')).toBe(12000);
    expect(parseStatementAmount('abc')).toBeNull();
  });

  it('finds the columns by name, skipping the bank’s preamble and balance rows', () => {
    const csv = [
      'ACCOUNT TRANSACTIONS',
      'Account,62xxxxxxx',
      '',
      'Date,Amount,Balance,Description',
      '2026/03/01,0.00,5000.00,Opening Balance',
      '2026/03/03,-1250.00,3750.00,POS PURCHASE BUILDERS WAREHOUSE 4567*1234 02 MAR',
      '2026/03/04,2000.00,5750.00,ACME PROPERTIES INV 12',
    ].join('\n');
    const p = parseStatementCsv(csv);
    expect(p.rows).toEqual([
      { date: '2026-03-03', description: 'POS PURCHASE BUILDERS WAREHOUSE 4567*1234 02 MAR', amountCents: -125000, balanceCents: 375000 },
      { date: '2026-03-04', description: 'ACME PROPERTIES INV 12', amountCents: 200000, balanceCents: 575000 },
    ]);
  });

  it('handles separate money in, money out and fee columns', () => {
    const csv = ['Transaction Date,Description,Money In,Money Out,Fee,Balance', '05/03/2026,Engen Walmer,,350.00,2.50,100.00', '06/03/2026,Payment received,500.00,,,600.00'].join('\n');
    const p = parseStatementCsv(csv);
    expect(p.rows.map((r) => r.amountCents)).toEqual([-35250, 50000]);
  });

  it('reads month-first dates (Discovery Bank) and leaves out pending card transactions', () => {
    const csv = [
      '\ufeffValue Date,Value Time,Type,Description,Beneficiary or CardHolder,Amount',
      '10-17-26,20:03,Pending,Hosting Co Cape Town ZA,A CARDHOLDER,-443.68',
      '10-14-26,09:12,Card Purchase,Engen Walmer ZA,A CARDHOLDER,-650.00',
      '10-02-26,08:00,Debit Order,Santam Insurance,,-845.50',
      ',,,,,',
      ',,,,,',
    ].join('\n');
    const p = parseStatementCsv(csv);
    expect(p.dateOrder).toBe('mdy');
    expect(p.pending).toBe(1);
    expect(p.rows.map((r) => [r.date, r.description, r.amountCents])).toEqual([
      ['2026-10-02', 'Santam Insurance', -84550],
      ['2026-10-14', 'Engen Walmer ZA', -65000],
    ]);
    expect(() => parseStatementCsv(csv.split('\n').slice(0, 2).join('\n'))).toThrow(/pending/);
  });

  it('works without a header row, and can flip a card statement’s signs', () => {
    const csv = ['"2026/03/05","350.00","1200.00","ENGEN WALMER"', '"2026/03/06","99.00","1299.00","VODACOM"'].join('\n');
    expect(parseStatementCsv(csv, { flip: true }).rows.map((r) => [r.description, r.amountCents])).toEqual([
      ['ENGEN WALMER', -35000],
      ['VODACOM', -9900],
    ]);
  });
});

describe('suggesting matches', () => {
  const line = (id: string, date: string, description: string, amountCents: number) => ({ id, date, description, amountCents, sourceId: 'bank' });
  const cost = (id: string, date: string, amountCents: number, supplier: string, description = 'item', sourceId: string | null = null) => ({ id, date, amountCents, supplier, description, sourceId });
  const none = { receipts: [], wages: [], invoices: [] };

  it('finds the slip behind a statement total, even when it was captured item by item', () => {
    const s = suggestMatches([line('L1', '2026-03-03', 'POS PURCHASE BUILDERS WAREHOUSE', -125000)], {
      ...none,
      costs: [cost('a', '2026-03-02', 70000, 'Builders'), cost('b', '2026-03-02', 30000, 'Builders'), cost('c', '2026-03-02', 25000, 'Builders'), cost('d', '2026-03-02', 25000, 'Cashbuild')],
    });
    expect(s.get('L1')?.ids.sort()).toEqual(['a', 'b', 'c']);
  });

  it('adds up items across suppliers and days when that’s the only way', () => {
    const s = suggestMatches([line('L1', '2026-03-05', 'CARD PURCHASE 1234', -10000)], {
      ...none,
      costs: [cost('a', '2026-03-03', 6000, 'X'), cost('b', '2026-03-04', 4000, 'Y'), cost('c', '2026-03-04', 3000, 'Z')],
    });
    expect(s.get('L1')?.ids.sort()).toEqual(['a', 'b']);
  });

  it('gives each cost to one line only, the better match first', () => {
    const s = suggestMatches([line('L1', '2026-03-03', 'ENGEN', -50000), line('L2', '2026-03-10', 'SHELL GARAGE', -50000)], {
      ...none,
      costs: [cost('a', '2026-03-09', 50000, 'Shell')],
    });
    expect(s.get('L2')?.ids).toEqual(['a']);
    expect(s.has('L1')).toBe(false);
  });

  it('suggests the invoice a payment settles', () => {
    const s = suggestMatches([line('L1', '2026-03-20', 'ACME PROPERTIES INV 7', 300000)], {
      costs: [],
      receipts: [],
      wages: [],
      invoices: [
        { id: 'i6', number: '6', clientName: 'Someone', balanceCents: 300000, depositOutstandingCents: 0, issueDate: '2026-03-01' },
        { id: 'i7', number: '7', clientName: 'Acme Properties', balanceCents: 300000, depositOutstandingCents: 0, issueDate: '2026-03-01' },
      ],
    });
    expect(s.get('L1')).toMatchObject({ kind: 'invoice', ids: ['i7'] });
  });

  it('reads the supplier and the cost type off a bank description', () => {
    expect(supplierFrom('POS PURCHASE BUILDERS WAREHOUSE 4567*1234 02 MAR')).toBe('Builders Warehouse');
    expect(supplierFrom('DEBIT ORDER SANTAM INS 123456789')).toBe('Santam Ins');
    const cats = [
      { id: 'bank', name: 'Bank', active: true },
      { id: 'ins', name: 'Insurance', active: true },
      { id: 'fuel', name: 'Petrol', active: true },
      { id: 'parts', name: 'Parts', active: true },
      { id: 'sundry', name: 'Sundry', active: true },
    ];
    expect(guessCategory('MONTHLY ACCOUNT FEE', cats, [])).toBe('bank');
    expect(guessCategory('DEBIT ORDER SANTAM', cats, [])).toBe('ins');
    expect(guessCategory('ENGEN WALMER', cats, [])).toBe('fuel');
    expect(guessCategory('MYSTERY CO', cats, [])).toBe('sundry');
    // How the same supplier was captured before wins.
    expect(guessCategory('POS PURCHASE ENGEN SHOP', cats, [{ supplier: 'Engen', categoryId: 'parts' }])).toBe('parts');
  });
});

describe('reconciling a statement', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  let bank: string;
  let card: string;
  let cats: Record<string, string>;
  const csv = [
    'Date,Amount,Balance,Description',
    '2026/03/03,-1250.00,8750.00,POS PURCHASE BUILDERS WAREHOUSE 4567*1234 02 MAR',
    '2026/03/04,-69.00,8681.00,MONTHLY ACCOUNT FEE',
    '2026/03/05,-845.50,7835.50,DEBIT ORDER SANTAM INSURANCE 99887766',
    '2026/03/06,-300.00,7535.50,POS PURCHASE WOOLWORTHS FOOD',
    '2026/03/10,3000.00,10535.50,ACME PROPERTIES INV 1',
    '2026/03/12,-2000.00,8535.50,FNB APP PAYMENT TO CREDIT CARD',
  ].join('\n');

  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    bank = await r.src('Business bank');
    card = (await owner.post('/api/sources', { name: 'Business card', kind: 'card', accountId: (await env.sql<{ id: string }[]>`select id from accounts where code = '2300'`)[0]!.id })).id;
    cats = { parts: await r.cat('Parts'), bank: await r.cat('Bank'), insurance: await r.cat('Insurance') };
    // A slip captured item by item, not yet matched to a payment.
    for (const [d, amt] of [['Bricks', 70000], ['Cement', 30000], ['Sand', 25000]] as const) {
      await owner.post('/api/costs', { date: '2026-03-02', description: d, amountCents: amt, supplier: 'Builders', categoryId: cats.parts, sourceId: null });
    }
    const client = await owner.post('/api/clients', { name: 'Acme Properties' });
    const inv = await owner.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: '2026-03-01', lines: [{ category: 'labour', description: 'Work', qty: 1, unitPriceCents: 300000 }] });
    await owner.post(`/api/documents/${inv.id}/issue`);
  });
  afterAll(() => env.close());

  it('previews what it read before importing', async () => {
    const p = await owner.post('/api/bank/preview', { sourceId: bank, csv });
    expect(p).toMatchObject({ count: 6, duplicates: 0, from: '2026-03-03', to: '2026-03-12', inCents: 300000, outCents: 446450 });
  });

  it('imports, and matches the sure things straight away', async () => {
    const r = await owner.post('/api/bank/statements', { sourceId: bank, csv, filename: 'march.csv' });
    expect(r).toMatchObject({ added: 6, duplicates: 0, autoMatched: 1 });
    // The three items now say they were paid from the bank.
    const [row] = await env.sql<{ n: number }[]>`select count(*)::int as n from costs where source_id = ${bank}`;
    const n = row!.n;
    expect(n).toBe(3);
    expect(await balance(env.sql, 'uncaptured')).toBe(0);
  });

  it('skips what it has already seen when the same statement comes in again', async () => {
    const r = await owner.post('/api/bank/statements', { sourceId: bank, csv });
    expect(r).toMatchObject({ added: 0, duplicates: 6 });
  });

  it('suggests the rest and guesses cost types for what was never captured', async () => {
    const rec = await owner.get(`/api/bank/recon?sourceId=${bank}`);
    const by = Object.fromEntries(rec.lines.map((l: { description: string }) => [l.description, l]));
    expect(by['POS PURCHASE BUILDERS WAREHOUSE 4567*1234 02 MAR'].state).toBe('matched');
    expect(by['ACME PROPERTIES INV 1']).toMatchObject({ state: 'suggested', suggestion: { kind: 'invoice' } });
    expect(by['MONTHLY ACCOUNT FEE']).toMatchObject({ state: 'open', categoryId: cats.bank });
    expect(by['DEBIT ORDER SANTAM INSURANCE 99887766']).toMatchObject({ state: 'open', categoryId: cats.insurance, supplier: 'Santam Insurance' });
  });

  it('records the client payment, adds the fees, leaves off the personal one, and books the card repayment as a transfer', async () => {
    const rec = await owner.get(`/api/bank/recon?sourceId=${bank}`);
    const id = (d: string) => rec.lines.find((l: { description: string }) => l.description.startsWith(d)).id;
    expect((await owner.post('/api/bank/accept', { sourceId: bank, lineIds: [id('ACME')] })).matched).toBe(1);
    const created = await owner.post('/api/bank/lines/create-costs', {
      items: [
        { lineId: id('MONTHLY'), categoryId: cats.bank },
        { lineId: id('DEBIT ORDER'), categoryId: cats.insurance, supplier: 'Santam' },
      ],
    });
    expect(created.created).toBe(2);
    await owner.post('/api/bank/lines/ignore', { lineIds: [id('POS PURCHASE WOOLWORTHS')], ignored: true });
    await owner.post(`/api/bank/lines/${id('FNB APP PAYMENT')}/transfer`, { otherSourceId: card });

    const after = await owner.get(`/api/bank/recon?sourceId=${bank}`);
    const states = after.lines.map((l: { state: string }) => l.state);
    expect(states.filter((s: string) => s === 'matched')).toHaveLength(5);
    expect(states.filter((s: string) => s === 'ignored')).toHaveLength(1);
    // The books now agree with the statement's closing balance, less the personal R300 left off.
    expect(after.statementBalance.cents - after.booksCents).toBe(1000000 - 30000);
    expect(await balance(env.sql, 'receivables')).toBe(0);
    expect(await ledgerTotal(env.sql)).toBe(0);
  });

  it('matches by hand only when the amounts add up, and can undo it', async () => {
    const rec = await owner.get(`/api/bank/recon?sourceId=${bank}`);
    const fee = rec.lines.find((l: { description: string }) => l.description === 'MONTHLY ACCOUNT FEE');
    await owner.post(`/api/bank/lines/${fee.id}/match`, {}, 'DELETE');
    await owner.post('/api/costs', { date: '2026-03-04', description: 'Tea', amountCents: 5000, supplier: 'Spar', categoryId: cats.parts, sourceId: bank });
    const cand = await owner.get(`/api/bank/lines/${fee.id}/candidates`);
    const theFee = cand.costs.find((c: { amountCents: number }) => c.amountCents === 6900);
    const wrong = cand.costs.find((c: { amountCents: number }) => c.amountCents !== 6900);
    const bad = await owner.call({ method: 'POST', url: `/api/bank/lines/${fee.id}/match`, payload: { items: [{ kind: 'cost', id: wrong.id }] } });
    expect(bad.statusCode).toBe(400);
    await owner.post(`/api/bank/lines/${fee.id}/match`, { items: [{ kind: 'cost', id: theFee.id }] });
    const again = await owner.get(`/api/bank/recon?sourceId=${bank}`);
    expect(again.lines.find((l: { id: string }) => l.id === fee.id).state).toBe('matched');
  });

  it('accepts a match a few cents out, and the biggest item takes the rounding', async () => {
    const csv2 = ['Date,Amount,Balance,Description', '2026/04/03,-300.01,0,POS PURCHASE CASHBUILD', '2026/04/05,12.34,0,CREDIT INTEREST', '2026/04/06,150.00,0,REFUND CASHBUILD'].join('\n');
    const a = await owner.post('/api/costs', { date: '2026-04-02', description: 'Timber', amountCents: 20000, supplier: 'Cashbuild', categoryId: cats.parts, sourceId: null });
    await owner.post('/api/costs', { date: '2026-04-02', description: 'Nails', amountCents: 10000, supplier: 'Cashbuild', categoryId: cats.parts, sourceId: null });
    const r = await owner.post('/api/bank/statements', { sourceId: bank, csv: csv2 });
    expect(r.added).toBe(3);
    const rec = await owner.get(`/api/bank/recon?sourceId=${bank}`);
    const line = rec.lines.find((l: { description: string }) => l.description === 'POS PURCHASE CASHBUILD');
    expect(line.state).toBe('suggested');
    await owner.post('/api/bank/accept', { sourceId: bank, lineIds: [line.id] });
    const [timber] = await env.sql<{ amountCents: number; note: string }[]>`select amount_cents, note from costs where id = ${a.id}`;
    expect(timber!.amountCents).toBe(20001);
    expect(timber!.note).toMatch(/Rounded/);
  });

  it('books money in as income or as a refund on a cost type', async () => {
    const rec = await owner.get(`/api/bank/recon?sourceId=${bank}`);
    const interest = rec.lines.find((l: { description: string }) => l.description === 'CREDIT INTEREST');
    const refund = rec.lines.find((l: { description: string }) => l.description === 'REFUND CASHBUILD');
    const otherIncome = (await env.sql<{ id: string }[]>`select id from accounts where system_key = 'revenue_other'`)[0]!.id;
    expect(interest.incomeAccountId).toBe(otherIncome);
    expect(refund.categoryId).toBe(cats.parts);
    const r = await owner.post('/api/bank/lines/create-costs', {
      items: [
        { lineId: interest.id, incomeAccountId: otherIncome },
        { lineId: refund.id, categoryId: cats.parts },
      ],
    });
    expect(r.created).toBe(2);
    expect(await balance(env.sql, 'revenue_other')).toBe(-1234);
    const [c] = await env.sql<{ amountCents: number }[]>`select amount_cents from costs where note like 'From statement: REFUND%'`;
    expect(c!.amountCents).toBe(-15000);
    expect(await ledgerTotal(env.sql)).toBe(0);
  });

  it('spots a statement line already captured on a job from another account, and merges a copy that slipped through', async () => {
    const job = await owner.post('/api/projects', { name: 'Garden wall', startDate: '2026-05-01' });
    const captured = await owner.post('/api/costs', {
      date: '2026-05-02', description: 'Blocks', amountCents: 31000, supplier: 'Mr Builder', categoryId: cats.parts, sourceId: card, projectId: job.id,
    });
    const r = await owner.post('/api/bank/statements', { sourceId: bank, csv: ['Date,Amount,Balance,Description', '2026/05/04,-310.00,0,POS PURCHASE MR BUILDER WALMER'].join('\n') });
    expect(r.autoMatched).toBe(0);
    const rec = await owner.get(`/api/bank/recon?sourceId=${bank}`);
    const line = rec.lines.find((l: { description: string }) => l.description === 'POS PURCHASE MR BUILDER WALMER');
    expect(line.state).toBe('suggested');
    expect(line.suggestion.label).toMatch(/Garden wall/);
    // Ticked and added as new anyway: held back, because it looks captured already.
    const held = await owner.post('/api/bank/lines/create-costs', { items: [{ lineId: line.id, categoryId: cats.parts }] });
    expect(held).toMatchObject({ created: 0, skipped: [{ lineId: line.id, costId: captured.id }] });
    // Forced through (as older versions did): it shows up as counted twice, and merging puts it right.
    expect((await owner.post('/api/bank/lines/create-costs', { items: [{ lineId: line.id, categoryId: cats.parts, force: true }] })).created).toBe(1);
    const dups = await owner.get('/api/costs/duplicates');
    expect(dups).toHaveLength(1);
    expect(dups[0]).toMatchObject({ originalId: captured.id, projectName: 'Garden wall', amountCents: 31000 });
    expect((await owner.get('/api/dashboard')).duplicateCosts).toBe(1);
    expect((await owner.post('/api/costs/merge', { pairs: [{ copyId: dups[0].copyId, originalId: captured.id }] })).merged).toBe(1);
    const rows = await env.sql<{ id: string; sourceId: string; projectId: string }[]>`select id, source_id, project_id from costs where description = 'Blocks' or note like 'From statement: POS PURCHASE MR BUILDER%'`;
    expect(rows).toEqual([{ id: captured.id, sourceId: bank, projectId: job.id }]);
    const after = await owner.get(`/api/bank/recon?sourceId=${bank}`);
    expect(after.lines.find((l: { id: string }) => l.id === line.id).state).toBe('matched');
    expect(await owner.get('/api/costs/duplicates')).toHaveLength(0);
    expect(await ledgerTotal(env.sql)).toBe(0);
  });

  it('moves a statement imported under the wrong account, with everything matched to it', async () => {
    const cardCsv = ['Date,Amount,Balance,Description', '2026/06/03,-450.00,,ENGEN WALMER', '2026/06/04,-120.00,,NETFLIX', '2026/06/20,2000.00,,PAYMENT RECEIVED THANK YOU'].join('\n');
    const fuel = await owner.post('/api/costs', { date: '2026-06-03', description: 'Fuel', amountCents: 45000, supplier: 'Engen', categoryId: cats.parts, sourceId: null });
    const r = await owner.post('/api/bank/statements', { sourceId: bank, csv: cardCsv, filename: 'card.csv' });
    expect(r.added).toBe(3);
    let rec = await owner.get(`/api/bank/recon?sourceId=${bank}`);
    const id = (d: string) => rec.lines.find((l: { description: string }) => l.description === d).id;
    await owner.post('/api/bank/accept', { sourceId: bank, lineIds: [id('ENGEN WALMER')] });
    await owner.post('/api/bank/lines/create-costs', { items: [{ lineId: id('NETFLIX'), categoryId: cats.bank }] });
    // The card repayment, booked (wrongly) as coming from the card.
    await owner.post(`/api/bank/lines/${id('PAYMENT RECEIVED THANK YOU')}/transfer`, { otherSourceId: card });
    // Part of it was also imported under the card already, unmatched there.
    await owner.post('/api/bank/statements', { sourceId: card, csv: cardCsv.split('\n').slice(0, 2).join('\n') });

    const list = await owner.get('/api/bank/statements');
    const st = list.find((x: { filename: string }) => x.filename === 'card.csv');
    expect(st).toMatchObject({ lineCount: 3, matchedCount: 3 });
    const moved = await owner.post(`/api/bank/statements/${st.id}/move`, { sourceId: card });
    expect(moved).toMatchObject({ lines: 3, alreadyThere: 1, costs: 2, transfersUndone: 1 });

    const costs = await env.sql<{ sourceId: string }[]>`select source_id from costs where id = ${fuel.id} or note = 'From statement: NETFLIX'`;
    expect(costs.map((c) => c.sourceId)).toEqual([card, card]);
    rec = await owner.get(`/api/bank/recon?sourceId=${card}`);
    const desc = rec.lines.map((l: { description: string; state: string }) => [l.description, l.state]);
    expect(desc).toEqual([
      ['ENGEN WALMER', 'matched'],
      ['NETFLIX', 'matched'],
      ['PAYMENT RECEIVED THANK YOU', expect.stringMatching(/open|suggested/)],
    ]);
    expect((await owner.get(`/api/bank/recon?sourceId=${bank}`)).lines.some((l: { description: string }) => l.description === 'NETFLIX')).toBe(false);
    expect(await ledgerTotal(env.sql)).toBe(0);
  });

  it('merges a copy whose statement line was itself imported twice, and by hand from either cost', async () => {
    const job = await owner.post('/api/projects', { name: 'Boundary wall', startDate: '2026-07-01' });
    const captured = await owner.post('/api/costs', {
      date: '2026-07-09', description: 'Sand, cement', amountCents: 31000, supplier: 'Mr Builder', categoryId: cats.parts, sourceId: card, projectId: job.id,
    });
    const a = await owner.post('/api/bank/statements', { sourceId: card, csv: ['Date,Amount,Balance,Description', '2026/07/09,-310.00,,MR BUILDER'].join('\n') });
    expect(a.autoMatched).toBe(1);
    // The same transaction again, written differently in another download.
    await owner.post('/api/bank/statements', { sourceId: card, csv: ['Date,Amount,Balance,Description', '2026/07/09,-310.00,,MR Builder Walmer'].join('\n') });
    const rec = await owner.get(`/api/bank/recon?sourceId=${card}`);
    const dup = rec.lines.find((l: { description: string }) => l.description === 'MR Builder Walmer');
    expect(dup.state).toBe('open');
    await owner.post('/api/bank/lines/create-costs', { items: [{ lineId: dup.id, categoryId: cats.parts, force: true }] });
    const found = (await owner.get('/api/costs/duplicates')).find((d: { originalId: string }) => d.originalId === captured.id);
    expect(found).toBeTruthy();
    const twins = await owner.get(`/api/costs/${found.copyId}/twins`);
    expect(twins.map((t: { id: string }) => t.id)).toContain(captured.id);
    const r = await owner.post('/api/costs/merge', { pairs: [{ copyId: found.copyId, originalId: captured.id }] });
    expect(r).toEqual({ merged: 1, failed: [] });
    const after = await owner.get(`/api/bank/recon?sourceId=${card}`);
    expect(after.lines.filter((l: { amountCents: number; date: string }) => l.date === '2026-07-09' && l.amountCents === -31000)).toHaveLength(1);
    const [c] = await env.sql<{ projectId: string }[]>`select project_id from costs where id = ${captured.id}`;
    expect(c!.projectId).toBe(job.id);

    // Two real payments of the same amount are not folded together.
    const p1 = await owner.post('/api/costs', { date: '2026-07-20', description: 'Paint', amountCents: 50000, supplier: 'Mica', categoryId: cats.parts, sourceId: card });
    const p2 = await owner.post('/api/costs', { date: '2026-07-22', description: 'Paint', amountCents: 50000, supplier: 'Mica', categoryId: cats.parts, sourceId: card });
    await owner.post('/api/bank/statements', { sourceId: card, csv: ['Date,Amount,Balance,Description', '2026/07/20,-500.00,,MICA', '2026/07/22,-500.00,,MICA'].join('\n') });
    const no = await owner.post('/api/costs/merge', { pairs: [{ copyId: p2.id, originalId: p1.id }] });
    expect(no.merged).toBe(0);
    expect(no.failed[0].reason).toMatch(/two separate payments/);
    // By hand you can say they're one: the copy's line goes back on the to-do list.
    const yes = await owner.post('/api/costs/merge', { pairs: [{ copyId: p2.id, originalId: p1.id }], byHand: true });
    expect(yes.merged).toBe(1);
    const open = (await owner.get(`/api/bank/recon?sourceId=${card}`)).lines.filter((l: { description: string; state: string }) => l.description === 'MICA' && l.state !== 'matched');
    expect(open).toHaveLength(1);

    // Same amount, a few days apart, nothing in common by name: not a twin.
    await owner.post('/api/costs', { date: '2026-08-04', description: 'Electrical', amountCents: 30000, supplier: 'Powerline', categoryId: cats.parts, sourceId: null });
    await owner.post('/api/bank/statements', { sourceId: bank, csv: ['Date,Amount,Balance,Description', '2026/08/13,-300.00,,EXCLUSIVE CAR CARE AND'].join('\n') });
    const car = (await owner.get(`/api/bank/recon?sourceId=${bank}`)).lines.find((l: { description: string }) => l.description === 'EXCLUSIVE CAR CARE AND');
    await owner.post('/api/bank/lines/create-costs', { items: [{ lineId: car.id, categoryId: cats.parts, force: true }] });
    expect((await owner.get('/api/costs/duplicates')).some((d: { originalDescription: string }) => d.originalDescription === 'Electrical')).toBe(false);
    expect(await ledgerTotal(env.sql)).toBe(0);
  });
});
