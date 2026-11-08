/**
 * VAT per line: standard-rated, zero-rated, exported and exempt lines on one invoice, prices
 * typed including or excluding VAT, the VAT201 split by line, bad debts on a mixed invoice, the
 * rate by date, and the VAT on costs.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientVatNumberProblem, documentTotals, idNumberProblem, vatRateOn } from '@shap/shared';
import { monthRates } from '../src/modules/market.js';
import { uifForEmp501 } from '../src/modules/payroll.js';
import { vat201 } from '../src/modules/taxforms.js';
import { vatStatus } from '../src/modules/vat.js';
import { balance, ledgerTotal, login, ref, setup, type TestEnv } from './helpers.js';

describe('working out a document’s totals', () => {
  it('charges VAT only on the standard-rated lines, once on their total', () => {
    const t = documentTotals(
      [
        { qty: 1, unitPriceCents: 100_000, vatCode: 'standard' },
        { qty: 3, unitPriceCents: 3_333, vatCode: 'standard' },
        { qty: 2, unitPriceCents: 5_000, vatCode: 'zero' },
        { qty: 1, unitPriceCents: 20_000, vatCode: 'export' },
        { qty: 1, unitPriceCents: 7_000, vatCode: 'exempt' },
      ],
      1500,
      false,
    );
    expect(t.subtotalCents).toBe(100_000 + 9_999 + 10_000 + 20_000 + 7_000);
    expect(t.vatCents).toBe(Math.round(109_999 * 0.15)); // 16 499.85 → 16 500
    expect(t.totalCents).toBe(t.subtotalCents + t.vatCents);
    expect(t.byCode).toEqual({ standard: 109_999, zero: 10_000, export: 20_000, exempt: 7_000 });
    expect(t.lines.map((l) => l.vatCents).reduce((a, b) => a + b, 0)).toBe(t.vatCents);
  });

  it('takes prices including VAT exactly as typed, with the VAT worked out from them', () => {
    const t = documentTotals(
      [
        { qty: 3, unitPriceCents: 10_000, vatCode: 'standard' },
        { qty: 1, unitPriceCents: 999, vatCode: 'standard' },
        { qty: 1, unitPriceCents: 5_000, vatCode: 'zero' },
        { qty: 1, unitPriceCents: -1_000, vatCode: 'standard' }, // a discount
      ],
      1500,
      true,
    );
    expect(t.totalCents).toBe(30_000 + 999 + 5_000 - 1_000);
    expect(t.vatCents).toBe(Math.round((29_999 * 15) / 115)); // 3 912.91 → 3 913
    // Each line excluding VAT adds up to the total excluding VAT; the zero-rated line is as typed.
    expect(t.lines.reduce((a, l) => a + l.netCents, 0)).toBe(t.subtotalCents);
    expect(t.lines[2]!.netCents).toBe(5_000);
    expect(t.lines.reduce((a, l) => a + l.vatCents, 0)).toBe(t.vatCents);
  });

  it('has no VAT at a 0% rate (not registered)', () => {
    expect(documentTotals([{ qty: 1, unitPriceCents: 10_000, vatCode: 'standard' }], 0, true)).toMatchObject({ subtotalCents: 10_000, vatCents: 0, totalCents: 10_000 });
  });

  it('gives a discount line its own share of the VAT, so each category’s revenue is right', () => {
    const t = documentTotals(
      [
        { qty: 1, unitPriceCents: 100_000, vatCode: 'standard' },
        { qty: 1, unitPriceCents: -99_990, vatCode: 'standard' },
      ],
      1500,
      true,
    );
    expect(t.vatCents).toBe(1); // R0.10 including VAT
    expect(t.lines[0]!.netCents).toBe(86_957); // R1 000 / 1.15, not R900
    expect(t.lines.reduce((a, l) => a + l.netCents, 0)).toBe(t.subtotalCents);
    expect(t.lines.reduce((a, l) => a + l.vatCents, 0)).toBe(t.vatCents);
  });

  it('knows the standard rate on any date', () => {
    expect(vatRateOn('2018-03-31')).toBe(1400);
    expect(vatRateOn('2018-04-01')).toBe(1500);
    expect(vatRateOn('2026-11-09')).toBe(1500);
  });
});

describe('in the books', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let client: { id: string };
  let bank: string;
  let mixed: { id: string };
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app);
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4740101508', address: '12 Fictional Street, Gqeberha', industry: 'electrician' }, 'PUT');
    client = await me.post('/api/clients', { name: 'Fictional Exports (Pty) Ltd', address: '1 Harbour Road, Gqeberha' });
    bank = await (await ref(env.sql)).src('Business bank');
  });
  afterAll(() => env.close());

  it('posts each kind of supply where it belongs, and the VAT201 splits them', async () => {
    mixed = await me.post('/api/documents', {
      kind: 'invoice',
      clientId: client.id,
      issueDate: '2026-11-03',
      lines: [
        { category: 'labour', description: 'Installation', qty: 1, unitPriceCents: 100_000, vatCode: 'standard' },
        { category: 'materials', description: 'Brown bread for the crew', qty: 2, unitPriceCents: 5_000, vatCode: 'zero' },
        { category: 'materials', description: 'Switchgear, exported', qty: 1, unitPriceCents: 20_000, vatCode: 'export' },
        { category: 'other', description: 'Interest on overdue account', qty: 1, unitPriceCents: 7_000, vatCode: 'exempt' },
      ],
    });
    await me.post(`/api/documents/${mixed.id}/issue`);
    const { doc, lines } = await me.get(`/api/documents/${mixed.id}`);
    expect(doc).toMatchObject({ subtotalCents: 137_000, vatCents: 15_000, totalCents: 152_000, pricesIncludeVat: false });
    expect(lines.map((l: { vatCode: string }) => l.vatCode)).toEqual(['standard', 'zero', 'export', 'exempt']);
    expect(await balance(env.sql, 'vat')).toBe(-15_000);
    expect(await balance(env.sql, 'receivables')).toBe(152_000);
    expect(await ledgerTotal(env.sql)).toBe(0);
    const f = await vat201(env.sql, '2026-11-01', '2026-11-30');
    expect(f).toMatchObject({ field1: 115_000, field2: 10_000, field2A: 20_000, field3: 7_000, field4: 15_000 });
  });

  it('credits a mixed invoice line by line, at the invoice’s VAT', async () => {
    const cn = await me.post(`/api/documents/${mixed.id}/credit-note`);
    const draft = await me.get(`/api/documents/${cn.id}`);
    expect(draft.lines.map((l: { vatCode: string }) => l.vatCode)).toEqual(['standard', 'zero', 'export', 'exempt']);
    // Take back only the exported switchgear.
    await me.post(`/api/documents/${cn.id}`, { ...draft.doc, creditReason: 'Switchgear returned', lines: [draft.lines[2]] }, 'PUT');
    await me.post(`/api/documents/${cn.id}/issue`);
    const f = await vat201(env.sql, '2026-11-01', '2026-11-30');
    expect(f).toMatchObject({ field1: 115_000, field2A: 0, field4: 15_000 });
    expect(await ledgerTotal(env.sql)).toBe(0);
  });

  it('takes an invoice priced including VAT at exactly what was typed', async () => {
    const inc = await me.post('/api/documents', {
      kind: 'invoice',
      clientId: client.id,
      issueDate: '2026-11-04',
      pricesIncludeVat: true,
      lines: [
        { category: 'labour', description: 'Install plug point', unit: 'point', qty: 3, unitPriceCents: 57_500, vatCode: 'standard' },
        { category: 'materials', description: 'Paraffin', qty: 1, unitPriceCents: 3_333, vatCode: 'zero' },
      ],
    });
    await me.post(`/api/documents/${inc.id}/issue`);
    const { doc, lines } = await me.get(`/api/documents/${inc.id}`);
    expect(doc).toMatchObject({ totalCents: 172_500 + 3_333, vatCents: 22_500, subtotalCents: 150_000 + 3_333, pricesIncludeVat: true });
    // Kept as typed; each line's total is without VAT (what the books post as revenue).
    expect(lines[0]).toMatchObject({ unitPriceCents: 57_500, lineTotalCents: 150_000 });
    expect(await ledgerTotal(env.sql)).toBe(0);
    // Shared anonymously without VAT: R500 a point, not R575.
    const rates = await monthRates(env.sql, 'electrician', '2026-11');
    expect(rates.find((r) => r.item === 'Install plug point')?.cents).toBe(50_000);
    const pdf = await me.call({ method: 'GET', url: `/api/documents/${inc.id}/pdf` });
    expect(pdf.headers['content-type']).toBe('application/pdf');
  });

  it('claims back only the VAT in a written-off mixed invoice', async () => {
    const before = (await vat201(env.sql, '2026-12-01', '2026-12-31')).field17;
    // R1 520 on the mixed invoice, R200 of it credited (the switchgear). Write off what's left.
    await me.post(`/api/documents/${mixed.id}/write-off`, { date: '2026-12-15', reason: 'Client closed down' });
    const { doc } = await me.get(`/api/documents/${mixed.id}`);
    const relief = (await vat201(env.sql, '2026-12-01', '2026-12-31')).field17 - before;
    // The credit note took back only zero-VAT switchgear: all R150 of VAT is still in the debt.
    expect(doc.writtenOffCents).toBe(132_000);
    expect(relief).toBe(15_000);
    // The VAT account moved by the same amount the return claims.
    expect(await ledgerTotal(env.sql)).toBe(0);
  });

  it('dates a document’s VAT rate by its own date', async () => {
    const old = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: '2018-03-20', lines: [{ category: 'labour', description: 'Old job', qty: 1, unitPriceCents: 10_000 }] });
    expect((await me.get(`/api/documents/${old.id}`)).doc).toMatchObject({ vatRateBp: 1400, vatCents: 1_400 });
  });

  it('claims VAT on a cost only when it’s standard-rated', async () => {
    const r = await ref(env.sql);
    const cat = await r.cat('Parts');
    const add = (vatCode: string, vatCents: number) => me.post('/api/costs', { date: '2026-11-05', description: `A ${vatCode} cost`, amountCents: 11_500, vatCents, vatCode, categoryId: cat, sourceId: bank });
    expect((await add('standard', 1_500)).vatCents).toBe(1_500);
    expect((await add('not_claimable', 1_500)).vatCents).toBe(0); // entertainment, a car
    expect((await add('zero', 1_500)).vatCents).toBe(0);
    const c = await add('no_vat', 0);
    expect(c.vatCode).toBe('no_vat');
    expect((await vat201(env.sql, '2026-11-01', '2026-11-30')).field15).toBe(1_500);
  });
});

describe('what the review found', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let client: { id: string };
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app);
    client = await me.post('/api/clients', { name: 'Fictional Lettings CC', address: '3 Imaginary Lane, Makhanda', email: 'accounts@lettings.example' });
  });
  afterAll(() => env.close());
  const settingsWith = async (patch: Record<string, unknown>) => {
    const { settings } = await me.get('/api/reference');
    return me.post('/api/settings', { ...settings, ...patch }, 'PUT');
  };
  const invoice = (lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
    me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: '2026-11-02', lines, ...extra });

  it('charges VAT on a draft made before registering, once it’s issued after', async () => {
    const draft = await invoice([{ category: 'labour', description: 'Wiring', qty: 1, unitPriceCents: 100_000 }]);
    expect((await me.get(`/api/documents/${draft.id}`)).doc).toMatchObject({ vatRateBp: 0, vatCents: 0 });
    await settingsWith({ vatRegistered: true, vatNumber: '4740101508', address: '' });
    // A tax invoice names the business's address.
    const noAddress = await me.call({ method: 'POST', url: `/api/documents/${draft.id}/issue` });
    expect(noAddress.json().error).toMatch(/business address/);
    await settingsWith({ address: '12 Fictional Street, Gqeberha' });
    await me.post(`/api/documents/${draft.id}/issue`);
    expect((await me.get(`/api/documents/${draft.id}`)).doc).toMatchObject({ vatRateBp: 1500, vatCents: 15_000, totalCents: 115_000 });
    expect((await vat201(env.sql, '2026-11-01', '2026-11-30')).field4).toBe(15_000);
  });

  it('needs the client’s details on any invoice with zero-rated or exported items', async () => {
    const walkIn = await me.post('/api/clients', { name: 'Walk-in' });
    const inv = await invoice([{ category: 'materials', description: 'Maize meal', qty: 1, unitPriceCents: 10_000, vatCode: 'zero' }], { clientId: walkIn.id });
    const r = await me.call({ method: 'POST', url: `/api/documents/${inv.id}/issue` });
    expect(r.json().error).toMatch(/zero-rated or exported/);
    // Standard-rated and under R5 000: the short form is fine.
    const small = await invoice([{ category: 'labour', description: 'Call-out', qty: 1, unitPriceCents: 10_000 }], { clientId: walkIn.id });
    expect((await me.call({ method: 'POST', url: `/api/documents/${small.id}/issue` })).statusCode).toBe(200);
  });

  it('holds a credit note to what the invoice it credits needed', async () => {
    const big = await me.post('/api/clients', { name: 'Fictional Builders (Pty) Ltd', address: '9 Make-Believe Road, Mthatha' });
    const inv = await invoice([{ category: 'labour', description: 'Rewire', qty: 1, unitPriceCents: 2_000_000 }], { clientId: big.id });
    await me.post(`/api/documents/${inv.id}/issue`);
    await me.post(`/api/clients/${big.id}`, { name: 'Fictional Builders (Pty) Ltd', address: '' }, 'PUT');
    const cn = await me.post(`/api/documents/${inv.id}/credit-note`);
    const draft = await me.get(`/api/documents/${cn.id}`);
    await me.post(`/api/documents/${cn.id}`, { ...draft.doc, creditReason: 'Overcharged', lines: [{ ...draft.lines[0], unitPriceCents: 100_000 }] }, 'PUT');
    // R1 150 itself, but on a R23 000 invoice: the client's details are still needed.
    const r = await me.call({ method: 'POST', url: `/api/documents/${cn.id}/issue` });
    expect(r.json().error).toMatch(/as the invoice it credits did/);
  });

  it('keeps how an issued invoice’s prices were typed', async () => {
    const inv = await invoice([{ category: 'labour', description: 'Plug point', qty: 1, unitPriceCents: 11_500 }], { pricesIncludeVat: true });
    await me.post(`/api/documents/${inv.id}/issue`);
    const { doc, lines } = await me.get(`/api/documents/${inv.id}`);
    expect(doc.totalCents).toBe(11_500);
    const flip = await me.call({ method: 'PUT', url: `/api/documents/${inv.id}`, payload: { ...doc, pricesIncludeVat: false, lines } });
    expect(flip.statusCode).toBe(400);
    // Left out (an older screen, another tool): it stays including VAT.
    const { pricesIncludeVat: _left, ...rest } = doc;
    await me.post(`/api/documents/${inv.id}`, { ...rest, lines }, 'PUT');
    expect((await me.get(`/api/documents/${inv.id}`)).doc).toMatchObject({ totalCents: 11_500, pricesIncludeVat: true });
  });

  it('claims nothing back on a written-off debt the credit note emptied of VAT', async () => {
    const inv = await invoice([
      { category: 'labour', description: 'Install', qty: 1, unitPriceCents: 115_000, vatCode: 'standard' },
      { category: 'materials', description: 'Panels, exported', qty: 1, unitPriceCents: 300_000, vatCode: 'export' },
    ], { pricesIncludeVat: true, issueDate: '2026-11-10' });
    await me.post(`/api/documents/${inv.id}/issue`);
    const cn = await me.post(`/api/documents/${inv.id}/credit-note`);
    const draft = await me.get(`/api/documents/${cn.id}`);
    await me.post(`/api/documents/${cn.id}`, { ...draft.doc, creditReason: 'Install not done', lines: [draft.lines[0]] }, 'PUT');
    await me.post(`/api/documents/${cn.id}/issue`);
    const before = (await vat201(env.sql, '2026-12-01', '2026-12-31')).field17;
    await me.post(`/api/documents/${inv.id}/write-off`, { date: '2026-12-20', reason: 'Client gone' });
    expect((await vat201(env.sql, '2026-12-01', '2026-12-31')).field17 - before).toBe(0);
    expect(await ledgerTotal(env.sql)).toBe(0);
    // And the books agree: no VAT moved on the write-off.
    const [w] = await env.sql<{ vat: number }[]>`select coalesce(sum(amount_cents), 0)::int as vat from ledger_detail where source_id = ${inv.id} and source = 'write_off' and account_id = sys_account('vat')`;
    expect(w!.vat).toBe(0);
  });
});

describe('an issued tax invoice is fixed', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let client: { id: string };
  let other: { id: string };
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app);
    client = await me.post('/api/clients', { name: 'Fictional Hardware CC', address: '7 Invented Avenue, Komani' });
    other = await me.post('/api/clients', { name: 'Fictional Other CC', address: '8 Invented Avenue, Komani' });
  });
  afterAll(() => env.close());
  const issued = async () => {
    const inv = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: '2026-11-05', lines: [{ category: 'labour', description: 'Geyser install', qty: 1, unitPriceCents: 300_000 }] });
    await me.post(`/api/documents/${inv.id}/issue`);
    return { id: inv.id as string, ...(await me.get(`/api/documents/${inv.id}`)) };
  };
  const put = (id: string, body: Record<string, unknown>) => me.call({ method: 'PUT', url: `/api/documents/${id}`, payload: body });

  it('lets a business that isn’t a VAT vendor change an issued invoice as it likes', async () => {
    const { id, doc, lines } = await issued();
    expect(doc.vatRateBp).toBe(0);
    const r = await put(id, { ...doc, lines: [{ ...lines[0], unitPriceCents: 350_000 }] });
    expect(r.statusCode).toBe(200);
    expect(r.json().doc.totalCents).toBe(350_000);
  });

  it('keeps what a VAT vendor’s issued invoice charges, to whom, when and under which number', async () => {
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4740101508' }, 'PUT');
    const { id, doc, lines } = await issued();
    expect(doc).toMatchObject({ vatRateBp: 1500, totalCents: 345_000 });
    for (const [change, what] of [
      [{ lines: [{ ...lines[0], unitPriceCents: 350_000 }] }, /items and prices/],
      [{ lines: [...lines, { category: 'materials', description: 'Valve', qty: 1, unitPriceCents: 10_000 }] }, /items and prices/],
      [{ lines: [{ ...lines[0], vatCode: 'zero' }] }, /items and prices/],
      [{ clientId: other.id }, /the client/],
      [{ issueDate: '2026-11-06' }, /the date/],
      [{ number: 'INV-9999' }, /the number/],
      [{ pricesIncludeVat: true }, /whether prices include VAT/],
    ] as const) {
      const r = await put(id, { ...{ ...doc, lines }, ...change });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(what);
      expect(r.json().error).toMatch(/credit note/);
    }
    // What isn't on the tax invoice's face as a charge can still change.
    const ok = await put(id, { ...doc, lines: [{ ...lines[0], category: 'other' }], notes: 'Thanks for the business', terms: 'Pay within 7 days', dueDate: '2026-11-30' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().doc).toMatchObject({ notes: 'Thanks for the business', dueDate: '2026-11-30', totalCents: 345_000 });
    expect(await ledgerTotal(env.sql)).toBe(0);
    // A draft is free to change until it's issued.
    const draft = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: '2026-11-05', lines: [{ category: 'labour', description: 'Quote me', qty: 1, unitPriceCents: 1_000 }] });
    const d2 = await me.get(`/api/documents/${draft.id}`);
    expect((await put(draft.id, { ...d2.doc, lines: [{ ...d2.lines[0], unitPriceCents: 2_000 }], clientId: other.id })).statusCode).toBe(200);
  });
});

describe('invoices from before VAT per line', () => {
  let env: TestEnv;
  afterAll(() => env.close());
  it('keeps zero-VAT invoices a vendor issued before VAT per line as zero-rated, and leaves out those from before registering', async () => {
    // Before this release: a pre-registration invoice (0%), the first with VAT, then a vendor's
    // invoice at 0% (how a zero-rated sale was done then), and a credit note on the first.
    env = await setup();
    await env.sql`update settings set vat_registered = true, vat_number = '4740101508'`;
    const t = await env.sql`insert into clients (name, address) values ('Fictional Old Client', '1 Old Road, Paarl') returning id`;
    const mk = async (date: string, rate: number) => {
      const [d] = await env.sql<{ id: string }[]>`
        insert into documents (kind, number, status, client_id, issue_date, vat_rate_bp, subtotal_cents, vat_cents, total_cents)
        values ('invoice', ${'OLD-' + date}, 'issued', ${t[0]!.id}, ${date}, ${rate}, 10000, ${rate ? 1500 : 0}, ${rate ? 11500 : 10000}) returning id`;
      await env.sql`insert into document_lines (document_id, sort, category, description, qty, unit_price_cents, line_total_cents) values (${d!.id}, 0, 'labour', 'Old work', 1, 10000, 10000)`;
      return d!.id;
    };
    const before = await mk('2025-03-01', 0);
    await mk('2025-06-01', 1500);
    const legacy = await mk('2025-07-01', 0);
    const [cn] = await env.sql<{ id: string }[]>`
      insert into documents (kind, number, status, client_id, issue_date, vat_rate_bp, subtotal_cents, vat_cents, total_cents, credited_invoice_id, credit_reason)
      values ('credit_note', 'OLD-CN', 'issued', ${t[0]!.id}, '2025-07-05', 0, 10000, 0, 10000, ${before}, 'Returned') returning id`;
    await env.sql`insert into document_lines (document_id, sort, category, description, qty, unit_price_cents, line_total_cents) values (${cn!.id}, 0, 'labour', 'Old work', 1, 10000, 10000)`;
    const sqlFile = readFileSync(new URL('../migrations/035_vat_per_line.sql', import.meta.url), 'utf8');
    await env.sql.unsafe(sqlFile.slice(sqlFile.indexOf('do $$\ndeclare first_vat'), sqlFile.indexOf('end $$;', sqlFile.indexOf('declare first_vat')) + 'end $$;'.length));
    const rows = await env.sql<{ number: string; vatRateBp: number; codes: string }[]>`
      select d.number, d.vat_rate_bp, string_agg(l.vat_code, ',') as codes from documents d join document_lines l on l.document_id = d.id group by d.id order by d.number`;
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { number: 'OLD-2025-03-01', vatRateBp: 0, codes: 'standard' },
      { number: 'OLD-2025-06-01', vatRateBp: 1500, codes: 'standard' },
      { number: 'OLD-2025-07-01', vatRateBp: 1500, codes: 'zero' },
      { number: 'OLD-CN', vatRateBp: 0, codes: 'standard' },
    ]);
    // July's return: the legacy zero-rated invoice in field 2; the credit note on the
    // pre-registration invoice isn't on it.
    expect(await vat201(env.sql, '2025-07-01', '2025-07-31')).toMatchObject({ field1: 0, field2: 10_000, field4: 0 });
    expect(legacy).toBeTruthy();
  });
});

describe('the VAT line in force at the time', () => {
  let env: TestEnv;
  afterAll(() => env.close());
  it('says a business had to register when 12 months passed the R1 million line of their day', async () => {
    env = await setup();
    const me = await login(env.app);
    const c = await me.post('/api/clients', { name: 'Fictional Mines Ltd', address: '1 Pretend Shaft, Rustenburg' });
    // R1.5 million from February 2025 to January 2026: over the R1 million line then, under
    // today's R2.3 million.
    for (const [i, month] of ['2025-02', '2025-05', '2025-08', '2025-11', '2026-01'].entries()) {
      const inv = await me.post('/api/documents', { kind: 'invoice', clientId: c.id, issueDate: `${month}-10`, lines: [{ category: 'labour', description: `Contract ${i + 1}`, qty: 1, unitPriceCents: 30_000_000 }] });
      await me.post(`/api/documents/${inv.id}/issue`);
    }
    const s = await vatStatus(env.sql, '2026-11-08');
    expect(s).toMatchObject({ state: 'over', compulsoryCents: 100_000_000 });
    // First crossed in the 12 months to November 2025 (R1.2 million), months before January.
    expect(s).toMatchObject({ peak12Cents: 120_000_000, peakTo: '2025-11-30' });
  });
});

describe('reference numbers people really have', () => {
  it('takes a client abroad’s VAT number, and still checks South African ones', () => {
    expect(clientVatNumberProblem('GB 123 4567 89')).toBeNull();
    expect(clientVatNumberProblem('DE123456789')).toBeNull();
    expect(clientVatNumberProblem('4740101508')).toBeNull();
    expect(clientVatNumberProblem('4740101509')).toMatch(/doesn’t add up/);
    expect(clientVatNumberProblem('474010150')).toMatch(/country code/);
  });

  it('takes a passport number of digits only, but not an ID number a digit short', () => {
    expect(idNumberProblem('123456789')).toBeNull();
    expect(idNumberProblem('A1234567')).toBeNull();
    expect(idNumberProblem('800101500908')).toMatch(/13 digits/);
    expect(idNumberProblem('12345')).toMatch(/6 or more/);
  });

  it('puts SARS’s UIF reference on the EMP501, not the Department of Labour number', () => {
    expect(uifForEmp501('7123456789', '1234567/8')).toBe('U123456789');
    expect(uifForEmp501('7123456789', 'U987654321')).toBe('U987654321');
    expect(uifForEmp501('', '1234567/8')).toBe('');
  });

  it('lets an old client be edited without retyping a VAT number from before the checks', async () => {
    const env = await setup();
    try {
      const me = await login(env.app);
      const c = await me.post('/api/clients', { name: 'Fictional Old Client' });
      await env.sql`update clients set vat_number = '41234' where id = ${c.id}`;
      const r = await me.call({ method: 'PUT', url: `/api/clients/${c.id}`, payload: { name: 'Fictional Old Client', vatNumber: '41234', address: '5 Nowhere Street, Kimberley' } });
      expect(r.statusCode).toBe(200);
      // Changing it to another bad one is caught.
      const bad = await me.call({ method: 'PUT', url: `/api/clients/${c.id}`, payload: { name: 'Fictional Old Client', vatNumber: '41235' } });
      expect(bad.statusCode).toBe(400);
    } finally {
      await env.close();
    }
  });
});
