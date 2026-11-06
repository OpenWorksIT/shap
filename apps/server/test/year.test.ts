/**
 * A fictional company's year pushed through the API, then every report checked against the
 * others and against figures worked out here independently: the trial balance and balance sheet
 * balance, the bank holds what went in less what went out, debtors and creditors agree with the
 * invoices and bills, the VAT account agrees with the VAT201, the payroll accounts with the
 * EMP201s, the income statement with the sums, and the accountant export with the ledger.
 */
import { payLine } from '@shap/shared';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildExport } from '../src/modules/accountantExport.js';
import { emp201Split } from '../src/modules/payroll.js';
import { balance, ledgerTotal, login, ref, setup, type TestEnv } from './helpers.js';

const round = Math.round;
const vatOf = (exVat: number) => round((exVat * 1500) / 10000);
const vatIn = (incl: number) => round((incl * 1500) / 11500);

describe('a year in the books, reconciled', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let ids: { bank: string; bills: string };
  let cash = 0; // the bank, tracked here
  const docs: Record<string, { id: string; subtotal: number; vat: number; total: number }> = {};
  const line = (category: string, description: string, qty: number, unitPriceCents: number) => ({ category, description, qty, unitPriceCents });

  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const { settings, sources } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4000000000', vatCategory: 'B', sdl: true, features: { ...settings.features, bills: true, payroll: true, dividends: true } }, 'PUT');
    ids = { bank: await r.src('Business bank'), bills: sources.find((s: { role: string | null }) => s.role === 'bills').id };
    const client = await me.post('/api/clients', { name: 'Fictional Holdings (Pty) Ltd' });

    // The owner lends the company R50 000 to start.
    await me.post('/api/journals', {
      date: '2026-03-01', description: 'Loan from the owner',
      lines: [{ accountId: await r.acc('bank'), debitCents: 5_000_000 }, { accountId: await r.acc('owner_loan'), creditCents: 5_000_000 }],
    });
    cash += 5_000_000;

    // Invoices, worked out line by line (rounded to the cent) with VAT once on the subtotal.
    const invoice = async (key: string, issueDate: string, lines: ReturnType<typeof line>[]) => {
      const d = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate, lines });
      await me.post(`/api/documents/${d.id}/issue`);
      const subtotal = lines.reduce((s, l) => s + round(l.qty * l.unitPriceCents), 0);
      docs[key] = { id: d.id, subtotal, vat: vatOf(subtotal), total: subtotal + vatOf(subtotal) };
    };
    await invoice('inv1', '2026-09-05', [line('labour', 'Wiring', 1, 1_000_000), line('materials', 'Cable', 2, 250_000)]);
    await invoice('inv2', '2026-09-15', [line('labour', 'Call-outs', 3.5, 33_333), line('materials', 'Fittings', 7, 1_999), line('materials', 'Sundries', 0.33, 100_001)]);
    await invoice('inv3', '2026-10-02', [line('materials', 'Solar panels', 1, 6_000_000)]);
    await invoice('inv4', '2026-10-05', [line('labour', 'Repairs', 1, 200_000)]);

    // Paid in full, part-paid, credited in part, written off.
    await me.post(`/api/documents/${docs.inv1!.id}/receipts`, { date: '2026-09-20', amountCents: docs.inv1!.total, sourceId: ids.bank });
    await me.post(`/api/documents/${docs.inv2!.id}/receipts`, { date: '2026-10-01', amountCents: 100_000, sourceId: ids.bank });
    cash += docs.inv1!.total + 100_000;
    const cn = await me.post(`/api/documents/${docs.inv3!.id}/credit-note`);
    await me.post(`/api/documents/${cn.id}`, { issueDate: '2026-10-10', creditReason: 'One panel returned', lines: [line('materials', 'Solar panel', 1, 500_000)] }, 'PUT');
    await me.post(`/api/documents/${cn.id}/issue`);
    docs.cn1 = { id: cn.id, subtotal: 500_000, vat: 75_000, total: 575_000 };
    await me.post(`/api/documents/${docs.inv4!.id}/write-off`, { date: '2026-10-25', reason: 'Client closed down' });

    // Costs: paid from the bank, a laptop capitalised, supplier bills (one paid, one owed).
    const cost = async (date: string, description: string, category: string, amountCents: number, vatCents: number, sourceId: string, extra = {}) =>
      me.post('/api/costs', { date, description, supplier: 'Fictional Supplies', amountCents, vatCents, categoryId: await r.cat(category), sourceId, ...extra });
    await cost('2026-09-10', 'Cable', 'Parts', 115_000, 15_000, ids.bank);
    await cost('2026-10-03', 'Petrol', 'Petrol', 30_000, 0, ids.bank);
    const laptop = await cost('2026-09-01', 'Laptop', 'Asset purchase', 1_380_000, 180_000, ids.bank);
    await me.post('/api/assets', { name: 'Laptop', category: 'computers', purchaseDate: '2026-09-01', costCents: 1_200_000, costId: laptop.id, lifeMonths: 36 });
    cash -= 115_000 + 30_000 + 1_380_000;
    const b1 = await cost('2026-09-25', 'Drill', 'Tool', 230_000, 30_000, ids.bills, { billNumber: 'T-1', dueDate: '2026-10-25' });
    await me.post(`/api/costs/${b1.id}/bill-payments`, { date: '2026-10-20', amountCents: 230_000, sourceId: ids.bank });
    cash -= 230_000;
    await cost('2026-10-28', 'Stationery', 'Sundry', 115_000, 15_000, ids.bills, { billNumber: 'S-9', dueDate: '2026-11-27' });

    // Payroll: two months, with SDL; September's EMP201 paid in two parts.
    await me.post('/api/employees', { name: 'Thandi Mokoena', salaryCents: 2_000_000, startDate: '2026-01-01' });
    for (const [period, payDate] of [['2026-09', '2026-09-25'], ['2026-10', '2026-10-25']] as const) {
      const run = await me.post('/api/pay-runs', { period, payDate, sourceId: ids.bank });
      await me.post(`/api/pay-runs/${run.id}/finalise`);
      cash -= payLine({ salaryCents: 2_000_000, payDate, sdl: true }).netCents;
    }
    const sep = payLine({ salaryCents: 2_000_000, payDate: '2026-09-25', sdl: true });
    const sepTotal = sep.payeCents + sep.uifEmployeeCents + sep.uifEmployerCents + sep.sdlCents;
    await me.post('/api/sars-payments', { kind: 'emp201', period: '2026-09', date: '2026-10-05', amountCents: 150_000, sourceId: ids.bank, reference: 'EMP201 Sep (part)' });
    await me.post('/api/sars-payments', { kind: 'emp201', period: '2026-09', date: '2026-10-06', amountCents: sepTotal - 150_000, sourceId: ids.bank, reference: 'EMP201 Sep (rest)' });
    cash -= sepTotal;

    // A dividend, 20% dividends tax withheld (owed to SARS).
    await me.post('/api/dividends', { declaredOn: '2026-10-15', paidOn: '2026-10-15', shareholder: 'Fictional Owner', grossCents: 1_000_000, sourceId: ids.bank });
    cash -= 800_000;
  });
  afterAll(() => env.close());

  const END = '2026-10-31';

  it('balances, everywhere', async () => {
    expect(await ledgerTotal(env.sql)).toBe(0);
    const tb = await me.get(`/api/reports/trial-balance?date=${END}`);
    expect(tb.totals.differenceCents).toBe(0);
    expect(tb.totals.debitCents).toBe(tb.totals.creditCents);
    const bs = await me.get(`/api/reports/balance-sheet?date=${END}`);
    expect(bs.differenceCents).toBe(0);
  });

  it('keeps each document’s figures and its postings in step', async () => {
    for (const [key, d] of Object.entries(docs)) {
      const got = (await me.get(`/api/documents/${d.id}`)).doc;
      expect({ key, subtotal: Number(got.subtotalCents), vat: Number(got.vatCents), total: Number(got.totalCents) }).toEqual({ key, subtotal: d.subtotal, vat: d.vat, total: d.total });
      const [p] = await env.sql<{ n: number }[]>`select coalesce(sum(amount_cents), 0)::bigint as n from ledger where source in ('invoice', 'credit_note') and source_id = ${d.id}`;
      expect(Number(p!.n)).toBe(0);
    }
  });

  it('has the bank holding what came in less what went out', async () => {
    expect(await balance(env.sql, 'bank', END)).toBe(cash);
    expect((await me.get('/api/dashboard')).bankCents).toBe(cash);
  });

  it('agrees debtors with the invoices', async () => {
    const owing = docs.inv2!.total - 100_000 + (docs.inv3!.total - docs.cn1!.total);
    expect(await balance(env.sql, 'receivables', END)).toBe(owing);
    expect((await me.get('/api/dashboard')).owing.totalCents).toBe(owing);
    const list = await me.get('/api/documents?kind=invoice&state=owing');
    expect(list.reduce((s: number, d: { totalCents: number; paidCents: number; writtenOffCents: number }) => s + Number(d.totalCents) - Number(d.paidCents) - Number(d.writtenOffCents), 0)).toBe(owing);
    const exp = await buildExport(env.sql, 'debtors', { from: '2026-03-01', to: END, groupBy: 'item' });
    expect(exp.rows.reduce((s, r) => s + Number(r.total ?? 0), 0)).toBe(owing);
    // The written-off invoice is out of debtors.
    expect(list.find((d: { id: string }) => d.id === docs.inv4!.id)).toBeUndefined();
  });

  it('agrees creditors with the bills', async () => {
    expect(await balance(env.sql, 'payables', END)).toBe(-115_000);
    const bills = await me.get('/api/bills');
    expect(bills.reduce((s: number, b: { owingCents: number }) => s + Number(b.owingCents), 0)).toBe(115_000);
  });

  it('agrees the VAT account with the VAT201', async () => {
    const v = await me.get('/api/vat/return?on=2026-10-10');
    expect(v.period).toEqual({ start: '2026-09-01', end: END });
    const outVat = docs.inv1!.vat + docs.inv2!.vat + docs.inv3!.vat + docs.inv4!.vat - docs.cn1!.vat;
    const outIncl = docs.inv1!.total + docs.inv2!.total + docs.inv3!.total + docs.inv4!.total - docs.cn1!.total;
    expect(v.fields).toMatchObject({
      field1: outIncl,
      field4: outVat,
      field13: outVat,
      field14: 180_000, // the laptop
      field15: 15_000 + 30_000 + 15_000,
      field17: vatIn(docs.inv4!.total), // the VAT in the debt written off
    });
    expect(v.fields.field19).toBe(v.fields.field14 + v.fields.field15 + v.fields.field17);
    expect(v.fields.field20).toBe(v.fields.field13 - v.fields.field19);
    // What the books say is owed to SARS for the period is what the return says.
    const moved = (await balance(env.sql, 'vat', END)) - (await balance(env.sql, 'vat', '2026-08-31'));
    expect(moved).toBe(-v.fields.field20);
  });

  it('agrees the payroll accounts with the EMP201s', async () => {
    const oct = payLine({ salaryCents: 2_000_000, payDate: '2026-10-25', sdl: true });
    const sars = await me.get('/api/payroll/sars');
    const byPeriod = Object.fromEntries(sars.emp201.map((r: { period: string }) => [r.period, r]));
    expect(byPeriod['2026-09']).toMatchObject({ paidCents: byPeriod['2026-09'].totalCents });
    expect(byPeriod['2026-10']).toMatchObject({ payeCents: oct.payeCents, uifCents: oct.uifEmployeeCents + oct.uifEmployerCents, sdlCents: oct.sdlCents, paidCents: 0 });
    // Only October is still owed, tax by tax.
    expect(await balance(env.sql, 'paye_payable', END)).toBe(-oct.payeCents);
    expect(await balance(env.sql, 'uif_payable', END)).toBe(-(oct.uifEmployeeCents + oct.uifEmployerCents));
    expect(await balance(env.sql, 'sdl_payable', END)).toBe(-oct.sdlCents);
    expect(await balance(env.sql, 'dwt_payable', END)).toBe(-200_000);
    expect(await balance(env.sql, 'dividends_payable', END)).toBe(0);
  });

  it('makes the profit the sums say', async () => {
    const revenue = docs.inv1!.subtotal + docs.inv2!.subtotal + docs.inv3!.subtotal + docs.inv4!.subtotal - docs.cn1!.subtotal;
    const pay = payLine({ salaryCents: 2_000_000, payDate: '2026-10-25', sdl: true });
    const costs = 100_000 + 30_000 + 200_000 + 100_000; // ex VAT
    const salaries = 2 * 2_000_000;
    const levies = 2 * (pay.uifEmployerCents + pay.sdlCents);
    const badDebt = docs.inv4!.total - vatIn(docs.inv4!.total); // ex VAT: the VAT comes back from SARS
    const depreciation = 2 * Math.floor(1_200_000 / 36); // September and October
    const profit = revenue - costs - salaries - levies - badDebt - depreciation;
    const is = await me.get(`/api/reports/income-statement?from=2026-03-01&to=${END}`);
    expect(is.totals.income.totalCents).toBe(revenue);
    expect(is.totals.netProfit.totalCents).toBe(profit);
    const bs = await me.get(`/api/reports/balance-sheet?date=${END}`);
    expect(bs.equity.totalCents).toBe(profit - 1_000_000);
    // The laptop, at cost less two months' depreciation.
    expect(bs.assets.nonCurrent.reduce((s: number, a: { amountCents: number }) => s + a.amountCents, 0)).toBe(1_200_000 - depreciation);
    expect(bs.liabilities.nonCurrent.reduce((s: number, a: { amountCents: number }) => s + a.amountCents, 0)).toBe(5_000_000);
  });

  it('exports a balanced journal that matches the ledger', async () => {
    const j = await buildExport(env.sql, 'journal', { from: '2026-03-01', to: END, groupBy: 'item' });
    const dr = j.rows.reduce((s, r) => s + Number(r.debit ?? 0), 0);
    const cr = j.rows.reduce((s, r) => s + Number(r.credit ?? 0), 0);
    expect(dr).toBe(cr);
    const [l] = await env.sql<{ d: number }[]>`select coalesce(sum(amount_cents) filter (where amount_cents > 0), 0)::bigint as d from ledger where date between '2026-03-01' and ${END}`;
    expect(dr).toBeGreaterThan(0);
    // Grouped per posting, the export's debits are the ledger's (journal lines net per account per item).
    expect(dr).toBeLessThanOrEqual(Number(l!.d));
    const sales = await buildExport(env.sql, 'invoiceLines', { from: '2026-03-01', to: END, groupBy: 'item' });
    const salesTotal = sales.rows.reduce((s, r) => s + Number(r.lineTotal ?? 0), 0);
    const revenue = docs.inv1!.subtotal + docs.inv2!.subtotal + docs.inv3!.subtotal + docs.inv4!.subtotal - docs.cn1!.subtotal;
    expect(salesTotal).toBe(revenue);
  });

  it('still agrees once the write-off is undone', async () => {
    await me.post(`/api/documents/${docs.inv4!.id}/write-off`, {}, 'DELETE');
    const v = await me.get('/api/vat/return?on=2026-10-10');
    expect(v.fields.field17).toBe(0);
    const moved = (await balance(env.sql, 'vat', END)) - (await balance(env.sql, 'vat', '2026-08-31'));
    expect(moved).toBe(-v.fields.field20);
    expect(await balance(env.sql, 'bad_debts', END)).toBe(0);
    expect((await me.get(`/api/reports/trial-balance?date=${END}`)).totals.differenceCents).toBe(0);
  });
});

