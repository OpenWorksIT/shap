/**
 * The accountant export (after Sorted's export studio): the books as the rows another package
 * imports. Each dataset returns plain rows keyed by the column keys in @shap/shared
 * EXPORT_DATASETS; formatting (dates, decimals, columns, order) happens in formatExportRows, so
 * the preview and the file always agree. Money is integer cents throughout.
 */
import type { FastifyInstance } from 'fastify';
import {
  EXPORT_DATASET_KEYS,
  EXPORT_DATASETS,
  exportOptionsSchema,
  exportTotalOf,
  financialYear,
  formatExportRows,
  LEDGER_SOURCE_LABELS,
  monthEnd,
  monthLabel,
  toDelimited,
  type ExportDataset,
  type ExportOptions,
  type ExportRow,
} from '@shap/shared';
import { z } from 'zod';
import { requireRole } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Db } from '../db/index.js';
import { getSettings, isIsoDate, today, type SettingsRow } from '../lib/books.js';
import { badRequest } from '../lib/errors.js';

interface Query {
  from: string;
  to: string;
  groupBy: ExportOptions['groupBy'];
}

export async function buildExport(db: Db, dataset: ExportDataset, q: Query): Promise<{ rows: ExportRow[]; notes: string[] }> {
  const s = await getSettings(db);
  switch (dataset) {
    case 'journal':
      return journal(db, q);
    case 'invoiceLines':
      return { rows: await invoiceLines(db, s, q), notes: s.vatRegistered ? [] : ['Not registered for VAT: tax type is “No VAT” throughout.'] };
    case 'invoices':
      return { rows: await invoices(db, q), notes: [] };
    case 'payments':
      return { rows: await payments(db, q), notes: [] };
    case 'costs':
      return costs(db, s, q);
    case 'debtors':
      return { rows: await debtors(db, q), notes: [`As at ${q.to}.`] };
  }
}

/** Every posting, or one line per account per day or month. Debits positive. */
async function journal(db: Db, q: Query) {
  const rows = await db<{ date: string; source: string; memo: string; amountCents: number; code: string; name: string; docNumber: string | null }[]>`
    select l.date, l.source, l.memo, l.amount_cents, a.code, a.name, coalesce(d.number, rd.number) as doc_number
    from ledger l join accounts a on a.id = l.account_id
    left join documents d on d.id = l.source_id and l.source in ('invoice', 'credit_note', 'write_off')
    left join receipts r on r.id = l.source_id and l.source = 'receipt'
    left join documents rd on rd.id = r.invoice_id
    where l.date between ${q.from}::date and ${q.to}::date and l.amount_cents <> 0
    order by l.date, l.source, l.source_id, a.code`;
  const line = (date: string, reference: string, source: string, code: string, name: string, description: string, cents: number): ExportRow => ({
    date,
    reference,
    source,
    accountCode: code,
    accountName: name,
    description,
    debit: cents > 0 ? cents : null,
    credit: cents < 0 ? -cents : null,
    amount: cents,
  });
  if (q.groupBy === 'item') {
    return {
      rows: rows.map((r) => line(r.date, r.docNumber ?? LEDGER_SOURCE_LABELS[r.source] ?? r.source, LEDGER_SOURCE_LABELS[r.source] ?? r.source, r.code, r.name, r.memo, Number(r.amountCents))),
      notes: [],
    };
  }
  // Summed per account per period, dated the period's last day.
  const sums = new Map<string, { date: string; ref: string; code: string; name: string; label: string; cents: number }>();
  for (const r of rows) {
    const period = q.groupBy === 'month' ? r.date.slice(0, 7) : r.date;
    const date = q.groupBy === 'month' ? (monthEnd(`${period}-01`) > q.to ? q.to : monthEnd(`${period}-01`)) : r.date;
    const label = q.groupBy === 'month' ? monthLabel(period) : r.date;
    const k = `${period}|${r.code}`;
    const x = sums.get(k) ?? { date, ref: `Shap ${label}`, code: r.code, name: r.name, label, cents: 0 };
    x.cents += Number(r.amountCents);
    sums.set(k, x);
  }
  return {
    rows: [...sums.values()].filter((x) => x.cents !== 0).map((x) => line(x.date, x.ref, 'Shap', x.code, x.name, `${x.name}, ${x.label}`, x.cents)),
    notes: ['Summed per account: each period’s debits and credits balance.'],
  };
}

