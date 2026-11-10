/**
 * Sales at the counter in Shap Pocket (no stock: inventory is full Shap's), and the annual
 * financial statements the Pocket way (no accountant's login: the signed compiler's report is
 * uploaded). The books are checked at each step and the audit is clean at the end. All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balance, expectCleanAudit, ledgerTotal, login, setup, type TestEnv } from './helpers.js';

const D = '2025-06-02';

describe('selling at the counter, VAT registered', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let till: string;
  let bank: string;
  let globe: { id: string };
  let bread: { id: string };
  let client: { id: string };

  beforeAll(async () => {
    env = await setup();
    me = await login(env.app);
    const { settings, sources } = await me.get('/api/reference');
    // Asked for inventory too: Pocket keeps it off (stock is full Shap's), sales on.
    await me.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4740101508', fyEndMonth: 2, features: { ...settings.features, sales: true, inventory: true, statements: true } }, 'PUT');
    till = (await env.sql<{ id: string }[]>`select id from payment_sources where till`)[0]!.id;
    bank = sources.find((s: { name: string }) => s.name === 'Business bank').id;
    globe = await me.post('/api/items', { description: 'LED globe (made up)', unitPriceCents: 4_600, priceIncludesVat: true });
    bread = await me.post('/api/items', { description: 'Brown bread (made up)', unitPriceCents: 1_800, vatCode: 'zero', priceIncludesVat: true });
    client = await me.post('/api/clients', { name: 'Fictional Builders', address: '3 Test Road, Fictional Town' });
  });
  afterAll(() => env.close());

  it('sells without keeping stock: inventory stays off and stocked items are refused', async () => {
    const { settings } = await me.get('/api/reference');
    expect(settings.features).toMatchObject({ sales: true, inventory: false });
    expect((await me.call({ method: 'POST', url: '/api/items', payload: { description: 'Stocked (made up)', stocked: true } })).statusCode).toBe(400);
    expect((await me.call({ method: 'POST', url: '/api/stock/purchases', payload: {} })).statusCode).toBe(404);
  });

  it('takes a sale: paid into the till, VAT by line (standard, zero-rated), a discount line', async () => {
    // Zero-rated bread on a sale over R50: the full tax invoice, so the customer's on it (VAT Act s20(5)).
    const s = await me.post('/api/sales', {
      date: D,
      sourceId: till,
      method: 'cash',
      clientId: client.id,
      lines: [
        { itemId: globe.id, description: 'LED globe (made up)', qty: 2, unitPriceCents: 4_600 },
        { itemId: bread.id, description: 'Brown bread (made up)', qty: 1, unitPriceCents: 1_800, vatCode: 'zero' },
        { description: 'Loyalty discount', qty: 1, unitPriceCents: -460 },
      ],
    });
    // An invoice, with the next invoice number (no sale numbers of their own any more).
    expect(s.doc).toMatchObject({ kind: 'invoice', counter: true, saleNumber: null });
    expect(s.number).toMatch(/\d/);
    // R92 − R4.60 at 15% inclusive: VAT R11.40; bread R18 at 0%.
    expect(s.doc).toMatchObject({ totalCents: 10_540, vatCents: 1_140 });
    expect(await balance(env.sql, 'receivables')).toBe(0);
    const tillBal = Number((await env.sql<{ b: string }[]>`select coalesce(sum(l.amount_cents), 0) as b from ledger l join payment_sources s on s.account_id = l.account_id where s.till`)[0]!.b);
    expect(tillBal).toBe(10_540);
    const vat = await me.get(`/api/vat/return?on=${D}`);
    // Field 1 is the standard-rated supplies including their VAT (R92 − R4.60).
    expect(vat.fields).toMatchObject({ field1: 8_740, field2: 1_800, field4: 1_140 });
  });

  it('wants the customer over R5 000, and puts a walk-in’s details on their invoice afterwards', async () => {
    const big = { date: D, sourceId: bank, method: 'card', lines: [{ itemId: globe.id, description: 'LED globe (made up)', qty: 120, unitPriceCents: 4_600 }] };
    expect((await me.call({ method: 'POST', url: '/api/sales', payload: big })).statusCode).toBe(400);
    const inv = await me.post('/api/sales', { ...big, clientId: client.id });
    expect(inv.doc).toMatchObject({ kind: 'invoice', counter: true, paymentState: 'paid' });
    const walkIn = await me.post('/api/sales', { date: D, sourceId: till, lines: [{ itemId: globe.id, description: 'LED globe (made up)', qty: 1, unitPriceCents: 4_600 }] });
    const made = await me.post(`/api/sales/${walkIn.id}/customer`, { clientId: client.id });
    expect(made.doc).toMatchObject({ kind: 'invoice', totalCents: 4_600, vatCents: 600, number: walkIn.number, clientId: client.id });
    expect(await balance(env.sql, 'receivables')).toBe(0);
  });

  it('refunds what came back, never more than was paid, and keeps every sale', async () => {
    const [sale] = await env.sql<{ id: string }[]>`select id from documents where counter order by created_at limit 1`;
    const detail = await me.get(`/api/sales/${sale!.id}`);
    const globes = detail.lines.find((l: { description: string }) => l.description.startsWith('LED'));
    const r = await me.post(`/api/documents/${sale!.id}/refund`, { date: D, sourceId: till, reason: 'Wrong fitting (made up)', lines: [{ lineId: globes.id, qty: 1 }] });
    expect(r.amountCents).toBe(4_600);
    const again = await me.call({ method: 'POST', url: `/api/documents/${sale!.id}/refund`, payload: { date: D, sourceId: till, reason: 'Again', lines: [{ lineId: globes.id, qty: 2 }] } });
    expect(again.statusCode).toBe(400);
    await expect(env.sql`delete from documents where id = ${sale!.id}`).rejects.toThrow();
    expect(await ledgerTotal(env.sql)).toBe(0);
    await expectCleanAudit(env.sql, D);
  });

  it('draws up the statements, and finishes the year with the accountant’s signed report uploaded', async () => {
    const fy = '2026-02-28';
    const years = await me.get('/api/statements');
    expect(years.map((y: { fyEnd: string }) => y.fyEnd)).toContain(fy);
    const draft = await me.get(`/api/statements/${fy}`);
    expect(draft.status).toBe('draft');
    expect(draft.statements.checks.filter((c: { ok: boolean; level?: string }) => !c.ok && c.level !== 'look')).toEqual([]);
    expect(draft.statements.sci.revenue.reduce((t: number, l: { current: number }) => t + l.current, 0)).toBeGreaterThan(0);
    const pdf = await me.call({ method: 'GET', url: `/api/statements/${fy}/pdf` });
    expect(pdf.statusCode).toBe(200);
    // No accountant's login and no mail on a phone: those steps aren't here.
    expect((await me.call({ method: 'POST', url: `/api/statements/${fy}/send`, payload: { to: 'accountant@example.co.za' } })).statusCode).toBe(404);
    expect((await me.call({ method: 'POST', url: `/api/statements/${fy}/compile`, payload: {} })).statusCode).toBe(404);
    const file = await me.post('/api/attachments', { filename: 'compiler report.pdf', mime: 'application/pdf', dataBase64: Buffer.from('%PDF-1.4\n% made-up signed report\n').toString('base64') });
    await me.post(`/api/statements/${fy}/compiler-report`, { attachmentId: file.id, compilerName: 'Fictional Accountant', date: '2026-05-01' });
    await me.post(`/api/statements/${fy}/approve`, { name: 'Fictional Owner', date: '2026-05-02' });
    expect((await me.get(`/api/statements/${fy}`)).status).toBe('approved');
    // The year is agreed and closed: nothing more goes into it.
    const late = await me.call({ method: 'POST', url: '/api/sales', payload: { date: '2025-12-01', sourceId: till, lines: [{ description: 'Late (made up)', qty: 1, unitPriceCents: 100 }] } });
    expect(late.statusCode).toBe(400);
    await expectCleanAudit(env.sql, '2026-05-02');
  });
});

describe('selling at the counter, not registered for VAT', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    env = await setup();
    me = await login(env.app);
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, vatRegistered: false, vatNumber: '', features: { ...settings.features, sales: true } }, 'PUT');
  });
  afterAll(() => env.close());

  it('sells without VAT, whatever VAT class a line says', async () => {
    const till = (await env.sql<{ id: string }[]>`select id from payment_sources where till`)[0]!.id;
    const s = await me.post('/api/sales', {
      date: D,
      sourceId: till,
      lines: [
        { description: 'Vetkoek (made up)', qty: 10, unitPriceCents: 800, vatCode: 'standard' },
        { description: 'Export parcel (made up)', qty: 1, unitPriceCents: 9_000_00, vatCode: 'export' },
      ],
    });
    // No VAT, and no full tax invoice needed (it isn't a tax invoice at all).
    expect(s.doc).toMatchObject({ vatCents: 0, totalCents: 8_000 + 900_000 });
    expect(await balance(env.sql, 'vat')).toBe(0);
    expect(await ledgerTotal(env.sql)).toBe(0);
    await expectCleanAudit(env.sql, D);
  });
});