describe('paying an EMP201 in parts', () => {
  const owed = { payeCents: 211_500, uifCents: 35_424, sdlCents: 20_000 };
  it('clears PAYE, then UIF, then SDL, carrying on from earlier payments', () => {
    expect(emp201Split(owed, 0, 266_924)).toEqual({ paye: 211_500, uif: 35_424, sdl: 20_000 });
    expect(emp201Split(owed, 0, 150_000)).toEqual({ paye: 150_000, uif: 0, sdl: 0 });
    expect(emp201Split(owed, 150_000, 116_924)).toEqual({ paye: 61_500, uif: 35_424, sdl: 20_000 });
    expect(emp201Split(owed, 211_500, 40_000)).toEqual({ paye: 0, uif: 35_424, sdl: 4_576 });
    // Overpaid: the extra sits against PAYE.
    expect(emp201Split(owed, 266_924, 1_000)).toEqual({ paye: 1_000, uif: 0, sdl: 0 });
    expect(emp201Split(owed, 200_000, 100_000)).toEqual({ paye: 11_500 + 33_076, uif: 35_424, sdl: 20_000 });
  });
});

describe('bad debts written off before the VAT fix', () => {
  it('stay as they were posted in a closed year, and claim the VAT back in an open one', async () => {
    const env = await setup();
    try {
      const me = await login(env.app, 'owner@example.co.za');
      const { settings } = await me.get('/api/reference');
      await me.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4000000000' }, 'PUT');
      const writeOff = async (issueDate: string, date: string) => {
        const d = await me.post('/api/documents', { kind: 'invoice', issueDate, lines: [{ category: 'labour', description: 'Work', qty: 1, unitPriceCents: 100_000 }] });
        await me.post(`/api/documents/${d.id}/issue`);
        await me.post(`/api/documents/${d.id}/write-off`, { date, reason: 'Gone' });
      };
      await writeOff('2025-06-01', '2025-12-01'); // in a year that will be closed
      await writeOff('2026-06-01', '2026-07-01');
      await env.sql`update documents set written_off_vat_relief = true`;
      await env.sql`update settings set lock_date = '2026-02-28'`;
      // The migration again, as an existing set of books meets it.
      await env.sql.unsafe(readFileSync(new URL('../migrations/028_bad_debt_vat.sql', import.meta.url), 'utf8'));
      expect(await balance(env.sql, 'bad_debts', '2026-02-28')).toBe(115_000);
      expect(await balance(env.sql, 'bad_debts')).toBe(115_000 + 100_000);
      expect(await balance(env.sql, 'vat', '2026-02-28')).toBe(-15_000);
      expect(await balance(env.sql, 'vat')).toBe(-15_000 - 15_000 + 15_000);
      expect(await ledgerTotal(env.sql)).toBe(0);
    } finally {
      await env.close();
    }
  });
});
