/**
 * Shap 1.24 / Pocket 1.8, from the accountant: cash receipts for sales are out. Every sale is a tax invoice (an
 * invoice for a business not registered for VAT), issued and paid on the spot, numbered in the
 * same series as every other invoice. And the books lock month by month for a business that sells
 * (month end, by hand or by itself on a day of the next month), year by year otherwise, the owner
 * locking and reopening (with a reason). Each test failed before. All data made up.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditBooks } from '../src/audit/books.js';
import { expectCleanAudit, login, setup, type TestEnv } from './helpers.js';

const D = '2026-09-15';

async function shop(env: TestEnv, opts: { vat?: boolean } = {}) {
  const me = await login(env.app);
  const { settings } = await me.get('/api/reference');
  await me.post('/api/settings', { ...settings, vatRegistered: opts.vat ?? true, vatNumber: opts.vat === false ? '' : '4740101508', features: { ...settings.features, sales: true } }, 'PUT');
  const till = (await env.sql<{ id: string }[]>`select id from payment_sources where till`)[0]!.id;
  const client = await me.post('/api/clients', { name: 'Fictional Builder (Pty) Ltd', address: '5 Pretend Road, Fictional Town' });
  return { me, till, client };
}
const sale = (till: string, extra: Record<string, unknown> = {}) => ({ date: D, sourceId: till, method: 'cash', lines: [{ description: 'Brown bread (made up)', qty: 1, unitPriceCents: 1_800, vatCode: 'zero' }, { description: 'Key cut (made up)', qty: 2, unitPriceCents: 2_300 }], ...extra });

describe('every sale is an invoice, in the invoice numbers', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
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

  it('takes the next invoice number, between the invoices from Quotes & invoices', async () => {
    const a = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: D, lines: [{ category: 'labour', description: 'Made-up work', qty: 1, unitPriceCents: 50_000 }] });
    await me.post(`/api/documents/${a.id}/issue`, {});
    const s = await me.post('/api/sales', sale(till));
    const b = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: D, lines: [{ category: 'labour', description: 'Made-up work', qty: 1, unitPriceCents: 50_000 }] });
    const n = (x: string) => Number(/(\d+)$/.exec(x)![1]);
    expect([n(s.number) - n(a.number), n(b.number) - n(s.number)]).toEqual([1, 1]);
    expect(s.doc).toMatchObject({ kind: 'invoice', counter: true, status: 'issued', saleNumber: null, clientId: null });
    expect(s).not.toHaveProperty('saleNumber');
    // The sales' own number series is gone.
    const cols = await env.sql`select column_name from information_schema.columns where table_name = 'settings' and column_name like 'sale_%'`;
    expect(cols.length).toBe(0);
    // In the invoice list with the rest.
    expect((await me.get('/api/documents?kind=invoice')).map((d: { id: string }) => d.id)).toContain(s.id);
  });

  it('is a tax invoice on paper, a walk-in’s with zero-rated goods the abridged one (no customer up to R5 000)', async () => {
    const s = await me.post('/api/sales', sale(till, { customerName: 'Made-up Walk-in' }));
    const pdf = await me.call({ method: 'GET', url: `/api/documents/${s.id}/pdf` });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-disposition']).toMatch(/Tax invoice /);
    expect(pdf.headers['content-disposition']).not.toMatch(/Sale /);
  });

  it('puts the customer on the same invoice afterwards, never on an ordinary one or twice', async () => {
    const s = await me.post('/api/sales', sale(till));
    const with_ = await me.post(`/api/sales/${s.id}/customer`, { clientId: client.id });
    expect(with_.doc).toMatchObject({ id: s.id, number: s.number, clientName: 'Fictional Builder (Pty) Ltd', counter: true });
    expect((await me.call({ method: 'POST', url: `/api/sales/${s.id}/customer`, payload: { clientId: client.id } })).statusCode).toBe(400);
    const ordinary = await me.post('/api/documents', { kind: 'invoice', issueDate: D, lines: [{ category: 'labour', description: 'Made-up work', qty: 1, unitPriceCents: 1_000 }] });
    expect((await me.call({ method: 'POST', url: `/api/sales/${ordinary.id}/customer`, payload: { clientId: client.id } })).statusCode).toBe(404);
    await me.call({ method: 'DELETE', url: `/api/documents/${ordinary.id}` });
  });

  it('takes a sale back only by a refund: no credit note on its own, no payment, no write-off, never voided', async () => {
    const s = await me.post('/api/sales', sale(till));
    for (const [url, payload] of [
      [`/api/documents/${s.id}/credit-note`, {}],
      [`/api/documents/${s.id}/receipts`, { date: D, amountCents: 100, sourceId: till, method: 'cash' }],
      [`/api/documents/${s.id}/write-off`, { date: D, reason: 'Made up' }],
      [`/api/documents/${s.id}/void`, { reason: 'Made up' }],
    ] as const) {
      const r = await me.call({ method: 'POST', url, payload });
      expect([r.statusCode, url]).toEqual([400, url]);
    }
  });

  it('flags a sale’s invoice that isn’t issued (put wrong behind the app’s back)', async () => {
    const s = await me.post('/api/sales', sale(till));
    await env.sql`update documents set status = 'void' where id = ${s.id}`;
    expect((await auditBooks(env.sql, '2026-09-30')).find((i) => /a sale's invoice that isn't issued/.test(i.text))).toMatchObject({ level: 'fail' });
    await env.sql`update documents set status = 'issued' where id = ${s.id}`;
  });
});

describe('a business not registered for VAT', () => {
  it('says “Invoice”, not “Tax invoice”, for a business not registered for VAT', async () => {
    const plain = await setup();
    try {
      const { me: owner, till: t } = await shop(plain, { vat: false });
      const s = await owner.post('/api/sales', sale(t));
      const pdf = await owner.call({ method: 'GET', url: `/api/documents/${s.id}/pdf` });
      expect(pdf.headers['content-disposition']).toMatch(/Invoice /);
      expect(pdf.headers['content-disposition']).not.toMatch(/Tax invoice|Sale /);
      await expectCleanAudit(plain.sql, '2026-09-30');
    } finally {
      await plain.close();
    }
  });
});

describe('sales made before 1.24, brought up to it', () => {
  it('become invoices at the numbers they were issued under, with nothing missing from the numbers', async () => {
    const env = await setup();
    try {
      const { me, till } = await shop(env);
      // Books as 1.23 left them: a walk-in's sale (SL00001), one made an invoice later (invoice
      // 9001, first issued as SL00002), and one whose number an invoice already has (SL00003).
      await env.sql.unsafe(`alter table documents drop constraint documents_kind_check; alter table documents drop constraint documents_check; alter table documents drop constraint documents_counter_check;
        alter table settings add column sale_prefix text not null default 'SL'; alter table settings add column sale_next int not null default 4; alter table settings add column sale_pad int not null default 5`);
      const made = async (kind: string, number: string, saleNumber: string) => {
        const [d] = await env.sql<{ id: string }[]>`insert into documents (kind, number, status, issue_date, sale_number, subtotal_cents, total_cents, terms)
          values (${kind}, ${number}, 'issued', ${D}, ${saleNumber}, 1_000, 1_000, '') returning id`;
        await env.sql`insert into document_lines (document_id, sort, category, description, qty, unit, unit_price_cents, line_total_cents, vat_code) values (${d!.id}, 0, 'other', 'Made-up goods', 1, '', 1_000, 1_000, 'exempt')`;
        const [rc] = await env.sql<{ id: string }[]>`insert into receipts (invoice_id, date, amount_cents, source_id, method, note) values (${d!.id}, ${D}, 1_000, ${till}, 'cash', 'Paid at the counter') returning id`;
        await env.sql`update documents set sale_receipt_id = ${rc!.id} where id = ${d!.id}`;
        return d!.id;
      };
      const walkIn = await made('sale', 'SL00001', 'SL00001');
      const invoiced = await made('invoice', '9001', 'SL00002');
      const clash = await made('sale', 'SL00003', 'SL00003');
      await env.sql`insert into documents (kind, number, status, issue_date) values ('invoice', 'SL00003', 'draft', ${D})`;
      await env.sql.unsafe(readFileSync(join(import.meta.dirname, '../migrations/042_sales_invoices_locks.sql'), 'utf8'));
      const rows = await env.sql<{ id: string; kind: string; number: string; saleNumber: string | null; counter: boolean; dueDate: string }[]>`
        select id, kind, number, sale_number, counter, due_date::text as due_date from documents where id in (${walkIn}, ${invoiced}, ${clash})`;
      const by = new Map(rows.map((x) => [x.id, x]));
      expect(by.get(walkIn)).toMatchObject({ kind: 'invoice', number: 'SL00001', saleNumber: null, counter: true, dueDate: D });
      expect(by.get(invoiced)).toMatchObject({ kind: 'invoice', number: '9001', saleNumber: 'SL00002', counter: true });
      expect(by.get(clash)).toMatchObject({ kind: 'invoice', number: 'SL00003-S', counter: true });
      expect((await env.sql`select column_name from information_schema.columns where table_name = 'settings' and column_name like 'sale_%'`).length).toBe(0);
      // SL00002 counts as used (it's invoice 9001's first number): no gap in the old series.
      const items = await auditBooks(env.sql, '2026-09-30');
      expect(items.find((i) => /invoice numbers missing/.test(i.text))?.text ?? '').not.toMatch(/SL00002/);
      expect(items.filter((i) => i.level === 'fail').map((i) => i.text)).toEqual([]);
      // And they're sales still: under Sales, refunded at the counter.
      expect((await me.get('/api/sales')).map((x: { id: string }) => x.id).sort()).toEqual([walkIn, invoiced, clash].sort());
    } finally {
      await env.close();
    }
  });
});

describe('locks: month end, and who may close and reopen', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let till: string;
  beforeAll(async () => {
    env = await setup();
    ({ me, till } = await shop(env));
    await me.post('/api/sales', sale(till, { date: '2026-09-15' }));
    await me.post('/api/sales', sale(till, { date: '2026-10-05' }));
  });
  afterAll(async () => {
    vi.useRealTimers();
    await expectCleanAudit(env.sql, '2026-10-31');
    await env.close();
  });

  it('is the owner’s: they lock a month', async () => {
    expect((await me.post('/api/periods/lock', { through: '2026-09-30' })).lockDate).toBe('2026-09-30');
  });

  it('closes a month for everyone, the owner too, pointing to who may reopen it', async () => {
    const r = await me.call({ method: 'POST', url: '/api/sales', payload: sale(till, { date: '2026-09-20' }) });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/closed up to 2026-09-30.*Accounts → Locks/);
    // Only month ends, only months that have ended, and never backwards by locking.
    for (const through of ['2026-10-15', '2099-12-31', '2026-08-31']) expect((await me.call({ method: 'POST', url: '/api/periods/lock', payload: { through } })).statusCode).toBe(400);
  });

  it('reopens with the reason, kept with who did it, and locks again where it was', async () => {
    expect((await me.call({ method: 'POST', url: '/api/periods/reopen', payload: { to: '2026-08-31', reason: '' } })).statusCode).toBe(400);
    const opened = await me.post('/api/periods/reopen', { to: '2026-08-31', reason: 'A supplier invoice came in late (made up)' });
    expect(opened).toMatchObject({ lockDate: '2026-08-31', reopened: { relockDate: '2026-09-30', reason: 'A supplier invoice came in late (made up)' } });
    const [logged] = await env.sql<{ details: { was: string; to: string; reason: string } }[]>`select details from audit_log where entity = 'period' and action = 'reopen'`;
    expect(logged!.details).toMatchObject({ was: '2026-09-30', to: '2026-08-31' });
    await me.post('/api/sales', sale(till, { date: '2026-09-21' }));
    expect((await me.get('/api/dashboard')).periods.reopened).toMatchObject({ relockDate: '2026-09-30' });
    const again = await me.post('/api/periods/lock', { through: '2026-09-30' });
    expect(again).toMatchObject({ lockDate: '2026-09-30', reopened: null });
  });

  it('by hand: nothing locks by itself; Home says when last month is due', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-09T08:00:00Z') });
    expect((await me.get('/api/dashboard')).periods).toMatchObject({ monthDue: '2026-10-31', lockDate: '2026-09-30' });
    vi.setSystemTime(new Date('2026-11-03T08:00:00Z'));
    expect((await me.get('/api/dashboard')).periods.monthDue).toBeNull();
    vi.useRealTimers();
  });

  it('by itself: each month locks on its day of the next, once, and a reopened month waits for the next one', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-05T08:00:00Z') });
    await me.post('/api/periods/month-end', { mode: 'auto', day: 7 }, 'PUT');
    expect((await me.get('/api/periods')).lockDate).toBe('2026-09-30');
    vi.setSystemTime(new Date('2026-11-07T08:00:00Z'));
    const r = await me.call({ method: 'POST', url: '/api/sales', payload: sale(till, { date: '2026-10-20' }) });
    expect(r.statusCode).toBe(400);
    expect((await me.get('/api/periods')).lockDate).toBe('2026-10-31');
    expect((await env.sql`select 1 from audit_log where entity = 'period' and action = 'lock' and actor = 'system'`).length).toBe(1);
    // Reopened on the 8th: still open on the 20th, locked again on 7 December (with November).
    vi.setSystemTime(new Date('2026-11-08T08:00:00Z'));
    await me.post('/api/periods/reopen', { to: '2026-09-30', reason: 'A refund was missed (made up)' });
    vi.setSystemTime(new Date('2026-11-20T08:00:00Z'));
    await me.post('/api/sales', sale(till, { date: '2026-10-21' }));
    vi.setSystemTime(new Date('2026-12-07T08:00:00Z'));
    expect((await me.get('/api/periods')).lockDate).toBe('2026-11-30');
    expect((await me.get('/api/periods')).reopened).toBeNull();
    vi.useRealTimers();
  });

  it('lists each month with what it holds for a business that sells', async () => {
    const p = await me.get('/api/periods');
    const sep = p.periods.find((x: { end: string }) => x.end === '2026-09-30');
    expect(sep).toMatchObject({ locked: true, salesCount: 2 });
    expect(sep.salesCents).toBe(2 * 6_400);
  });
});

describe('locks for a business that doesn’t sell', () => {
  it('lists years, locks a year the same way, and has no month end', async () => {
    const service = await setup();
    try {
      const owner = await login(service.app);
      const { settings } = await owner.get('/api/reference');
      await owner.post('/api/settings', { ...settings, fyEndMonth: 2 }, 'PUT');
      const s = await owner.get('/api/periods');
      expect(s.sells).toBe(false);
      expect(s.periods[0].end.slice(5)).toBe('02-28');
      expect((await owner.call({ method: 'PUT', url: '/api/periods/month-end', payload: { mode: 'auto', day: 7 } })).statusCode).toBe(400);
      expect((await owner.get('/api/dashboard')).periods.monthDue).toBeNull();
      // A year locks the same way.
      expect((await owner.post('/api/periods/lock', { through: '2026-02-28' })).lockDate).toBe('2026-02-28');
      await expectCleanAudit(service.sql, '2026-02-28');
    } finally {
      await service.close();
    }
  });
});
