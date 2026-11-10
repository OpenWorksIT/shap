import type { App as FastifyInstance } from '../http.js';
import { addDays, documentInput, documentTotals, featureOn, quoteStatusInput, receiptInput, vatRateOn, writeOffInput, type DocKind } from '@shap/shared';
import { z } from 'zod';
import { requireRole, userOrThrow, type AuthUser } from '../auth.js';
import type { Ctx } from '../context.js';
import { pgCode, PG, type Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { assertOpen, formatNumber, getSettings, q, today } from '../lib/books.js';
import { badRequest, conflict, notFound, HttpError } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { renderDocumentPdf, type BrandRow, type PdfDocument } from './pdf.js';
import { milli, reverseDocumentStock, stockOutForDocument } from '../lib/stock.js';

export async function loadBrand(db: Db, id: string | null | undefined): Promise<BrandRow | null> {
  if (!id) return null;
  const [b] = await db<BrandRow[]>`select * from brands where id = ${id}`;
  return b ?? null;
}

const idParam = z.object({ id: z.string().uuid() });
type DocInput = z.input<typeof documentInput>;

/** Paid state of an invoice, worked out from its payments, due date and any write-off. */
export const paymentStateSql = `
  case when d.kind <> 'invoice' or d.status <> 'issued' then null
       when d.written_off_on is not null then 'written_off'
       when coalesce(r.paid, 0) >= d.total_cents and d.total_cents > 0 then 'paid'
       when coalesce(r.paid, 0) > 0 then 'part_paid'
       when d.due_date is not null and d.due_date < current_date then 'overdue'
       else 'unpaid' end`;

/** The deposit asked for, in cents: a percentage of the total or a fixed amount, never more than the total. */
export const depositDueSql = `least(d.total_cents, coalesce(round(d.total_cents * d.deposit_bp / 10000.0), d.deposit_cents, 0))::bigint`;

/**
 * A job follows its invoices: once it's fully invoiced (at least its accepted quotes) it's
 * "invoiced", and once those invoices are settled (paid, or written off as delinquent) it's
 * "done". Leads, quotes and cancelled jobs are left alone, as are jobs still being invoiced.
 */
export async function syncProjectStatus(db: Db, projectId: string | null | undefined): Promise<void> {
  if (!projectId) return;
  const [r] = await db<{ status: string; invoiced: number | null; settled: boolean | null; quoted: number | null }[]>`
    select p.status,
      (select sum(d.total_cents) from documents d where d.project_id = p.id and d.kind = 'invoice' and d.status = 'issued')::bigint as invoiced,
      (select bool_and(d.written_off_on is not null or coalesce((select sum(x.amount_cents) from receipts x where x.invoice_id = d.id), 0) >= d.total_cents)
         from documents d where d.project_id = p.id and d.kind = 'invoice' and d.status = 'issued') as settled,
      (select sum(q.total_cents) from documents q where q.project_id = p.id and q.kind = 'quote' and q.status = 'accepted')::bigint as quoted
    from projects p where p.id = ${projectId}`;
  if (!r || !['active', 'invoiced', 'done'].includes(r.status) || r.invoiced == null) return;
  const full = r.invoiced >= (r.quoted ?? 0);
  const next = full ? (r.settled ? 'done' : 'invoiced') : 'active';
  if (next !== r.status) await db`update projects set status = ${next} where id = ${projectId}`;
}

/** The same, for the job an invoice belongs to. */
export async function syncProjectOfDocument(db: Db, documentId: string): Promise<void> {
  const [d] = await db<{ projectId: string | null }[]>`select project_id from documents where id = ${documentId}`;
  await syncProjectStatus(db, d?.projectId);
}

export async function nextNumber(db: Db, kind: DocKind, proforma = false): Promise<string> {
  // Lock the settings row so two people can't take the same number.
  const series = kind === 'invoice' ? 'invoice' : kind === 'credit_note' ? 'credit' : kind === 'sale' ? 'sale' : proforma ? 'proforma' : 'quote';
  const [s] = await db<{ prefix: string; next: number; pad: number }[]>`
    select ${db.unsafe(`${series}_prefix`)} as prefix, ${db.unsafe(`${series}_next`)} as next,
           ${db.unsafe(series === 'proforma' ? 'quote_pad' : `${series}_pad`)} as pad
    from settings where id for update`;
  let n = s!.next;
  let number = formatNumber(s!.prefix, n, s!.pad);
  // Skip numbers already used (e.g. typed by hand or imported).
  for (let i = 0; i < 1000; i++) {
    const [taken] = kind === 'sale' ? await db`select 1 from documents where sale_number = ${number}` : await db`select 1 from documents where kind = ${kind} and number = ${number}`;
    if (!taken) break;
    n++;
    number = formatNumber(s!.prefix, n, s!.pad);
  }
  await db`update settings set ${db.unsafe(`${series}_next`)} = ${n + 1} where id`;
  return number;
}

async function writeLines(db: Db, documentId: string, lines: NonNullable<DocInput['lines']>, vatRateBp: number, pricesIncludeVat = false) {
  await db`delete from document_lines where document_id = ${documentId}`;
  // Each line keeps its price as typed; its total is excluding VAT, which is what the books post.
  const t = documentTotals(lines.map((l) => ({ qty: l.qty ?? 1, unitPriceCents: l.unitPriceCents, vatCode: l.vatCode })), vatRateBp, pricesIncludeVat);
  let sort = 0;
  for (const [i, l] of lines.entries()) {
    await db`
      insert into document_lines (document_id, sort, category, description, qty, unit, unit_price_cents, line_total_cents, vat_code, item_id)
      values (${documentId}, ${sort++}, ${l.category ?? 'labour'}, ${l.description}, ${l.qty ?? 1}, ${l.unit ?? ''}, ${l.unitPriceCents}, ${t.lines[i]!.netCents}, ${l.vatCode ?? 'standard'}, ${l.itemId ?? null})`;
  }
  await db`update documents set subtotal_cents = ${t.subtotalCents}, vat_cents = ${t.vatCents}, total_cents = ${t.totalCents}, prices_include_vat = ${pricesIncludeVat}, updated_at = now() where id = ${documentId}`;
}

/** Whether a document moved stock (its lines are then fixed). */
async function movedStock(db: Db, id: string): Promise<boolean> {
  const [m] = await db`select 1 from stock_moves where document_id = ${id} limit 1`;
  return Boolean(m);
}

/** The lines as typed are the lines it has: nothing it charges or moves would change. */
async function linesUnchanged(db: Db, id: string, lines: NonNullable<DocInput['lines']>): Promise<boolean> {
  const have = await db<{ category: string; description: string; qty: string; unit: string; unitPriceCents: string; vatCode: string; itemId: string | null }[]>`
    select category, description, qty, unit, unit_price_cents, vat_code, item_id from document_lines where document_id = ${id} order by sort`;
  if (have.length !== lines.length) return false;
  return have.every((h, i) => {
    const l = lines[i]!;
    return h.description === l.description && milli(h.qty) === milli(l.qty ?? 1) && Number(h.unitPriceCents) === l.unitPriceCents && h.vatCode === (l.vatCode ?? 'standard') && (h.itemId ?? null) === (l.itemId ?? null) && h.unit === (l.unit ?? '');
  });
}

/** The trading name a document goes out under: the job's, else the client's, else the company default. */
export async function defaultBrand(db: Db, projectId: string | null, clientId: string | null): Promise<string | null> {
  const [r] = await db<{ id: string | null }[]>`
    select coalesce(
      (select brand_id from projects where id = ${projectId}),
      (select brand_id from clients where id = ${clientId}),
      (select default_brand_id from settings where id)) as id`;
  return r?.id ?? null;
}

/** Creates a quote or invoice with its lines. Call inside a transaction (numbering locks the settings row). */
export async function createDocument(tx: Db, user: AuthUser | null, kind: DocKind, raw: DocInput, opts: { status?: string } = {}): Promise<{ id: string; number: string }> {
  const input = parse(documentInput, raw);
  const settings = await getSettings(tx);
  let clientId = input.clientId ?? null;
  if (!clientId && input.projectId) {
    const [p] = await tx<{ clientId: string | null }[]>`select client_id from projects where id = ${input.projectId}`;
    clientId = p?.clientId ?? null;
  }
  const brandId = input.brandId ?? (await defaultBrand(tx, input.projectId ?? null, clientId));
  const proforma = kind === 'quote' && input.proforma;
  const number = input.number?.trim() || (await nextNumber(tx, kind, proforma));
  const due =
    kind === 'credit_note' || kind === 'sale' ? null : (input.dueDate ?? (kind === 'invoice' || proforma ? addDays(input.issueDate, settings.paymentDays) : addDays(input.issueDate, settings.quoteValidDays)));
  // The standard rate on the document's own date (vat.ts), for a VAT vendor.
  let vatRate = settings.vatRegistered ? vatRateOn(input.issueDate) : 0;
  let inclusive = input.pricesIncludeVat ?? false;
  if (kind === 'credit_note') {
    const [inv] = await tx<{ kind: string; status: string; clientId: string | null; vatRateBp: number; pricesIncludeVat: boolean }[]>`
      select kind, status, client_id, vat_rate_bp, prices_include_vat from documents where id = ${input.creditedInvoiceId ?? null}`;
    if (!inv || !(inv.kind === 'invoice' || inv.kind === 'sale') || inv.status !== 'issued') throw badRequest('A credit note is made from an issued invoice or sale');
    clientId = inv.clientId;
    // The VAT goes back at the rate the invoice charged, priced the way it was.
    vatRate = inv.vatRateBp;
    inclusive = inv.pricesIncludeVat;
  }
  let row: { id: string; number: string } | undefined;
  try {
    [row] = await tx<{ id: string; number: string }[]>`
      insert into documents (kind, number, status, project_id, client_id, issue_date, due_date, title, notes, terms, vat_rate_bp, created_by, brand_id,
                             deposit_bp, deposit_cents, deposit_show_balance, pay_link, proforma, credited_invoice_id, credit_reason, issued_at)
      values (${kind}, ${number}, ${opts.status ?? 'draft'}, ${input.projectId ?? null}, ${clientId}, ${input.issueDate}, ${due},
              ${input.title}, ${input.notes},
              ${kind === 'credit_note' || kind === 'sale' ? input.terms : input.terms || (kind === 'invoice' || proforma ? settings.invoiceTerms : settings.quoteTerms)},
              ${vatRate}, ${user?.id ?? null}, ${brandId}, ${input.depositBp}, ${input.depositCents}, ${input.depositShowBalance}, ${input.payLink ?? ''},
              ${proforma}, ${kind === 'credit_note' ? (input.creditedInvoiceId ?? null) : null}, ${input.creditReason},
              ${opts.status === 'issued' ? new Date() : null})
      returning id, number`;
  } catch (err) {
    if (pgCode(err) === PG.uniqueViolation) throw conflict(`There is already ${kind === 'invoice' ? 'an invoice' : kind === 'credit_note' ? 'a credit note' : kind === 'sale' ? 'a sale' : 'a quote'} numbered ${number}`);
    throw err;
  }
  await writeLines(tx, row!.id, input.lines ?? [], vatRate, inclusive);
  return row!;
}

export async function loadDocument(db: Db, id: string) {
  const [doc] = await db<PdfDocument['doc'][]>`
    select d.*, coalesce(r.paid, 0)::bigint as paid_cents, ${db.unsafe(paymentStateSql)} as payment_state,
      ${db.unsafe(depositDueSql)} as deposit_due_cents,
      p.name as project_name, p.number as project_number, p.site_address,
      c.name as client_name, c.contact_person as client_contact, c.address as client_address, c.email as client_email,
      c.phone as client_phone, c.vat_number as client_vat_number, c.code as client_code,
      sq.number as source_quote_number, b.name as brand_name,
      ci.number as credited_invoice_number, ci.issue_date as credited_invoice_date, ci.total_cents as credited_invoice_total_cents
    from documents d
    left join brands b on b.id = d.brand_id
    left join lateral (select sum(amount_cents) as paid from receipts where invoice_id = d.id) r on true
    left join projects p on p.id = d.project_id left join clients c on c.id = d.client_id
    left join documents sq on sq.id = d.source_quote_id
    left join documents ci on ci.id = d.credited_invoice_id
    where d.id = ${id}`;
  if (!doc) throw notFound('Document');
  const lines = await db<PdfDocument['lines']>`select * from document_lines where document_id = ${id} order by sort`;
  const receipts = await db`
    select r.*, s.name as source_name from receipts r join payment_sources s on s.id = r.source_id
    where r.invoice_id = ${id} order by r.date, r.created_at`;
  const creditNotes = await db`
    select id, number, status, issue_date, total_cents, credit_reason from documents where credited_invoice_id = ${id} order by issue_date, created_at`;
  return { doc, lines, receipts, creditNotes };
}

/** A quote or invoice as its PDF, under its trading name, with the file name clients see. */
export async function documentPdf(db: Db, id: string) {
  const data = await loadDocument(db, id);
  const settings = await getSettings(db);
  // One name on the door (trading names switched off): the business's own details and logo.
  const brand = featureOn(settings.features, 'brands') ? await loadBrand(db, data.doc.brandId ?? settings.defaultBrandId) : null;
  let logo: Buffer | null = null;
  const logoId = brand?.logoId ?? settings.logoId;
  if (logoId) {
    const [a] = await db<{ bytes: Buffer }[]>`select bytes from attachments where id = ${logoId}`;
    logo = a?.bytes ?? null;
  }
  const pdf = await renderDocumentPdf({ ...data, settings, brand, logo });
  const label =
    data.doc.kind === 'invoice' ? (settings.vatRegistered ? 'Tax invoice' : 'Invoice') : data.doc.kind === 'credit_note' ? 'Credit note' : data.doc.kind === 'sale' ? 'Sale' : data.doc.proforma ? 'Pro-forma invoice' : 'Quote';
  const filename = `${brand ? `${brand.name} ` : ''}${label} ${data.doc.number}${data.doc.clientName ? ` - ${data.doc.clientName}` : ''}.pdf`.replace(/[^\w.\- ]/g, '');
  return { pdf, filename, data, settings, brand };
}

/** Shared from the phone (WhatsApp, email…): a draft quote counts as sent; either way, when. */
export async function markShared(db: Db, id: string): Promise<string | null> {
  const [d] = await db<{ kind: string; status: string }[]>`select kind, status from documents where id = ${id}`;
  if (!d) return null;
  if (d.kind === 'quote' && d.status === 'draft') await db`update documents set status = 'sent', sent_at = now() where id = ${id}`;
  else await db`update documents set sent_at = coalesce(sent_at, now()) where id = ${id}`;
  return d.kind;
}

/** A full tax invoice (over R5 000) names the recipient and their address: VAT Act s20(4)(c). */
export { FULL_TAX_INVOICE_CENTS } from '@shap/shared';
import { FULL_TAX_INVOICE_CENTS } from '@shap/shared';

/**
 * What a tax invoice or credit note must carry before it's issued (VAT Act s20(4) and (5),
 * s21(3)): https://www.acts.co.za/value-added-tax-act-1991/20__tax_invoices
 * - Every tax invoice and credit note: the business's name, address and VAT number.
 * - A full tax invoice: the client's name and address too (and their VAT number if they're
 *   registered). It's needed over R5 000, and always when anything on it is zero-rated or
 *   exported: the short (abridged) form can't be used for zero-rated supplies (s20(5) proviso).
 * - A credit note: the reason and the invoice it credits, and the client's details whenever
 *   the invoice it credits needed them (s21(3)(c)).
 */
export async function assertTaxDocument(db: Db, id: string): Promise<void> {
  const [d] = await db<{ kind: string; vatRateBp: number; totalCents: number; creditReason: string; creditedInvoiceId: string | null; clientName: string | null; clientAddress: string | null; brandAddress: string | null }[]>`
    select d.kind, d.vat_rate_bp, d.total_cents, d.credit_reason, d.credited_invoice_id, c.name as client_name, c.address as client_address, b.address as brand_address
    from documents d left join clients c on c.id = d.client_id left join brands b on b.id = d.brand_id where d.id = ${id}`;
  if (!d) return;
  const s = await getSettings(db);
  if (d.kind === 'credit_note') {
    if (!d.creditedInvoiceId) throw badRequest('A credit note says which invoice it credits');
    if (!String(d.creditReason ?? '').trim()) throw badRequest('Say briefly why the credit note is issued (SARS requires the reason on it)');
  }
  if (!(d.kind === 'invoice' || d.kind === 'credit_note' || d.kind === 'sale') || !(Number(d.vatRateBp) > 0)) return;
  const what = d.kind === 'credit_note' ? 'credit note' : 'tax invoice';
  // A discount takes off what it discounts, in the same VAT class: never more, or the VAT201 would
  // show negative supplies (or VAT) of a kind that wasn't sold.
  const [inc] = await db<{ pricesIncludeVat: boolean }[]>`select prices_include_vat from documents where id = ${id}`;
  const ls = await db<{ qty: string; unitPriceCents: string; vatCode: string }[]>`select qty, unit_price_cents, vat_code from document_lines where document_id = ${id}`;
  const sums = documentTotals(ls.map((l) => ({ qty: Number(l.qty), unitPriceCents: Number(l.unitPriceCents), vatCode: l.vatCode as never })), Number(d.vatRateBp), Boolean(inc?.pricesIncludeVat));
  if (sums.vatCents < 0 || Object.values(sums.byCode).some((v) => v < 0)) {
    throw badRequest(`A discount here is more than what it discounts in its VAT class: put it in the same VAT class as the goods it’s on (a ${what} can’t show less than nothing of a kind of supply)`);
  }
  if (!s.vatNumber.trim()) throw badRequest(`A ${what} must show your VAT number. Add it in Settings → Company first.`);
  if (!(d.brandAddress?.trim() || s.address.trim())) throw badRequest(`A ${what} must show your business address. Add it in Settings → Company first.`);
  // A walk-in's slip is the short form (makeSale asks for the customer when it can't be).
  if (d.kind === 'sale') return;
  // Whether the full form is needed: for a credit note, whether the invoice it credits needed it.
  const basis = d.kind === 'credit_note' ? d.creditedInvoiceId! : id;
  const [f] = await db<{ kind: string; totalCents: number; zeroRated: boolean }[]>`
    select d.kind, d.total_cents, exists (select 1 from document_lines l where l.document_id = d.id and l.vat_code in ('zero', 'export')) as zero_rated
    from documents d where d.id = ${basis}`;
  // Money back on a walk-in's sale: its credit note is short like the slip was (a sale that
  // needed the full form was made an invoice, with the customer on it).
  if (f?.kind === 'sale') return;
  const full = Math.abs(Number(f?.totalCents ?? d.totalCents)) > FULL_TAX_INVOICE_CENTS || Boolean(f?.zeroRated);
  if (full && (!d.clientName?.trim() || !d.clientAddress?.trim())) {
    const why = Math.abs(Number(f?.totalCents ?? d.totalCents)) > FULL_TAX_INVOICE_CENTS ? 'over R5 000' : 'with zero-rated or exported items';
    throw badRequest(
      d.kind === 'invoice'
        ? `A tax invoice ${why} must show the client’s name and address (and their VAT number if they’re registered). Add them to the client first.`
        : `This credit note must show the client’s name and address, as the invoice it credits did (a tax invoice ${why}). Add them to the client first.`,
    );
  }
}

/**
 * An issued tax invoice (one that charged VAT) is fixed: what it charges, to whom, when, under
 * which number and trading name. The VAT Act allows one tax invoice per supply (s20(1)), and a
 * correction is a credit note (s21), with a new invoice for anything extra. Its notes, terms,
 * due date, deposit, payment link, job and the kind of each item (for the books) can still
 * change. An invoice without VAT (from a business that isn't a VAT vendor) stays open to change.
 */
async function assertTaxInvoiceUnchanged(db: Db, id: string, input: DocInput): Promise<void> {
  const [d] = await db<{ number: string; issueDate: string; clientId: string | null; brandId: string | null; projectId: string | null; pricesIncludeVat: boolean }[]>`
    select number, issue_date::text, client_id, brand_id, project_id, prices_include_vat from documents where id = ${id}`;
  if (!d) return;
  const lines = await db<{ description: string; qty: number; unit: string; unitPriceCents: number; vatCode: string }[]>`
    select description, qty, unit, unit_price_cents, vat_code from document_lines where document_id = ${id} order by sort`;
  let clientId = input.clientId ?? null;
  if (!clientId && input.projectId) clientId = (await db<{ clientId: string | null }[]>`select client_id from projects where id = ${input.projectId}`)[0]?.clientId ?? null;
  const brandId = input.brandId ?? (await defaultBrand(db, input.projectId ?? null, clientId));
  const next = input.lines ?? [];
  const sameLines =
    next.length === lines.length &&
    next.every((l, i) => {
      const o = lines[i]!;
      return l.description === o.description && Number(l.qty ?? 1) === Number(o.qty) && String(l.unit ?? '') === String(o.unit ?? '') && Number(l.unitPriceCents) === Number(o.unitPriceCents) && (l.vatCode ?? 'standard') === o.vatCode;
    });
  const changed = [
    !sameLines && 'its items and prices',
    input.pricesIncludeVat !== undefined && input.pricesIncludeVat !== Boolean(d.pricesIncludeVat) && 'whether prices include VAT',
    clientId !== d.clientId && 'the client',
    input.issueDate !== d.issueDate && 'the date',
    Boolean(input.number?.trim()) && input.number!.trim() !== d.number && 'the number',
    brandId !== d.brandId && 'the trading name',
  ].filter(Boolean) as string[];
  if (changed.length)
    throw new HttpError(
      400,
      `This tax invoice is issued, so ${changed.join(', ').replace(/, ([^,]*)$/, ' and $1')} can’t change (SARS allows one tax invoice per supply). To correct it, issue a credit note, and a new invoice for anything extra.`,
      'tax_invoice_issued',
    );
}

/**
 * A draft invoice charges VAT as the business stands when it's issued: one drafted before
 * registering for VAT gets VAT once registered (and the other way round), at the rate on its date.
 */
export async function refreshDraftVat(db: Db, id: string): Promise<void> {
  const [d] = await db<{ kind: string; status: string; issueDate: string; vatRateBp: number; pricesIncludeVat: boolean }[]>`
    select kind, status, issue_date::text, vat_rate_bp, prices_include_vat from documents where id = ${id}`;
  if (!d || d.kind !== 'invoice' || d.status !== 'draft') return;
  const s = await getSettings(db);
  const rate = s.vatRegistered ? vatRateOn(d.issueDate) : 0;
  if (rate === Number(d.vatRateBp)) return;
  const lines = await db<{ category: string; description: string; qty: number; unit: string; unitPriceCents: number; vatCode: 'standard' | 'zero' | 'export' | 'exempt' }[]>`
    select category, description, qty, unit, unit_price_cents, vat_code from document_lines where document_id = ${id} order by sort`;
  await db`update documents set vat_rate_bp = ${rate} where id = ${id}`;
  await writeLines(db, id, lines.map((l) => ({ ...l, qty: Number(l.qty), unitPriceCents: Number(l.unitPriceCents) })) as NonNullable<DocInput['lines']>, rate, d.pricesIncludeVat);
}

export function registerDocumentRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;

  // The things this business usually charges for, with what it charged last time: offered when
  // adding a line, so a regular "Cut and blow-dry" is one tap with the right price.
  app.get('/api/documents/usual-lines', { preHandler: requireRole('owner') }, async () => {
    return sql`
      select distinct on (lower(l.description)) l.description, l.category, l.unit, l.unit_price_cents,
             count(*) over (partition by lower(l.description))::int as uses, d.issue_date
        from document_lines l join documents d on d.id = l.document_id
       where d.status <> 'void' and length(l.description) between 2 and 80
         -- Not lines made from one job's costs ("Labour – Smith roof"): they're never usual.
         and l.description !~ '^(Labour|Materials|Demo|Demolition|Other|Work / time|Parts / materials) – '
         and d.issue_date > current_date - 540
       order by lower(l.description), d.issue_date desc, d.created_at desc`.then(async (rows) => {
      const used = (rows as unknown as { description: string; uses: number; issueDate: string }[]).sort((a, b) => b.uses - a.uses || b.issueDate.localeCompare(a.issueDate)).slice(0, 40);
      // Then the items list brought in from another package, for what hasn't been charged yet.
      const seen = new Set(used.map((u) => u.description.toLowerCase()));
      const items = await sql<{ description: string; category: string; unit: string; unitPriceCents: number }[]>`
        select description, category, unit, unit_price_cents from items where active order by description limit 200`;
      return [...used, ...items.filter((i) => !seen.has(i.description.toLowerCase())).map((i) => ({ ...i, uses: 0, issueDate: '' }))].slice(0, 120);
    });
  });

  app.get('/api/documents', { preHandler: requireRole('owner', 'accountant') }, async (req) => {
    const { kind, status, client, project, search, state } = q(req);
    const s = search?.trim() || null;
    const rows = await sql.unsafe(
      `select d.id, d.kind, d.number, d.status, d.issue_date, d.due_date, d.title, d.subtotal_cents, d.vat_cents, d.total_cents, d.written_off_cents,
         d.project_id, d.client_id, d.brand_id, b.name as brand_name, p.name as project_name, p.number as project_number, c.name as client_name,
         coalesce(r.paid, 0)::bigint as paid_cents, ${paymentStateSql} as payment_state, d.proforma, d.reminded_at, d.reminders,
         d.credited_invoice_id
       from documents d
       left join lateral (select sum(amount_cents) as paid from receipts where invoice_id = d.id) r on true
       left join projects p on p.id = d.project_id left join clients c on c.id = d.client_id
       left join brands b on b.id = d.brand_id
       where (($1::text is null and d.kind <> 'sale') or d.kind = $1) and ($2::text is null or d.status = $2)
         and ($3::uuid is null or d.client_id = $3::uuid) and ($4::uuid is null or d.project_id = $4::uuid)
         and ($5::text is null or d.number ilike '%' || $5 || '%' or d.title ilike '%' || $5 || '%'
              or c.name ilike '%' || $5 || '%' or p.name ilike '%' || $5 || '%')
       order by d.issue_date desc, d.created_at desc limit 1000`,
      [(kind ?? null) as never, (status ?? null) as never, (client ?? null) as never, (project ?? null) as never, s as never],
    );
    return state ? rows.filter((r) => (state === 'owing' ? ['unpaid', 'part_paid', 'overdue'].includes(r.paymentState as string) : r.paymentState === state)) : rows;
  });

  app.get('/api/documents/:id', { preHandler: requireRole('owner', 'accountant') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return loadDocument(sql, id);
  });

  app.post('/api/documents', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { kind, ...rest } = parse(z.object({ kind: z.enum(['quote', 'invoice', 'credit_note']) }).passthrough(), req.body);
    const input = parse(documentInput, rest);
    if (kind !== 'quote') await assertOpen(sql, input.issueDate);
    const doc = await sql.begin((tx) => createDocument(tx, user, kind, input));
    await audit(sql, { userId: user.id, action: 'create', entity: kind, entityId: doc.id, ip: req.ip, details: { number: doc.number } });
    return doc;
  });

  /** Change a quote or invoice at any time, even after it was sent. Voided invoices stay as they were. */
  app.put('/api/documents/:id', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const input = parse(documentInput, req.body);
    const [old] = await sql<{ kind: DocKind; status: string; issueDate: string; number: string; vatRateBp: number; updatedAt: Date | string }[]>`select * from documents where id = ${id}`;
    if (!old) throw notFound('Document');
    // Someone else saved it after this screen opened it: don't overwrite their change.
    if (input.expectUpdatedAt && Math.abs(new Date(old.updatedAt).getTime() - new Date(input.expectUpdatedAt).getTime()) > 1) {
      throw new HttpError(409, 'Someone else changed this while you had it open. Reload to see their changes, then make yours again.', 'stale_record');
    }
    if (old.status === 'void') throw badRequest('This invoice was voided. Duplicate it to make a new one.');
    if (old.kind === 'sale') throw badRequest('A sale can’t be changed. Refund what needs to come back, or make it an invoice to add the customer.');
    if (old.kind === 'credit_note' && old.status !== 'draft') throw badRequest('An issued credit note can’t be changed. Void it and make a new one.');
    if (old.kind === 'invoice' && old.status === 'issued') await assertOpen(sql, old.issueDate, input.issueDate);
    const settings = await getSettings(sql);
    const vatRate = old.status === 'draft' && old.kind !== 'credit_note' ? (settings.vatRegistered ? vatRateOn(input.issueDate) : 0) : old.vatRateBp;
    // A credit note is priced the way its invoice was. Left out, how prices were typed stays as it was.
    const was = Boolean((old as { pricesIncludeVat?: boolean }).pricesIncludeVat);
    if (old.kind === 'invoice' && old.status === 'issued' && Number(old.vatRateBp) > 0) await assertTaxInvoiceUnchanged(sql, id, input);
    // A sale made an invoice was paid when it was made, and goods taken back stand against an
    // invoice's lines: either way, what it charges (and for a sale, its date and customer) stays.
    if (old.kind === 'invoice' && old.status === 'issued') {
      const o = old as unknown as { saleNumber: string | null; clientId: string | null };
      if (o.saleNumber && (!(await linesUnchanged(sql, id, input.lines ?? [])) || input.issueDate !== String(old.issueDate) || (input.clientId ?? o.clientId) !== o.clientId)) {
        throw badRequest('This invoice was a sale, paid when it was made: what it charges, its date and its customer stay as they are. Take anything back with Goods returned.');
      }
      const [returned] = await sql`select 1 from document_lines cl join document_lines l on l.id = cl.credited_line_id join documents c on c.id = cl.document_id
        where l.document_id = ${id} and c.status <> 'void' limit 1`;
      if (returned && !(await linesUnchanged(sql, id, input.lines ?? []))) throw badRequest('Goods came back against this invoice, so what it charges can’t change. Credit it and make a new invoice.');
    }
    const inclusive =
      old.kind === 'credit_note'
        ? Boolean((await sql<{ inc: boolean }[]>`select i.prices_include_vat as inc from documents d join documents i on i.id = d.credited_invoice_id where d.id = ${id}`)[0]?.inc)
        : old.status === 'draft'
          ? (input.pricesIncludeVat ?? was)
          : was;
    const number = input.number?.trim() || old.number;
    await sql.begin(async (tx) => {
      let clientId = input.clientId ?? null;
      if (!clientId && input.projectId) {
        const [p] = await tx<{ clientId: string | null }[]>`select client_id from projects where id = ${input.projectId}`;
        clientId = p?.clientId ?? null;
      }
      // A credit note is always to the client of the invoice it credits.
      if (old.kind === 'credit_note') {
        const [inv] = await tx<{ clientId: string | null }[]>`select i.client_id from documents d join documents i on i.id = d.credited_invoice_id where d.id = ${id}`;
        clientId = inv?.clientId ?? clientId;
      }
      try {
        await tx`
          update documents set number = ${number}, project_id = ${input.projectId ?? null}, client_id = ${clientId},
            issue_date = ${input.issueDate}, due_date = ${input.dueDate ?? null}, title = ${input.title}, notes = ${input.notes},
            terms = ${input.terms}, vat_rate_bp = ${vatRate}, updated_at = now(),
            credit_reason = case when kind = 'credit_note' then ${input.creditReason} else credit_reason end,
            deposit_bp = ${input.depositBp}, deposit_cents = ${input.depositCents}, deposit_show_balance = ${input.depositShowBalance}, pay_link = ${input.payLink ?? ''},
            brand_id = ${input.brandId ?? (await defaultBrand(tx, input.projectId ?? null, clientId))}
          where id = ${id}`;
      } catch (err) {
        if (pgCode(err) === PG.uniqueViolation) throw conflict(`Number ${number} is already used`);
        throw err;
      }
      // An issued invoice that moved stock keeps its lines as they are (the stock went out on them):
      // a change to what it charged is a credit note, or voiding it.
      if (await movedStock(tx, id)) {
        if (!(await linesUnchanged(tx, id, input.lines))) throw badRequest('This invoice moved stock out, so what it charges can’t change. Credit it (or void it) and make a new one.');
      } else await writeLines(tx, id, input.lines, vatRate, inclusive);
      // A written-off invoice that changes: what's written off is still whatever wasn't paid.
      await tx`update documents d set written_off_cents = greatest(d.total_cents - coalesce((select sum(amount_cents) from receipts where invoice_id = d.id), 0), 0)
        where d.id = ${id} and d.written_off_on is not null`;
      await audit(tx, { userId: user.id, action: 'update', entity: old.kind, entityId: id, ip: req.ip, details: { number, status: old.status } });
    });
    await syncProjectStatus(sql, (old as { projectId?: string | null }).projectId);
    await syncProjectStatus(sql, input.projectId);
    return loadDocument(sql, id);
  });

  app.post('/api/documents/:id/issue', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const [doc] = await sql<{ kind: string; status: string; issueDate: string; totalCents: number; number: string; creditedInvoiceId: string | null }[]>`select * from documents where id = ${id}`;
    if (!doc || (doc.kind !== 'invoice' && doc.kind !== 'credit_note')) throw notFound('Invoice');
    const what = doc.kind === 'credit_note' ? 'credit note' : 'invoice';
    if (doc.status !== 'draft') throw badRequest(`This ${what} has already been issued`);
    await assertOpen(sql, doc.issueDate);
    const [lines] = await sql<{ n: number }[]>`select count(*) as n from document_lines where document_id = ${id}`;
    if (!lines!.n) throw badRequest('Add at least one item first');
    await refreshDraftVat(sql, id);
    await assertTaxDocument(sql, id);
    if (doc.kind === 'credit_note') {
      // It settles that much of the invoice: never more than what's still owed on it.
      const [inv] = await sql<{ status: string; totalCents: number; paid: number; writtenOffCents: number }[]>`
        select d.status, d.total_cents, d.written_off_cents, coalesce((select sum(amount_cents) from receipts where invoice_id = d.id), 0)::bigint as paid
        from documents d where d.id = ${doc.creditedInvoiceId}`;
      if (!inv || inv.status !== 'issued') throw badRequest('The invoice this credits isn’t issued');
      const owing = Number(inv.totalCents) - Number(inv.paid) - Number(inv.writtenOffCents);
      if (Number(doc.totalCents) <= 0) throw badRequest('A credit note needs an amount');
      if (Number(doc.totalCents) > owing)
        throw badRequest(`That's more than is still owed on the invoice (${(owing / 100).toFixed(2)}). If the client already paid, refund them and record it as a cost or journal.`);
      const [src] = await sql<{ id: string }[]>`select id from payment_sources where role = 'credit_notes'`;
      await sql.begin(async (tx) => {
        const [r] = await tx<{ id: string }[]>`
          insert into receipts (invoice_id, date, amount_cents, source_id, method, reference, note, created_by)
          values (${doc.creditedInvoiceId}, ${doc.issueDate}, ${doc.totalCents}, ${src!.id}, 'credit', ${doc.number}, 'Credit note', ${user.id}) returning id`;
        // Issued once, even if asked twice at the same moment (a double tap).
        const [now] = await tx`update documents set status = 'issued', issued_at = now(), credit_receipt_id = ${r!.id}, updated_at = now() where id = ${id} and status = 'draft' returning id`;
        if (!now) throw badRequest('This credit note has already been issued');
      });
      await syncProjectOfDocument(sql, doc.creditedInvoiceId!);
      await audit(sql, { userId: user.id, action: 'issue', entity: 'credit_note', entityId: id, ip: req.ip });
      return loadDocument(sql, id);
    }
    await sql.begin(async (tx) => {
      // Issued once, even if asked twice at the same moment (a double tap): stock goes out once.
      const [now] = await tx`update documents set status = 'issued', issued_at = now(), updated_at = now() where id = ${id} and status = 'draft' returning id`;
      if (!now) throw badRequest('This invoice has already been issued');
      // Stocked items on it go out of stock now, at average cost.
      await stockOutForDocument(tx, id, doc.issueDate, user.id);
    });
    await syncProjectStatus(sql, (doc as { projectId?: string | null }).projectId);
    await audit(sql, { userId: user.id, action: 'issue', entity: 'invoice', entityId: id, ip: req.ip });
    return loadDocument(sql, id);
  });

  app.post('/api/documents/:id/status', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const { status } = parse(quoteStatusInput, req.body);
    const [doc] = await sql<{ kind: string; projectId: string | null }[]>`select kind, project_id from documents where id = ${id}`;
    if (!doc || doc.kind !== 'quote') throw notFound('Quote');
    await sql.begin(async (tx) => {
      await tx`update documents set status = ${status}, sent_at = case when ${status} = 'sent' then coalesce(sent_at, now()) else sent_at end, updated_at = now() where id = ${id}`;
      if (doc.projectId) {
        if (status === 'sent') await tx`update projects set status = 'quoted' where id = ${doc.projectId} and status = 'lead'`;
        if (status === 'accepted') await tx`update projects set status = 'active' where id = ${doc.projectId} and status in ('lead', 'quoted')`;
      }
      await audit(tx, { userId: user.id, action: `quote_${status}`, entity: 'quote', entityId: id, ip: req.ip });
    });
    await syncProjectStatus(sql, doc.projectId);
    return loadDocument(sql, id);
  });

  app.post('/api/documents/:id/void', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(2, 'Give a reason').max(300) }), req.body);
    const [doc] = await sql<{ kind: string; status: string; issueDate: string; writtenOffOn: string | null; creditReceiptId: string | null; creditedInvoiceId: string | null }[]>`select * from documents where id = ${id}`;
    if (doc?.kind === 'sale') throw badRequest('A sale is never voided: refund what came back instead, so the record stays whole.');
    if (!doc || (doc.kind !== 'invoice' && doc.kind !== 'credit_note')) throw notFound('Invoice');
    await assertOpen(sql, doc.issueDate);
    if (doc.kind === 'credit_note') {
      const [refunded] = await sql`select 1 from refunds where credit_note_id = ${id}`;
      if (refunded) throw badRequest('This credit note was refunded in money: it stays. Record a new sale for anything that went out again.');
      await sql.begin(async (tx) => {
        await tx`update documents set status = 'void', void_reason = ${reason}, credit_receipt_id = null, updated_at = now() where id = ${id}`;
        if (doc.creditReceiptId) await tx`delete from receipts where id = ${doc.creditReceiptId}`;
        await reverseDocumentStock(tx, id, doc.issueDate, `Credit note voided: ${reason}`, user.id);
      });
      if (doc.creditedInvoiceId) await syncProjectOfDocument(sql, doc.creditedInvoiceId);
      await audit(sql, { userId: user.id, action: 'void', entity: 'credit_note', entityId: id, ip: req.ip, details: { reason } });
      return loadDocument(sql, id);
    }
    // Credit notes on it are part of what was settled: void those first.
    const [credited] = await sql`select 1 from documents where credited_invoice_id = ${id} and status = 'issued' limit 1`;
    if (credited) throw badRequest('Void the credit notes on this invoice first');
    const [paid] = await sql`select 1 from receipts where invoice_id = ${id} and method <> 'credit' limit 1`;
    if (paid) throw badRequest('Remove the payments on this invoice before voiding it');
    if (doc.writtenOffOn) throw badRequest('Undo the write-off before voiding this invoice');
    await sql.begin(async (tx) => {
      await tx`update documents set status = 'void', void_reason = ${reason}, updated_at = now() where id = ${id}`;
      // What it took out of stock goes back, at what it went out at, on the invoice's own date: a
      // voided invoice never happened, so neither did its cost of sales (its revenue goes the same way).
      await reverseDocumentStock(tx, id, doc.issueDate, `Invoice voided: ${reason}`, user.id);
    });
    await syncProjectOfDocument(sql, id);
    await audit(sql, { userId: user.id, action: 'void', entity: 'invoice', entityId: id, ip: req.ip, details: { reason } });
    return loadDocument(sql, id);
  });

  app.delete('/api/documents/:id', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const [doc] = await sql<{ kind: string; status: string; number: string; issueDate: string; totalCents: number; clientName: string | null; proforma: boolean }[]>`
      select d.kind, d.status, d.number, d.issue_date, d.total_cents, d.proforma, c.name as client_name from documents d left join clients c on c.id = d.client_id where d.id = ${id}`;
    if (!doc) throw notFound('Document');
    if (doc.kind === 'sale') throw badRequest('A sale can’t be deleted. Refund it instead, so the record stays whole.');
    if ((doc.kind === 'invoice' || doc.kind === 'credit_note') && doc.status !== 'draft')
      throw badRequest(`Issued ${doc.kind === 'invoice' ? 'invoices' : 'credit notes'} can’t be deleted. Void it instead, so the number stays accounted for.`);
    await sql.begin(async (tx) => {
      await tx`update documents set source_quote_id = null where source_quote_id = ${id}`;
      await tx`delete from documents where id = ${id}`;
      // What it was stays in the audit log (SARS expects records kept for five years).
      await audit(tx, { userId: user.id, action: 'delete', entity: doc.kind, entityId: id, ip: req.ip, details: { number: doc.number, status: doc.status, issueDate: doc.issueDate, totalCents: Number(doc.totalCents), client: doc.clientName, proforma: doc.proforma } });
    });
    return { ok: true };
  });

  /** Quote → draft invoice with the same lines; the quote is marked accepted. */
  app.post('/api/documents/:id/convert', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const { doc, lines } = await loadDocument(sql, id);
    if (doc.kind !== 'quote') throw badRequest('Only quotes can be turned into invoices');
    const created = await sql.begin(async (tx) => {
      const inv = await createDocument(tx, user, 'invoice', {
        brandId: doc.brandId,
        projectId: doc.projectId,
        clientId: doc.clientId,
        issueDate: today(),
        title: doc.title,
        notes: doc.notes,
        terms: '',
        depositBp: doc.depositBp,
        depositCents: doc.depositCents,
        depositShowBalance: doc.depositShowBalance,
        lines: lines.map((l) => ({ category: l.category, description: l.description, qty: l.qty, unit: l.unit, unitPriceCents: l.unitPriceCents, vatCode: l.vatCode })),
        pricesIncludeVat: doc.pricesIncludeVat,
      });
      await tx`update documents set source_quote_id = ${id} where id = ${inv.id}`;
      await tx`update documents set status = 'accepted', updated_at = now() where id = ${id} and status <> 'accepted'`;
      if (doc.projectId) await tx`update projects set status = 'active' where id = ${doc.projectId} and status in ('lead', 'quoted')`;
      await audit(tx, { userId: user.id, action: 'convert', entity: 'quote', entityId: id, ip: req.ip, details: { invoiceId: inv.id } });
      return inv;
    });
    return created;
  });

  /** A draft credit note for an invoice: all of what's still owed, line by line (change it before issuing). */
  app.post('/api/documents/:id/credit-note', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const { doc, lines } = await loadDocument(sql, id);
    if (doc.kind === 'sale') throw badRequest('A sale is taken back with a refund (from the sale), not a credit note on its own');
    if (doc.kind !== 'invoice' || doc.status !== 'issued') throw badRequest('Credit notes are made from issued invoices');
    const created = await sql.begin((tx) =>
      createDocument(tx, user, 'credit_note', {
        brandId: doc.brandId,
        projectId: doc.projectId,
        clientId: doc.clientId,
        issueDate: today(),
        title: doc.title,
        creditedInvoiceId: id,
        creditReason: '',
        lines: lines.map((l) => ({ category: l.category, description: l.description, qty: l.qty, unit: l.unit, unitPriceCents: l.unitPriceCents, vatCode: l.vatCode })),
        pricesIncludeVat: doc.pricesIncludeVat,
      }),
    );
    await audit(sql, { userId: user.id, action: 'create', entity: 'credit_note', entityId: created.id, ip: req.ip, details: { invoiceId: id } });
    return created;
  });

  /** A payment reminder was sent (from the phone's share sheet, or emailed). */
  app.post('/api/documents/:id/reminded', { preHandler: requireRole('owner') }, async (req) => {
    const { id } = parse(idParam, req.params);
    await sql`update documents set reminded_at = now(), reminders = reminders + 1 where id = ${id} and kind = 'invoice'`;
    return { ok: true };
  });

  app.post('/api/documents/:id/duplicate', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const { kind } = parse(z.object({ kind: z.enum(['quote', 'invoice']).optional() }), req.body);
    const { doc, lines } = await loadDocument(sql, id);
    // (A sale copies into a draft invoice: a sale is only ever made at the counter.)
    return sql.begin((tx) =>
      createDocument(tx, user, kind ?? (doc.kind === 'sale' ? 'invoice' : doc.kind), {
        brandId: doc.brandId,
        projectId: doc.projectId,
        clientId: doc.clientId,
        issueDate: today(),
        title: doc.title,
        notes: doc.notes,
        terms: '',
        depositBp: doc.depositBp,
        depositCents: doc.depositCents,
        depositShowBalance: doc.depositShowBalance,
        lines: lines.map((l) => ({ category: l.category, description: l.description, qty: l.qty, unit: l.unit, unitPriceCents: l.unitPriceCents, vatCode: l.vatCode })),
        pricesIncludeVat: doc.pricesIncludeVat,
      }),
    );
  });

  // ---- delinquent: write off what's left
  app.post('/api/documents/:id/write-off', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const input = parse(writeOffInput, req.body);
    const { doc } = await loadDocument(sql, id);
    if (doc.kind !== 'invoice') throw notFound('Invoice');
    if ((doc as { saleNumber?: string | null }).saleNumber) throw badRequest('This invoice was a sale, paid when it was made: nothing is owed on it to write off');
    if (doc.status !== 'issued') throw badRequest('Only issued invoices can be written off');
    if (doc.writtenOffOn) throw badRequest('This invoice is already written off');
    const left = doc.totalCents - doc.paidCents;
    if (left <= 0) throw badRequest('Nothing is owed on this invoice');
    if (input.date < doc.issueDate) throw badRequest('The write-off can’t be dated before the invoice');
    await assertOpen(sql, input.date);
    await sql`update documents set written_off_on = ${input.date}, written_off_cents = ${left}, written_off_reason = ${input.reason}, written_off_vat_relief = true, updated_at = now() where id = ${id}`;
    await syncProjectStatus(sql, doc.projectId);
    await audit(sql, { userId: user.id, action: 'write_off', entity: 'invoice', entityId: id, ip: req.ip, details: { amount: left, reason: input.reason } });
    return loadDocument(sql, id);
  });

  app.delete('/api/documents/:id/write-off', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const [doc] = await sql<{ writtenOffOn: string | null }[]>`select written_off_on from documents where id = ${id}`;
    if (!doc?.writtenOffOn) throw notFound('Write-off');
    await assertOpen(sql, doc.writtenOffOn);
    await sql`update documents set written_off_on = null, written_off_cents = 0, written_off_reason = '', updated_at = now() where id = ${id}`;
    await syncProjectOfDocument(sql, id);
    await audit(sql, { userId: user.id, action: 'undo_write_off', entity: 'invoice', entityId: id, ip: req.ip });
    return loadDocument(sql, id);
  });

  // ---- payments received
  app.post('/api/documents/:id/receipts', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const input = parse(receiptInput, req.body);
    const [doc] = await sql<{ kind: string; status: string; writtenOffOn: string | null; saleNumber: string | null }[]>`select kind, status, written_off_on, sale_number from documents where id = ${id}`;
    if (doc?.kind === 'sale' || doc?.saleNumber) throw badRequest('A sale was paid when it was made: money back on it is a refund (from the sale)');
    if (!doc || doc.kind !== 'invoice') throw notFound('Invoice');
    if (doc.status !== 'issued') throw badRequest(doc.status === 'draft' ? 'Issue the invoice before recording a payment' : 'This invoice is void');
    if (doc.writtenOffOn) throw badRequest('This invoice was written off as delinquent. Undo that first, then record the payment.');
    // A negative amount is money paid back to the client: never more than they paid.
    if (input.amountCents < 0) {
      const [p] = await sql<{ paid: number }[]>`select coalesce(sum(amount_cents), 0)::bigint as paid from receipts where invoice_id = ${id}`;
      if (Number(p!.paid) + input.amountCents < 0) throw badRequest('That’s more than the client has paid on this invoice.');
    }
    await assertOpen(sql, input.date);
    const [row] = await sql`insert into receipts ${sql({ ...input, invoiceId: id, createdBy: user.id })} returning *`;
    await syncProjectOfDocument(sql, id);
    await audit(sql, { userId: user.id, action: 'create', entity: 'receipt', entityId: row!.id, ip: req.ip, details: { invoiceId: id, amount: input.amountCents } });
    return loadDocument(sql, id);
  });

  app.delete('/api/receipts/:id', { preHandler: requireRole('owner') }, async (req) => {
    {
      const { id: rid } = parse(idParam, req.params);
      const [cr] = await sql`select 1 from receipts where id = ${rid} and method = 'credit'`;
      if (cr) throw badRequest('That was settled by a credit note: void the credit note instead.');
      const [sold] = await sql`select 1 from documents where sale_receipt_id = ${rid}`;
      if (sold) throw badRequest('That’s the payment taken at the counter for a sale: it stays. Refund the sale instead.');
    }
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const [r] = await sql<{ date: string; invoiceId: string; writtenOffOn: string | null }[]>`
      select r.date, r.invoice_id, d.written_off_on from receipts r join documents d on d.id = r.invoice_id where r.id = ${id}`;
    if (!r) throw notFound('Payment');
    if (r.writtenOffOn) throw badRequest('This invoice was written off as delinquent. Undo that first, then change its payments.');
    await assertOpen(sql, r.date);
    await sql`delete from receipts where id = ${id}`;
    await syncProjectOfDocument(sql, r.invoiceId);
    await audit(sql, { userId: user.id, action: 'delete', entity: 'receipt', entityId: id, ip: req.ip });
    return loadDocument(sql, r.invoiceId);
  });

  // ---- PDF and email
  const pdfFor = (id: string) => documentPdf(sql, id);

  app.get('/api/documents/:id/pdf', { preHandler: requireRole('owner', 'accountant') }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    // A draft invoice shows the VAT it will be issued with.
    await refreshDraftVat(sql, id);
    const { pdf, filename } = await pdfFor(id);
    reply.header('content-type', 'application/pdf');
    reply.header('content-disposition', `${q(req).download ? 'attachment' : 'inline'}; filename="${filename}"`);
    return reply.send(pdf);
  });

  app.post('/api/documents/:id/shared', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const kind = await markShared(sql, id);
    if (!kind) throw notFound('Document');
    await audit(sql, { userId: user.id, action: 'share', entity: kind, entityId: id, ip: req.ip });
    return { ok: true };
  });
}
