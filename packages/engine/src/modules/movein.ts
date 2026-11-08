/**
 * Moving in from another package: the CSV exports of Sage Accounting, Xero, QuickBooks Online,
 * Zoho Invoice / Books and Invoice Ninja, read into Shap's clients, items, invoices (with what's
 * been paid), quotes, payments, costs and bills, and the opening balances.
 *
 * Every package names its columns differently and changes them now and then, so files are read by
 * what's in them, not by a fixed layout: each column's heading is matched against the names the
 * packages use for it, and the kind of file (clients, invoices, a trial balance…) follows from the
 * columns it has. Nothing is written until the preview has been seen; then it all goes in, in one
 * transaction, or none of it does.
 *
 * Opening balances: the trial balance at the end of the last year in the old package, mapped to
 * Shap's accounts, becomes one opening journal on that date. It's worked out after the invoices
 * and payments are in, so whatever history came along, the balances on that date are exactly the
 * trial balance's.
 */
import type { App as FastifyInstance } from '../http.js';
import { addDays, financialYear, formatDate, type AccountType, type LineCategory } from '@shap/shared';
import { z } from 'zod';
import { requireRole, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { freshTotals, getSettings, noteAllShapFigures } from '../lib/books.js';
import { badRequest } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { parseCsv } from './clients.js';

/* ---------------------------------------------------------------- reading values */

/** "R 1 234,56", "1,234.56", "(12.50)", "-12.5", "1234" → cents. Blank or unreadable → null. */
export function parseMoney(raw: string | undefined): number | null {
  if (raw == null) return null;
  let s = raw.trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith('-')) {
    neg = true;
    s = s.slice(0, -1);
  }
  s = s.replace(/[^\d.,-]/g, '');
  if (s.startsWith('-')) {
    neg = !neg;
    s = s.slice(1);
  }
  if (!s || !/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let whole = s;
  let frac = '';
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    const i = s.lastIndexOf(dec);
    whole = s.slice(0, i);
    frac = s.slice(i + 1);
  } else if (lastComma >= 0 || lastDot >= 0) {
    const dec = lastComma >= 0 ? ',' : '.';
    const i = s.lastIndexOf(dec);
    const after = s.slice(i + 1);
    // One separator: a decimal point when 1 or 2 digits follow it (or it's the only one and 3+ digits isn't a thousands group).
    if (after.length <= 2 || s.split(dec).length === 2 && after.length !== 3) {
      whole = s.slice(0, i);
      frac = after;
    }
  }
  whole = whole.replace(/[.,]/g, '');
  const cents = Number(whole || '0') * 100 + Math.round(Number(`0.${frac || '0'}`) * 100);
  if (!Number.isFinite(cents)) return null;
  return neg ? -cents : cents;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, '0');
const valid = (y: number, m: number, d: number) => y > 1990 && y < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Which way round a file writes its day and month (the US packages write the month first). */
export type DayOrder = 'dmy' | 'mdy';
export function guessDayOrder(values: string[]): DayOrder {
  let dmy = 0;
  let mdy = 0;
  for (const v of values) {
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(v.trim());
    if (!m) continue;
    if (Number(m[1]) > 12) dmy++;
    if (Number(m[2]) > 12) mdy++;
  }
  return mdy > dmy ? 'mdy' : 'dmy';
}

/** A date in any of the usual export layouts → YYYY-MM-DD, or null. */
export function parseDate(raw: string | undefined, order: DayOrder = 'dmy'): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/.exec(s);
  if (m) return valid(+m[1]!, +m[2]!, +m[3]!) ? `${m[1]}-${pad(+m[2]!)}-${pad(+m[3]!)}` : null;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(s);
  if (m) {
    let [a, b, y] = [+m[1]!, +m[2]!, +m[3]!];
    if (y < 100) y += 2000;
    let [d, mo] = order === 'mdy' ? [b, a] : [a, b];
    if (!valid(y, mo, d) && valid(y, d, mo)) [d, mo] = [mo, d];
    return valid(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  m = /^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s-,]*(\d{2,4})/.exec(s);
  if (m) {
    const mo = MONTHS[m[2]!.slice(0, 4).toLowerCase()] ?? MONTHS[m[2]!.slice(0, 3).toLowerCase()];
    let y = +m[3]!;
    if (y < 100) y += 2000;
    return mo && valid(y, mo, +m[1]!) ? `${y}-${pad(mo)}-${pad(+m[1]!)}` : null;
  }
  m = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/.exec(s);
  if (m) {
    const mo = MONTHS[m[1]!.slice(0, 3).toLowerCase()];
    return mo && valid(+m[3]!, mo, +m[2]!) ? `${m[3]}-${pad(mo)}-${pad(+m[2]!)}` : null;
  }
  return null;
}

const parseQty = (raw: string | undefined) => {
  const c = parseMoney(raw);
  return c == null ? null : c / 100;
};

/* ---------------------------------------------------------------- columns */

/** A heading reduced to letters and digits: "*InvoiceNumber" and "Invoice Number" both → "invoicenumber". */
const norm = (h: string) => h.toLowerCase().replace(/^\*/, '').replace(/[^a-z0-9]/g, '');