const salesTaxType = (rateBp: number, registered: boolean, code = 'standard') =>
  rateBp > 0
    ? ({ standard: 'Standard Rate Sales', zero: 'Zero Rated Sales', export: 'Zero Rated Sales (Exports)', exempt: 'Exempt Sales' } as Record<string, string>)[code] ?? 'Standard Rate Sales'
    : registered
      ? 'Zero Rated Sales'
      : 'No VAT';
const purchaseTaxType = (vatCents: number, registered: boolean, code = 'standard') =>
  !registered
    ? 'No VAT'
    : vatCents !== 0
      ? 'Standard Rate Purchases'
      : (({ zero: 'Zero Rated Purchases', exempt: 'Exempt Purchases', not_claimable: 'No VAT (not claimable)' } as Record<string, string>)[code] ?? 'No VAT (or zero rated)');

async function invoiceLines(db: Db, s: SettingsRow, q: Query) {
  const rows = await db<{
    number: string;
    kind: string;
    issueDate: string;
    dueDate: string | null;
    client: string | null;
    clientEmail: string | null;
    clientVat: string | null;
    job: string | null;
    sort: number;
    description: string;
    qty: number;
    unit: string;
    unitPriceCents: number;
    lineTotalCents: number;
    vatRateBp: number;
    vatCode: string;
    pricesIncludeVat: boolean;
    code: string | null;
  }[]>`
    select d.number, d.kind, d.issue_date, d.due_date, c.name as client, c.email as client_email, c.vat_number as client_vat, p.name as job,
      l.sort, l.description, l.qty, l.unit, l.unit_price_cents, l.line_total_cents, d.vat_rate_bp, l.vat_code, d.prices_include_vat, a.code
    from documents d join document_lines l on l.document_id = d.id
    left join clients c on c.id = d.client_id left join projects p on p.id = d.project_id
    left join accounts a on a.system_key = 'revenue_' || l.category
    where d.kind in ('invoice', 'credit_note', 'sale') and d.status = 'issued' and d.issue_date between ${q.from}::date and ${q.to}::date
    order by d.issue_date, d.number, l.sort`;
  const lineNo = new Map<string, number>();
  return rows.map((r) => {
    const sign = r.kind === 'credit_note' ? -1 : 1;
    const n = (lineNo.get(r.number) ?? 0) + 1;
    lineNo.set(r.number, n);
    const total = sign * Number(r.lineTotalCents);
    return {
      number: r.number,
      kind: r.kind === 'credit_note' ? 'Credit note' : r.kind === 'sale' ? 'Sale' : 'Invoice',
      date: r.issueDate,
      dueDate: r.dueDate ?? r.issueDate,
      client: r.client ?? '',
      clientEmail: r.clientEmail ?? '',
      clientVat: r.clientVat ?? '',
      job: r.job ?? '',
      line: n,
      description: r.description,
      quantity: sign * Number(r.qty),
      unit: r.unit,
      // Excluding VAT throughout (a price typed including VAT is taken from the line's total).
      unitPrice: r.pricesIncludeVat && Number(r.qty) ? Math.round(Number(r.lineTotalCents) / Number(r.qty)) : Number(r.unitPriceCents),
      lineTotal: total,
      vatRate: r.vatCode === 'standard' ? r.vatRateBp / 100 : 0,
      vat: r.vatCode === 'standard' ? Math.round((total * r.vatRateBp) / 10000) : 0,
      taxType: salesTaxType(r.vatRateBp, s.vatRegistered, r.vatCode),
      accountCode: r.code ?? '',
    };
  });
}

