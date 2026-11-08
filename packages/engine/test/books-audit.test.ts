/**
 * The books audit (audit/books.ts): clean books pass, and books broken on purpose (behind the
 * app's back, straight in the database) are caught, each by the check meant for it.
 */
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
    expect(said).toMatch(/each VAT201 of the last year agrees with the VAT account/);
    expect(said).toMatch(/the debtors account agrees with the open invoices/);
    expect(said).toMatch(/the creditors account agrees with the unpaid bills \(R 130\.00\)/);
    expect(said).toMatch(/PAYE, UIF and SDL owed agree with the EMP201s/);
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