/** The names packages use for each field (normalised). First match wins. */
const FIELDS = {
  number: ['invoicenumber', 'invoiceno', 'invoicenum', 'documentnumber', 'documentno', 'docnumber', 'estimatenumber', 'quotenumber', 'quoteno', 'creditnotenumber', 'no', 'num', 'number', 'invoice', 'transactionnumber', 'refno'],
  date: ['invoicedate', 'documentdate', 'estimatedate', 'quotedate', 'issuedate', 'transactiondate', 'txndate', 'date'],
  dueDate: ['duedate', 'expirydate', 'expirationdate', 'validuntil', 'validtill'],
  client: ['contactname', 'customername', 'clientname', 'customer', 'client', 'customerdisplayname', 'displayname', 'billto', 'name', 'companyname'],
  clientEmail: ['emailaddress', 'customeremail', 'clientemail', 'contactemail', 'email', 'emailid'],
  reference: ['reference', 'ref', 'ponumber', 'orderreference', 'subject', 'title', 'memo', 'memodescription', 'publicnotes'],
  status: ['invoicestatus', 'estimatestatus', 'quotestatus', 'documentstatus', 'status'],
  type: ['transactiontype', 'documenttype', 'type'],
  total: ['total', 'invoicetotal', 'totalincl', 'totalinclusive', 'totalinclvat', 'totalamount', 'grandtotal', 'amountincl', 'inclusive', 'amount'],
  taxTotal: ['taxtotal', 'totaltax', 'vattotal', 'totalvat', 'tax', 'vat'],
  subtotal: ['subtotal', 'totalexcl', 'totalexclusive', 'exclusive', 'amountexcl', 'nettotal', 'net'],
  balance: ['invoiceamountdue', 'amountdue', 'balancedue', 'openbalance', 'outstanding', 'outstandingamount', 'balance'],
  paid: ['invoiceamountpaid', 'amountpaid', 'paidtodate', 'totalpaid', 'paidamount', 'paid'],
  paidDate: ['fullypaidondate', 'paiddate', 'lastpaymentdate', 'paymentdate', 'datepaid'],
  item: ['itemname', 'itemproductservice', 'productservice', 'productservicename', 'item', 'itemproduct', 'product', 'inventoryitemcode', 'itemcode', 'productname'],
  description: ['description', 'itemdescription', 'itemdesc', 'linedescription', 'productdescription', 'itemnotes', 'salesdescription'],
  quantity: ['quantity', 'itemquantity', 'qty', 'linequantity', 'productquantity'],
  unitPrice: ['unitamount', 'unitprice', 'itemrate', 'itemprice', 'itemcost', 'unitcost', 'rate', 'price', 'sellingprice', 'salesunitprice', 'salesprice', 'salespricerate', 'sellingpriceexcl', 'priceexcl'],
  lineAmount: ['lineamount', 'itemamount', 'itemtotal', 'linetotal', 'lineexclusive', 'lineamountexcl'],
  lineTax: ['itemtaxamount', 'linetaxamount', 'taxamount', 'linevat', 'vatamount'],
  taxRate: ['itemtax', 'itemtaxrate', 'taxrate', 'vatrate', 'itemtaxpercent', 'taxpercent'],
  taxType: ['taxtype', 'itemtaxcode', 'taxcode', 'vattype', 'salestaxrate'],
  unit: ['unit', 'usageunit', 'uom', 'unitofmeasure'],
  lineAmountTypes: ['lineamounttypes', 'amountsare', 'taxinclusive', 'isinclusivetax'],
  // Clients
  contactPerson: ['contactperson', 'attention', 'poattentionto', 'fullname', 'primarycontact', 'contact'],
  firstName: ['firstname', 'contactfirstname'],
  lastName: ['lastname', 'contactlastname'],
  phone: ['phonenumber', 'phone', 'telephone', 'phonenumbers', 'workphone', 'businessphone', 'tel', 'clientphone'],
  mobile: ['mobilenumber', 'mobile', 'mobilephone', 'cell', 'cellphone', 'cellnumber'],
  vatNumber: ['taxnumber', 'vatnumber', 'taxregistrationnumber', 'vatregistrationnumber', 'taxreference', 'vatno', 'vatreference', 'taxid', 'trn', 'clientvatnumber'],
  code: ['accountnumber', 'customercode', 'clientnumber', 'customernumber', 'customerid', 'code', 'accountcode', 'clientid'],
  notes: ['notes', 'note', 'privatenotes', 'comments'],
  // Payments
  amountApplied: ['amountapplied', 'paymentamount', 'amountreceived', 'amountpaid', 'amount'],
  method: ['paymentmethod', 'paymentmode', 'method', 'paymenttype'],
  // Trial balance
  account: ['account', 'accountname', 'ledgeraccount', 'description', 'name'],
  accountCode: ['accountcode', 'code', 'accountnumber', 'glcode', 'ledgercode', 'accountno'],
  debit: ['debit', 'debits', 'debitamount', 'dr'],
  credit: ['credit', 'credits', 'creditamount', 'cr'],
  netBalance: ['closingbalance', 'balance', 'net', 'netamount', 'ytdbalance'],
  // Costs and bills
  supplier: ['suppliername', 'vendorname', 'supplier', 'vendor', 'payee', 'contactname'],
  category: ['category', 'expenseaccount', 'account', 'accountname', 'expensecategory'],
} as const;
type Field = keyof typeof FIELDS;

/** Which column holds each field. Debit/credit also match "Debit - Year to date" and the like. */
function mapColumns(headers: string[]): Partial<Record<Field, number>> {
  const n = headers.map(norm);
  const out: Partial<Record<Field, number>> = {};
  // Fields can share a column (a "Name" is the client in one file and the account in another):
  // what kind of file it is decides which reading counts.
  for (const f of Object.keys(FIELDS) as Field[]) {
    for (const name of FIELDS[f]) {
      const i = n.indexOf(name);
      if (i >= 0) {
        out[f] = i;
        break;
      }
    }
  }
  // Prefix matches for trial balances ("Debit - Year to date", "Credit YTD").
  if (out.debit == null) {
    const i = n.findIndex((h) => h.startsWith('debit'));
    if (i >= 0) out.debit = i;
  }
  if (out.credit == null) {
    const i = n.findIndex((h) => h.startsWith('credit') && !h.startsWith('creditnote'));
    if (i >= 0) out.credit = i;
  }
  return out;
}

/* ---------------------------------------------------------------- what's in a file */

export type FileKind = 'invoices' | 'quotes' | 'clients' | 'items' | 'payments' | 'trialBalance' | 'costs' | 'unknown';
export type SourceGuess = 'Xero' | 'QuickBooks' | 'Sage' | 'Zoho' | 'Invoice Ninja' | 'a spreadsheet';

export interface InLine {
  description: string;
  qty: number;
  unit: string;
  unitPriceCents: number;
  /** Excluding VAT. */
  lineTotalCents: number;
  category: LineCategory;
}
export interface InDoc {
  kind: 'invoice' | 'quote';
  number: string;
  date: string;
  dueDate: string | null;
  client: string;
  clientEmail: string;
  reference: string;
  status: 'draft' | 'issued' | 'sent' | 'accepted' | 'declined';
  lines: InLine[];
  subtotalCents: number;
  vatCents: number;
  totalCents: number;
  /** What the file says was paid (total less what's still due), when it says. */
  paidCents: number | null;
  paidDate: string | null;
  /** The total the file states, when it differs from the lines (a warning). */
  statedTotalCents: number | null;
}
export interface InClient {
  name: string;
  code: string;
  contactPerson: string;
  email: string;
  phone: string;
  address: string;
  vatNumber: string;
  notes: string;
}
export interface InItem {
  description: string;
  unit: string;
  unitPriceCents: number;
}
export interface InPayment {
  date: string;
  invoice: string;
  amountCents: number;
  method: 'eft' | 'cash' | 'card' | 'other';
  reference: string;
}
export interface InTbLine {
  code: string;
  name: string;
  /** Debit positive. */
  cents: number;
}
export interface InCost {
  date: string;
  dueDate: string | null;
  supplier: string;
  description: string;
  billNumber: string;
  category: string;
  amountCents: number;
  vatCents: number;
  unpaidCents: number;
}

