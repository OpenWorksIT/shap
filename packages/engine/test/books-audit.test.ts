/**
 * The books audit (audit/books.ts): clean books pass, and books broken on purpose (behind the
 * app's back, straight in the database) are caught, each by the check meant for it.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditBooks } from '../src/audit/books.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from './helpers.js';

const ON = '2027-02-28';

describe('the books audit', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let invoiceId: string;
  const found = async (level: 'fail' | 'warn', text: RegExp) => {
    const items = await auditBooks(env.sql, ON);
    return items.some((i) => i.level === level && text.test(i.text));
  };

  beforeAll(async () => {
    env = await setup();
    me = await login(env.app);
    const { settings, sources } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4740101508' }, 'PUT');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    const bills = sources.find((s: { role: string | null }) => s.role === 'bills').id;
    const client = await me.post('/api/clients', { name: 'Fictional Audit Client', address: '1 Ledger Lane, Gqeberha' });
    // A VAT company's month: invoices of each kind, a credit note, a payment, a write-off,
    // costs with VAT, a bill paid in part, and a pay run with its EMP201 paid in part.
    const inv = await me.post('/api/documents', {
      kind: 'invoice',
      clientId: client.id,
      issueDate: '2026-11-03',
      lines: [
        { category: 'labour', description: 'Install', qty: 1, unitPriceCents: 100_000, vatCode: 'standard' },
        { category: 'materials', description: 'Exported panels', qty: 1, unitPriceCents: 50_000, vatCode: 'export' },
      ],
    });
    invoiceId = inv.id;
    await me.post(`/api/documents/${inv.id}/issue`);
    const cn = await me.post(`/api/documents/${inv.id}/credit-note`);
    const draft = await me.get(`/api/documents/${cn.id}`);
    await me.post(`/api/documents/${cn.id}`, { ...draft.doc, creditReason: 'Panels returned', lines: [draft.lines[1]] }, 'PUT');
    await me.post(`/api/documents/${cn.id}/issue`);
    const inv2 = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: '2026-11-10', lines: [{ category: 'labour', description: 'Repairs', qty: 1, unitPriceCents: 40_000 }] });
    await me.post(`/api/documents/${inv2.id}/issue`);
    await me.post(`/api/documents/${inv2.id}/receipts`, { date: '2026-11-20', amountCents: 20_000, sourceId: bank }).catch(() => undefined);
    await me.post(`/api/documents/${inv2.id}/write-off`, { date: '2026-12-10', reason: 'Client gone' });
    const parts = await r.cat('Parts');
    await me.post('/api/costs', { date: '2026-11-05', description: 'Cable', amountCents: 11_500, vatCents: 1_500, vatCode: 'standard', categoryId: parts, sourceId: bank });
    const bill = await me.post('/api/costs', { date: '2026-11-06', description: 'Breakers on account', supplier: 'Fictional Wholesale', amountCents: 23_000, vatCents: 3_000, vatCode: 'standard', categoryId: parts, sourceId: bills });
    await me.post(`/api/costs/${bill.id}/bill-payments`, { date: '2026-11-25', amountCents: 10_000, sourceId: bank });
    await me.post('/api/employees', { name: 'Fictional Worker', idNumber: '8001015009087', taxNumber: '0123456782', salaryCents: 2_000_000, startDate: '2026-01-01' });
    const run = await me.post('/api/pay-runs', { period: '2026-11', payDate: '2026-11-25', sourceId: bank });
    await me.post(`/api/pay-runs/${run.id}/finalise`);
    await me.post('/api/sars-payments', { kind: 'emp201', period: '2026-11', date: '2026-12-05', amountCents: 10_000, sourceId: bank, reference: 'EMP201 Nov (part)' });
  });
  afterAll(() => env.close());

  it('finds nothing to fix in books kept through the app, and checks what it says it does', async () => {
    const items = await expectCleanAudit(env.sql, ON);
    const said = items.map((i) => i.text).join('\n');
    expect(said).toMatch(/the VAT account moved by what Shap's VAT201 shows for each period/);
    expect(said).toMatch(/the debtors account agrees with the open invoices/);
    expect(said).toMatch(/the creditors account agrees with the unpaid bills \(R 130\.00\)/);
    expect(said).toMatch(/PAYE, UIF and SDL owed agree with the pay runs less the EMP201 payments/);
    expect(said).toMatch(/the quick totals agree with the ledger/);
    // The cable's slip isn't attached.
    expect(items.some((i) => i.level === 'warn' && /without a slip attached/.test(i.text))).toBe(true);
  });

  it('catches a document whose total no longer adds up', async () => {
    await env.sql`update documents set total_cents = total_cents + 100 where id = ${invoiceId}`;
    expect(await found('fail', /don't add up/)).toBe(true);
    // The debtors account follows the total in the books, so it still agrees: the document is the problem.
    await env.sql`update documents set total_cents = total_cents - 100 where id = ${invoiceId}`;
    expect(await found('fail', /don't add up/)).toBe(false);
  });

  it('catches debtors that don’t agree with the open invoices', async () => {
    await env.sql`update documents set written_off_cents = written_off_cents + 500 where id = ${invoiceId}`;
    expect(await found('fail', /the debtors account .* differ by R 5\.00/)).toBe(true);
    await env.sql`update documents set written_off_cents = written_off_cents - 500 where id = ${invoiceId}`;
  });

  it('catches a VAT return that would disagree with the books', async () => {
    // A credit note with VAT on an invoice that charged none: the books take the VAT back, the
    // VAT201 (rightly) doesn't. Two ways of counting VAT drifting apart is what this check is for.
    const [c] = await env.sql<{ id: string }[]>`select id from clients limit 1`;
    const [d] = await env.sql<{ id: string }[]>`
      insert into documents (kind, number, status, client_id, issue_date, vat_rate_bp, subtotal_cents, vat_cents, total_cents, credit_reason)
      values ('credit_note', 'AUDIT-CN', 'issued', ${c!.id}, '2026-11-15', 0, 1000, 150, 1150, 'Test') returning id`;
    await env.sql`insert into document_lines (document_id, sort, category, description, qty, unit_price_cents, line_total_cents) values (${d!.id}, 0, 'labour', 'x', 1, 1000, 1000)`;
    expect(await found('fail', /the VAT201 and the VAT account disagree/)).toBe(true);
    await env.sql`delete from document_lines where document_id = ${d!.id}`;
    await env.sql`delete from documents where id = ${d!.id}`;
  });

  it('notices an invoice number gone without a trace in the audit log', async () => {
    await env.sql`update documents set number = 'INV-9001' where id = ${invoiceId}`;
    const [other] = await env.sql<{ number: string }[]>`select number from documents where kind = 'invoice' and id <> ${invoiceId} limit 1`;
    const n2 = other?.number;
    await env.sql`insert into documents (kind, number, status, issue_date, vat_rate_bp, subtotal_cents, vat_cents, total_cents) values ('invoice', 'INV-9003', 'draft', '2026-11-20', 1500, 0, 0, 0)`;
    expect(await found('warn', /invoice numbers missing.*INV-9002/)).toBe(true);
    await env.sql`delete from documents where number = 'INV-9003'`;
    expect(n2).toBeTruthy();
  });

  it('fails when the database’s own safeguards are gone, and an entry no longer balances', async () => {
    await env.sql.unsafe('alter table audit_log disable trigger audit_log_no_update');
    // A disabled trigger is still listed; a dropped one isn't. Drop it in a transaction and roll back.
    await env.sql
      .begin(async (tx) => {
        await tx.unsafe('drop trigger audit_log_no_update on audit_log');
        const items = await auditBooks(tx as unknown as typeof env.sql, ON);
        expect(items.some((i) => i.level === 'fail' && /audit log can be changed/.test(i.text))).toBe(true);
        throw new Error('roll back');
      })
      .catch((e: Error) => expect(e.message).toBe('roll back'));
    await env.sql.unsafe('alter table audit_log enable trigger audit_log_no_update');
    await env.sql
      .begin(async (tx) => {
        await tx.unsafe('drop trigger journal_balanced on journal_lines');
        const [j] = await tx<{ id: string }[]>`insert into journals (date, description, kind) values ('2026-11-30', 'Lopsided', 'manual') returning id`;
        const [a] = await tx<{ id: string }[]>`select id from accounts where system_key = 'bank'`;
        await tx`insert into journal_lines (journal_id, account_id, debit_cents, credit_cents) values (${j!.id}, ${a!.id}, 999, 0)`;
        const items = await auditBooks(tx as unknown as typeof env.sql, ON);
        expect(items.some((i) => i.level === 'fail' && /postings don't balance/.test(i.text))).toBe(true);
        expect(items.some((i) => i.level === 'fail' && /entries don't balance on their own/.test(i.text))).toBe(true);
        expect(items.some((i) => i.level === 'fail' && /journal_balanced/.test(i.text))).toBe(true);
        throw new Error('roll back');
      })
      .catch((e: Error) => expect(e.message).toBe('roll back'));
    await expectCleanAudit(env.sql, ON);
  });

  it('is there to ask for', async () => {
    const r = await me.get('/api/audit/books');
    expect(r).toMatchObject({ fails: 0 });
    expect(r.items.length).toBeGreaterThan(15);
  });
});

/**
 * The review of 1.21 (docs/AUDIT.md): books kept the way the app means them to be kept must come
 * out clean, and a check must be able to fail, not only warn.
 */
