/**
 * The accountant export (after Sorted's export studio): what can be exported, the columns each
 * has, how the file is laid out, and starting presets for the packages SA accountants use. Pick a
 * dataset and a preset, adjust the date format, separator and so on, preview, download.
 */
import { z } from 'zod';

export type ColumnType = 'text' | 'date' | 'money' | 'number';
export interface ExportColumn {
  key: string;
  label: string;
  type: ColumnType;
}

const c = (key: string, label: string, type: ColumnType = 'text'): ExportColumn => ({ key, label, type });

export const EXPORT_DATASETS = {
  journal: {
    label: 'Journal (double entry)',
    description: 'Every posting in the books, debits and credits by account code: invoices, payments, costs, wages, assets and journals. Per item, or summed by day or month.',
    columns: [
      c('date', 'Date', 'date'),
      c('reference', 'Reference'),
      c('source', 'Source'),
      c('accountCode', 'Account code'),
      c('accountName', 'Account name'),
      c('description', 'Description'),
      c('debit', 'Debit', 'money'),
      c('credit', 'Credit', 'money'),
      c('amount', 'Amount (debit +, credit −)', 'money'),
    ],
  },
  invoiceLines: {
    label: 'Sales: invoice lines',
    description: 'Each line of each issued invoice and credit note (credit notes negative): the shape most packages import sales in.',
    columns: [
      c('number', 'Invoice number'),
      c('kind', 'Type'),
      c('date', 'Invoice date', 'date'),
      c('dueDate', 'Due date', 'date'),
      c('client', 'Client'),
      c('clientEmail', 'Client email'),
      c('clientVat', 'Client VAT number'),
      c('job', 'Job'),
      c('line', 'Line', 'number'),
      c('description', 'Description'),
      c('quantity', 'Quantity', 'number'),
      c('unit', 'Unit'),
      c('unitPrice', 'Unit price (excl. VAT)', 'money'),
      c('lineTotal', 'Line total (excl. VAT)', 'money'),
      c('vatRate', 'VAT %', 'number'),
      c('vat', 'VAT', 'money'),
      c('taxType', 'Tax type'),
      c('accountCode', 'Revenue account code'),
    ],
  },
  invoices: {
    label: 'Sales: invoices (one row each)',
    description: 'Every issued invoice and credit note, with what was paid and what is still owed.',
    columns: [
      c('number', 'Invoice number'),
      c('kind', 'Type'),
      c('date', 'Invoice date', 'date'),
      c('dueDate', 'Due date', 'date'),
      c('status', 'Status'),
      c('client', 'Client'),
      c('clientVat', 'Client VAT number'),
      c('job', 'Job'),
      c('subtotal', 'Excl. VAT', 'money'),
      c('vat', 'VAT', 'money'),
      c('total', 'Total', 'money'),
      c('paid', 'Paid or credited', 'money'),
      c('writtenOff', 'Written off', 'money'),
      c('balance', 'Balance', 'money'),
      c('creditedInvoice', 'Credits invoice'),
    ],
  },
  payments: {
    label: 'Payments received',
    description: 'Money received against invoices, and into which account.',
    columns: [
      c('date', 'Date received', 'date'),
      c('invoice', 'Invoice number'),
      c('client', 'Client'),
      c('method', 'Method'),
      c('amount', 'Amount', 'money'),
      c('reference', 'Reference'),
      c('bankAccount', 'Received into'),
      c('bankAccountCode', 'Received into (account code)'),
    ],
  },
  costs: {
    label: 'Purchases: costs and bills',
    description: 'Every cost: supplier, type, the account it posts to, VAT, and how it was paid (or that it’s a bill still to pay).',
    columns: [
      c('date', 'Date', 'date'),
      c('supplier', 'Supplier'),
      c('description', 'Description'),
      c('billNumber', 'Bill / slip number'),
      c('dueDate', 'Due date', 'date'),
      c('category', 'Cost type'),
      c('accountCode', 'Account code'),
      c('accountName', 'Account name'),
      c('excl', 'Excl. VAT', 'money'),
      c('vat', 'VAT', 'money'),
      c('amount', 'Total', 'money'),
      c('taxType', 'Tax type'),
      c('paidFrom', 'Paid from'),
      c('paidFromCode', 'Paid from (account code)'),
      c('job', 'Job'),
      c('hasSlip', 'Slip on file'),
    ],
  },
  debtors: {
    label: 'Debtors age analysis',
    description: 'What each client owes at the end date, by how long it has been outstanding.',
    columns: [
      c('client', 'Client'),
      c('phone', 'Phone'),
      c('email', 'Email'),
      c('current', 'Current (0–30 days)', 'money'),
      c('days30', '31–60 days', 'money'),
      c('days60', '61–90 days', 'money'),
      c('days90', 'Over 90 days', 'money'),
      c('total', 'Total owing', 'money'),
      c('oldestInvoice', 'Oldest unpaid invoice', 'date'),
    ],
  },
} as const satisfies Record<string, { label: string; description: string; columns: ExportColumn[] }>;

