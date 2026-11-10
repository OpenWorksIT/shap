/**
 * The annual financial statements (IFRS for SMEs), built from two years of made-up books: each
 * statement adds up, they agree with each other and the books (the statement of financial
 * position balances, the cash flows are the change in cash, the changes in equity end at the
 * equity shown), every account lands on its line, and the sign-off runs from draft to approved,
 * the year closed at the signed figures. All data made up.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { STATEMENT_LINE_KEYS, defaultLineFor } from '@shap/shared';
import { buildStatements } from '../src/statements/build.js';
import { renderStatementsPdf } from '../src/statements/pdf.js';
import { balance, expectCleanAudit, login, ref, setup, type TestEnv } from './helpers.js';

const Y1 = '2025-02-28';
const Y2 = '2026-02-28';

describe('the financial statements', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let acc: Awaited<ReturnType<typeof login>>;
  let bank: string;

  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    acc = await login(env.app, 'accountant@example.co.za');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, companyName: 'Fictional Trading (Pty) Ltd', regNumber: '2020/123456/07', vatRegistered: true, vatNumber: '4740101508', address: '1 Test Street, Fictional Town, 0001', features: { ...settings.features, statements: true, inventory: true } }, 'PUT');
    const r = await ref(env.sql);
    bank = await r.src('Business bank');
    const owner = await r.acc('owner_loan');
    const shares = await r.acc('share_capital');
    // Year 1: shares issued, a loan from the shareholder, a vehicle, sales and costs.
    await me.post('/api/journals', { date: '2024-03-01', description: 'Shares issued (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 10_000 }, { accountId: shares, creditCents: 10_000 }] });
    await me.post('/api/journals', { date: '2024-03-02', description: 'Loan from the shareholder (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 20_000_000 }, { accountId: owner, creditCents: 20_000_000 }] });
    await me.post('/api/assets', { name: 'Fictional bakkie', category: 'vehicles', purchaseDate: '2024-04-01', costCents: 18_000_000, vatCents: 0, lifeMonths: 60, sourceId: bank });
    const client = await me.post('/api/clients', { name: 'Fictional Client', address: '2 Test Road, Fictional Town' });
    const inv1 = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: '2024-09-10', lines: [{ category: 'labour', description: 'Work (made up)', qty: 1, unitPriceCents: 9_000_000 }] });
    await me.post(`/api/documents/${inv1.id}/issue`);
    await me.post(`/api/documents/${inv1.id}/receipts`, { date: '2024-10-01', amountCents: 10_350_000, sourceId: bank });
    await me.post('/api/costs', { date: '2024-11-01', description: 'Rent (made up)', amountCents: 1_150_000, vatCents: 150_000, vatCode: 'standard', categoryId: await r.cat('Rent').catch(() => r.cat('Tool')), sourceId: bank });
    // Year 2: stock bought and sold, an invoice still owed at year end, the loan partly repaid, dividends.
    const item = await me.post('/api/items', { description: 'Fictional widget', unitPriceCents: 23_000, priceIncludesVat: true, stocked: true });
    await me.post('/api/stock/purchases', { date: '2025-06-01', supplier: 'Fictional Supplier', reference: 'FS-1', sourceId: bank, lines: [{ itemId: item.id, qtyInvoiced: 100, unitCostCents: 10_000 }] });
    const till = (await env.sql<{ id: string }[]>`select id from payment_sources where till`)[0]!.id;
    await me.post('/api/sales', { date: '2025-07-01', sourceId: till, lines: [{ itemId: item.id, description: 'Fictional widget', qty: 20, unitPriceCents: 23_000 }] });
    await me.post('/api/stock/takes', { date: '2026-02-28', lines: [{ itemId: item.id, countedQty: 78, reason: 'Two missing at the count' }] });
    const inv2 = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: '2026-02-10', lines: [{ category: 'labour', description: 'More work (made up)', qty: 1, unitPriceCents: 5_000_000 }] });
    await me.post(`/api/documents/${inv2.id}/issue`);
    await me.post('/api/journals', { date: '2025-12-01', description: 'Part of the loan repaid (made up)', lines: [{ accountId: owner, debitCents: 5_000_000 }, { accountId: await r.acc('bank'), creditCents: 5_000_000 }] });
  });
  afterAll(() => env.close());

  it('puts every account on a line that fits it', async () => {
    const rows = await env.sql<{ code: string; type: string; systemKey: string | null; statementLine: string; name: string }[]>`select code, type, system_key, statement_line, name from accounts`;
    for (const r of rows) expect(STATEMENT_LINE_KEYS).toContain(r.statementLine);
    // The database's rules and the shared ones agree, account by account.
    for (const r of rows) expect(r.statementLine).toBe(defaultLineFor({ systemKey: r.systemKey, type: r.type as never, name: r.name }));
    // A new account picks one; a rename keeps a chosen one; a type change it doesn't fit resets it.
    const a = await me.post('/api/accounts', { code: '1700', name: 'Fictional investment', type: 'asset', statementLine: 'investments' });
    expect(a.statementLine).toBe('investments');
    const renamed = await me.post(`/api/accounts/${a.id}`, { code: '1700', name: 'Fictional unit trust', type: 'asset', active: true }, 'PUT');
    expect(renamed.statementLine).toBe('investments');
    const asLiability = await me.post(`/api/accounts/${a.id}`, { code: '1700', name: 'Fictional loan', type: 'liability', active: true }, 'PUT');
    expect(asLiability.statementLine).toBe('trade_payables');
    const refused = await me.call({ method: 'POST', url: '/api/accounts', payload: { code: '1701', name: 'Wrong', type: 'asset', statementLine: 'revenue' } });
    expect(refused.statusCode).toBe(400);
    await me.post(`/api/accounts/${a.id}`, { code: '1700', name: 'Fictional loan', type: 'liability', active: false }, 'PUT');
  });

  it('adds up: the position balances, the cash flows are the change in cash, equity ties', async () => {
    for (const y of [Y1, Y2]) {
      const s = await buildStatements(env.sql, y);
      expect(s.checks.filter((c) => !c.ok)).toEqual([]);
    }
    const s = await buildStatements(env.sql, Y2);
    expect(s.hasPrior).toBe(true);
    // The position agrees with the books at each year end.
    expect(s.sfp.assets.find((b) => b.key === 'current_assets')!.lines.find((l) => l.key === 'cash')!.current).toBe((await balance(env.sql, 'bank', Y2)) + (await balance(env.sql, 'cash_on_hand_none', Y2)) + Number((await env.sql<{ b: string }[]>`select coalesce(sum(l.amount_cents), 0) as b from ledger l join accounts a on a.id = l.account_id where a.statement_line = 'cash' and a.system_key is distinct from 'bank' and l.date <= ${Y2}::date`)[0]!.b));
    const inventories = s.sfp.assets.flatMap((b) => b.lines).find((l) => l.key === 'inventories')!;
    expect(inventories.current).toBe(780_000);
    expect(inventories.prior).toBe(0);
    // Profit: the same in the income statement, the changes in equity and the cash flows.
    expect(s.soce.rows.find((r) => r.label === 'Profit for the year' && r.total === s.sci.profit.current)).toBeTruthy();
    expect(s.scf.operating[0]).toMatchObject({ key: 'pbt', current: s.sci.profitBeforeTax.current });
    // The vehicle: cost, depreciation, carrying amount, and its reconciliation.
    const ppe = s.notes.find((n) => n.key === 'ppe')!;
    const carrying = ppe.tables[0]!.rows.find((r) => r.label === 'Carrying amount')!;
    expect(carrying.current).toBe(s.sfp.assets[0]!.lines.find((l) => l.key === 'ppe')!.current);
    const recon = ppe.tables[1]!.rows;
    expect(recon.at(-1)!.current).toBe(recon.slice(0, -1).reduce((t, r) => t + (r.current ?? 0), 0));
    // Inventories note: what was expensed is cost of sales and the stock lost.
    const invNote = s.notes.find((n) => n.key === 'inventories')!;
    expect(invNote.tables[1]!.rows[0]!.current).toBe(20 * 10_000 + 2 * 10_000);
    // Loans from the shareholder, with no fixed terms of repayment: current (IFRS for SMEs 4.7(d)),
    // with its terms; repaid R50 000 in financing.
    expect(s.sfp.liabilities.find((b) => b.key === 'current_liabilities')!.lines.find((l) => l.key === 'shareholder_loans_current')).toMatchObject({ current: 15_000_000, prior: 20_000_000 });
    expect(s.scf.financing.find((l) => l.key === 'owner_loans')).toMatchObject({ current: -5_000_000, prior: 20_000_000 });
    // Notes are numbered in order, each referred to from its line.
    expect(s.notes.map((n) => n.number)).toEqual(s.notes.map((_, i) => i + 1));
    expect(inventories.note).toBe(invNote.number);
  });

  it('prints the set: cover, contents, the statements and notes, DRAFT until approved', async () => {
    const s = await buildStatements(env.sql, Y2);
    const pdf = await renderStatementsPdf(s);
    if (process.env.STATEMENTS_PDF_OUT) (await import('node:fs')).writeFileSync(process.env.STATEMENTS_PDF_OUT, pdf);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(10_000);
    const res = await me.call({ method: 'GET', url: `/api/statements/${Y2}/pdf` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
  });

  it('words the policies: Shap’s for this business, one reworded replaces it, a blank one keeps Shap’s', async () => {
    const before = await buildStatements(env.sql, Y2);
    expect(before.policyDefaults.inventories).toMatch(/weighted average cost/);
    const policies = () => before.notes.find((n) => n.key === 'policies')!.paragraphs;
    expect(policies()).toContain(before.policyDefaults.inventories);
    const details = await acc.get('/api/statements/details');
    await acc.post('/api/statements/details', { ...details, policies: { revenue: 'Revenue is recognised when the goods are handed over (made up wording).', ppe: '   ' } }, 'PUT');
    const after = await buildStatements(env.sql, Y2);
    const paras = after.notes.find((n) => n.key === 'policies')!.paragraphs;
    expect(paras).toContain('Revenue is recognised when the goods are handed over (made up wording).');
    expect(paras).not.toContain(before.policyDefaults.revenue);
    expect(paras).toContain(before.policyDefaults.ppe);
    // The wording isn't part of the signed figures.
    const { figuresHash } = await import('../src/modules/financial-statements.js');
    expect(figuresHash(after)).toBe(figuresHash(before));
    await acc.post('/api/statements/details', { ...details, policies: {} }, 'PUT');
  });

  it('goes from draft to signed: sent, compiled by the accountant in Shap, approved, the year closed', async () => {
    const years = await me.get('/api/statements');
    expect(years.map((y: { fyEnd: string }) => y.fyEnd)).toEqual([Y2, Y1]);
    await me.post(`/api/statements/${Y2}/send`, { to: 'accountant@example.co.za' });
    expect(env.mails.at(-1)!.attachments?.[0]?.filename).toMatch(/DRAFT financial statements 2026\.pdf$/);
    expect((await me.get(`/api/statements/${Y2}`)).status).toBe('sent');
    // Only the accountant signs the compiler's report; the owner approves once it's compiled.
    expect((await me.call({ method: 'POST', url: `/api/statements/${Y2}/compile`, payload: { date: '2026-05-10', compiler: { name: 'Owner', qualification: 'none' } } })).statusCode).toBe(403);
    expect((await me.call({ method: 'POST', url: `/api/statements/${Y2}/approve`, payload: { name: 'Fictional Director', date: '2026-05-12' } })).statusCode).toBe(400);
    await acc.post(`/api/statements/${Y2}/compile`, { date: '2026-05-10', compiler: { name: 'Fictional Accountant', qualification: 'Professional Accountant (SA)', body: 'SAIPA', number: '12345', practice: 'Fictional Accounting CC' } });
    const compiled = await me.get(`/api/statements/${Y2}`);
    expect(compiled.status).toBe('compiled');
    expect(compiled.changedSince).toBe(false);
    // The books change after it was compiled: it can't be approved at figures that are no longer true.
    const late = await me.post('/api/costs', { date: '2026-01-15', description: 'A late slip (made up)', amountCents: 11_500, vatCents: 1_500, vatCode: 'standard', categoryId: (await env.sql<{ id: string }[]>`select id from cost_categories where name = 'Tool'`)[0]!.id, sourceId: bank });
    expect((await me.get(`/api/statements/${Y2}`)).changedSince).toBe(true);
    const stale = await me.call({ method: 'POST', url: `/api/statements/${Y2}/approve`, payload: { name: 'Fictional Director', date: '2026-05-12' } });
    expect(stale.statusCode).toBe(400);
    expect(stale.json().error).toMatch(/books have changed since/);
    await me.call({ method: 'DELETE', url: `/api/costs/${late.id}` });
    await me.post(`/api/statements/${Y2}/approve`, { name: 'Fictional Director', date: '2026-05-12' });
    const done = await me.get(`/api/statements/${Y2}`);
    expect(done.status).toBe('approved');
    // Agreed at the signed figures, closed, and the signed set kept.
    const [s] = await env.sql<{ lockDate: string }[]>`select lock_date::text as lock_date from settings`;
    expect(s!.lockDate).toBe(Y2);
    const [ye] = await env.sql`select 1 from year_ends where fy_end = ${Y2}`;
    expect(ye).toBeTruthy();
    const signed = await me.call({ method: 'GET', url: `/api/statements/${Y2}/pdf` });
    expect(signed.statusCode).toBe(200);
    expect(signed.headers['content-disposition']).not.toMatch(/DRAFT/);
    const log = await env.sql<{ action: string }[]>`select action from audit_log where entity = 'financial_statements' order by id`;
    expect(log.map((l) => l.action)).toEqual(['send_statements', 'compile_statements', 'approve_statements']);
    await expectCleanAudit(env.sql, '2026-06-30');
  });

  it('takes the accountant’s signed report uploaded instead (Pocket’s way, and Shap’s without the accountant signed in)', async () => {
    // The year before: compiled on paper, the signed report uploaded, then approved.
    const file = await me.post('/api/attachments', { filename: 'compiler report.pdf', mime: 'application/pdf', dataBase64: Buffer.from('%PDF-1.4\n% made-up signed report\n').toString('base64') });
    await me.post(`/api/statements/${Y1}/compiler-report`, { attachmentId: file.id, compilerName: 'Fictional Accountant', date: '2025-06-01' });
    await me.post(`/api/statements/${Y1}/approve`, { name: 'Fictional Director', date: '2025-06-02' });
    expect((await me.get(`/api/statements/${Y1}`)).status).toBe('approved');
    const report = await me.call({ method: 'GET', url: `/api/statements/${Y1}/compiler-report` });
    expect(report.statusCode).toBe(200);
  });
});

describe('the years to draw up', () => {
  let env: TestEnv;
  afterAll(() => env.close());
  it('lists each year that has ended from the books as they are (nothing drawn up yet)', async () => {
    env = await setup();
    const me = await login(env.app, 'owner@example.co.za');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, fyEndMonth: 2, features: { ...settings.features, statements: true } }, 'PUT');
    const r = await ref(env.sql);
    await me.post('/api/journals', { date: '2025-04-01', description: 'Shares issued (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 10_000 }, { accountId: await r.acc('share_capital'), creditCents: 10_000 }] });
    const years = await me.get('/api/statements');
    expect(years.map((y: { fyEnd: string }) => y.fyEnd)).toEqual(['2026-02-28']);
  });
});

describe('the statements’ words and lines (from the accountant bot’s run)', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  afterEach(() => env?.close());

  // The words on the pages, as a reader sees them.
  const pdfText = async (buf: Buffer) => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
    let out = '';
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      out += (await page.getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ') + '\n';
    }
    return out.replace(/\s+/g, ' ');
  };

  it('a company: shares issued on their own row, the tax explained against the profit, a first year without “previous year”, other lines in revenue', async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, fyEndMonth: 2, features: { ...settings.features, statements: true } }, 'PUT');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    await me.post('/api/journals', { date: '2025-03-01', description: 'Shares issued (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 10_000 }, { accountId: await r.acc('share_capital'), creditCents: 10_000 }] });
    const client = await me.post('/api/clients', { name: 'Fictional Client', address: '2 Test Road' });
    const inv = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: '2025-06-01', lines: [{ category: 'labour', description: 'Work (made up)', qty: 1, unitPriceCents: 1_000_000 }, { category: 'other', description: 'Call-out (made up)', qty: 1, unitPriceCents: 50_000 }] });
    await me.post(`/api/documents/${inv.id}/issue`);
    await me.post(`/api/documents/${inv.id}/receipts`, { date: '2025-06-10', amountCents: 1_050_000, sourceId: bank });
    await me.post('/api/journals', { date: '2026-02-28', description: 'Income tax (made up)', lines: [{ accountId: await r.acc('income_tax'), debitCents: 100_000 }, { accountId: await r.acc('income_tax_payable'), creditCents: 100_000 }] });
    const s = await buildStatements(env.sql, '2026-02-28');
    expect(s.checks.filter((c) => !c.ok)).toEqual([]);
    expect(s.sci.revenue.reduce((t, l) => t + l.current, 0)).toBe(1_050_000);
    expect(s.sci.otherIncome).toEqual([]);
    expect(s.soce.rows.find((x) => x.label === 'Issue of shares')).toMatchObject({ total: 10_000 });
    const recon = s.notes.find((n) => n.key === 'tax')!.tables[1]!.rows;
    expect(recon.map((x) => x.label)[1]).toMatch(/27%/);
    expect(recon.at(-1)).toMatchObject({ current: 100_000 });
    expect(recon[1]!.current! + recon[2]!.current!).toBe(100_000);
    expect(s.notes.find((n) => n.key === 'policies')!.paragraphs[0]).not.toMatch(/previous year/);
  });

  it('a sole proprietor: the owner’s words, drawings told as drawings, no tax, and the basis note 1 describes', async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, businessType: 'sole_prop', features: { ...settings.features, statements: true } }, 'PUT');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    const client = await me.post('/api/clients', { name: 'Fictional Client', address: '2 Test Road' });
    const inv = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: '2025-06-01', lines: [{ category: 'labour', description: 'Work (made up)', qty: 1, unitPriceCents: 500_000 }] });
    await me.post(`/api/documents/${inv.id}/issue`);
    await me.post(`/api/documents/${inv.id}/receipts`, { date: '2025-06-10', amountCents: 500_000, sourceId: bank });
    await me.post('/api/journals', { date: '2025-07-01', description: 'Drawings (made up)', lines: [{ accountId: await r.acc('owner_loan'), debitCents: 300_000 }, { accountId: await r.acc('bank'), creditCents: 300_000 }] });
    const s = await buildStatements(env.sql, '2026-02-28');
    expect(s.checks.filter((c) => !c.ok)).toEqual([]);
    const report = s.directorsReport;
    expect(report.find((x) => x.title === 'Financial results')!.text).not.toMatch(/after tax/);
    expect(report.find((x) => x.title === 'Contributions and drawings')!.text).toMatch(/drew a net R\s?3 000/);
    expect(report.find((x) => x.title === 'Events after the reporting period')!.text).toMatch(/^The owner is not aware/);
    const text = await pdfText(await renderStatementsPdf(s, { compiler: { name: 'Fictional Accountant', date: '2026-04-01', how: 'uploaded' } }));
    expect(text).toMatch(/Owner.s responsibilities/);
    expect(text).not.toMatch(/owner are|Owner. responsibilities|Registered office|Country of incorporation/);
    expect(text).toMatch(/basis of accounting described in note 1/);
    expect(text).toMatch(/FOR APPROVAL/);
  });

  it('nets a bank overdraft off cash in the cash note, as the cash flows do', async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, fyEndMonth: 2, features: { ...settings.features, statements: true } }, 'PUT');
    const r = await ref(env.sql);
    const petty = await me.post('/api/accounts', { code: '1060', name: 'Petty cash (made up)', type: 'asset' });
    await me.post('/api/journals', { date: '2025-03-01', description: 'Float (made up)', lines: [{ accountId: petty.id, debitCents: 50_000 }, { accountId: await r.acc('share_capital'), creditCents: 50_000 }] });
    await me.post('/api/journals', { date: '2025-04-01', description: 'Equipment on overdraft (made up)', lines: [{ accountId: await r.acc('sundry'), debitCents: 200_000 }, { accountId: await r.acc('bank'), creditCents: 200_000 }] });
    const s = await buildStatements(env.sql, '2026-02-28');
    expect(s.checks.filter((c) => !c.ok)).toEqual([]);
    const note = s.notes.find((n) => n.key === 'cash')!;
    expect(note.tables[0]!.rows.at(-1)!.current).toBe(s.scf.closing.current);
    expect(s.scf.closing.current).toBe(50_000 - 200_000);
    expect(note.paragraphs.join(' ')).toMatch(/net of them/);
  });

  it('keeps an approved year closed: the lock date doesn’t move back until the statements are reopened', async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, fyEndMonth: 2, features: { ...settings.features, statements: true } }, 'PUT');
    const r = await ref(env.sql);
    await me.post('/api/journals', { date: '2025-03-01', description: 'Shares issued (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 10_000 }, { accountId: await r.acc('share_capital'), creditCents: 10_000 }] });
    const file = await me.post('/api/attachments', { filename: 'report.pdf', mime: 'application/pdf', dataBase64: Buffer.from('%PDF-1.4\n% made up\n').toString('base64') });
    await me.post('/api/statements/2026-02-28/compiler-report', { attachmentId: file.id, compilerName: 'Fictional Accountant', date: '2026-04-01' });
    await me.post('/api/statements/2026-02-28/approve', { name: 'Fictional Director', date: '2026-04-02' });
    const now = (await me.get('/api/reference')).settings;
    const moved = await me.call({ method: 'PUT', url: '/api/settings', payload: { ...now, lockDate: null } });
    expect(moved.statusCode).toBe(400);
    expect(moved.json().error).toMatch(/Reopen them first/);
    // Saving settings without touching the lock date still works.
    const { lockDate: _l, ...rest } = now;
    expect((await me.call({ method: 'PUT', url: '/api/settings', payload: rest })).statusCode).toBe(200);
    await me.post('/api/statements/2026-02-28/reopen', { reason: 'A missed invoice (made up)' });
    expect((await me.call({ method: 'PUT', url: '/api/settings', payload: { ...now, lockDate: null } })).statusCode).toBe(200);
  });
});
