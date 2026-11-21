import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ruleFor, type BankRule } from '../../src/modules/bank/match.js';
import { fingerprints, parseStatement, parseStatementAmount, parseStatementOfx, parseStatementQif } from '../../src/modules/bank/parse.js';
import { MAX_BANK_RULES } from '../../src/modules/bank/routes.js';
import { MAX_CSV_CELL, MAX_CSV_ROWS } from '../../src/modules/clients.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

// The reviews of 1.33: statements read in one pass and held to a CSV's limits, one account a file,
// amounts written the other way round, and rules held to a number. Made-up statements throughout.

const ofx = (body: string, more = '') => `OFXHEADER:100
DATA:OFXSGML

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>ZAR
<BANKTRANLIST>
${body}
</BANKTRANLIST>
${more}
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
const trn = (fitid: string, date: string, amount: string, name: string, type = '') => `<STMTTRN>${type ? `\n<TRNTYPE>${type}` : ''}
<DTPOSTED>${date}
<TRNAMT>${amount}
<FITID>${fitid}
<NAME>${name}
</STMTTRN>`;

describe('reading a statement file (security and accounting reviews of 1.33)', () => {
  it('reads a file made to hold the server up in one pass: a ledger balance with no end, repeated to 10 MB', () => {
    const text = ofx(trn('1', '20260403', '-650.00', 'MADE-UP GARAGE')).replace('</STMTRS>', '') + '<LEDGERBAL>'.repeat(900_000);
    expect(text.length).toBeGreaterThan(9_900_000);
    const t = Date.now();
    const p = parseStatementOfx(text);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(p.rows).toHaveLength(1);
  });

  it('reads many transactions with no closing tags, and no end to the list, in one pass', () => {
    const body = Array.from({ length: 60_000 }, (_, i) => `<STMTTRN><DTPOSTED>20260403<TRNAMT>-1.00<FITID>${i}<NAME>MADE-UP ${i}`).join('\n');
    const t = Date.now();
    const p = parseStatementOfx(`OFXHEADER:100\n<OFX><STMTRS><BANKTRANLIST>\n${body}`);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(p.rows).toHaveLength(60_000);
  });

  it('cuts a long description to a CSV cell’s length, and refuses more transactions than a CSV’s rows', () => {
    const long = 'MADE-UP PAYEE '.repeat(10_000);
    expect(parseStatementOfx(ofx(trn('1', '20260403', '-1.00', long))).rows[0]!.description.length).toBe(MAX_CSV_CELL);
    expect(parseStatementQif(`!Type:Bank\nD04/03/2026\nT-1.00\nP${long}\n^\n`).rows[0]!.description.length).toBe(MAX_CSV_CELL);
    const many = '!Type:Bank\n' + 'D03/04/2026\nT-1.00\nPMADE-UP\n^\n'.repeat(MAX_CSV_ROWS + 1);
    expect(() => parseStatementQif(many)).toThrow(/too many transactions/);
  });

  it('keeps a fingerprint short enough for the database however long the description', () => {
    const [key] = fingerprints([{ date: '2026-04-03', amountCents: -100, description: 'x9'.repeat(5000), balanceCents: null }]);
    expect(key!.length).toBeLessThan(2100);
    // A description of ordinary length gives the same key as before.
    expect(fingerprints([{ date: '2026-04-03', amountCents: -100, description: 'Made-up Garage', balanceCents: null }])).toEqual(['2026-04-03|-100|madeupgarage|1']);
  });

  it('refuses a file with more than one account’s statement in it', () => {
    const two = `${ofx(trn('1', '20260403', '-10.00', 'MADE-UP A'))}\n<STMTRS><BANKTRANLIST>${trn('2', '20260404', '-20.00', 'MADE-UP B')}</BANKTRANLIST></STMTRS>`;
    expect(() => parseStatementOfx(two)).toThrow(/more than one account/);
    const qif = '!Account\nNMade-up cheque\nTBank\n^\n!Type:Bank\nD03/04/2026\nT-10.00\nPMADE-UP A\n^\n!Account\nNMade-up savings\nTBank\n^\n!Type:Bank\nD04/04/2026\nT-20.00\nPMADE-UP B\n^\n';
    expect(() => parseStatementQif(qif)).toThrow(/more than one account/);
    // One account's block is read as the account, not as a line that couldn't be read.
    const one = parseStatementQif('!Account\nNMade-up cheque\nTBank\n^\n!Type:Bank\nD03/04/2026\nT-10.00\nPMADE-UP A\n^\n');
    expect(one.rows).toHaveLength(1);
    expect(one.skipped).toBe(0);
  });

  it('reads amounts written -.50 and 1.234,56', () => {
    expect(parseStatementAmount('-.50')).toBe(-50);
    expect(parseStatementAmount('1.234,56')).toBe(123_456);
    expect(parseStatementAmount('1,234.56')).toBe(123_456);
    expect(parseStatementAmount('-1 234,56')).toBe(-123_456);
    expect(parseStatementAmount('12,50')).toBe(1250);
  });

  it('takes a debit marked DEBIT as money out, brings a repeated transaction in once, and decodes &amp; last', () => {
    const p = parseStatementOfx(ofx([trn('1', '20260403', '650.00', 'MADE-UP GARAGE', 'DEBIT'), trn('1', '20260403', '650.00', 'MADE-UP GARAGE', 'DEBIT'), trn('2', '20260404', '10.00', 'A &amp;lt;B&amp;gt; &amp;amp; C &#38; D', 'CREDIT')].join('\n')));
    expect(p.rows.map((r) => r.amountCents)).toEqual([-65_000, 1000]);
    expect(p.skipped).toBe(1);
    expect(p.rows[1]!.description).toBe('A &lt;B&gt; &amp; C & D');
  });
});

describe('bringing a statement in, and rules (security review of 1.33)', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  let bank: string;
  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
    bank = await (await ref(env.sql)).src('Business bank');
    const { settings: s } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...s, features: { ...s.features, bank: true } }, 'PUT');
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('brings in a QIF, an OFX and a CSV with a very long description (not a server error)', async () => {
    const long = 'MADEUPPAYEE'.repeat(9000);
    const q = await owner.call({ method: 'POST', url: '/api/bank/statements', payload: { sourceId: bank, csv: `!Type:Bank\nD03/04/2026\nT-1.00\nP${long}\n^\n`, filename: 'a.qif' } });
    expect(q.statusCode).toBe(200);
    const o = await owner.call({ method: 'POST', url: '/api/bank/statements', payload: { sourceId: bank, csv: ofx(trn('9', '20260405', '-2.00', long)), filename: 'a.ofx' } });
    expect(o.statusCode).toBe(200);
    const random = Array.from({ length: 3990 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789'[(i * 7919) % 36]).join('');
    const c = await owner.call({ method: 'POST', url: '/api/bank/statements', payload: { sourceId: bank, csv: `Date,Description,Amount\n06/04/2026,${random},-3.00\n`, filename: 'a.csv' } });
    expect(c.statusCode).toBe(200);
  });

  it('holds rules to a number, and logs what a rule replaced', async () => {
    const r = await ref(env.sql);
    const petrol = await r.cat('Petrol');
    const bankCat = await r.cat('Bank');
    await owner.post('/api/bank/rules', { matchText: 'MADE-UP GARAGE', direction: 'out', categoryId: petrol, supplier: 'Made-up Garage' });
    await owner.post('/api/bank/rules', { matchText: 'made-up garage', direction: 'out', categoryId: bankCat, supplier: '' });
    const [a] = await env.sql<{ details: { replaced?: { categoryId: string; supplier: string }; categoryId: string } }[]>`select details from audit_log where action = 'save_bank_rule' order by id desc limit 1`;
    expect(a!.details.replaced).toMatchObject({ categoryId: petrol, supplier: 'Made-up Garage' });
    expect(a!.details.categoryId).toBe(bankCat);
    await env.sql`insert into bank_rules (match_text, direction, category_id, supplier) select 'MADE-UP RULE ' || g, 'out', ${petrol}, '' from generate_series(2, ${MAX_BANK_RULES}) g`;
    const next = await owner.call({ method: 'POST', url: '/api/bank/rules', payload: { matchText: 'ONE TOO MANY', direction: 'out', categoryId: petrol } });
    expect(next.statusCode).toBe(400);
    expect(next.json().error).toMatch(/500 rules already/);
    // Changing one that's there is still fine.
    expect((await owner.call({ method: 'POST', url: '/api/bank/rules', payload: { matchText: 'MADE-UP RULE 7', direction: 'out', categoryId: bankCat } })).statusCode).toBe(200);
  });

  it('checks 5 000 lines against 500 rules quickly', () => {
    const rules: BankRule[] = Array.from({ length: 500 }, (_, i) => ({ id: String(i), matchText: `MADE-UP SUPPLIER ${i}`, direction: 'out', categoryId: 'c', incomeAccountId: null, supplier: '' }));
    const t = Date.now();
    let hits = 0;
    for (let i = 0; i < 5000; i++) if (ruleFor(`POS PURCHASE MADE-UP SUPPLIER ${i % 700} 4567*1234`, -100, rules)) hits++;
    expect(Date.now() - t).toBeLessThan(1500);
    expect(hits).toBeGreaterThan(0);
  });
});

// The statement reader also dispatches by content: a made-up OFX still reads through parseStatement.
it('parseStatement still reads an OFX', () => {
  expect(parseStatement(ofx(trn('1', '20260403', '-1.00', 'MADE-UP'))).rows).toHaveLength(1);
});