export type ExportDataset = keyof typeof EXPORT_DATASETS;
export const EXPORT_DATASET_KEYS = Object.keys(EXPORT_DATASETS) as ExportDataset[];

export const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD-MM-YYYY', 'YYYYMMDD', 'DD MMM YYYY'] as const;

export const exportColumnSchema = z.union([
  /** A fixed value on every row, e.g. a tax type or branch the package insists on. (First, so its value isn't stripped.) */
  z.object({ key: z.literal('const'), header: z.string().max(80), value: z.string().max(120) }),
  z.object({ key: z.string().min(1).max(40), header: z.string().max(80) }),
]);
export type ExportColumnChoice = z.infer<typeof exportColumnSchema>;

export const exportOptionsSchema = z.object({
  columns: z.array(exportColumnSchema).min(1).max(40),
  delimiter: z.enum([',', ';', '\t']).default(','),
  decimal: z.enum(['.', ',']).default('.'),
  dateFormat: z.enum(DATE_FORMATS).default('YYYY-MM-DD'),
  /** Negative amounts as -12.50 or (12.50). */
  negatives: z.enum(['minus', 'brackets']).default('minus'),
  /** Plain numbers (12.50) or with thousands separators (1 250.00). */
  thousands: z.boolean().default(false),
  header: z.boolean().default(true),
  /** Journal: one entry per item, or summed per day or month. */
  groupBy: z.enum(['item', 'day', 'month']).default('item'),
});
export type ExportOptions = z.infer<typeof exportOptionsSchema>;

export interface BuiltinPreset {
  id: string;
  name: string;
  dataset: ExportDataset;
  note: string;
  options: Partial<ExportOptions> & { columns: ExportColumnChoice[] };
}

const all = (d: ExportDataset): ExportColumnChoice[] => EXPORT_DATASETS[d].columns.map((col) => ({ key: col.key, header: col.label }));

/**
 * Starting points. Package import layouts change over time and differ by edition, so each preset
 * says to check it against the package's current import template.
 */
