import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ruleFor } from '../src/modules/bank/match.js';
import { parseStatement, parseStatementOfx, parseStatementQif, statementFormat } from '../src/modules/bank/parse.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from './helpers.js';

// Made-up statements: no real account, card or person.
const OFX1 = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>ZAR
<BANKTRANLIST>
<DTSTART>20260401
<DTEND>20260430
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260403120000
<TRNAMT>-650.00
<FITID>1001
<NAME>ENGEN WALMER
<MEMO>POS PURCHASE 4567*1234
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260405
<TRNAMT>2500.00
<FITID>1002
<NAME>MADE-UP CLIENT PTY LTD
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260407
<TRNAMT>-69.00
<FITID>1003
<NAME>MONTHLY ACCOUNT FEE
<MEMO>MONTHLY ACCOUNT FEE
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>8781.00<DTASOF>20260430</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

// OFX 2 is XML, with closing tags.
const OFX2 = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="220"?>
<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260410</DTPOSTED><TRNAMT>-1200.50</TRNAMT><FITID>a1</FITID><NAME>BUILDERS &amp; CO</NAME></STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>-1200.50</BALAMT><DTASOF>20260430</DTASOF></LEDGERBAL></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;

const QIF = `!Type:Bank
D03/04/2026
T-650.00
PENGEN WALMER
MPOS PURCHASE
^
D5/ 4'26
T2,500.00
PMADE-UP CLIENT PTY LTD
^
D07/04/2026
U-69.00
PMONTHLY ACCOUNT FEE
^
`;

describe('reading OFX and QIF statements', () => {
  it('tells the formats apart by what’s in the file', () => {
    expect(statementFormat(OFX1)).toBe('ofx');
    expect(statementFormat(OFX2)).toBe('ofx');
    expect(statementFormat(QIF)).toBe('qif');
    expect(statementFormat('Date,Amount,Description\n2026/04/03,-650.00,ENGEN')).toBe('csv');
  });

  it('reads OFX 1 (SGML): dates, signed amounts, name and memo, and the closing balance on the last line', () => {
    const p = parseStatementOfx(OFX1);
    expect(p.rows).toEqual([
      { date: '2026-04-03', description: 'ENGEN WALMER POS PURCHASE 4567*1234', amountCents: -65000, balanceCents: null },
      { date: '2026-04-05', description: 'MADE-UP CLIENT PTY LTD', amountCents: 250000, balanceCents: null },
      // The memo that only repeats the name isn't said twice.
      { date: '2026-04-07', description: 'MONTHLY ACCOUNT FEE', amountCents: -6900, balanceCents: 878100 },
    ]);
    expect(p.columns.balance).toBe('LEDGERBAL');
  });

  it('reads OFX 2 (XML), and a card statement flips with its balance', () => {
    const p = parseStatement(OFX2, { flip: true });
    expect(p.rows).toEqual([{ date: '2026-04-10', description: 'BUILDERS & CO', amountCents: 120050, balanceCents: 120050 }]);
  });

  it('reads QIF, Quicken’s short dates included', () => {
    const p = parseStatementQif(QIF);
    expect(p.rows.map((r) => [r.date, r.description, r.amountCents])).toEqual([
      ['2026-04-03', 'ENGEN WALMER POS PURCHASE', -65000],
      ['2026-04-05', 'MADE-UP CLIENT PTY LTD', 250000],
      ['2026-04-07', 'MONTHLY ACCOUNT FEE', -6900],
    ]);
  });

  it('says so when a file has no transactions', () => {
    expect(() => parseStatement('<OFX><BANKTRANLIST></BANKTRANLIST></OFX>')).toThrow(/No transactions/);
    expect(() => parseStatement('!Type:Bank\n^\n')).toThrow(/No transactions/);
  });

  it('stays quick on a large or crafted file', () => {
    const many = `<OFX><BANKTRANLIST>${Array.from({ length: 20000 }, (_, i) => `<STMTTRN><DTPOSTED>20260401<TRNAMT>-${(i % 900) + 1}.00<NAME>MADE-UP ${i}`).join('\n')}</BANKTRANLIST></OFX>`;
    const t = Date.now();
    expect(parseStatement(many).rows).toHaveLength(20000);
    expect(() => parseStatement(`<OFX>${'<STMTTRN>'.repeat(50000)}`)).toThrow(/No transactions/);
    expect(() => parseStatement(`<OFX><STMTTRN>${'<'.repeat(200000)}`)).toThrow(/No transactions/);
    expect(Date.now() - t).toBeLessThan(3000);
  });
});

