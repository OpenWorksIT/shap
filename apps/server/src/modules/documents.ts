import type { FastifyInstance } from 'fastify';
import { addDays, documentInput, lineTotal, quoteStatusInput, receiptInput, type DocKind } from '@shap/shared';
import { z } from 'zod';
import { requireRole, userOrThrow, type AuthUser } from '../auth.js';
import type { Ctx } from '../context.js';
import { pgCode, PG, type Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { assertOpen, formatNumber, getSettings, q, today } from '../lib/books.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { renderDocumentPdf, type PdfDocument } from './pdf.js';

const idParam = z.object({ id: z.string().uuid() });
type DocInput = z.input<typeof documentInput>;

/** Paid state of an invoice, worked out from its payments and due date. */
export const paymentStateSql = `
  case when d.kind <> 'invoice' or d.status <> 'issued' then null
       when coalesce(r.paid, 0) >= d.total_cents and d.total_cents > 0 then 'paid'
       when coalesce(r.paid, 0) > 0 then 'part_paid'
       when d.due_date is not null and d.due_date < current_date then 'overdue'
       else 'unpaid' end`;

async function nextNumber(db: Db, kind: DocKind): Promise<string> {
  // Lock the settings row so two people can't take the same number.
  const [s] = await db<{ prefix: string; next: number; pad: number }[]>`
    select ${kind === 'invoice' ? db`invoice_prefix` : db`quote_prefix`} as prefix,
           ${kind === 'invoice' ? db`invoice_next` : db`quote_next`} as next,
           ${kind === 'invoice' ? db`invoice_pad` : db`quote_pad`} as pad
    from settings where id for update`;
  let n = s!.next;
  let number = formatNumber(s!.prefix, n, s!.pad);
  // Skip numbers already used (e.g. typed by hand or imported).
  for (let i = 0; i < 1000; i++) {
    const [taken] = await db`select 1 from documents where kind = ${kind} and number = ${number}`;
    if (!taken) break;
    n++;
    number = formatNumber(s!.prefix, n, s!.pad);
  }
  if (kind === 'invoice') await db`update settings set invoice_next = ${n + 1} where id`;
  else await db`update settings set quote_next = ${n + 1} where id`;
  return number;
}

async function writeLines(db: Db, documentId: string, lines: NonNullable<DocInput['lines']>, vatRateBp: number) {
  await db`delete from document_lines where document_id = ${documentId}`;
  let subtotal = 0;
  let sort = 0;
  for (const l of lines) {
    const qty = l.qty ?? 1;
    const total = lineTotal(qty, l.unitPriceCents);
    subtotal += total;
    await db`
      insert into document_lines (document_id, sort, category, description, qty, unit, unit_price_cents, line_total_cents)
      values (${documentId}, ${sort++}, ${l.category ?? 'labour'}, ${l.description}, ${qty}, ${l.unit ?? ''}, ${l.unitPriceCents}, ${total})`;
  }
  const vat = Math.round((subtotal * vatRateBp) / 10000);
  await db`update documents set subtotal_cents = ${subtotal}, vat_cents = ${vat}, total_cents = ${subtotal + vat}, updated_at = now() where id = ${documentId}`;
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
  const number = input.number?.trim() || (await nextNumber(tx, kind));
  const due = input.dueDate ?? (kind === 'invoice' ? addDays(input.issueDate, settings.paymentDays) : addDays(input.issueDate, settings.quoteValidDays));
  const vatRate = settings.vatRegistered ? settings.vatRateBp : 0;
  let row: { id: string; number: string } | undefined;
  try {
    [row] = await tx<{ id: string; number: string }[]>`
      insert into documents (kind, number, status, project_id, client_id, issue_date, due_date, title, notes, terms, vat_rate_bp, created_by)
      values (${kind}, ${number}, ${opts.status ?? 'draft'}, ${input.projectId ?? null}, ${clientId}, ${input.issueDate}, ${due},
              ${input.title}, ${input.notes}, ${input.terms || (kind === 'invoice' ? settings.invoiceTerms : settings.quoteTerms)},
              ${vatRate}, ${user?.id ?? null})
      returning id, number`;
  } catch (err) {
    if (pgCode(err) === PG.uniqueViolation) throw conflict(`There is already ${kind === 'invoice' ? 'an invoice' : 'a quote'} numbered ${number}`);
    throw err;
  }
  await writeLines(tx, row!.id, input.lines ?? [], vatRate);
  return row!;
}

export async function loadDocument(db: Db, id: string) {
  const [doc] = await db<PdfDocument['doc'][]>`
    select d.*, coalesce(r.paid, 0)::bigint as paid_cents, ${db.unsafe(paymentStateSql)} as payment_state,
      p.name as project_name, p.number as project_number, p.site_address,
      c.name as client_name, c.contact_person as client_contact, c.address as client_address, c.email as client_email,
      c.phone as client_phone, c.vat_number as client_vat_number, c.code as client_code,
      sq.number as source_quote_number
    from documents d
    left join lateral (select sum(amount_cents) as paid from receipts where invoice_id = d.id) r on true
    left join projects p on p.id = d.project_id left join clients c on c.id = d.client_id
    left join documents sq on sq.id = d.source_quote_id
    where d.id = ${id}`;
  if (!doc) throw notFound('Document');
  const lines = await db<PdfDocument['lines']>`select * from document_lines where document_id = ${id} order by sort`;
  const receipts = await db`
    select r.*, s.name as source_name from receipts r join payment_sources s on s.id = r.source_id
    where r.invoice_id = ${id} order by r.date, r.created_at`;
  return { doc, lines, receipts };
}

export function registerDocumentRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;

  app.get('/api/documents', { preHandler: requireRole('owner', 'accountant') }, async (req) => {
    const { kind, status, client, project, search, state } = q(req);
    const s = search?.trim() || null;
    const rows = await sql.unsafe(
      `select d.id, d.kind, d.number, d.status, d.issue_date, d.due_date, d.title, d.subtotal_cents, d.vat_cents, d.total_cents,
         d.project_id, d.client_id, p.name as project_name, p.number as project_number, c.name as client_name,
         coalesce(r.paid, 0)::bigint as paid_cents, ${paymentStateSql} as payment_state
       from documents d
       left join lateral (select sum(amount_cents) as paid from receipts where invoice_id = d.id) r on true
       left join projects p on p.id = d.project_id left join clients c on c.id = d.client_id
       where ($1::text is null or d.kind = $1) and ($2::text is null or d.status = $2)
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
    const { kind, ...rest } = parse(z.object({ kind: z.enum(['quote', 'invoice']) }).passthrough(), req.body);
    const input = parse(documentInput, rest);
    if (kind === 'invoice') await assertOpen(sql, input.issueDate);
    const doc = await sql.begin((tx) => createDocument(tx, user, kind, input));
    await audit(sql, { userId: user.id, action: 'create', entity: kind, entityId: doc.id, ip: req.ip, details: { number: doc.number } });
    return doc;
  });

  /** Change a quote or invoice at any time, even after it was sent. Voided invoices stay as they were. */
  app.put('/api/documents/:id', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const input = parse(documentInput, req.body);
    const [old] = await sql<{ kind: DocKind; status: string; issueDate: string; number: string; vatRateBp: number }[]>`select * from documents where id = ${id}`;
    if (!old) throw notFound('Document');
    if (old.status === 'void') throw badRequest('This invoice was voided. Duplicate it to make a new one.');
    if (old.kind === 'invoice' && old.status === 'issued') await assertOpen(sql, old.issueDate, input.issueDate);
    const settings = await getSettings(sql);
    const vatRate = old.status === 'draft' ? (settings.vatRegistered ? settings.vatRateBp : 0) : old.vatRateBp;
    const number = input.number?.trim() || old.number;
    await sql.begin(async (tx) => {
      let clientId = input.clientId ?? null;
      if (!clientId && input.projectId) {
        const [p] = await tx<{ clientId: string | null }[]>`select client_id from projects where id = ${input.projectId}`;
        clientId = p?.clientId ?? null;
      }
      try {
        await tx`
          update documents set number = ${number}, project_id = ${input.projectId ?? null}, client_id = ${clientId},
            issue_date = ${input.issueDate}, due_date = ${input.dueDate ?? null}, title = ${input.title}, notes = ${input.notes},
            terms = ${input.terms}, vat_rate_bp = ${vatRate}, updated_at = now()
          where id = ${id}`;
      } catch (err) {
        if (pgCode(err) === PG.uniqueViolation) throw conflict(`Number ${number} is already used`);
        throw err;
      }
      await writeLines(tx, id, input.lines, vatRate);
      await audit(tx, { userId: user.id, action: 'update', entity: old.kind, entityId: id, ip: req.ip, details: { number, status: old.status } });
    });
    return loadDocument(sql, id);
  });

  app.post('/api/documents/:id/issue', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const [doc] = await sql<{ kind: string; status: string; issueDate: string; totalCents: number }[]>`select * from documents where id = ${id}`;
    if (!doc || doc.kind !== 'invoice') throw notFound('Invoice');
    if (doc.status !== 'draft') throw badRequest('This invoice has already been issued');
    await assertOpen(sql, doc.issueDate);
    const [lines] = await sql<{ n: number }[]>`select count(*) as n from document_lines where document_id = ${id}`;
    if (!lines!.n) throw badRequest('Add at least one line first');
    await sql`update documents set status = 'issued', updated_at = now() where id = ${id}`;
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
    return loadDocument(sql, id);
  });

  app.post('/api/documents/:id/void', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(2, 'Give a reason').max(300) }), req.body);
    const [doc] = await sql<{ kind: string; status: string; issueDate: string }[]>`select * from documents where id = ${id}`;
    if (!doc || doc.kind !== 'invoice') throw notFound('Invoice');
    await assertOpen(sql, doc.issueDate);
    const [paid] = await sql`select 1 from receipts where invoice_id = ${id} limit 1`;
    if (paid) throw badRequest('Remove the payments on this invoice before voiding it');
    await sql`update documents set status = 'void', void_reason = ${reason}, updated_at = now() where id = ${id}`;
    await audit(sql, { userId: user.id, action: 'void', entity: 'invoice', entityId: id, ip: req.ip, details: { reason } });
    return loadDocument(sql, id);
  });

  app.delete('/api/documents/:id', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const [doc] = await sql<{ kind: string; status: string }[]>`select kind, status from documents where id = ${id}`;
    if (!doc) throw notFound('Document');
    if (doc.kind === 'invoice' && doc.status !== 'draft') throw badRequest('Issued invoices can’t be deleted. Void it instead, so the number stays accounted for.');
    await sql.begin(async (tx) => {
      await tx`update documents set source_quote_id = null where source_quote_id = ${id}`;
      await tx`delete from documents where id = ${id}`;
      await audit(tx, { userId: user.id, action: 'delete', entity: doc.kind, entityId: id, ip: req.ip });
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
        projectId: doc.projectId,
        clientId: doc.clientId,
        issueDate: today(),
        title: doc.title,
        notes: doc.notes,
        terms: '',
        lines: lines.map((l) => ({ category: l.category, description: l.description, qty: l.qty, unit: l.unit, unitPriceCents: l.unitPriceCents })),
      });
      await tx`update documents set source_quote_id = ${id} where id = ${inv.id}`;
      await tx`update documents set status = 'accepted', updated_at = now() where id = ${id} and status <> 'accepted'`;
      if (doc.projectId) await tx`update projects set status = 'active' where id = ${doc.projectId} and status in ('lead', 'quoted')`;
      await audit(tx, { userId: user.id, action: 'convert', entity: 'quote', entityId: id, ip: req.ip, details: { invoiceId: inv.id } });
      return inv;
    });
    return created;
  });

  app.post('/api/documents/:id/duplicate', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const { kind } = parse(z.object({ kind: z.enum(['quote', 'invoice']).optional() }), req.body);
    const { doc, lines } = await loadDocument(sql, id);
    return sql.begin((tx) =>
      createDocument(tx, user, kind ?? doc.kind, {
        projectId: doc.projectId,
        clientId: doc.clientId,
        issueDate: today(),
        title: doc.title,
        notes: doc.notes,
        terms: '',
        lines: lines.map((l) => ({ category: l.category, description: l.description, qty: l.qty, unit: l.unit, unitPriceCents: l.unitPriceCents })),
      }),
    );
  });

  // ---- payments received
  app.post('/api/documents/:id/receipts', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const input = parse(receiptInput, req.body);
    const [doc] = await sql<{ kind: string; status: string }[]>`select kind, status from documents where id = ${id}`;
    if (!doc || doc.kind !== 'invoice') throw notFound('Invoice');
    if (doc.status !== 'issued') throw badRequest(doc.status === 'draft' ? 'Issue the invoice before recording a payment' : 'This invoice is void');
    await assertOpen(sql, input.date);
    const [row] = await sql`insert into receipts ${sql({ ...input, invoiceId: id, createdBy: user.id })} returning *`;
    await audit(sql, { userId: user.id, action: 'create', entity: 'receipt', entityId: row!.id, ip: req.ip, details: { invoiceId: id, amount: input.amountCents } });
    return loadDocument(sql, id);
  });

  app.delete('/api/receipts/:id', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const [r] = await sql<{ date: string; invoiceId: string }[]>`select date, invoice_id from receipts where id = ${id}`;
    if (!r) throw notFound('Payment');
    await assertOpen(sql, r.date);
    await sql`delete from receipts where id = ${id}`;
    await audit(sql, { userId: user.id, action: 'delete', entity: 'receipt', entityId: id, ip: req.ip });
    return loadDocument(sql, r.invoiceId);
  });

  // ---- PDF and email
  const pdfFor = async (id: string) => {
    const data = await loadDocument(sql, id);
    const settings = await getSettings(sql);
    let logo: Buffer | null = null;
    if (settings.logoId) {
      const [a] = await sql<{ bytes: Buffer }[]>`select bytes from attachments where id = ${settings.logoId}`;
      logo = a?.bytes ?? null;
    }
    const pdf = await renderDocumentPdf({ ...data, settings, logo });
    const label = data.doc.kind === 'invoice' ? (settings.vatRegistered ? 'Tax invoice' : 'Invoice') : 'Quote';
    const filename = `${label} ${data.doc.number}${data.doc.clientName ? ` - ${data.doc.clientName}` : ''}.pdf`.replace(/[^\w.\- ]/g, '');
    return { pdf, filename, data, settings };
  };

  app.get('/api/documents/:id/pdf', { preHandler: requireRole('owner', 'accountant') }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const { pdf, filename } = await pdfFor(id);
    reply.header('content-type', 'application/pdf');
    reply.header('content-disposition', `${q(req).download ? 'attachment' : 'inline'}; filename="${filename}"`);
    return reply.send(pdf);
  });

  app.post('/api/documents/:id/email', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const input = parse(z.object({ to: z.string().trim().email('Enter the client’s email'), message: z.string().max(4000).default('') }), req.body);
    if (!ctx.config.SMTP_URL) throw badRequest('Email isn’t set up on this server (SMTP_URL). Use Share or Download instead.');
    const { pdf, filename, data, settings } = await pdfFor(id);
    const what = data.doc.kind === 'invoice' ? 'Invoice' : 'Quote';
    await ctx.mailer.send({
      to: input.to,
      replyTo: settings.email || undefined,
      subject: `${what} ${data.doc.number} from ${settings.tradingName || settings.companyName}`,
      text: input.message || `Good day,\n\nPlease find ${what.toLowerCase()} ${data.doc.number} attached.\n\nKind regards,\n${settings.tradingName || settings.companyName}`,
      attachments: [{ filename, content: pdf, contentType: 'application/pdf' }],
    });
    if (data.doc.kind === 'quote' && data.doc.status === 'draft') await sql`update documents set status = 'sent', sent_at = now() where id = ${id}`;
    else await sql`update documents set sent_at = coalesce(sent_at, now()) where id = ${id}`;
    await audit(sql, { userId: user.id, action: 'email', entity: data.doc.kind, entityId: id, ip: req.ip, details: { to: input.to } });
    return { ok: true };
  });
}