export const BUILTIN_PRESETS: BuiltinPreset[] = [
  ...EXPORT_DATASET_KEYS.map((d) => ({
    id: `generic-${d}`,
    name: 'Everything (CSV)',
    dataset: d,
    note: 'All columns, plain CSV. Opens in Excel, Google Sheets or LibreOffice.',
    options: { columns: all(d) },
  })),
  {
    id: 'journal-monthly',
    name: 'Monthly journal summary',
    dataset: 'journal',
    note: 'One debit or credit per account per month: the usual way an accountant posts another system’s totals.',
    options: {
      groupBy: 'month',
      dateFormat: 'DD/MM/YYYY',
      columns: [
        { key: 'date', header: 'Date' },
        { key: 'reference', header: 'Reference' },
        { key: 'accountCode', header: 'Account' },
        { key: 'accountName', header: 'Account name' },
        { key: 'description', header: 'Description' },
        { key: 'debit', header: 'Debit' },
        { key: 'credit', header: 'Credit' },
      ],
    },
  },
  {
    id: 'pastel-journal',
    name: 'Journal for Sage 50 / Pastel batch import',
    dataset: 'journal',
    note: 'Date, account, reference, description and a signed amount: the columns a Pastel journal batch takes. Map Shap’s account codes to yours, and check the order against the batch’s import layout.',
    options: {
      groupBy: 'day',
      dateFormat: 'DD/MM/YYYY',
      header: false,
      columns: [
        { key: 'date', header: 'Date' },
        { key: 'accountCode', header: 'Account' },
        { key: 'reference', header: 'Reference' },
        { key: 'description', header: 'Description' },
        { key: 'amount', header: 'Amount' },
      ],
    },
  },
  {
    id: 'xero-journal',
    name: 'Xero manual journal',
    dataset: 'journal',
    note: 'Laid out like Xero’s manual journal import (date, narration, account code, description, amount; debits positive). Check against Xero’s current template.',
    options: {
      groupBy: 'month',
      dateFormat: 'DD/MM/YYYY',
      columns: [
        { key: 'date', header: '*Date' },
        { key: 'reference', header: '*Narration' },
        { key: 'accountCode', header: '*AccountCode' },
        { key: 'description', header: 'Description' },
        { key: 'amount', header: '*Amount' },
      ],
    },
  },
  {
    id: 'xero-sales',
    name: 'Xero sales invoices',
    dataset: 'invoiceLines',
    note: 'Laid out like Xero’s sales invoice import (contact, invoice number, dates, line, account code, tax type). Set the tax type names to the ones your Xero uses.',
    options: {
      dateFormat: 'DD/MM/YYYY',
      columns: [
        { key: 'client', header: '*ContactName' },
        { key: 'clientEmail', header: 'EmailAddress' },
        { key: 'number', header: '*InvoiceNumber' },
        { key: 'job', header: 'Reference' },
        { key: 'date', header: '*InvoiceDate' },
        { key: 'dueDate', header: '*DueDate' },
        { key: 'description', header: '*Description' },
        { key: 'quantity', header: '*Quantity' },
        { key: 'unitPrice', header: '*UnitAmount' },
        { key: 'accountCode', header: '*AccountCode' },
        { key: 'taxType', header: '*TaxType' },
      ],
    },
  },
  {
    id: 'xero-bills',
    name: 'Xero bills (purchases)',
    dataset: 'costs',
    note: 'Laid out like Xero’s bill import. Costs paid on the spot come through as bills too: mark them paid in Xero, or import only the bills.',
    options: {
      dateFormat: 'DD/MM/YYYY',
      columns: [
        { key: 'supplier', header: '*ContactName' },
        { key: 'billNumber', header: '*InvoiceNumber' },
        { key: 'date', header: '*InvoiceDate' },
        { key: 'dueDate', header: '*DueDate' },
        { key: 'description', header: '*Description' },
        { key: 'const', header: '*Quantity', value: '1' },
        { key: 'amount', header: '*UnitAmount' },
        { key: 'accountCode', header: '*AccountCode' },
        { key: 'taxType', header: '*TaxType' },
      ],
    },
  },
  {
    id: 'qbo-invoices',
    name: 'QuickBooks Online invoices',
    dataset: 'invoiceLines',
    note: 'Laid out like QuickBooks Online’s invoice import (invoice number, customer, dates, item description, quantity, rate, amount). Check against its current sample file.',
    options: {
      dateFormat: 'DD/MM/YYYY',
      columns: [
        { key: 'number', header: 'InvoiceNo' },
        { key: 'client', header: 'Customer' },
        { key: 'date', header: 'InvoiceDate' },
        { key: 'dueDate', header: 'DueDate' },
        { key: 'description', header: 'ItemDescription' },
        { key: 'quantity', header: 'ItemQuantity' },
        { key: 'unitPrice', header: 'ItemRate' },
        { key: 'lineTotal', header: 'ItemAmount' },
        { key: 'taxType', header: 'ItemTaxCode' },
      ],
    },
  },
  {
    id: 'sage-accounting-invoices',
    name: 'Sage Accounting customer invoices',
    dataset: 'invoiceLines',
    note: 'Customer, document number, date, description, quantity, price and account: what Sage Accounting’s invoice import asks for. Match the headings to its template before the first import.',
    options: {
      dateFormat: 'DD/MM/YYYY',
      columns: [
        { key: 'client', header: 'Customer Name' },
        { key: 'number', header: 'Document Number' },
        { key: 'date', header: 'Document Date' },
        { key: 'job', header: 'Reference' },
        { key: 'description', header: 'Description' },
        { key: 'quantity', header: 'Quantity' },
        { key: 'unitPrice', header: 'Unit Price' },
        { key: 'accountCode', header: 'Account' },
        { key: 'taxType', header: 'Tax Type' },
      ],
    },
  },
  {
    id: 'sage-accounting-supplier',
    name: 'Sage Accounting supplier invoices',
    dataset: 'costs',
    note: 'Supplier, document number, date, description and amount for Sage Accounting’s supplier invoice import. Match the headings to its template.',
    options: {
      dateFormat: 'DD/MM/YYYY',
      columns: [
        { key: 'supplier', header: 'Supplier Name' },
        { key: 'billNumber', header: 'Document Number' },
        { key: 'date', header: 'Document Date' },
        { key: 'description', header: 'Description' },
        { key: 'const', header: 'Quantity', value: '1' },
        { key: 'excl', header: 'Unit Price' },
        { key: 'accountCode', header: 'Account' },
        { key: 'taxType', header: 'Tax Type' },
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Formatting (shared so the preview on screen matches the file exactly)
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatExportDate(iso: string | null | undefined, f: ExportOptions['dateFormat']): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m as unknown as [string, string, string, string];
  switch (f) {
    case 'DD/MM/YYYY':
      return `${d}/${mo}/${y}`;
    case 'MM/DD/YYYY':
      return `${mo}/${d}/${y}`;
    case 'DD-MM-YYYY':
      return `${d}-${mo}-${y}`;
    case 'YYYYMMDD':
      return `${y}${mo}${d}`;
    case 'DD MMM YYYY':
      return `${d} ${MONTHS[Number(mo) - 1]} ${y}`;
    default:
      return `${y}-${mo}-${d}`;
  }
}

export function formatExportMoney(cents: number | null | undefined, o: Pick<ExportOptions, 'decimal' | 'negatives' | 'thousands'>): string {
  if (cents == null) return '';
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  let whole = String(Math.floor(abs / 100));
  if (o.thousands) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const s = `${whole}${o.decimal}${String(abs % 100).padStart(2, '0')}`;
  if (!neg) return s;
  return o.negatives === 'brackets' ? `(${s})` : `-${s}`;
}

export type ExportRow = Record<string, string | number | null | undefined>;

/** Turns rows into the cells of the file, following the chosen columns and formats. */
export function formatExportRows(dataset: ExportDataset, rows: ExportRow[], o: ExportOptions): { headers: string[]; cells: string[][] } {
  const types = new Map<string, ColumnType>(EXPORT_DATASETS[dataset].columns.map((col) => [col.key, col.type]));
  const headers = o.columns.map((col) => safeText(col.header));
  const cells = rows.map((r) =>
    o.columns.map((col) => {
      if (col.key === 'const') return safeText('value' in col ? col.value : '');
      const v = r[col.key];
      const t = types.get(col.key);
      if (t === 'money') return typeof v === 'number' ? formatExportMoney(v, o) : '';
      if (t === 'date') return formatExportDate(typeof v === 'string' ? v : null, o.dateFormat);
      if (t === 'number') return v == null ? '' : o.decimal === ',' ? String(v).replace('.', ',') : String(v);
      return v == null ? '' : safeText(String(v));
    }),
  );
  return { headers, cells };
}

/**
 * Text a spreadsheet would run as a formula (=, +, -, @ at the start) gets a leading apostrophe,
 * so opening an export in Excel can't run a formula someone typed into a name or description
 * (CSV injection). Plain numbers like -12.50 are left alone.
 */
export function safeText(s: string): string {
  if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-\d+([.,]\d+)?$/.test(s))) return `'${s}`;
  return s;
}

/** RFC 4180 CSV (with the chosen separator), with a byte-order mark so Excel opens it as UTF-8. */
export function toDelimited(headers: string[], cells: string[][], o: Pick<ExportOptions, 'delimiter' | 'header'>): string {
  const d = o.delimiter;
  const cell = (s: string) => (s.includes(d) || /["\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [...(o.header ? [headers] : []), ...cells].map((r) => r.map(cell).join(d));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** The figure to check the package against after importing. */
export function exportTotalOf(dataset: ExportDataset, rows: ExportRow[]): { label: string; cents: number } | null {
  const key = ({ journal: 'debit', invoiceLines: 'lineTotal', invoices: 'total', payments: 'amount', costs: 'amount', debtors: 'total' } as Record<ExportDataset, string>)[dataset];
  const label = ({ journal: 'Total debits', invoiceLines: 'Sales excl. VAT', invoices: 'Total invoiced', payments: 'Total received', costs: 'Total costs', debtors: 'Total owing' } as Record<ExportDataset, string>)[dataset];
  return { label, cents: rows.reduce((sum, r) => sum + (typeof r[key] === 'number' ? (r[key] as number) : 0), 0) };
}