describe('the books audit on books an accountant has agreed', () => {
  const AT = '2026-06-30';
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let r: Awaited<ReturnType<typeof ref>>;
  let bank: string;
  let parts: string;
  const audit = () => auditBooks(env.sql, AT);
  const fails = async () => (await audit()).filter((i) => i.level === 'fail').map((i) => i.text);
  const line = async (re: RegExp) => (await audit()).find((i) => re.test(i.text));

  beforeAll(async () => {
    env = await setup();
    me = await login(env.app);
    const { settings, sources } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4740101508' }, 'PUT');
    r = await ref(env.sql);
    bank = await r.src('Business bank');
    parts = await r.cat('Parts');
    const bills = sources.find((s: { role: string | null }) => s.role === 'bills').id;
    const client = await me.post('/api/clients', { name: 'Fictional Agreed Client', address: '2 Test Road, Fictional Town' });
    const inv = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: '2025-06-01', lines: [{ category: 'labour', description: 'Work', qty: 1, unitPriceCents: 100_000 }] });
    await me.post(`/api/documents/${inv.id}/issue`);
    await me.post('/api/costs', { date: '2025-06-10', description: 'Breakers on account', supplier: 'Fictional Supplier', amountCents: 23_000, vatCents: 3_000, vatCode: 'standard', categoryId: parts, sourceId: bills });
  });
  afterAll(() => env.close());

  it('accepts a cost’s VAT the way the app does (rounded, and a cent for the supplier’s rounding)', async () => {
    // R1 000.03 including VAT holds R130.4387: the app takes R130.45.
    const c = await me.call({ method: 'POST', url: '/api/costs', payload: { date: '2025-07-01', description: 'Fictional fittings', amountCents: 100_003, vatCents: 13_045, vatCode: 'standard', categoryId: parts, sourceId: bank } });
    expect(c.statusCode).toBe(200);
    expect(await fails()).toEqual([]);
    // A cent more than that is more than the amount can hold (put in behind the app's back).
    await env.sql`update costs set vat_cents = 13_046 where description = 'Fictional fittings'`;
    expect(await fails()).toEqual([expect.stringMatching(/1 costs claim more VAT than what was paid includes: Fictional fittings/)]);
    // At 14% (before April 2018) less VAT fits in the same amount.
    await env.sql`update costs set vat_cents = 12_283, date = '2018-03-01' where description = 'Fictional fittings'`;
    expect((await fails()).join()).toMatch(/more VAT than what was paid includes/);
    await env.sql`update costs set vat_cents = 12_282 where description = 'Fictional fittings'`;
    expect(await fails()).toEqual([]);
    await env.sql`delete from costs where description = 'Fictional fittings'`;
  });

  it('is clean after a year is agreed at the accountant’s figures, not Shap’s', async () => {
    // The accountant adds an accrual: creditors R250 (Shap has R230), and R20 more on parts.
    const form = await me.get('/api/year-ends/form?fyEnd=2026-02-28');
    const materials = await r.acc('cos_materials');
    const partsAcc = form.rows.find((x: { id: string }) => x.id === materials);
    expect(partsAcc).toBeTruthy();
    await me.post('/api/year-ends', {
      fyEnd: '2026-02-28',
      lock: false,
      note: 'Agreed with the accountant (made up)',
      figures: [{ accountId: await r.acc('payables'), amountCents: 25_000 }, { accountId: partsAcc.id, amountCents: partsAcc.shapCents + 2_000 }],
    }, 'PUT');
    expect(await fails()).toEqual([]);
    const said = (await audit()).map((i) => i.text).join('\n');
    // The creditors account, less the accountant's adjustment, still agrees with the bills.
    expect(said).toMatch(/the creditors account agrees with the unpaid bills \(R 230\.00\)/);
    expect(said).toMatch(/the quick totals agree with the ledger/);
    expect(said).toMatch(/the year to 2026-02-28 still shows the figures it was agreed at, with nothing added or changed in it since/);
  });

  it('stays clean when the year end in Settings changes after a year was agreed', async () => {
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, fyEndMonth: 6 }, 'PUT');
    expect(await fails()).toEqual([]);
    await me.post('/api/settings', { ...settings, fyEndMonth: settings.fyEndMonth }, 'PUT');
  });

  it('notices something dated in an agreed year added afterwards: worth a look while open, wrong once closed', async () => {
    const late = await me.post('/api/costs', { date: '2025-08-01', description: 'A late slip', amountCents: 5_750, vatCents: 750, vatCode: 'standard', categoryId: parts, sourceId: bank });
    let l = await line(/after it was agreed/);
    expect(l).toMatchObject({ level: 'warn', section: 'Agreed years' });
    // Each account it touched, by what Shap's own figure moved.
    expect(l!.text).toMatch(/Cost of sales – project materials \(R 50\.00\)/);
    expect(l!.text).toMatch(/VAT[^(]* \(R 7\.50\)/);
    expect(l!.text).toMatch(/tell your accountant/);
    // The agreed figures still show.
    expect(await fails()).toEqual([]);
    await me.call({ method: 'DELETE', url: `/api/costs/${late.id}` });
    expect((await line(/the year to 2026-02-28/))!.level).toBe('ok');

    // An account opened since, with something in the agreed year.
    const acc = await me.post('/api/accounts', { code: '6950', name: 'Fictional new costs', type: 'expense' });
    const j = await me.post('/api/journals', { date: '2025-09-01', description: 'Moved in late (made up)', lines: [{ accountId: acc.id, debitCents: 1_000 }, { accountId: await r.acc('bank'), creditCents: 1_000 }] });
    l = await line(/after it was agreed/);
    expect(l!.level).toBe('warn');
    expect(l!.text).toMatch(/Fictional new costs \(R 10\.00, an account opened since\)/);

    // Closed: the same is a fault (it got past the lock).
    await env.sql`update settings set lock_date = '2026-02-28'`;
    l = await line(/after it was agreed/);
    expect(l).toMatchObject({ level: 'fail' });
    expect(l!.text).toMatch(/though the year is closed/);
    await env.sql`update settings set lock_date = null`;
    await me.call({ method: 'DELETE', url: `/api/journals/${j.id}` });
    expect(await fails()).toEqual([]);
    // Agreed again, it starts from the books as they are then.
    await me.post('/api/costs', { date: '2025-08-01', description: 'A late slip', amountCents: 5_750, vatCents: 750, vatCode: 'standard', categoryId: parts, sourceId: bank });
    expect((await line(/the year to 2026-02-28/))!.level).toBe('warn');
    const form = await me.get('/api/year-ends/form?fyEnd=2026-02-28');
    await me.post('/api/year-ends', { fyEnd: '2026-02-28', lock: false, note: 'Agreed again (made up)', figures: form.rows.filter((x: { targetCents: number | null }) => x.targetCents != null).map((x: { id: string; targetCents: number }) => ({ accountId: x.id, amountCents: x.targetCents })) }, 'PUT');
    expect((await line(/the year to 2026-02-28/))!.level).toBe('ok');
  });

  it('fails when the agreed figures don’t show (a year-end adjustment missing from the totals)', async () => {
    await env.sql`delete from ledger_totals where source = 'year_end'`;
    const said = (await fails()).join('\n');
    expect(said).toMatch(/the year to 2026-02-28 no longer shows the figures it was agreed at/);
    expect(said).toMatch(/quick totals/);
    await env.sql`update books_version set changed = changed + 1`;
    expect(await fails()).toEqual([]);
  });

  it('fails on debtors, creditors or payroll that don’t agree, even with journals by hand on them', async () => {
    // An opening balance on debtors and creditors, typed in: counted apart, so the check stays exact.
    await me.post('/api/journals', {
      date: '2025-03-01',
      description: 'Opening balances (made up)',
      lines: [
        { accountId: await r.acc('receivables'), debitCents: 10_000 },
        { accountId: await r.acc('payables'), creditCents: 4_000 },
        { accountId: await r.acc('retained_earnings'), creditCents: 6_000 },
      ],
    });
    let said = (await audit()).map((i) => `${i.level} ${i.text}`).join('\n');
    expect(said).toMatch(/ok the debtors account agrees with the open invoices \(R 1 150\.00; journals by hand add R 100\.00 to the account\)/);
    expect(said).toMatch(/ok the creditors account agrees with the unpaid bills \(R 230\.00; journals by hand add R 40\.00 to the account\)/);
    const [inv] = await env.sql<{ id: string }[]>`select id from documents where kind = 'invoice' and status = 'issued' limit 1`;
    await env.sql`update documents set written_off_cents = 77_700 where id = ${inv!.id}`;
    expect((await line(/the debtors account/))).toMatchObject({ level: 'fail', text: expect.stringMatching(/differ by R 777\.00/) });
    await env.sql`update documents set written_off_cents = 0 where id = ${inv!.id}`;

    // Payroll posts as the app's own journals: a pay line changed behind its back is a FAIL.
    await me.post('/api/employees', { name: 'Fictional Employee', idNumber: '8001015009087', taxNumber: '0123456782', salaryCents: 3_000_000, startDate: '2026-01-01' });
    const run = await me.post('/api/pay-runs', { period: '2026-05', payDate: '2026-05-25', sourceId: bank });
    await me.post(`/api/pay-runs/${run.id}/finalise`);
    await me.post('/api/sars-payments', { kind: 'emp201', period: '2026-05', date: '2026-06-05', amountCents: 50_000, sourceId: bank, reference: 'EMP201 May (made up)' });
    expect((await line(/PAYE, UIF and SDL owed/))!.level).toBe('ok');
    await env.sql`update pay_lines set paye_cents = paye_cents + 100_000 where run_id = ${run.id}`;
    expect(await line(/PAYE, UIF and SDL owed/)).toMatchObject({ level: 'fail', text: expect.stringMatching(/differ by R 1 000\.00/) });
    await env.sql`update pay_lines set paye_cents = paye_cents - 100_000 where run_id = ${run.id}`;
    said = (await fails()).join('\n');
    expect(said).toBe('');
  });

  it('fails when the quick totals miss something, or hold something the ledger doesn’t', async () => {
    const [row] = await env.sql<{ accountId: string; date: string; source: string }[]>`select account_id, date::text as date, source from ledger_totals where source = 'invoice' limit 1`;
    await env.sql`delete from ledger_totals where account_id = ${row!.accountId} and date = ${row!.date}::date and source = 'invoice'`;
    expect(await line(/quick totals/)).toMatchObject({ level: 'fail' });
    await env.sql`update books_version set changed = changed + 1`;
    expect((await line(/quick totals/))!.level).toBe('ok');
    await env.sql`insert into ledger_totals (account_id, date, source, amount_cents, postings) values (${await r.acc('bank')}, '2026-01-01', 'cost', 123, 1)`;
    expect(await line(/quick totals/)).toMatchObject({ level: 'fail', text: expect.stringMatching(/on 1 accounts/) });
    await env.sql`update books_version set changed = changed + 1`;
    expect(await fails()).toEqual([]);
  });

  it('measures a year agreed before 1.21.1 from the update on (the migration notes Shap’s figures then)', async () => {
    // The opening balances typed in above are dated in the agreed year: noticed.
    expect((await line(/the year to 2026-02-28/))!.level).toBe('warn');
    await env.sql`update year_end_figures set shap_cents = null`;
    // Agreed before 1.21.1: nothing to compare with, so not called wrong.
    expect((await line(/the year to 2026-02-28/))!.level).toBe('ok');
    await env.sql.unsafe(readFileSync(new URL('../migrations/036_agreed_shap_figures.sql', import.meta.url), 'utf8'));
    const [left] = await env.sql<{ unset: number }[]>`select count(*)::int as unset from year_end_figures where shap_cents is null`;
    expect(left!.unset).toBe(0);
    expect((await line(/the year to 2026-02-28/))!.level).toBe('ok');
    // From then on, something added in the year shows.
    const late = await me.post('/api/costs', { date: '2025-10-01', description: 'After the update', amountCents: 1_150, vatCents: 150, vatCode: 'standard', categoryId: parts, sourceId: bank });
    expect((await line(/the year to 2026-02-28/))!.level).toBe('warn');
    await me.call({ method: 'DELETE', url: `/api/costs/${late.id}` });
    expect((await line(/the year to 2026-02-28/))!.level).toBe('ok');
  });

  it('isn’t moved by agreeing an earlier year afterwards, or removing it, even when the later year is closed', async () => {
    expect((await line(/the year to 2026-02-28/))!.level).toBe('ok');
    await env.sql`update settings set lock_date = '2026-02-28'`;
    // The year before, agreed for the first time: the accountant has creditors of R30 (Shap had none).
    await me.post('/api/year-ends', { fyEnd: '2025-02-28', lock: false, note: 'The year before (made up)', figures: [{ accountId: await r.acc('payables'), amountCents: 3_000 }] }, 'PUT');
    expect((await line(/the year to 2026-02-28/))!.level).toBe('ok');
    expect((await line(/the year to 2025-02-28/))!.level).toBe('ok');
    expect(await fails()).toEqual([]);
    await env.sql`update settings set lock_date = null`;
    await me.call({ method: 'DELETE', url: '/api/year-ends/2025-02-28' });
    expect((await line(/the year to 2026-02-28/))!.level).toBe('ok');
    expect(await fails()).toEqual([]);
  });

  it('doesn’t ask a business that has deregistered for VAT for a VAT number', async () => {
    const { settings } = await me.get('/api/reference');
    const inv = await me.post('/api/documents', { kind: 'invoice', clientId: (await env.sql<{ id: string }[]>`select id from clients limit 1`)[0]!.id, issueDate: '2026-03-10', lines: [{ category: 'labour', description: 'Work', qty: 1, unitPriceCents: 10_000 }] });
    await me.post(`/api/documents/${inv.id}/issue`);
    await me.post('/api/settings', { ...settings, vatRegistered: false, vatNumber: '' }, 'PUT');
    expect(await fails()).toEqual([]);
    expect((await audit()).some((i) => /VAT number/.test(i.text))).toBe(false);
    await expectCleanAudit(env.sql, AT);
  });
});

