/**
 * The four reviews of 1.24 (security and privacy, IFRS for SMEs and company law, SARS and tax,
 * accounting and arithmetic), each finding fixed; each test failed before its fix. All data made up.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditBooks } from '../../src/audit/books.js';
import { applyMonthLock } from '../../src/lib/books.js';
import { exportCompanyFile, restoreCompanyFile } from '../../src/modules/company-file.js';
import { applyTracker } from '../../src/modules/import/apply.js';
import { readTracker } from '../../src/modules/import/tracker.js';
import { fullAfterwards } from '../../src/modules/pdf.js';
import { buildDemoTracker } from '../../src/db/demo-tracker.js';
import { needsFullTaxInvoice } from '@shap/shared';
import { expectCleanAudit, login, ref, sessionFor, setup, type TestEnv } from '../helpers.js';

const D = '2026-09-15';
type Me = Awaited<ReturnType<typeof login>>;

async function shop(env: TestEnv, opts: { vat?: boolean; features?: Record<string, boolean> } = {}) {
  const me = await login(env.app, 'owner@example.co.za');
  const { settings } = await me.get('/api/reference');
  await me.post('/api/settings', { ...settings, fyEndMonth: 2, vatRegistered: opts.vat ?? true, vatNumber: opts.vat === false ? '' : '4740101508', features: { ...settings.features, sales: true, ...opts.features } }, 'PUT');
  const till = (await env.sql<{ id: string }[]>`select id from payment_sources where till`)[0]!.id;
  const client = await me.post('/api/clients', { name: 'Fictional Builder (Pty) Ltd', address: '5 Pretend Road, Fictional Town' });
  return { me, till, client, r: await ref(env.sql) };
}
const keyCut = (till: string, extra: Record<string, unknown> = {}) => ({ date: D, sourceId: till, method: 'cash', lines: [{ description: 'Key cut (made up)', qty: 2, unitPriceCents: 2_300 }], ...extra });

describe('a sale’s invoice stays as it was issued', () => {
  let env: TestEnv;
  let me: Me;
  let till: string;
  let client: { id: string };
  beforeAll(async () => {
    env = await setup();
    ({ me, till, client } = await shop(env, { features: { timeTracker: true, jobs: true } }));
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql, '2026-10-31');
    await env.close();
  });

  it('can’t be changed through Quotes & invoices at all: not its number, customer, job or notes', async () => {
    const s = await me.post('/api/sales', keyCut(till));
    for (const change of [{ number: 'CHANGED-1' }, { notes: 'Made-up note' }, { clientId: client.id }]) {
      const r = await me.call({ method: 'PUT', url: `/api/documents/${s.id}`, payload: { issueDate: D, lines: s.lines.map((l: Record<string, unknown>) => ({ ...l, qty: Number(l.qty), unitPriceCents: Number(l.unitPriceCents) })), ...change } });
      expect([r.statusCode, JSON.stringify(change)]).toEqual([400, JSON.stringify(change)]);
    }
    expect((await me.get(`/api/documents/${s.id}`)).doc).toMatchObject({ number: s.number, clientId: null, notes: '' });
  });

  it('takes no time: time goes on a quote or a draft invoice, with VAT by line, in the audit log', async () => {
    const s = await me.post('/api/sales', keyCut(till));
    const [t] = await env.sql<{ id: string }[]>`insert into time_entries (started_at, ended_at, minutes, user_id) values (now() - interval '2 hours', now() - interval '1 hour', 60, (select id from users where email = 'owner@example.co.za')) returning id`;
    expect((await me.call({ method: 'POST', url: '/api/time/bill', payload: { documentId: s.id, ids: [t!.id] } })).statusCode).toBe(400);
    const issued = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: D, lines: [{ category: 'labour', description: 'Made-up work', qty: 1, unitPriceCents: 10_000 }] });
    await me.post(`/api/documents/${issued.id}/issue`, {});
    expect((await me.call({ method: 'POST', url: '/api/time/bill', payload: { documentId: issued.id, ids: [t!.id] } })).statusCode).toBe(400);
    // A draft with a zero-rated line: the time is standard-rated, the bread isn't.
    const draft = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: D, lines: [{ category: 'other', description: 'Bread (made up)', qty: 1, unitPriceCents: 10_000, vatCode: 'zero' }] });
    await env.sql`update settings set hourly_rate_cents = 50_000`;
    await me.post('/api/time/bill', { documentId: draft.id, ids: [t!.id] });
    const d = (await me.get(`/api/documents/${draft.id}`)).doc;
    expect([Number(d.subtotalCents), Number(d.vatCents)]).toEqual([60_000, 7_500]);
    expect((await env.sql`select 1 from audit_log where action = 'bill_time' and entity_id = ${draft.id}`).length).toBe(1);
    await me.call({ method: 'DELETE', url: `/api/documents/${draft.id}` });
  });

  it('isn’t paid again from a bank line', async () => {
    const s = await me.post('/api/sales', keyCut(till));
    const bank = (await ref(env.sql)).src;
    const src = await bank('Business bank');
    const [st] = await env.sql<{ id: string }[]>`insert into bank_statements (source_id, filename) values (${src}, 'made-up.csv') returning id`;
    const [line] = await env.sql<{ id: string }[]>`insert into bank_lines (statement_id, source_id, date, description, amount_cents, fingerprint) values (${st!.id}, ${src}, ${D}, 'MADE UP PAYMENT', 4_600, 'fp-sale') returning id`;
    expect((await me.call({ method: 'POST', url: `/api/bank/lines/${line!.id}/receipt`, payload: { invoiceId: s.id } })).statusCode).toBe(400);
  });

  it('is always issued: the database refuses a draft or a void one, and the books audit says if one is', async () => {
    const s = await me.post('/api/sales', keyCut(till));
    await expect(env.sql`update documents set status = 'void' where id = ${s.id}`).rejects.toThrow(/documents_counter_check/);
    await env.sql.unsafe('alter table documents drop constraint documents_counter_check');
    await env.sql`update documents set status = 'void' where id = ${s.id}`;
    expect((await auditBooks(env.sql, '2026-09-30')).find((i) => /a sale's invoice that isn't issued/.test(i.text))).toMatchObject({ level: 'fail' });
    await env.sql`update documents set status = 'issued' where id = ${s.id}`;
    await env.sql.unsafe(`alter table documents add constraint documents_counter_check check (not counter or (kind = 'invoice' and status = 'issued')) not valid`);
  });

  it('gets a walk-in’s details in a closed month (nothing it charges changes), saying it replaces the short one', async () => {
    const s = await me.post('/api/sales', keyCut(till, { date: '2026-10-05' }));
    await me.post('/api/periods/lock', { through: '2026-10-31' });
    const full = await me.post(`/api/sales/${s.id}/customer`, { clientId: client.id });
    expect(full.doc).toMatchObject({ clientId: client.id, number: s.number });
    expect(fullAfterwards({ ...full.doc, vatRateBp: Number(full.doc.vatRateBp) })).toMatch(/^Full tax invoice with the customer’s details, added .*: it replaces the abridged tax invoice of the same number issued on 5 Oct 2026\.$/);
    // The short one as it was handed over, and the full one, both to hand.
    const first = await me.call({ method: 'GET', url: `/api/documents/${s.id}/pdf?abridged=1` });
    const now = await me.call({ method: 'GET', url: `/api/documents/${s.id}/pdf` });
    expect([first.statusCode, now.statusCode]).toEqual([200, 200]);
    expect(first.rawPayload.length).not.toBe(now.rawPayload.length);
  });
});

describe('zero-rated goods at the counter (VAT Act s20(5) proviso, s20(6))', () => {
  let env: TestEnv;
  let me: Me;
  let till: string;
  let client: { id: string };
  beforeAll(async () => {
    env = await setup();
    ({ me, till, client } = await shop(env));
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql, '2026-09-30');
    await env.close();
  });

  it('wants the full tax invoice over R50, not under', async () => {
    expect([needsFullTaxInvoice(5_000, true), needsFullTaxInvoice(5_001, true), needsFullTaxInvoice(500_000, false), needsFullTaxInvoice(500_001, false)]).toEqual([false, true, false, true]);
    const bread = (cents: number) => ({ date: D, sourceId: till, method: 'cash', lines: [{ description: 'Brown bread (made up)', qty: 1, unitPriceCents: cents, vatCode: 'zero' }] });
    const r = await me.call({ method: 'POST', url: '/api/sales', payload: bread(6_000) });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/Zero-rated goods over R50 need a full tax invoice/);
    expect((await me.call({ method: 'POST', url: '/api/sales', payload: bread(4_500) })).statusCode).toBe(200);
    expect((await me.call({ method: 'POST', url: '/api/sales', payload: { ...bread(6_000), clientId: client.id } })).statusCode).toBe(200);
    // And the books audit goes by the same rule: nothing to say about either.
    expect((await auditBooks(env.sql, '2026-09-30')).filter((i) => /don't show the client's name/.test(i.text))).toEqual([]);
  });
});

describe('locks that hold', () => {
  let env: TestEnv;
  let me: Me;
  let till: string;
  beforeAll(async () => {
    env = await setup();
    ({ me, till } = await shop(env, { features: { bank: true, inventory: true } }));
  });
  afterAll(async () => {
    vi.useRealTimers();
    await expectCleanAudit(env.sql, '2026-10-31');
    await env.close();
  });

  it('locks a month that’s due before any change, and a look doesn’t lock it', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-09T08:00:00Z') });
    await me.post('/api/periods/month-end', { mode: 'auto', day: 7 }, 'PUT');
    // Put back to before the 7th's lock, as if nothing had been written since.
    await env.sql`update settings set lock_date = null, month_locked_through = null`;
    expect((await me.get('/api/periods')).lockDate).toBe('2026-10-31');
    expect((await env.sql<{ lockDate: string | null }[]>`select lock_date::text as lock_date from settings`)[0]!.lockDate).toBeNull();
    // Any change (a client here, with no date of its own) locks it first.
    await me.post('/api/clients', { name: 'Made-up Client' });
    expect((await env.sql<{ lockDate: string | null }[]>`select lock_date::text as lock_date from settings`)[0]!.lockDate).toBe('2026-10-31');
    await me.post('/api/periods/month-end', { mode: 'manual', day: 7 }, 'PUT');
    vi.useRealTimers();
  });

  it('gives the lock as it is now when another request locked it first', async () => {
    await env.sql`update settings set lock_date = '2026-08-31', month_locked_through = null, month_end_mode = 'auto', month_end_day = 7`;
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-08T08:00:00Z') });
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const first = env.sql.begin(async (tx) => {
      await tx`update settings set lock_date = '2026-09-30', month_locked_through = '2026-09-30' where id`;
      await hold;
    });
    await new Promise((r) => setTimeout(r, 100));
    const second = env.sql.begin((tx) => applyMonthLock(tx));
    await new Promise((r) => setTimeout(r, 100));
    release();
    await first;
    expect(await second).toBe('2026-09-30');
    vi.useRealTimers();
    await env.sql`update settings set month_end_mode = 'manual'`;
  });

  it('two locks sent together leave it at the later one', async () => {
    await env.sql`update settings set lock_date = '2026-08-31'`;
    await Promise.all([me.call({ method: 'POST', url: '/api/periods/lock', payload: { through: '2026-10-31' } }), me.call({ method: 'POST', url: '/api/periods/lock', payload: { through: '2026-09-30' } })]);
    expect((await me.get('/api/periods')).lockDate).toBe('2026-10-31');
  });

  it('won’t undo a bank match that would change a closed month', async () => {
    await env.sql`update settings set lock_date = '2026-09-30'`;
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    const cost = await me.post('/api/costs', { date: '2026-10-10', description: 'Bank fee (made up)', amountCents: 10_000, categoryId: await r.cat('Bank'), sourceId: await r.src('Paid personally (owner)') });
    const [st] = await env.sql<{ id: string }[]>`insert into bank_statements (source_id, filename) values (${bank}, 'made-up.csv') returning id`;
    const [line] = await env.sql<{ id: string }[]>`insert into bank_lines (statement_id, source_id, date, description, amount_cents, fingerprint) values (${st!.id}, ${bank}, '2026-10-10', 'MADE UP FEE', -10_000, 'fp-fee') returning id`;
    await me.post(`/api/bank/lines/${line!.id}/match`, { items: [{ kind: 'cost', id: cost.id }] });
    await me.post('/api/periods/lock', { through: '2026-10-31' });
    expect((await me.call({ method: 'DELETE', url: `/api/bank/lines/${line!.id}/match` })).statusCode).toBe(400);
  });

  it('counts only a sale’s refunds in month end’s refunds', async () => {
    const r = await ref(env.sql);
    await env.sql`update settings set lock_date = '2026-08-31', relock_date = null`;
    const client = await me.post('/api/clients', { name: 'Made-up Regular', address: '9 Pretend Way' });
    const inv = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: '2026-09-01', lines: [{ category: 'goods', description: 'Made-up goods', qty: 1, unitPriceCents: 10_000 }] });
    await me.post(`/api/documents/${inv.id}/issue`, {});
    await me.post(`/api/documents/${inv.id}/receipts`, { date: '2026-09-02', amountCents: 11_500, sourceId: await r.src('Business bank'), method: 'eft' });
    const line = (await me.get(`/api/sales/${inv.id}`)).lines[0];
    await me.post(`/api/documents/${inv.id}/refund`, { date: '2026-09-03', money: 'paid_out', sourceId: await r.src('Business bank'), method: 'eft', reason: 'Returned (made up)', lines: [{ lineId: line.id, qty: 1 }] });
    const sep = (await me.get('/api/periods')).periods.find((p: { end: string }) => p.end === '2026-09-30');
    expect(sep.refundsCents).toBe(0);
    void till;
  });

  it('says which filed VAT periods a reopen opens again', async () => {
    await env.sql`update settings set lock_date = '2026-10-31', relock_date = null, vat_category = 'B'`;
    const r = await me.post('/api/periods/reopen', { to: '2026-08-31', reason: 'A refund was missed (made up)' });
    expect(r.vatReopened.map((p: { end: string }) => p.end)).toEqual(['2026-10-31']);
    await me.post('/api/periods/lock', { through: '2026-10-31' });
  });

  it('shrinks a slip only in a closed year, not a closed month', async () => {
    const r = await ref(env.sql);
    await env.sql`update settings set lock_date = '2026-09-30', relock_date = null`;
    const tiny = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
    const att = await me.post('/api/attachments', { filename: 'slip.jpg', mime: 'image/jpeg', dataBase64: Buffer.concat([tiny, Buffer.alloc(5_000)]).toString('base64') });
    await me.post('/api/costs', { date: '2026-10-12', description: 'Made-up slip', amountCents: 5_000, categoryId: await r.cat('Bank'), sourceId: await r.src('Business bank'), receiptId: att.id });
    await me.post('/api/periods/lock', { through: '2026-10-31' });
    const res = await me.call({ method: 'PUT', url: `/api/attachments/${att.id}`, payload: { mime: 'image/jpeg', dataBase64: tiny.toString('base64') } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/closed year/);
  });
});

describe('who sees what', () => {
  it('a teller’s stock history shows their own sales, not others’ or the invoices', async () => {
    const env = await setup();
    try {
      const { me, till, client } = await shop(env, { features: { inventory: true } });
      const widget = await me.post('/api/items', { description: 'Widget (made up)', unitPriceCents: 1_000, stocked: true });
      await me.post(`/api/items/${widget.id}/opening`, { date: '2026-09-01', qty: 10, unitCostCents: 500, from: 'opening_balances' });
      const [teller] = await env.sql<{ id: string }[]>`select id from profiles where name = 'Teller'`;
      await me.post('/api/users', { name: 'Teller A (made up)', email: 'teller-a@example.co.za', role: 'staff', profileId: teller!.id, password: 'test-password-1' });
      const a = await sessionFor(env, 'teller-a@example.co.za');
      const mine = await a.post('/api/sales', { date: D, sourceId: till, method: 'cash', lines: [{ itemId: widget.id, description: 'Widget (made up)', qty: 1, unitPriceCents: 1_000 }] });
      const inv = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: D, lines: [{ category: 'goods', description: 'Widget (made up)', qty: 3, unitPriceCents: 1_000, itemId: widget.id }] });
      await me.post(`/api/documents/${inv.id}/issue`, {});
      const h = await a.get(`/api/items/${widget.id}/history`);
      expect(h.documents.map((d: { id: string }) => d.id)).toEqual([mine.id]);
      expect(h.documents[0]).not.toHaveProperty('lineTotalCents');
      expect(JSON.stringify(h.moves)).not.toContain('Fictional Builder');
      expect(h.moves.filter((m: { documentNumber: string | null }) => m.documentNumber === inv.number)).toEqual([]);
      // Whoever reopened the books, and why, is for those who may lock (and the owner and accountant).
      await me.post('/api/periods/lock', { through: '2026-09-30' });
      await me.post('/api/periods/reopen', { to: '2026-08-31', reason: 'Teller B’s till was short (made up)' });
      await me.post('/api/users', { name: 'Clerk (made up)', email: 'clerk@example.co.za', role: 'staff', profileId: null, access: ['reports.view'], password: 'test-password-1' });
      const clerk = await sessionFor(env, 'clerk@example.co.za');
      expect((await clerk.get('/api/periods')).reopened).toMatchObject({ byName: null, reason: '' });
      expect((await me.get('/api/periods')).reopened).toMatchObject({ reason: 'Teller B’s till was short (made up)' });
      await me.post('/api/periods/lock', { through: '2026-09-30' });
      await expectCleanAudit(env.sql, '2026-09-30');
    } finally {
      await env.close();
    }
  });
});

describe('closed and signed years stay so', () => {
  async function approved(env: TestEnv, me: Me) {
    const r = await ref(env.sql);
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, fyEndMonth: 2, features: { ...settings.features, statements: true } }, 'PUT');
    await me.post('/api/journals', { date: '2025-03-01', description: 'Shares issued (made up)', lines: [{ accountId: await r.acc('bank'), debitCents: 10_000 }, { accountId: await r.acc('share_capital'), creditCents: 10_000 }] });
    const file = await me.post('/api/attachments', { filename: 'report.pdf', mime: 'application/pdf', dataBase64: Buffer.from('%PDF-1.4\n% made up\n').toString('base64') });
    await me.post('/api/statements/2026-02-28/compiler-report', { attachmentId: file.id, compilerName: 'Fictional Accountant', date: '2026-04-01' });
    await me.post('/api/statements/2026-02-28/approve', { name: 'Fictional Director', date: '2026-04-02' });
  }

  it('keeps the signed set, with its PDF, when the statements are reopened', async () => {
    const env = await setup();
    try {
      const me = await login(env.app, 'owner@example.co.za');
      await approved(env, me);
      await me.post('/api/statements/2026-02-28/reopen', { reason: 'A missed invoice (made up)' });
      const v = await me.get('/api/statements/2026-02-28');
      expect(v.versions).toHaveLength(1);
      expect(v.versions[0]).toMatchObject({ status: 'approved', approvedName: 'Fictional Director', reason: 'A missed invoice (made up)', hasPdf: true });
      const pdf = await me.call({ method: 'GET', url: `/api/statements/2026-02-28/versions/${v.versions[0].id}/pdf` });
      expect(pdf.statusCode).toBe(200);
      expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    } finally {
      await env.close();
    }
  });

  it('takes nothing from moving in or a tracker into a closed or signed year', async () => {
    const env = await setup();
    try {
      const me = await login(env.app, 'owner@example.co.za');
      await approved(env, me);
      const bank = await (await ref(env.sql)).src('Business bank');
      // Moving in an invoice dated in the approved year, with an opening date: left out.
      const csv = `ContactName,InvoiceNumber,InvoiceDate,DueDate,Total,TaxTotal,InvoiceAmountPaid,InvoiceAmountDue,Description,Quantity,UnitAmount,LineAmount,TaxAmount,Type,Status
Made-up Client,MV-1,15/09/2025,22/09/2025,1150.00,150.00,0.00,1150.00,Made-up work,1.0000,1000.00,1000.00,150.00,Sales invoice,AUTHORISED
`;
      const moved = await me.call({ method: 'POST', url: '/api/move-in', payload: { files: [{ name: 'invoices.csv', text: csv }], options: { receiptSourceId: bank, openingDate: '2025-02-28' } } });
      if (moved.statusCode === 200) expect(moved.json().invoices).toBe(0);
      expect((await env.sql`select 1 from documents where number = 'MV-1'`).length).toBe(0);
      // A tracker replacing books with closed periods.
      const plan = await readTracker((await buildDemoTracker('2026-06-30')).buffer);
      await me.post('/api/costs', { date: '2026-03-10', description: 'Made-up cost', amountCents: 1_000, categoryId: await (await ref(env.sql)).cat('Bank'), sourceId: bank });
      await expect(applyTracker(env.sql, plan, { replace: true })).rejects.toThrow(/closed up to/);
    } finally {
      await env.close();
    }
  });

  it('takes no agreed year from a company file into a year closed here', async () => {
    const first = await setup();
    let file: Awaited<ReturnType<typeof exportCompanyFile>>;
    try {
      const me = await login(first.app, 'owner@example.co.za');
      const { settings } = await me.get('/api/reference');
      await me.post('/api/settings', { ...settings, fyEndMonth: 2 }, 'PUT');
      await me.post('/api/year-ends', { fyEnd: '2026-02-28', note: 'Agreed (made up)', lock: true, figures: [] }, 'PUT');
      file = await exportCompanyFile(first.sql);
    } finally {
      await first.close();
    }
    const env = await setup();
    try {
      const me = await login(env.app, 'owner@example.co.za');
      const { settings } = await me.get('/api/reference');
      await me.post('/api/settings', { ...settings, fyEndMonth: 2 }, 'PUT');
      await me.post('/api/periods/lock', { through: '2026-02-28' });
      await expect(env.sql.begin((tx) => restoreCompanyFile(tx as never, file))).rejects.toThrow(/closed up to 2026-02-28/);
    } finally {
      await env.close();
    }
  });

  it('logs the lock a company file moves', async () => {
    const first = await setup();
    let file: Awaited<ReturnType<typeof exportCompanyFile>>;
    try {
      const me = await login(first.app, 'owner@example.co.za');
      const { settings } = await me.get('/api/reference');
      await me.post('/api/settings', { ...settings, fyEndMonth: 2 }, 'PUT');
      await me.post('/api/year-ends', { fyEnd: '2026-02-28', note: 'Agreed (made up)', lock: true, figures: [] }, 'PUT');
      file = await exportCompanyFile(first.sql);
    } finally {
      await first.close();
    }
    const env = await setup();
    try {
      await env.sql.begin((tx) => restoreCompanyFile(tx as never, file));
      const [row] = await env.sql<{ details: { through: string; by: string } }[]>`select details from audit_log where entity = 'period' and action = 'lock'`;
      expect(row!.details).toMatchObject({ through: '2026-02-28', by: 'the company file' });
    } finally {
      await env.close();
    }
  });
});