export interface ReadFile {
  name: string;
  kind: FileKind;
  source: SourceGuess;
  rows: number;
  skipped: { reason: string; count: number }[];
  columns: string[];
  docs?: InDoc[];
  clients?: InClient[];
  items?: InItem[];
  payments?: InPayment[];
  tb?: InTbLine[];
  costs?: InCost[];
}

function guessSource(headers: string[]): SourceGuess {
  const n = new Set(headers.map(norm));
  const has = (...xs: string[]) => xs.some((x) => n.has(x));
  if (has('invoiceamountdue', 'invoiceamountpaid', 'lineamounttypes', 'poaddressline1', 'inventoryitemcode', 'poattentionto')) return 'Xero';
  if (has('itemdesc', 'invoicestatus', 'estimatestatus', 'emailid', 'displayname', 'usageunit')) return 'Zoho';
  if (has('invoiceno', 'itemrate', 'itemamount', 'transactiontype', 'productservice', 'productservicename', 'openbalance', 'itemtaxcode')) return 'QuickBooks';
  if (has('paidtodate', 'itemnotes', 'itemproduct', 'clientname', 'contactfirstname', 'publicnotes', 'itemcost')) return 'Invoice Ninja';
  if (has('documentnumber', 'exclusive', 'taxreference', 'sellingpriceexcl', 'documentdate')) return 'Sage';
  return 'a spreadsheet';
}

const MATERIAL = /\b(material|materials|part|parts|stock|supply|supplies|cable|pipe|paint|cement|brick|timber|fitting|fittings|hardware|component|components|goods|product)\b/i;
const lineCategory = (desc: string): LineCategory => (MATERIAL.test(desc) ? 'materials' : 'labour');

function docStatus(kind: 'invoice' | 'quote', raw: string): InDoc['status'] | 'skip' {
  const s = raw.toLowerCase();
  if (/void|delet|cancel|revers|archiv/.test(s)) return 'skip';
  if (/draft/.test(s)) return 'draft';
  if (kind === 'quote') {
    if (/accept|invoiced|approved|converted/.test(s)) return 'accepted';
    if (/declin|reject|expired|lost/.test(s)) return 'declined';
    if (/sent|submit|open|pending/.test(s)) return 'sent';
    return s ? 'sent' : 'draft';
  }
  return 'issued';
}

function classify(m: Partial<Record<Field, number>>, headers: string[]): FileKind {
  const n = headers.map(norm);
  const has = (f: Field) => m[f] != null;
  const anyHeader = (re: RegExp) => n.some((h) => re.test(h));
  if (((has('debit') && has('credit')) || (has('netBalance') && has('accountCode'))) && !has('date') && !has('number') && !has('quantity') && !has('clientEmail')) return 'trialBalance';
  // A payments export (it may also have an "Amount" column, which would otherwise look like an invoice total).
  if (anyHeader(/^payment(number|no|id|date|mode|method|type|reference)$/) && (has('amountApplied') || has('total')) && !has('quantity') && !has('balance')) return 'payments';
  if (has('number') && has('date') && (has('total') || has('lineAmount') || has('unitPrice') || has('subtotal'))) {
    if (anyHeader(/^(estimate|quote)/)) return 'quotes';
    if (has('supplier') && !has('client') && n.some((h) => /supplier|vendor|payee/.test(h))) return 'costs';
    return 'invoices';
  }
  if (anyHeader(/payment/) && has('amountApplied') && (has('number') || anyHeader(/invoice/)) && !has('quantity')) return 'payments';
  if (n.some((h) => /supplier|vendor|payee/.test(h)) && has('date') && (has('total') || has('amountApplied'))) return 'costs';
  if (has('item') || (has('description') && has('unitPrice') && !has('client'))) {
    if (has('unitPrice') && !has('date') && !has('client')) return 'items';
  }
  if (has('client') && (has('clientEmail') || has('phone') || has('mobile') || has('vatNumber') || anyHeader(/address|city/)) && !has('date')) return 'clients';
  return 'unknown';
}

/** The parts of an address, in order: postal / billing first, then the street address. */
function addressOf(headers: string[], row: string[]): string {
  const n = headers.map(norm);
  const groups = [/^(po|postal|billing|bill|mailing)/, /^(sa|street|physical|shipping|ship|delivery)/, /^(address|addressline|city|town|state|province|region|postcode|postalcode|zip|zipcode|country|suburb)/];
  for (const g of groups) {
    const parts = n
      .map((h, i) => (g.test(h) && /address|line|street|city|town|state|province|region|post|zip|country|suburb|code/.test(h) && !/email|phone/.test(h) ? (row[i] ?? '').trim() : ''))
      .filter(Boolean);
    if (parts.length) return [...new Set(parts)].join(', ');
  }
  return '';
}

