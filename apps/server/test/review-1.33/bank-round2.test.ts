import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_GROUPS } from '@shap/shared';
import { ruleFor, type BankRule } from '../../src/modules/bank/match.js';
import { parseStatementOfx, parseStatementQif } from '../../src/modules/bank/parse.js';
import { MAX_BANK_RULES } from '../../src/modules/bank/routes.js';
import { MAX_CSV_ROWS } from '../../src/modules/clients.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

// The second round of 1.33's reviews (security, accounting): every transaction counts against the
// limit, the ledger balance is found letter for letter, entities decoded once, an unsigned file
// read by its types, a repeated id only when it's the same transaction, a QIF account list read as
// a list, rules held to their number however they're sent, and their words tidied once. Made-up.

const ofx = (body: string, more = '') => `OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>\n<BANKTRANLIST>\n${body}\n</BANKTRANLIST>\n${more}</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
const trn = (fitid: string, date: string, amount: string, name: string, type = '') => `<STMTTRN>${type ? `<TRNTYPE>${type}` : ''}<DTPOSTED>${date}<TRNAMT>${amount}<FITID>${fitid}<NAME>${name}</STMTTRN>`;

describe('reading a statement, second round', () => {
  it('counts every transaction against the limit, read or not, and refuses quickly', () => {
    const text = `OFXHEADER:100\n<OFX><STMTRS><BANKTRANLIST>${'<STMTTRN>'.repeat(MAX_CSV_ROWS + 1)}`;
    const t = Date.now();
    expect(() => parseStatementOfx(text)).toThrow(/too many transactions/);
    expect(Date.now() - t).toBeLessThan(1500);
  });

  it('finds the ledger balance letter for letter (a ß doesn’t move it onto the available balance)', () => {
    const text = ofx(trn('1', '20260403', '-1.00', 'MADE-UP'), `<LEDGERBAL><MEMO>${'ß'.repeat(300)}</LEDGERBAL><AVAILBAL><BALAMT>999.00</AVAILBAL>`);
    expect(parseStatementOfx(text).rows[0]!.balanceCents).toBeNull();
  });

  it('decodes entities once', () => {
    // &#38; is "&": once decoded, "&#38;lt;" is the text "&lt;", not "<".
    expect(parseStatementOfx(ofx(trn('1', '20260403', '-1.00', '&#38;lt;B&#38;gt;'))).rows[0]!.description).toBe('&lt;B&gt;');
    const p = parseStatementOfx(ofx(trn('1', '20260403', '-1.00', '&amp;#38;lt;B&amp;#38;gt; &amp;#x26;amp;')));
    expect(p.rows[0]!.description).toBe('&#38;lt;B&#38;gt; &#x26;amp;');
  });

  it('trusts a signed file’s signs, and reads an unsigned one by its transaction types', () => {
    // A debit order reversed: DEBIT, but money back in.
    const signed = parseStatementOfx(ofx([trn('1', '20260403', '-100.00', 'MADE-UP ORDER', 'DEBIT'), trn('2', '20260404', '100.00', 'MADE-UP ORDER REVERSED', 'DEBIT')].join('\n')));
    expect(signed.rows.map((r) => r.amountCents)).toEqual([-10_000, 10_000]);
    const unsigned = parseStatementOfx(ofx([trn('1', '20260403', '50.00', 'MADE-UP SHOP', 'POS'), trn('2', '20260403', '5.00', 'MADE-UP FEE', 'FEE'), trn('3', '20260404', '300.00', 'MADE-UP ATM', 'ATM'), trn('4', '20260405', '900.00', 'MADE-UP CLIENT', 'DEP')].join('\n')));
    expect(unsigned.rows.map((r) => r.amountCents)).toEqual([-5_000, -500, -30_000, 90_000]);
  });

  it('brings a repeated id in once only when it’s the same transaction', () => {
    const p = parseStatementOfx(ofx([trn('1', '20261101', '-100.00', 'MADE-UP A'), trn('1', '20261101', '-100.00', 'MADE-UP A'), trn('1', '20261102', '-70.00', 'MADE-UP B')].join('\n')));
    expect(p.rows.map((r) => r.amountCents)).toEqual([-10_000, -7_000]);
    expect(p.skipped).toBe(1);
  });

  it('reads a QIF account list between AutoSwitch lines as a list, and refuses a second kind of account', () => {
    const one = '!Option:AutoSwitch\n!Account\nNMade-up cheque\nTBank\n^\n!Clear:AutoSwitch\n!Account\nNMade-up cheque\nTBank\n^\n!Type:Bank\nD03/04/2026\nT-10.00\nPMADE-UP A\n^\n';
    expect(parseStatementQif(one).rows).toHaveLength(1);
    const two = '!Type:Bank\nD03/04/2026\nT-10.00\nPMADE-UP A\n^\n!Type:CCard\nD04/04/2026\nT-20.00\nPMADE-UP B\n^\n';
    expect(() => parseStatementQif(two)).toThrow(/more than one account/);
  });
});

describe('rules, second round', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
    const { settings: s } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...s, features: { ...s.features, bank: true } }, 'PUT');
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('tidies each rule’s words once, not once a line', () => {
    let reads = 0;
    const rules: BankRule[] = Array.from({ length: 500 }, (_, i) => {
      const r = { id: String(i), direction: 'out' as const, categoryId: 'c', incomeAccountId: null, supplier: '' } as BankRule;
      Object.defineProperty(r, 'matchText', { get: () => (reads++, `MADE-UP SUPPLIER ${i}`) });
      return r;
    });
    for (let i = 0; i < 5000; i++) ruleFor(`POS MADE-UP LINE ${i}`, -100, rules);
    // Each read once to tidy it (and a few more for the longest), not 2.5 million times.
    expect(reads).toBeLessThan(2000);
  });

  it('holds rules to their number when they’re sent at once', async () => {
    const petrol = await (await ref(env.sql)).cat('Petrol');
    await env.sql`insert into bank_rules (match_text, direction, category_id, supplier) select 'MADE-UP RULE ' || g, 'out', ${petrol}, '' from generate_series(2, ${MAX_BANK_RULES}) g`;
    const sent = await Promise.all(Array.from({ length: 20 }, (_, i) => owner.call({ method: 'POST', url: '/api/bank/rules', payload: { matchText: `MADE-UP AT ONCE ${i}`, direction: 'out', categoryId: petrol } })));
    const [count] = await env.sql<{ n: number }[]>`select count(*)::int as n from bank_rules`;
    expect(count!.n).toBeLessThanOrEqual(MAX_BANK_RULES);
    expect(sent.filter((r) => r.statusCode === 200)).toHaveLength(1);
  });

  it('slows rules sent faster than anyone would make them', async () => {
    const petrol = await (await ref(env.sql)).cat('Petrol');
    let limited = false;
    for (let i = 0; i < 61 && !limited; i++) {
      const r = await owner.call({ method: 'POST', url: '/api/bank/rules', payload: { matchText: 'MADE-UP RULE 7', direction: 'out', categoryId: petrol } });
      if (r.statusCode === 429) limited = true;
    }
    expect(limited).toBe(true);
  });
});

it('the reports task says it opens the forecast, with salary totals', () => {
  const reports = ACCESS_GROUPS.flatMap((g) => g.tasks as readonly { key: string; hint?: string }[]).find((t) => t.key === 'reports.view')!;
  expect(reports.hint).toMatch(/the cash-flow forecast \(with salary totals\) and the budgets/);
});

describe('a rule for an income account that’s no longer income', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('is listed as not applied', async () => {
    const owner = await login(env.app, 'owner@example.co.za');
    const { settings: s } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...s, features: { ...s.features, bank: true } }, 'PUT');
    const [inc] = await env.sql<{ id: string }[]>`insert into accounts (code, name, type) values ('4095', 'Made-up rent received', 'income') returning id`;
    await owner.post('/api/bank/rules', { matchText: 'MADE-UP TENANT', direction: 'in', incomeAccountId: inc!.id });
    expect((await owner.get('/api/bank/rules'))[0].usable).toBe(true);
    await env.sql`update accounts set type = 'liability', statement_line = null where id = ${inc!.id}`;
    expect((await owner.get('/api/bank/rules'))[0].usable).toBe(false);
  });
});
