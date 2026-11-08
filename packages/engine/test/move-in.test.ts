/**
 * Moving in from another package: each package's CSV exports (fictional data laid out the way
 * Xero, QuickBooks, Zoho, Invoice Ninja and Sage export), read and brought in, with the opening
 * balances landing exactly on the trial balance.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guessDayOrder, makePlan, parseDate, parseMoney, readExportFile } from '../src/modules/movein.js';
import { balance, login, ref, setup, type TestEnv } from './helpers.js';

const XERO_INVOICES = `ContactName,EmailAddress,POAddressLine1,POAddressLine2,POAddressLine3,POAddressLine4,POCity,PORegion,POPostalCode,POCountry,InvoiceNumber,Reference,InvoiceDate,DueDate,Total,TaxTotal,InvoiceAmountPaid,InvoiceAmountDue,InventoryItemCode,Description,Quantity,UnitAmount,Discount,LineAmount,AccountCode,TaxType,TaxAmount,TrackingName1,TrackingOption1,TrackingName2,TrackingOption2,Currency,Type,Sent,Status
Bayview Guesthouse,accounts@bayview.example,12 Marine Drive,,,,Gqeberha,Eastern Cape,6001,South Africa,INV-0101,Kitchen rewire,02/03/2026,09/03/2026,1495.00,195.00,1000.00,495.00,,Labour: rewiring,2.0000,500.00,,1000.00,200,Standard Rate Sales,150.00,,,,,ZAR,Sales invoice,Sent,AUTHORISED
Bayview Guesthouse,accounts@bayview.example,12 Marine Drive,,,,Gqeberha,Eastern Cape,6001,South Africa,INV-0101,Kitchen rewire,02/03/2026,09/03/2026,1495.00,195.00,1000.00,495.00,,"Cable, 2.5mm",1.0000,300.00,,300.00,200,Standard Rate Sales,45.00,,,,,ZAR,Sales invoice,Sent,AUTHORISED
Mrs P. Naidoo,,,,,,,,,,INV-0102,,05/03/2026,12/03/2026,230.00,30.00,0.00,230.00,,Call-out,1.0000,200.00,,200.00,200,Standard Rate Sales,30.00,,,,,ZAR,Sales invoice,Sent,VOIDED
Mrs P. Naidoo,,,,,,,,,,INV-0103,DB board,15/03/2026,22/03/2026,2300.00,300.00,2300.00,0.00,,DB board replacement,1.0000,2000.00,,2000.00,200,Standard Rate Sales,300.00,,,,,ZAR,Sales invoice,Sent,PAID
`;
const XERO_CONTACTS = `ContactName,AccountNumber,EmailAddress,FirstName,LastName,POAttentionTo,POAddressLine1,POCity,POPostalCode,PhoneNumber,MobileNumber,TaxNumber
Bayview Guesthouse,BAY01,accounts@bayview.example,Sipho,Dlamini,,12 Marine Drive,Gqeberha,6001,041 555 0101,,4123456789
Kariega Motors,KAR01,info@kariega.example,,,,3 Main Road,Kariega,6229,,082 555 0199,
`;
const QBO_INVOICES = `InvoiceNo,Customer,InvoiceDate,DueDate,Terms,Memo,Item(Product/Service),ItemDescription,ItemQuantity,ItemRate,ItemAmount,ItemTaxCode,ItemTaxAmount
2001,Summit Dental,03/25/2026,04/24/2026,Net 30,,Consulting,Network setup,3,650,1950,Standard,292.50
2001,Summit Dental,03/25/2026,04/24/2026,Net 30,,Hardware,Switch (8 port),1,1200,1200,Standard,180
`;
const QBO_TRANSACTIONS = `Transaction List by Date
Summit Dental
Date,Transaction type,No.,Customer,Memo/Description,Due date,Amount,Open balance
04/02/2026,Invoice,2002,Summit Dental,Monthly support,05/02/2026,"1,150.00",0.00
04/03/2026,Payment,,Summit Dental,,,"-1,150.00",0.00
04/10/2026,Estimate,E-15,Summit Dental,Server upgrade,,"9,200.00",
`;
const ZOHO_INVOICES = `Invoice Date,Invoice Number,Invoice Status,Customer Name,Due Date,Item Name,Item Desc,Quantity,Item Price,Item Total,Item Tax %,Item Tax Amount,SubTotal,Total,Balance
2026-04-02,ZINV-0007,Partially Paid,Algoa Bakery,2026-04-16,Service,Fridge repair,1,800.00,800.00,15,120.00,800.00,920.00,420.00
`;
const ZOHO_PAYMENTS = `Payment Number,Date,Invoice Number,Customer Name,Amount Applied,Payment Mode,Reference Number
1,2026-04-20,ZINV-0007,Algoa Bakery,500.00,Bank Transfer,FNB 551
`;
const NINJA_INVOICES = `"Client Name","Invoice Number","Invoice Date","Due Date","Amount","Balance","Status","Item Product","Item Notes","Item Cost","Item Quantity","Item Tax Rate"
"Walmer Vet","0042","2026-05-10","2026-05-17","575.00","0.00","Paid","Site visit","Site visit and quote","500.00","1","15"
`;
const SAGE_INVOICES = `Document Number,Customer Name,Date,Due Date,Reference,Exclusive,Tax,Total,Amount Due,Status
SI0009,Kariega Motors,20/05/2026,19/06/2026,Workshop lights,"4 000,00","600,00","4 600,00","4 600,00",Unpaid
`;
const XERO_ITEMS = `ItemCode,ItemName,PurchasesDescription,PurchasesUnitPrice,PurchasesAccount,PurchasesTaxRate,SalesDescription,SalesUnitPrice,SalesAccount,SalesTaxRate
CALL,Call-out,,,,,Call-out fee,450.00,200,Standard Rate Sales
COC,Certificate of compliance,,,,,COC inspection and certificate,1200.00,200,Standard Rate Sales
`;
const TRIAL_BALANCE = `Trial Balance
Sparky Electrical (Pty) Ltd
As at 28 February 2026

Account Code,Account,Debit,Credit
1000,FNB Business Cheque,"25,000.00",
1100,Accounts Receivable,"4,950.00",
2100,VAT Output,,"1,200.00"
2300,Loan from Director,,"10,000.00"
3000,Share Capital,,100.00
3100,Retained Earnings,,"8,650.00"
4000,Sales,,"50,000.00"
5000,Purchases,"20,000.00",
6100,Bank Charges,"1,200.00",
6200,Motor Vehicle Expenses,"18,800.00",
,Total,"69,950.00","69,950.00"
`;
const XERO_BILLS = `ContactName,InvoiceNumber,InvoiceDate,DueDate,Total,TaxTotal,InvoiceAmountPaid,InvoiceAmountDue,Description,Quantity,UnitAmount,LineAmount,AccountCode,Type,Status
ACDC Dynamics,B-771,10/03/2026,10/04/2026,1150.00,150.00,0.00,1150.00,Cable and fittings,1,1000.00,1000.00,300,Bill,AUTHORISED
Engen Walmer,B-772,11/03/2026,11/03/2026,575.00,75.00,575.00,0.00,Fuel,1,500.00,500.00,449,Bill,PAID
`;

describe('reading other packages’ exports', () => {
  it('reads money and dates the way SA and US exports write them', () => {
    expect(parseMoney('R 1 234,56')).toBe(123456);
    expect(parseMoney('1,234.56')).toBe(123456);
    expect(parseMoney('4 000,00')).toBe(400000);
    expect(parseMoney('(12.50)')).toBe(-1250);
    expect(parseMoney('-1,150.00')).toBe(-115000);
    expect(parseMoney('1,150')).toBe(115000);
    expect(parseMoney('')).toBeNull();
    expect(guessDayOrder(['03/25/2026', '04/24/2026'])).toBe('mdy');
    expect(guessDayOrder(['15/03/2026'])).toBe('dmy');
    expect(parseDate('02/03/2026')).toBe('2026-03-02');
    expect(parseDate('03/25/2026', 'mdy')).toBe('2026-03-25');
    expect(parseDate('2026-04-02T00:00:00')).toBe('2026-04-02');
    expect(parseDate('20 May 2026')).toBe('2026-05-20');
    expect(parseDate('Mar 5, 2026')).toBe('2026-03-05');
  });

  it('knows each kind of file and which package it came from', () => {
    const f = (name: string, text: string) => readExportFile(name, text);
    expect([f('a', XERO_INVOICES).kind, f('a', XERO_INVOICES).source]).toEqual(['invoices', 'Xero']);
    expect([f('a', XERO_CONTACTS).kind, f('a', XERO_CONTACTS).source]).toEqual(['clients', 'Xero']);
    expect([f('a', QBO_INVOICES).kind, f('a', QBO_INVOICES).source]).toEqual(['invoices', 'QuickBooks']);
    expect(f('a', QBO_TRANSACTIONS).kind).toBe('invoices');
    expect([f('a', ZOHO_INVOICES).kind, f('a', ZOHO_INVOICES).source]).toEqual(['invoices', 'Zoho']);
    expect(f('a', ZOHO_PAYMENTS).kind).toBe('payments');
    expect([f('a', NINJA_INVOICES).kind, f('a', NINJA_INVOICES).source]).toEqual(['invoices', 'Invoice Ninja']);
    expect([f('a', SAGE_INVOICES).kind, f('a', SAGE_INVOICES).source]).toEqual(['invoices', 'Sage']);
    expect(f('a', XERO_ITEMS).kind).toBe('items');
    expect(f('a', TRIAL_BALANCE).kind).toBe('trialBalance');
    expect(f('a', XERO_BILLS).kind).toBe('costs');
  });

  it('turns rows into invoices with lines, VAT and what was paid', () => {
    const x = readExportFile('x', XERO_INVOICES);
    expect(x.docs).toHaveLength(2); // the void one left out
    expect(x.skipped).toContainEqual({ reason: 'Voided or deleted', count: 1 });
    const inv = x.docs![0]!;
    expect(inv).toMatchObject({ number: 'INV-0101', date: '2026-03-02', dueDate: '2026-03-09', client: 'Bayview Guesthouse', subtotalCents: 130000, vatCents: 19500, totalCents: 149500, paidCents: 100000 });
    expect(inv.lines.map((l) => [l.description, l.qty, l.unitPriceCents, l.category])).toEqual([
      ['Labour: rewiring', 2, 50000, 'labour'],
      ['Cable, 2.5mm', 1, 30000, 'materials'],
    ]);
    const q = readExportFile('q', QBO_INVOICES).docs![0]!;
    expect(q).toMatchObject({ number: '2001', date: '2026-03-25', subtotalCents: 315000, vatCents: 47250, totalCents: 362250, paidCents: null });
    const t = readExportFile('t', QBO_TRANSACTIONS);
    expect(t.docs!.map((d) => [d.kind, d.number, d.totalCents, d.paidCents])).toEqual([
      ['invoice', '2002', 115000, 115000],
      ['quote', 'E-15', 920000, null],
    ]);
    // Invoice Ninja's Amount includes VAT; its item cost doesn't.
    const n = readExportFile('n', NINJA_INVOICES).docs![0]!;
    expect(n).toMatchObject({ number: '0042', totalCents: 57500, paidCents: 57500 });
    const s = readExportFile('s', SAGE_INVOICES).docs![0]!;
    expect(s).toMatchObject({ number: 'SI0009', date: '2026-05-20', subtotalCents: 400000, vatCents: 60000, totalCents: 460000, paidCents: 0 });
    expect(s.lines[0]!.description).toBe('Workshop lights');
  });
});

describe('moving in', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  let bank: string;
  const files = [
    { name: 'Xero contacts.csv', text: XERO_CONTACTS },
    { name: 'Xero invoices.csv', text: XERO_INVOICES },
    { name: 'Zoho invoices.csv', text: ZOHO_INVOICES },
    { name: 'Zoho payments.csv', text: ZOHO_PAYMENTS },
    { name: 'Sage invoices.csv', text: SAGE_INVOICES },
    { name: 'QuickBooks transactions.csv', text: QBO_TRANSACTIONS },
    { name: 'Items.csv', text: XERO_ITEMS },
    { name: 'Bills.csv', text: XERO_BILLS },
    { name: 'Trial balance.csv', text: TRIAL_BALANCE },
  ];
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app);
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4000000002', features: { ...settings.features, bills: true } }, 'PUT');
    bank = await (await ref(env.sql)).src('Business bank');
  });
  afterAll(() => env.close());

  it('previews without saving anything, with the trial balance mapped', async () => {
    const p = await me.post('/api/move-in/preview', { files });
    expect(p.files.map((f: { kind: string }) => f.kind)).toEqual(['clients', 'invoices', 'invoices', 'payments', 'invoices', 'invoices', 'items', 'costs', 'trialBalance']);
    expect(p.invoices.count).toBe(5);
    expect(p.quotes).toBe(1);
    expect(p.tb.balanced).toBe(true);
    const names = (id: string | null) => p.accounts.find((a: { id: string }) => a.id === id)?.name;
    expect(p.tb.lines.map((l: { name: string; suggestion: string | null }) => [l.name, names(l.suggestion)])).toEqual([
      ['FNB Business Cheque', 'Bank – business account'],
      ['Accounts Receivable', 'Debtors (money owed by clients)'],
      ['VAT Output', 'VAT'],
      ['Loan from Director', 'Owner’s loan account'],
      ['Share Capital', 'Share capital'],
      ['Retained Earnings', 'Retained earnings'],
      ['Sales', 'Project revenue – labour'],
      ['Purchases', 'Cost of sales – project materials'],
      ['Bank Charges', 'Bank charges'],
      ['Motor Vehicle Expenses', 'Travel – vehicle maintenance'],
    ]);
    expect((await me.get('/api/documents?kind=invoice')).length).toBe(0);
    expect(p.openingDates[0]).toMatch(/-02-28$/);
  });

  it('brings everything in, and the opening balances land on the trial balance', async () => {
    const p = await me.post('/api/move-in/preview', { files });
    const r = await me.post('/api/move-in', {
      files,
      options: { receiptSourceId: bank, openingDate: '2026-02-28', tbAccounts: p.tb.lines.map((l: { suggestion: string }) => l.suggestion), lockOpening: true },
    });
    expect(r).toMatchObject({ clients: 5, invoices: 5, quotes: 1, items: 2, costs: 2, opening: true });
    // Zoho's payment came from the payments file (with its date), not the balance column.
    const zoho = (await me.get('/api/documents?kind=invoice')).find((d: { number: string }) => d.number === 'ZINV-0007');
    expect(zoho).toMatchObject({ totalCents: 92000, paidCents: 50000, clientName: 'Algoa Bakery' });
    const xero = (await me.get('/api/documents?kind=invoice')).find((d: { number: string }) => d.number === 'INV-0101');
    expect(xero).toMatchObject({ paidCents: 100000, paymentState: 'part_paid' });
    // Contacts filled in from the contacts list.
    const clients = await me.get('/api/clients');
    expect(clients.find((c: { name: string }) => c.name === 'Bayview Guesthouse')).toMatchObject({ code: 'BAY01', email: 'accounts@bayview.example', vatNumber: '4123456789', address: '12 Marine Drive, Gqeberha, 6001' });
    // The balances on the opening date are the trial balance's.
    expect(await balance(env.sql, 'bank', '2026-02-28')).toBe(2_500_000);
    expect(await balance(env.sql, 'receivables', '2026-02-28')).toBe(495_000);
    expect(await balance(env.sql, 'vat', '2026-02-28')).toBe(-120_000);
    expect(await balance(env.sql, 'owner_loan', '2026-02-28')).toBe(-1_000_000);
    // After it, what was invoiced and paid since.
    expect(await balance(env.sql, 'receivables')).toBe(495_000 + 49500 + 42000 + 460000);
    const [s] = await env.sql<{ lockDate: string; invoiceNext: number; invoicePrefix: string }[]>`select lock_date, invoice_next, invoice_prefix from settings`;
    expect(s!.lockDate).toBe('2026-02-28');
    // Usual items include the imported list.
    const usual = await me.get('/api/documents/usual-lines');
    expect(usual.map((u: { description: string }) => u.description)).toContain('COC inspection and certificate');
    // The unpaid bill is owed; the paid one isn't.
    expect((await me.get('/api/bills')).map((b: { billNumber: string }) => b.billNumber)).toEqual(['B-771']);
    // The books still balance.
    const [t] = await env.sql<{ s: number }[]>`select coalesce(sum(amount_cents), 0)::bigint as s from ledger`;
    expect(Number(t!.s)).toBe(0);
  });

  it('won’t bring the same invoices in twice', async () => {
    const r = await me.post('/api/move-in', { files: [{ name: 'again.csv', text: XERO_INVOICES }], options: { receiptSourceId: bank } });
    expect(r.invoices).toBe(0);
    expect(r.skipped.join(' ')).toContain('INV-0101 is already in Shap');
  });

  it('refuses a trial balance that doesn’t balance', async () => {
    const lop = TRIAL_BALANCE.replace('"25,000.00"', '"24,000.00"');
    const p = makePlan([{ name: 'tb.csv', text: lop }]);
    expect(p.tb.reduce((s, l) => s + l.cents, 0)).toBe(-100000);
    const r = await me.call({ method: 'POST', url: '/api/move-in', payload: { files: [{ name: 'tb.csv', text: lop }], options: { receiptSourceId: bank, openingDate: '2025-02-28', tbAccounts: p.tb.map(() => bank) } } });
    expect(r.statusCode).toBe(400);
  });
});