async function invoices(db: Db, q: Query) {
  const rows = await db<{
    number: string;
    kind: string;
    issueDate: string;
    dueDate: string | null;
    status: string;
    client: string | null;
    clientVat: string | null;
    job: string | null;
    subtotalCents: number;
    vatCents: number;
    totalCents: number;
    writtenOffCents: number;
    paid: number;
    credited: string | null;
  }[]>`
    select d.number, d.kind, d.issue_date, d.due_date, case when d.written_off_on is not null then 'Written off' when d.status = 'void' then 'Void' else 'Issued' end as status,
      c.name as client, c.vat_number as client_vat, p.name as job, d.subtotal_cents, d.vat_cents, d.total_cents, coalesce(d.written_off_cents, 0)::bigint as written_off_cents,
      coalesce((select sum(amount_cents) from receipts r where r.invoice_id = d.id), 0)::bigint as paid, ci.number as credited
    from documents d left join clients c on c.id = d.client_id left join projects p on p.id = d.project_id left join documents ci on ci.id = d.credited_invoice_id
    where d.kind in ('invoice', 'credit_note', 'sale') and d.status = 'issued' and d.issue_date between ${q.from}::date and ${q.to}::date
    order by d.issue_date, d.number`;
  return rows.map((r) => {
    const sign = r.kind === 'credit_note' ? -1 : 1;
    const paid = r.kind === 'credit_note' ? 0 : Number(r.paid);
    const wo = r.kind === 'credit_note' ? 0 : Number(r.writtenOffCents);
    return {
      number: r.number,
      kind: r.kind === 'credit_note' ? 'Credit note' : r.kind === 'sale' ? 'Sale' : 'Invoice',
      date: r.issueDate,
      dueDate: r.dueDate,
      status: r.status,
      client: r.client ?? '',
      clientVat: r.clientVat ?? '',
      job: r.job ?? '',
      subtotal: sign * Number(r.subtotalCents),
      vat: sign * Number(r.vatCents),
      total: sign * Number(r.totalCents),
      paid: r.kind === 'credit_note' ? null : paid,
      writtenOff: r.kind === 'credit_note' ? null : wo,
      balance: r.kind === 'credit_note' ? null : Number(r.totalCents) - paid - wo,
      creditedInvoice: r.credited ?? '',
    };
  });
}

const METHOD = { eft: 'EFT', cash: 'Cash', card: 'Card', other: 'Other' } as Record<string, string>;

async function payments(db: Db, q: Query) {
  // Credit notes settle invoices too, but they aren't money in: they're left out here.
  const rows = await db<{ date: string; number: string; client: string | null; method: string; amountCents: number; reference: string; source: string; code: string }[]>`
    select r.date, d.number, c.name as client, r.method, r.amount_cents, r.reference, s.name as source, a.code
    from receipts r join documents d on d.id = r.invoice_id left join clients c on c.id = d.client_id
    join payment_sources s on s.id = r.source_id join accounts a on a.id = s.account_id
    where r.method <> 'credit' and r.date between ${q.from}::date and ${q.to}::date order by r.date, d.number`;
  return rows.map((r) => ({
    date: r.date,
    invoice: r.number,
    client: r.client ?? '',
    method: METHOD[r.method] ?? r.method,
    amount: Number(r.amountCents),
    reference: r.reference,
    bankAccount: r.source,
    bankAccountCode: r.code,
  }));
}

async function costs(db: Db, s: SettingsRow, q: Query) {
  const rows = await db<{
    date: string;
    supplier: string;
    description: string;
    billNumber: string | null;
    dueDate: string | null;
    category: string;
    code: string;
    accountName: string;
    amountCents: number;
    vatCents: number;
    source: string | null;
    sourceCode: string | null;
    job: string | null;
    receiptId: string | null;
  }[]>`
    select c.date, c.supplier, c.description, c.bill_number, c.due_date, k.name as category, a.code, a.name as account_name, c.amount_cents, c.vat_cents, c.vat_code,
      s.name as source, sa.code as source_code, p.name as job, c.receipt_id
    from costs c join cost_categories k on k.id = c.category_id join accounts a on a.id = k.account_id
    left join payment_sources s on s.id = c.source_id left join accounts sa on sa.id = s.account_id left join projects p on p.id = c.project_id
    where c.date between ${q.from}::date and ${q.to}::date order by c.date, c.created_at`;
  const uncaptured = rows.filter((r) => !r.source).length;
  return {
    rows: rows.map((r) => ({
      date: r.date,
      supplier: r.supplier,
      description: r.description,
      billNumber: r.billNumber ?? '',
      dueDate: r.dueDate ?? r.date,
      category: r.category,
      accountCode: r.code,
      accountName: r.accountName,
      excl: Number(r.amountCents) - Number(r.vatCents),
      vat: Number(r.vatCents),
      amount: Number(r.amountCents),
      taxType: purchaseTaxType(Number(r.vatCents), s.vatRegistered, (r as { vatCode?: string }).vatCode),
      paidFrom: r.source ?? 'Not captured yet',
      paidFromCode: r.sourceCode ?? '',
      job: r.job ?? '',
      hasSlip: r.receiptId ? 'Yes' : 'No',
    })),
    notes: uncaptured ? [`${uncaptured} cost${uncaptured === 1 ? '' : 's'} don’t say yet which account paid ${uncaptured === 1 ? 'it' : 'them'}.`] : [],
  };
}