/** Reads one CSV export. */
export function readExportFile(name: string, text: string): ReadFile {
  const all = parseCsv(text);
  // Some exports start with a title block ("Trial Balance", the company, the dates): the header row
  // is the first with three or more filled cells.
  const headerAt = all.findIndex((r) => r.filter((c) => c.trim()).length >= 3);
  if (headerAt < 0) return { name, kind: 'unknown', source: 'a spreadsheet', rows: 0, skipped: [], columns: [] };
  const headers = all[headerAt]!.map((h) => h.trim());
  const rows = all.slice(headerAt + 1);
  const m = mapColumns(headers);
  let kind = classify(m, headers);
  // Xero exports sales and purchases with the same columns: the Type says which.
  if (kind === 'invoices' && m.type != null) {
    const types = rows.map((r) => (r[m.type!] ?? '').toLowerCase()).filter(Boolean);
    if (types.length && types.filter((t) => /bill|accpay|purchase|supplier/.test(t)).length > types.length / 2) kind = 'costs';
  }
  const source = guessSource(headers);
  const get = (row: string[], f: Field) => (m[f] == null ? '' : (row[m[f]!] ?? '').trim());
  const dateCols = (['date', 'dueDate', 'paidDate'] as Field[]).filter((f) => m[f] != null);
  const order = guessDayOrder(rows.flatMap((r) => dateCols.map((f) => get(r, f))));
  const skipped = new Map<string, number>();
  const skip = (reason: string) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  const base: ReadFile = { name, kind, source, rows: rows.length, skipped: [], columns: headers };
  const done = (r: ReadFile) => ({ ...r, skipped: [...skipped].map(([reason, count]) => ({ reason, count })) });

  if (kind === 'clients') {
    const seen = new Set<string>();
    const clients: InClient[] = [];
    for (const r of rows) {
      const nm = get(r, 'client');
      if (!nm) {
        skip('No name');
        continue;
      }
      if (seen.has(nm.toLowerCase())) {
        skip('Listed twice');
        continue;
      }
      seen.add(nm.toLowerCase());
      const person = get(r, 'contactPerson') || [get(r, 'firstName'), get(r, 'lastName')].filter(Boolean).join(' ');
      clients.push({
        name: nm,
        code: get(r, 'code'),
        contactPerson: person === nm ? '' : person,
        email: get(r, 'clientEmail'),
        phone: get(r, 'phone') || get(r, 'mobile'),
        address: addressOf(headers, r),
        vatNumber: get(r, 'vatNumber'),
        notes: get(r, 'notes'),
      });
    }
    return done({ ...base, clients });
  }

  if (kind === 'items') {
    const items: InItem[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const description = get(r, 'description') || get(r, 'item');
      const price = parseMoney(get(r, 'unitPrice'));
      if (!description) {
        skip('No description');
        continue;
      }
      if (seen.has(description.toLowerCase())) continue;
      seen.add(description.toLowerCase());
      items.push({ description: description.slice(0, 200), unit: get(r, 'unit').slice(0, 20), unitPriceCents: price ?? 0 });
    }
    return done({ ...base, items });
  }

  if (kind === 'payments') {
    const payments: InPayment[] = [];
    for (const r of rows) {
      const date = parseDate(get(r, 'paidDate') || get(r, 'date'), order);
      const invoice = get(r, 'number');
      const amount = parseMoney(get(r, 'amountApplied')) ?? parseMoney(get(r, 'total'));
      if (!date || !invoice || !amount) {
        skip('Missing the date, invoice number or amount');
        continue;
      }
      const how = get(r, 'method').toLowerCase();
      payments.push({ date, invoice, amountCents: amount, method: /cash/.test(how) ? 'cash' : /card|credit card|yoco|snapscan/.test(how) ? 'card' : /eft|bank|transfer|deposit|cheque|check/.test(how) || !how ? 'eft' : 'other', reference: get(r, 'reference').slice(0, 120) });
    }
    return done({ ...base, payments });
  }

  if (kind === 'trialBalance') {
    const tb: InTbLine[] = [];
    for (const r of rows) {
      const name = get(r, 'account');
      const code = get(r, 'accountCode');
      if (!name && !code) continue;
      if (/^total/i.test(name) || /^total/i.test(code)) continue;
      const cents = m.debit != null || m.credit != null ? (parseMoney(get(r, 'debit')) ?? 0) - (parseMoney(get(r, 'credit')) ?? 0) : (parseMoney(get(r, 'netBalance')) ?? 0);
      if (!cents) continue;
      tb.push({ code, name: name || code, cents });
    }
    return done({ ...base, tb });
  }

  if (kind === 'costs') {
    const costs: InCost[] = [];
    const byNumber = new Map<string, InCost>();
    for (const r of rows) {
      const date = parseDate(get(r, 'date'), order);
      const total = parseMoney(get(r, 'total')) ?? parseMoney(get(r, 'lineAmount')) ?? parseMoney(get(r, 'amountApplied'));
      if (!date || total == null) {
        skip('Missing the date or amount');
        continue;
      }
      const st = get(r, 'status').toLowerCase();
      if (/void|delet|cancel/.test(st)) {
        skip('Voided or deleted');
        continue;
      }
      const number = get(r, 'number');
      // One row per line: the bill's totals are on every row, so keep the first.
      if (number && byNumber.has(`${number}|${get(r, 'supplier')}`)) continue;
      const balance = parseMoney(get(r, 'balance'));
      const c: InCost = {
        date,
        dueDate: parseDate(get(r, 'dueDate'), order),
        supplier: get(r, 'supplier').slice(0, 200),
        description: (get(r, 'description') || get(r, 'reference') || get(r, 'supplier') || 'Imported cost').slice(0, 300),
        billNumber: number.slice(0, 60),
        category: get(r, 'category'),
        amountCents: total,
        vatCents: parseMoney(get(r, 'taxTotal')) ?? parseMoney(get(r, 'lineTax')) ?? 0,
        unpaidCents: Math.max(0, balance ?? 0),
      };
      if (number) byNumber.set(`${number}|${c.supplier}`, c);
      costs.push(c);
    }
    return done({ ...base, costs });
  }

  if (kind === 'invoices' || kind === 'quotes') {
    // One row per line (Xero, Zoho, QuickBooks' import layout, Invoice Ninja) or one per document
    // (Sage's and QuickBooks' lists): rows with the same number are one document.
    const groups = new Map<string, string[][]>();
    for (const r of rows) {
      const t = get(r, 'type').toLowerCase();
      if (t && /payment|receipt(?!.*sale)|journal|deposit|transfer|expense|bill|refund/.test(t) && !/sales receipt/.test(t)) {
        skip(`${get(r, 'type')} rows (not invoices)`);
        continue;
      }
      if (t && /credit/.test(t)) {
        skip('Credit notes (add them in Shap as credit notes on the invoices)');
        continue;
      }
      const number = get(r, 'number');
      if (!number) {
        if (groups.size && (get(r, 'description') || get(r, 'item'))) {
          // A continuation line with the number left blank (some exports only fill the first row).
          [...groups.values()].pop()!.push(r);
        } else skip('No number');
        continue;
      }
      const isQuote = kind === 'quotes' || /estimate|quote/.test(t);
      const key = `${isQuote ? 'q' : 'i'}|${number}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }
    const docs: InDoc[] = [];
    for (const [key, rs] of groups) {
      const first = rs[0]!;
      const dkind = key.startsWith('q') ? 'quote' : 'invoice';
      const status = docStatus(dkind, get(first, 'status'));
      if (status === 'skip') {
        skip('Voided or deleted');
        continue;
      }
      const date = parseDate(get(first, 'date'), order);
      if (!date) {
        skip('No date (or a date that couldn’t be read)');
        continue;
      }
      const statedTotal = parseMoney(get(first, 'total'));
      const statedTax = parseMoney(get(first, 'taxTotal'));
      const statedSub = parseMoney(get(first, 'subtotal'));
      const inclusiveHint = /incl|inclusive|true|yes/i.test(get(first, 'lineAmountTypes'));
      // The lines.
      const raw = rs
        .map((r) => {
          const description = [get(r, 'item') && get(r, 'description') && get(r, 'item') !== get(r, 'description') ? `${get(r, 'item')}: ` : '', get(r, 'description') || get(r, 'item')].join('').trim();
          const qty = parseQty(get(r, 'quantity'));
          const price = parseMoney(get(r, 'unitPrice'));
          const amount = parseMoney(get(r, 'lineAmount'));
          let tax = parseMoney(get(r, 'lineTax'));
          // Only a VAT rate on the line (Invoice Ninja, Zoho): the VAT from the rate.
          const rate = parseQty(get(r, 'taxRate'));
          if (tax == null && rate && rate > 0 && rate < 100) tax = Math.round((amount ?? Math.round((qty ?? 1) * (price ?? 0))) * (rate / 100));
          return { description, qty, price, amount, tax, unit: get(r, 'unit') };
        })
        .filter((l) => l.description || l.amount != null || l.price != null);
      const hasLines = raw.some((l) => l.amount != null || (l.price != null && l.qty != null));
      let lines: InLine[];
      let vat: number;
      if (hasLines) {
        let amounts = raw.map((l) => l.amount ?? Math.round((l.qty ?? 1) * (l.price ?? 0)));
        const lineTaxSum = raw.reduce((s, l) => s + (l.tax ?? 0), 0);
        const sum = amounts.reduce((s, a) => s + a, 0);
        let tax = statedTax ?? (lineTaxSum || null);
        // No VAT figures at all, but the total is the lines plus 15%: that's the VAT.
        if (tax == null && statedTotal != null && sum > 0 && Math.abs(statedTotal / sum - 1.15) < 0.002) tax = statedTotal - sum;
        // Are the line amounts with VAT or without? The total says: lines + VAT = total means without.
        const inclusive = inclusiveHint || (statedTotal != null && tax != null && tax !== 0 && Math.abs(sum - statedTotal) <= rs.length && Math.abs(sum + tax - statedTotal) > rs.length);
        if (inclusive && tax) {
          const ex = statedTotal != null ? statedTotal - tax : sum - tax;
          // Spread the VAT-exclusive total over the lines in proportion, the last line taking the rounding.
          let left = ex;
          amounts = amounts.map((a, i) => {
            if (i === amounts.length - 1) return left;
            const v = sum ? Math.round((a * ex) / sum) : 0;
            left -= v;
            return v;
          });
        }
        vat = tax ?? 0;
        lines = raw.map((l, i) => {
          const total = amounts[i]!;
          const qty = l.qty && l.qty !== 0 ? l.qty : 1;
          let unitPrice = l.price != null && !inclusive ? l.price : Math.round(total / qty);
          let q = qty;
          // A discount or rounding the quantity and price don't explain: one line at the line's amount.
          if (Math.abs(Math.round(q * unitPrice) - total) > 1) {
            q = 1;
            unitPrice = total;
          }
          const description = (l.description || 'Imported line').slice(0, 500);
          return { description, qty: q, unit: l.unit.slice(0, 20), unitPriceCents: unitPrice, lineTotalCents: Math.round(q * unitPrice), category: lineCategory(description) };
        });
      } else {
        // A list with one row per document: one line for the whole amount.
        const total = statedTotal ?? 0;
        const tax = statedTax ?? (statedSub != null ? total - statedSub : 0);
        const ex = statedSub ?? total - tax;
        vat = tax;
        const description = (get(first, 'reference') || get(first, 'description') || `As on ${dkind} ${get(first, 'number')}`).slice(0, 500);
        lines = [{ description, qty: 1, unit: '', unitPriceCents: ex, lineTotalCents: ex, category: lineCategory(description) }];
      }
      const subtotal = lines.reduce((s, l) => s + l.lineTotalCents, 0);
      const total = subtotal + vat;
      const balance = parseMoney(get(first, 'balance'));
      const paidCol = parseMoney(get(first, 'paid'));
      const paid = dkind !== 'invoice' || status === 'draft' ? null : paidCol ?? (balance != null ? total - balance : /paid/i.test(get(first, 'status')) && !/part/i.test(get(first, 'status')) ? total : null);
      docs.push({
        kind: dkind,
        number: get(first, 'number').slice(0, 40),
        date,
        dueDate: parseDate(get(first, 'dueDate'), order),
        client: get(first, 'client').slice(0, 200),
        clientEmail: get(first, 'clientEmail').slice(0, 200),
        reference: get(first, 'reference').slice(0, 200),
        status,
        lines,
        subtotalCents: subtotal,
        vatCents: vat,
        totalCents: total,
        paidCents: paid == null ? null : Math.max(0, Math.min(total, paid)),
        paidDate: parseDate(get(first, 'paidDate'), order),
        statedTotalCents: statedTotal != null && Math.abs(statedTotal - total) > 100 ? statedTotal : null,
      });
    }
    return done({ ...base, kind: docs.length && docs.every((d) => d.kind === 'quote') ? 'quotes' : kind, docs });
  }
  return done(base);
}

/* ---------------------------------------------------------------- the plan */

const CATEGORY_HINTS: [RegExp, string][] = [
  [/fuel|petrol|diesel/i, 'Petrol'],
  [/vehicle|motor|car|repairs.*vehicle|maintenance/i, 'Vehicle Maintenance'],
  [/bank|charges|fees/i, 'Bank'],
  [/insur/i, 'Insurance'],
  [/phone|cell|airtime|data|internet|telephone/i, 'Cellphone'],
  [/advert|marketing/i, 'Advertising'],
  [/account|audit|bookkeep|legal|professional/i, 'Accounting'],
  [/entertain|meal/i, 'Entertainment'],
  [/gift|donation/i, 'Gifts'],
  [/interest/i, 'Interest'],
  [/tool/i, 'Tool'],
  [/software|subscription|computer|licen/i, 'Software & subscriptions'],
  [/material|stock|purchases|cost of sales|parts/i, 'Parts'],
  [/fine|penalt/i, 'Fines'],
  [/cloth|ppe|uniform/i, 'PPE'],
];

/** A guess at the Shap account for a trial-balance line, by its name. */
export function suggestAccount(line: InTbLine, accounts: { id: string; code: string; name: string; type: AccountType; systemKey: string | null }[]): string | null {
  const byKey = (k: string) => accounts.find((a) => a.systemKey === k)?.id ?? null;
  const byCode = (c: string) => accounts.find((a) => a.code === c)?.id ?? null;
  // An account name is short; matching only its start keeps the patterns cheap on a crafted file.
  const n = line.name.toLowerCase().slice(0, 200);
  const exact = accounts.find((a) => a.name.toLowerCase() === n || (line.code && a.code === line.code && a.name.toLowerCase().includes(n.split(/\s+/)[0] ?? '')));
  if (exact) return exact.id;
  const rules: [RegExp, () => string | null][] = [
    [/accum.*(dep|amort)/, () => byKey('accumulated_depreciation')],
    [/vehicle|motor/, () => (/(dep|expense|fuel|repair|maint)/.test(n) ? null : byKey('fixed_assets_vehicles'))],
    [/equipment|tools|furniture|computer|fixed asset|plant|machinery/, () => (/(dep|expense|small)/.test(n) ? null : byKey('fixed_assets'))],
    [/\bbank\b|cheque|current account|savings|call account|fnb|absa|nedbank|standard bank|capitec|investec/, () => (/charge|fee|interest/.test(n) ? null : byKey('bank'))],
    [/petty cash|cash on hand|^cash/, () => byCode('1050')],
    [/debtor|receivable|accounts receivable|trade receivables/, () => byKey('receivables')],
    [/creditor|payable|accounts payable|trade payables/, () => byKey('payables') ?? byCode('2000')],
    [/\bvat\b|output tax|input tax|value added/, () => byKey('vat')],
    [/paye|uif|sdl|salar.*(owed|payable)|wages payable|accrued wages/, () => byKey('wages_payable')],
    [/income tax|provisional tax|sars/, () => (/expense/.test(n) ? byKey('income_tax') : byKey('income_tax_payable'))],
    [/loan.*(director|shareholder|member|owner)|director.*loan|shareholder.*loan|drawings|owner|capital account/, () => byKey('owner_loan')],
    [/share capital|stated capital|ordinary shares/, () => byKey('share_capital')],
    [/retained|accumulated (profit|loss)|reserves/, () => byKey('retained_earnings')],
    [/deposit.*(client|customer)|income received in advance|unearned/, () => byCode('2400')],
    [/interest received|other income|sundry income|discount received/, () => byKey('revenue_other')],
    [/sales|revenue|turnover|fees|income|services/, () => (/cost/.test(n) ? byKey('cos_materials') : byKey('revenue_labour'))],
    [/cost of sales|purchases|materials|stock/, () => byKey('cos_materials')],
    [/subcontract|direct labour|labour/, () => byKey('cos_labour')],
    [/depreciation/, () => byKey('depreciation')],
    [/salar|wages/, () => byKey('general_labour')],
  ];
  for (const [re, pick] of rules) if (re.test(n)) {
    const id = pick();
    if (id) return id;
  }
  // Expenses by name: the closest of Shap's expense accounts.
  for (const [re, cat] of CATEGORY_HINTS) if (re.test(n)) {
    const a = accounts.find((x) => x.type === 'expense' && x.name.toLowerCase().includes(cat.toLowerCase().split(' ')[0]!));
    if (a) return a.id;
  }
  return null;
}

export interface Plan {
  files: ReadFile[];
  clients: InClient[];
  items: InItem[];
  invoices: InDoc[];
  quotes: InDoc[];
  payments: InPayment[];
  costs: InCost[];
  tb: InTbLine[];
}

export function makePlan(files: { name: string; text: string }[]): Plan {
  const read = files.map((f) => readExportFile(f.name, f.text));
  const docs = read.flatMap((f) => f.docs ?? []);
  return {
    files: read,
    clients: read.flatMap((f) => f.clients ?? []),
    items: read.flatMap((f) => f.items ?? []),
    invoices: docs.filter((d) => d.kind === 'invoice'),
    quotes: docs.filter((d) => d.kind === 'quote'),
    payments: read.flatMap((f) => f.payments ?? []),
    costs: read.flatMap((f) => f.costs ?? []),
    tb: read.flatMap((f) => f.tb ?? []),
  };
}

/* ---------------------------------------------------------------- applying it */

export const applyOptions = z.object({
  /** Where clients' payments went (Shap's "paid into"). */
  receiptSourceId: z.string().uuid(),
  /** Costs marked paid: paid from here. */
  costSourceId: z.string().uuid().nullable().default(null),
  /** The trial balance's date: the last day of the old package's last financial year. */
  openingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  /** Each trial-balance line's Shap account (by its index in the plan's tb). */
  tbAccounts: z.array(z.string().uuid().nullable()).default([]),
  /** Carry on numbering after the imported invoices and quotes. */
  continueNumbering: z.boolean().default(true),
  lockOpening: z.boolean().default(true),
});
export type ApplyOptions = z.infer<typeof applyOptions>;

/** Splits "INV-0042" into prefix "INV-", 42 and 4 digits. */
function splitNumber(s: string): { prefix: string; n: number; pad: number } | null {
  const m = /^(.*?)(\d+)$/.exec(s.trim());
  return m ? { prefix: m[1]!, n: Number(m[2]), pad: m[2]!.length } : null;
}

export async function applyPlan(tx: Db, plan: Plan, o: ApplyOptions, userId: string | null) {
  const settings = await getSettings(tx);
  const counts = { clients: 0, clientsMatched: 0, items: 0, invoices: 0, quotes: 0, payments: 0, costs: 0, opening: false, skipped: [] as string[] };
  const note = (s: string) => counts.skipped.push(s);
  const lock = settings.lockDate;

  // Clients: by name (case doesn't matter); the list's details fill in what's blank.
  const existing = await tx<{ id: string; name: string; code: string | null }[]>`select id, name, code from clients`;
  const clientId = new Map(existing.map((c) => [c.name.toLowerCase(), c.id]));
  const codes = new Set(existing.map((c) => c.code).filter(Boolean));
  const fromDocs = [...plan.invoices, ...plan.quotes].filter((d) => d.client).map((d) => ({ name: d.client, code: '', contactPerson: '', email: d.clientEmail, phone: '', address: '', vatNumber: '', notes: '' }));
  for (const c of [...plan.clients, ...fromDocs]) {
    const k = c.name.toLowerCase();
    const id = clientId.get(k);
    if (id) {
      if (plan.clients.includes(c)) {
        await tx`update clients set email = case when email = '' then ${c.email} else email end, phone = case when phone = '' then ${c.phone} else phone end,
                 address = case when address = '' then ${c.address} else address end, vat_number = case when vat_number = '' then ${c.vatNumber} else vat_number end,
                 contact_person = case when contact_person = '' then ${c.contactPerson} else contact_person end where id = ${id}`;
        counts.clientsMatched++;
      }
      continue;
    }
    const code = c.code && !codes.has(c.code) ? c.code.slice(0, 40) : null;
    if (code) codes.add(code);
    const [row] = await tx<{ id: string }[]>`
      insert into clients (code, name, contact_person, email, phone, address, vat_number, notes)
      values (${code}, ${c.name.slice(0, 200)}, ${c.contactPerson.slice(0, 200)}, ${c.email.slice(0, 200)}, ${c.phone.slice(0, 60)}, ${c.address.slice(0, 1000)}, ${c.vatNumber.slice(0, 40)}, ${c.notes.slice(0, 2000)})
      returning id`;
    clientId.set(k, row!.id);
    counts.clients++;
  }

  // Items: the usual items offered on quotes and invoices.
  for (const it of plan.items) {
    const r = await tx`insert into items (description, category, unit, unit_price_cents) values (${it.description}, ${lineCategory(it.description)}, ${it.unit}, ${it.unitPriceCents}) on conflict ((lower(description))) do nothing`;
    counts.items += r.count;
  }

  // Invoices and quotes, with their numbers as they were.
  const taken = new Set((await tx<{ k: string }[]>`select kind || '|' || number as k from documents`).map((r) => r.k));
  const docIds = new Map<string, { id: string; totalCents: number }>();
  const brand = settings.defaultBrandId ?? null;
  for (const d of [...plan.invoices, ...plan.quotes]) {
    if (taken.has(`${d.kind}|${d.number}`)) {
      note(`${d.kind === 'invoice' ? 'Invoice' : 'Quote'} ${d.number} is already in Shap`);
      continue;
    }
    if (d.kind === 'invoice' && d.status !== 'draft' && lock && d.date <= lock && !o.openingDate) {
      note(`Invoice ${d.number} is dated in a closed period (${formatDate(d.date)})`);
      continue;
    }
    const vatRate = d.vatCents && d.subtotalCents ? (Math.abs(d.vatCents / d.subtotalCents - 0.15) < 0.01 ? 1500 : Math.round((d.vatCents / d.subtotalCents) * 10000)) : 0;
    const due = d.kind === 'invoice' ? (d.dueDate ?? addDays(d.date, settings.paymentDays)) : d.dueDate;
    const [row] = await tx<{ id: string }[]>`
      insert into documents (kind, number, status, client_id, issue_date, due_date, title, notes, terms, vat_rate_bp, created_by, brand_id, subtotal_cents, vat_cents, total_cents)
      values (${d.kind}, ${d.number}, ${d.status}, ${d.client ? (clientId.get(d.client.toLowerCase()) ?? null) : null}, ${d.date}, ${due}, ${d.reference}, '', '',
              ${vatRate}, ${userId}, ${brand}, ${d.subtotalCents}, ${d.vatCents}, ${d.totalCents})
      returning id`;
    let sort = 0;
    for (const l of d.lines)
      await tx`insert into document_lines (document_id, sort, category, description, qty, unit, unit_price_cents, line_total_cents)
               values (${row!.id}, ${sort++}, ${l.category}, ${l.description}, ${l.qty}, ${l.unit}, ${l.unitPriceCents}, ${l.lineTotalCents})`;
    taken.add(`${d.kind}|${d.number}`);
    if (d.kind === 'invoice') {
      docIds.set(d.number, { id: row!.id, totalCents: d.totalCents });
      counts.invoices++;
    } else counts.quotes++;
  }

  // Payments: from the payments export where there is one, else what each invoice says was paid.
  const paid = new Map<string, number>();
  for (const p of plan.payments) {
    const inv = docIds.get(p.invoice);
    if (!inv) {
      if (!taken.has(`invoice|${p.invoice}`)) note(`A payment for invoice ${p.invoice}, which isn’t in the files`);
      continue;
    }
    const sofar = paid.get(p.invoice) ?? 0;
    const amount = Math.min(p.amountCents, inv.totalCents - sofar);
    if (amount <= 0) continue;
    await tx`insert into receipts (invoice_id, date, amount_cents, source_id, method, reference, note, created_by)
             values (${inv.id}, ${p.date}, ${amount}, ${o.receiptSourceId}, ${p.method}, ${p.reference}, 'Imported', ${userId})`;
    paid.set(p.invoice, sofar + amount);
    counts.payments++;
  }
  for (const d of plan.invoices) {
    const inv = docIds.get(d.number);
    if (!inv || paid.has(d.number) || !d.paidCents) continue;
    await tx`insert into receipts (invoice_id, date, amount_cents, source_id, method, reference, note, created_by)
             values (${inv.id}, ${d.paidDate ?? d.date}, ${d.paidCents}, ${o.receiptSourceId}, 'eft', '', ${d.paidDate ? 'Imported' : 'Imported (the old package didn’t say when)'}, ${userId})`;
    counts.payments++;
  }

  // Costs and bills.
  if (plan.costs.length) {
    const cats = await tx<{ id: string; name: string; kind: string }[]>`select id, name, kind from cost_categories where active`;
    const sundry = cats.find((c) => c.name === 'Sundry') ?? cats.find((c) => c.kind === 'overhead') ?? cats[0];
    const [billSrc] = await tx<{ id: string }[]>`select id from payment_sources where role = 'bills'`;
    const paidFrom = o.costSourceId ?? settings.defaultCostSourceId;
    for (const c of plan.costs) {
      if (lock && c.date <= lock && !o.openingDate) {
        note(`A cost on ${formatDate(c.date)} is in a closed period`);
        continue;
      }
      const hint = CATEGORY_HINTS.find(([re]) => re.test(c.category.slice(0, 200)) || re.test(c.description.slice(0, 200)))?.[1];
      const cat = (hint && cats.find((x) => x.name.toLowerCase() === hint.toLowerCase())) || cats.find((x) => x.name.toLowerCase() === c.category.toLowerCase()) || sundry;
      const unpaid = c.unpaidCents > 0 && billSrc;
      const [row] = await tx<{ id: string }[]>`
        insert into costs (date, description, supplier, amount_cents, vat_cents, category_id, source_id, bill_number, due_date, note, created_by)
        values (${c.date}, ${c.description}, ${c.supplier}, ${c.amountCents}, ${c.vatCents}, ${cat!.id}, ${unpaid ? billSrc!.id : paidFrom}, ${c.billNumber}, ${c.dueDate}, 'Imported', ${userId})
        returning id`;
      // Partly paid: the part paid as a payment against the bill.
      if (unpaid && c.unpaidCents < c.amountCents && paidFrom)
        await tx`insert into bill_payments (cost_id, date, amount_cents, source_id, note) values (${row!.id}, ${c.date}, ${c.amountCents - c.unpaidCents}, ${paidFrom}, 'Imported')`;
      counts.costs++;
    }
  }

  // Numbering carries on after the highest imported number, when it's in the same style.
  if (o.continueNumbering) {
    for (const [kind, list] of [['invoice', plan.invoices], ['quote', plan.quotes]] as const) {
      const nums = list.map((d) => splitNumber(d.number)).filter((x): x is NonNullable<typeof x> => x != null);
      if (!nums.length) continue;
      const top = nums.reduce((a, b) => (b.n > a.n ? b : a));
      const col = kind === 'invoice' ? 'invoice' : 'quote';
      await tx`update settings set ${tx.unsafe(`${col}_prefix`)} = ${top.prefix}, ${tx.unsafe(`${col}_pad`)} = ${Math.min(8, top.pad)},
               ${tx.unsafe(`${col}_next`)} = greatest(${tx.unsafe(`${col}_next`)}, ${top.n + 1}) where id`;
    }
  }

  // Opening balances: one journal that brings every account to the trial balance on that date.
  if (plan.tb.length && o.openingDate) {
    const target = new Map<string, number>();
    plan.tb.forEach((l, i) => {
      const id = o.tbAccounts[i];
      if (!id) throw badRequest(`Choose a Shap account for “${l.name}” in the trial balance`);
      target.set(id, (target.get(id) ?? 0) + l.cents);
    });
    const sum = [...target.values()].reduce((s, v) => s + v, 0);
    if (sum !== 0) throw badRequest(`The trial balance doesn’t balance: debits and credits are ${formatMoney(Math.abs(sum))} apart. Check the file has every account.`);
    const accounts = await tx<{ id: string; type: AccountType; systemKey: string | null }[]>`select id, type, system_key from accounts`;
    const typeOf = new Map(accounts.map((a) => [a.id, a.type]));
    const re = accounts.find((a) => a.systemKey === 'retained_earnings')!.id;
    // Profit and loss accounts close into retained earnings: the journal works on balances.
    const pl = (id: string) => ['income', 'cost_of_sales', 'expense'].includes(typeOf.get(id) ?? '');
    const want = new Map<string, number>();
    for (const [id, cents] of target) {
      const k = pl(id) ? re : id;
      want.set(k, (want.get(k) ?? 0) + cents);
    }
    await freshTotals(tx);
    const have = await tx<{ accountId: string; cents: number }[]>`
      select account_id, sum(amount_cents)::bigint as cents from ledger_totals where date <= ${o.openingDate}::date group by account_id`;
    const now = new Map<string, number>();
    for (const h of have) {
      const k = pl(h.accountId) ? re : h.accountId;
      now.set(k, (now.get(k) ?? 0) + Number(h.cents));
    }
    const ids = new Set([...want.keys(), ...now.keys()]);
    const lines = [...ids].map((id) => ({ id, cents: (want.get(id) ?? 0) - (now.get(id) ?? 0) })).filter((l) => l.cents !== 0);
    if (lines.length) {
      const [j] = await tx<{ id: string }[]>`
        insert into journals (date, description, reference, kind, created_by)
        values (${o.openingDate}, ${`Opening balances at ${formatDate(o.openingDate)}, from the old package`}, 'Moved in', 'opening', ${userId}) returning id`;
      for (const l of lines)
        await tx`insert into journal_lines (journal_id, account_id, debit_cents, credit_cents, memo)
                 values (${j!.id}, ${l.id}, ${l.cents > 0 ? l.cents : 0}, ${l.cents < 0 ? -l.cents : 0}, 'Opening balance')`;
    }
    if (o.lockOpening) await tx`update settings set lock_date = greatest(coalesce(lock_date, ${o.openingDate}::date), ${o.openingDate}::date) where id`;
    counts.opening = true;
  }
  // History brought in, possibly into an agreed year: the books start from here.
  await noteAllShapFigures(tx);
  return counts;
}

const formatMoney = (c: number) => `R${(c / 100).toFixed(2)}`;

/* ---------------------------------------------------------------- routes */

const filesInput = z.object({ files: z.array(z.object({ name: z.string().max(200), text: z.string().max(20_000_000) })).min(1).max(12) });

export function registerMoveInRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;
  const owner = { preHandler: requireRole('owner') };

  /** What's in the files, and what would happen: nothing is saved. */
  app.post('/api/move-in/preview', owner, async (req) => {
    const { files } = parse(filesInput, req.body);
    const plan = makePlan(files);
    const settings = await getSettings(sql);
    const accounts = await sql<{ id: string; code: string; name: string; type: AccountType; systemKey: string | null }[]>`select id, code, name, type, system_key from accounts where active order by code`;
    const known = new Set((await sql<{ k: string }[]>`select kind || '|' || number as k from documents`).map((r) => r.k));
    const names = new Set((await sql<{ n: string }[]>`select lower(name) as n from clients`).map((r) => r.n));
    const newClients = new Set([...plan.clients.map((c) => c.name), ...[...plan.invoices, ...plan.quotes].map((d) => d.client).filter(Boolean)].map((n) => n.toLowerCase()).filter((n) => !names.has(n)));
    const dates = plan.invoices.map((d) => d.date).sort();
    const tbBalance = plan.tb.reduce((s, l) => s + l.cents, 0);
    // The opening date: the last financial year end before the first invoice (or the latest one before today).
    const fyEnds = [0, 1, 2, 3].map((n) => financialYear(addDays(financialYear(new Date().toISOString().slice(0, 10), settings.fyEndMonth).start, -1 - 365 * n), settings.fyEndMonth).end);
    return {
      files: plan.files.map((f) => ({ name: f.name, kind: f.kind, source: f.source, rows: f.rows, skipped: f.skipped, columns: f.kind === 'unknown' ? f.columns.slice(0, 20) : [] })),
      clients: { total: newClients.size + plan.clients.filter((c) => names.has(c.name.toLowerCase())).length, new: newClients.size, matched: plan.clients.filter((c) => names.has(c.name.toLowerCase())).length },
      items: plan.items.length,
      invoices: {
        count: plan.invoices.length,
        drafts: plan.invoices.filter((d) => d.status === 'draft').length,
        totalCents: plan.invoices.filter((d) => d.status !== 'draft').reduce((s, d) => s + d.totalCents, 0),
        paidCents: plan.invoices.reduce((s, d) => s + (d.paidCents ?? 0), 0),
        from: dates[0] ?? null,
        to: dates[dates.length - 1] ?? null,
        already: plan.invoices.filter((d) => known.has(`invoice|${d.number}`)).map((d) => d.number).slice(0, 20),
        totalsDiffer: plan.invoices.filter((d) => d.statedTotalCents != null).map((d) => ({ number: d.number, stated: d.statedTotalCents, worked: d.totalCents })).slice(0, 10),
        withVat: plan.invoices.filter((d) => d.vatCents).length,
        sample: plan.invoices.slice(0, 3),
      },
      quotes: plan.quotes.length,
      payments: plan.payments.length,
      costs: { count: plan.costs.length, totalCents: plan.costs.reduce((s, c) => s + c.amountCents, 0), unpaid: plan.costs.filter((c) => c.unpaidCents > 0).length },
      tb: {
        lines: plan.tb.map((l) => ({ ...l, suggestion: suggestAccount(l, accounts) })),
        balanced: tbBalance === 0,
        differenceCents: tbBalance,
      },
      openingDates: fyEnds,
      accounts,
      vatRegistered: settings.vatRegistered,
    };
  });

  app.post('/api/move-in', { ...owner, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const user = userOrThrow(req);
    const body = parse(filesInput.extend({ options: applyOptions }), req.body);
    const plan = makePlan(body.files);
    if (!plan.invoices.length && !plan.quotes.length && !plan.clients.length && !plan.items.length && !plan.tb.length && !plan.costs.length)
      throw badRequest('Nothing in those files that Shap could read. Export them as CSV from the old package.');
    const counts = await sql.begin(async (tx) => {
      const c = await applyPlan(tx, plan, body.options, user.id);
      await audit(tx, { userId: user.id, action: 'move_in', entity: 'company', ip: req.ip, details: { ...c, skipped: c.skipped.length, files: plan.files.map((f) => `${f.source} ${f.kind}`) } });
      return c;
    });
    return counts;
  });
}