/**
 * History brought in after a year was agreed (moving in from another package with an opening
 * date in it, an order the app allows): that's where the books start from, not a change made
 * after agreeing.
 */
describe('the books audit after history is brought into an agreed year', () => {
  const TB = `Trial Balance
Fictional Electrical (Pty) Ltd
As at 28 February 2026

Account Code,Account,Debit,Credit
1000,FNB Business Cheque,"25,000.00",
2300,Loan from Director,,"10,000.00"
3100,Retained Earnings,,"5,000.00"
4000,Sales,,"30,000.00"
5000,Purchases,"20,000.00",
`;
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(() => env.close());

  it('is clean when the opening balances come in after the year was agreed and closed', async () => {
    const me = await login(env.app);
    await me.post('/api/year-ends', { fyEnd: '2026-02-28', lock: true, note: 'Agreed (made up)', figures: [] }, 'PUT');
    const bank = await (await ref(env.sql)).src('Business bank');
    const files = [{ name: 'Trial balance.csv', text: TB }];
    const p = await me.post('/api/move-in/preview', { files });
    await me.post('/api/move-in', { files, options: { receiptSourceId: bank, openingDate: '2026-02-28', tbAccounts: p.tb.lines.map((l: { suggestion: string }) => l.suggestion), lockOpening: true } });
    const items = await auditBooks(env.sql, '2026-06-30');
    expect(items.find((i) => /the year to 2026-02-28/.test(i.text))).toMatchObject({ level: 'ok' });
    expect(items.filter((i) => i.section === 'Agreed years' && i.level !== 'ok')).toEqual([]);
  });
});