/** What each client owed at the end date, by age (days past the invoice's due date). */
async function debtors(db: Db, q: Query) {
  const rows = await db<{ client: string | null; phone: string | null; email: string | null; issueDate: string; dueDate: string | null; owing: number }[]>`
    select c.name as client, c.phone, c.email, d.issue_date, d.due_date,
      (d.total_cents
        - coalesce((select sum(amount_cents) from receipts r where r.invoice_id = d.id and r.date <= ${q.to}::date), 0)
        - case when d.written_off_on <= ${q.to}::date then coalesce(d.written_off_cents, 0) else 0 end)::bigint as owing
    from documents d left join clients c on c.id = d.client_id
    where d.kind = 'invoice' and d.status = 'issued' and d.issue_date <= ${q.to}::date`;
  const by = new Map<string, ExportRow & { current: number; days30: number; days60: number; days90: number; total: number; oldestInvoice: string }>();
  const end = Date.parse(q.to);
  for (const r of rows) {
    const owing = Number(r.owing);
    if (owing === 0) continue;
    const key = r.client ?? 'No client';
    const x = by.get(key) ?? { client: key, phone: r.phone ?? '', email: r.email ?? '', current: 0, days30: 0, days60: 0, days90: 0, total: 0, oldestInvoice: r.issueDate };
    const late = Math.floor((end - Date.parse(r.dueDate ?? r.issueDate)) / 86_400_000);
    const bucket = late <= 30 ? 'current' : late <= 60 ? 'days30' : late <= 90 ? 'days60' : 'days90';
    x[bucket] += owing;
    x.total += owing;
    if (r.issueDate < x.oldestInvoice) x.oldestInvoice = r.issueDate;
    by.set(key, x);
  }
  return [...by.values()].sort((a, b) => b.total - a.total);
}

export function registerAccountantExportRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;
  const readers = { preHandler: requireRole('owner', 'accountant') };

  /**
   * ?dataset=journal&from=…&to=…&options={json}: the CSV file; with &preview=1, the first rows
   * as they'll appear, the row count and the figure to check after importing.
   */
  app.get('/api/accountant-export', readers, async (req, reply) => {
    const raw = req.query as Record<string, string | undefined>;
    const dataset = z.enum(EXPORT_DATASET_KEYS as [ExportDataset, ...ExportDataset[]]).parse(raw.dataset ?? 'journal');
    let options: ExportOptions;
    try {
      options = exportOptionsSchema.parse(raw.options ? JSON.parse(raw.options) : { columns: EXPORT_DATASETS[dataset].columns.map((c) => ({ key: c.key, header: c.label })) });
    } catch {
      throw badRequest('Those export settings don’t look right');
    }
    const settings = await getSettings(sql);
    // Up to a day given (today by default), from the start of that day's financial year unless said.
    const to = isIsoDate(raw.to) ? raw.to! : today();
    const from = isIsoDate(raw.from) ? raw.from! : financialYear(to, settings.fyEndMonth).start;
    if (from > to) throw badRequest('The start date is after the end date');
    const { rows, notes } = await buildExport(sql, dataset, { from, to, groupBy: options.groupBy });
    const { headers, cells } = formatExportRows(dataset, rows, options);
    if (raw.preview === '1') return { headers, cells: cells.slice(0, 30), rowCount: rows.length, total: exportTotalOf(dataset, rows), notes };
    const name = `${EXPORT_DATASETS[dataset].label.replace(/[^\w ]+/g, '').replace(/\s+/g, ' ').trim()} ${from} to ${to}.csv`;
    reply.header('content-type', options.delimiter === '\t' ? 'text/tab-separated-values; charset=utf-8' : 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${name}"`);
    return reply.send(toDelimited(headers, cells, options));
  });
}