describe('the rule a line fits', () => {
  const rules = [
    { id: 'a', matchText: 'engen', direction: 'out' as const, categoryId: 'fuel', incomeAccountId: null, supplier: 'Engen' },
    { id: 'b', matchText: 'Engen  Walmer', direction: 'out' as const, categoryId: 'fuel2', incomeAccountId: null, supplier: '' },
    { id: 'c', matchText: 'MADE-UP CLIENT', direction: 'in' as const, categoryId: null, incomeAccountId: 'other', supplier: '' },
  ];
  it('matches any case and spacing, money the same way, the longest rule first', () => {
    expect(ruleFor('POS PURCHASE ENGEN WALMER 1234', -65000, rules)?.id).toBe('b');
    expect(ruleFor('ENGEN SUMMERSTRAND', -30000, rules)?.id).toBe('a');
    // Money in from Engen (a refund) isn't a money-out rule's.
    expect(ruleFor('ENGEN REFUND', 5000, rules)).toBeNull();
    expect(ruleFor('MADE-UP CLIENT PTY LTD', 250000, rules)?.id).toBe('c');
    expect(ruleFor('MONTHLY ACCOUNT FEE', -6900, rules)).toBeNull();
  });
});

describe('importing OFX and QIF, and saved rules', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  let bank: string;
  let fuel: string;
  let otherIncome: string;
  let stockCat: string | undefined;

  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    bank = await r.src('Business bank');
    fuel = (await env.sql<{ id: string }[]>`select id from cost_categories where name ilike '%fuel%' or name ilike '%petrol%' limit 1`)[0]!.id;
    otherIncome = await r.acc('revenue_other');
    stockCat = (await env.sql<{ id: string }[]>`select id from cost_categories where kind = 'stock' limit 1`)[0]?.id;
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('previews and imports an OFX file like a CSV, with its closing balance', async () => {
    const p = await owner.post('/api/bank/preview', { sourceId: bank, csv: OFX1, filename: 'april.ofx' });
    expect(p).toMatchObject({ count: 3, from: '2026-04-03', to: '2026-04-07', inCents: 250000, outCents: 71900 });
    const r = await owner.post('/api/bank/statements', { sourceId: bank, csv: OFX1, filename: 'april.ofx' });
    expect(r).toMatchObject({ added: 3, duplicates: 0 });
    const [st] = await env.sql<{ closing: number }[]>`select closing_balance_cents as closing from bank_statements where filename = 'april.ofx'`;
    expect(st!.closing).toBe(878100);
  });

  it('skips the same transactions when they come again as QIF', async () => {
    const r = await owner.post('/api/bank/statements', { sourceId: bank, csv: QIF, filename: 'april.qif' });
    // QIF's ENGEN line has a different description (no card memo), so it's new; the others are the same.
    expect(r.duplicates).toBe(2);
  });

  it('saves a rule, and fills in the cost type and supplier from it ahead of Shap’s guess', async () => {
    const before = (await owner.get(`/api/bank/recon?sourceId=${bank}`)).lines.find((l: { description: string }) => l.description.startsWith('ENGEN WALMER POS'));
    expect(before.rule).toBeNull();
    const saved = await owner.post('/api/bank/rules', { matchText: 'engen', direction: 'out', categoryId: fuel, supplier: 'Engen (made-up rule)' });
    const after = (await owner.get(`/api/bank/recon?sourceId=${bank}`)).lines.filter((l: { description: string }) => /ENGEN/.test(l.description));
    expect(after.length).toBe(2);
    for (const l of after) expect(l).toMatchObject({ categoryId: fuel, supplier: 'Engen (made-up rule)', rule: { id: saved.id, matchText: 'engen' } });
    // The same words again replace the rule rather than adding a second.
    await owner.post('/api/bank/rules', { matchText: 'ENGEN', direction: 'out', categoryId: fuel, supplier: 'Engen' });
    const list = await owner.get('/api/bank/rules');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ matchText: 'ENGEN', supplier: 'Engen', categoryName: expect.any(String) });
  });

  it('a money-in rule can book income; nothing is captured until the line is ticked', async () => {
    await owner.post('/api/bank/rules', { matchText: 'MADE-UP CLIENT', direction: 'in', incomeAccountId: otherIncome });
    const line = (await owner.get(`/api/bank/recon?sourceId=${bank}`)).lines.find((l: { description: string }) => l.description === 'MADE-UP CLIENT PTY LTD');
    expect(line).toMatchObject({ incomeAccountId: otherIncome, categoryId: null, rule: { matchText: 'MADE-UP CLIENT' } });
    const [none] = await env.sql<{ n: number }[]>`select count(*)::int as n from costs where note like 'From statement:%'`;
    expect(none!.n).toBe(0);
    // Ticked and captured, the rule's choices are what's posted.
    const lines = (await owner.get(`/api/bank/recon?sourceId=${bank}`)).lines.filter((l: { state: string; rule: unknown }) => l.state === 'open' && l.rule);
    const r = await owner.post('/api/bank/lines/create-costs', {
      items: lines.map((l: { id: string; categoryId: string | null; incomeAccountId: string | null; supplier: string }) => ({ lineId: l.id, categoryId: l.categoryId, incomeAccountId: l.incomeAccountId, supplier: l.supplier })),
    });
    expect(r.created).toBe(3);
  });

  it('refuses a rule that can’t work: too short, money out as income, stock, or a cost type and income at once', async () => {
    const bad = async (body: object) => (await owner.call({ method: 'POST', url: '/api/bank/rules', payload: body as never })).statusCode;
    expect(await bad({ matchText: 'ab', direction: 'out', categoryId: fuel })).toBe(400);
    expect(await bad({ matchText: 'interest', direction: 'out', incomeAccountId: otherIncome })).toBe(400);
    expect(await bad({ matchText: 'both', direction: 'in', categoryId: fuel, incomeAccountId: otherIncome })).toBe(400);
    if (stockCat) expect(await bad({ matchText: 'stock', direction: 'out', categoryId: stockCat })).toBe(400);
  });

  it('takes a rule away, and only someone who reconciles the bank may see or change rules', async () => {
    const [rule] = await owner.get('/api/bank/rules');
    await owner.post(`/api/bank/rules/${rule.id}`, {}, 'DELETE');
    expect((await owner.get('/api/bank/rules')).some((r: { id: string }) => r.id === rule.id)).toBe(false);
    const [logged] = await env.sql<{ n: number }[]>`select count(*)::int as n from audit_log where action in ('save_bank_rule', 'delete_bank_rule')`;
    expect(logged!.n).toBeGreaterThanOrEqual(3);
    const { createUser } = await import('../src/auth.js');
    await createUser(env.sql, { name: 'Made-up Site Hand', email: 'site-rules@example.co.za', password: 'test-password-1', role: 'staff', accessAdd: [] });
    const staff = await login(env.app, 'site-rules@example.co.za');
    expect((await staff.call({ method: 'GET', url: '/api/bank/rules' })).statusCode).toBe(403);
    expect((await staff.call({ method: 'POST', url: '/api/bank/rules', payload: { matchText: 'engen', direction: 'out', categoryId: fuel } })).statusCode).toBe(403);
  });
});
