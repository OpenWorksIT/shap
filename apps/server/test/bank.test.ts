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
});
