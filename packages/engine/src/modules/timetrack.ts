/**
 * Time tracker: a clock per job (one running at a time for each person), an hourly rate on the job, and the
 * unbilled time onto an invoice as a line. Time is for billing; it doesn't touch the books.
 */
import type { App as FastifyInstance } from '../http.js';
import { timeEntryInput } from '@shap/shared';
import { z } from 'zod';
import { requireRole, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import { audit } from '../lib/audit.js';
import { q } from '../lib/books.js';
import { rewriteLines } from './documents.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

const idParam = z.object({ id: z.string().uuid() });
const minutesBetween = (a: string | Date, b: string | Date) => Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000));

export function registerTimeRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;
  const owner = { preHandler: requireRole('owner') };

  /** Time entries (a job's, or all), newest first, and the clock if one is running. */
  app.get('/api/time', owner, async (req) => {
    const user = userOrThrow(req);
    const { project, unbilled } = q(req);
    const rows = await sql`
      select t.*, p.name as project_name, p.number as project_number,
        coalesce(nullif(p.hourly_rate_cents, 0), (select hourly_rate_cents from settings where id))::bigint as hourly_rate_cents, d.number as billed_number, u.name as user_name
      from time_entries t left join projects p on p.id = t.project_id left join documents d on d.id = t.billed_document_id left join users u on u.id = t.user_id
      where (${project ?? null}::uuid is null or t.project_id = ${project ?? null}::uuid)
        and (${unbilled === '1'} = false or (t.billed_document_id is null and t.ended_at is not null))
      order by t.started_at desc limit 500`;
    const [running] = await sql`select t.*, p.name as project_name from time_entries t left join projects p on p.id = t.project_id where t.ended_at is null and t.user_id is not distinct from ${user.id}`;
    return { entries: rows, running: running ?? null };
  });

  /** Starts the clock for a job (stopping any other that's running). */
  app.post('/api/time/start', owner, async (req) => {
    const user = userOrThrow(req);
    const { projectId, note } = parse(z.object({ projectId: z.string().uuid().nullable().default(null), note: z.string().max(300).default('') }), req.body);
    return sql.begin(async (tx) => {
      await tx`update time_entries set ended_at = now(), minutes = greatest(0, round(extract(epoch from now() - started_at) / 60))::int where ended_at is null and user_id is not distinct from ${user.id}`;
      const [row] = await tx`insert into time_entries (project_id, started_at, note, user_id) values (${projectId}, now(), ${note}, ${user.id}) returning *`;
      return row;
    });
  });

  app.post('/api/time/stop', owner, async (req) => {
    const user = userOrThrow(req);
    const [row] = await sql`
      update time_entries set ended_at = now(), minutes = greatest(0, round(extract(epoch from now() - started_at) / 60))::int
      where ended_at is null and user_id is not distinct from ${user.id} returning *`;
    if (!row) throw badRequest('No clock is running');
    return row;
  });

  /** Time added or corrected by hand. */
  app.post('/api/time', owner, async (req) => {
    const input = parse(timeEntryInput, req.body);
    if (!input.endedAt) throw badRequest('Give the end time');
    const minutes = minutesBetween(input.startedAt, input.endedAt);
    const [row] = await sql`insert into time_entries (project_id, started_at, ended_at, minutes, note, user_id) values (${input.projectId ?? null}, ${input.startedAt}, ${input.endedAt}, ${minutes}, ${input.note}, ${userOrThrow(req).id}) returning *`;
    return row;
  });
  app.put('/api/time/:id', owner, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(timeEntryInput, req.body);
    const minutes = input.endedAt ? minutesBetween(input.startedAt, input.endedAt) : null;
    const [row] = await sql`
      update time_entries set project_id = ${input.projectId ?? null}, started_at = ${input.startedAt}, ended_at = ${input.endedAt}, minutes = ${minutes}, note = ${input.note}
      where id = ${id} and billed_document_id is null returning *`;
    if (!row) throw badRequest('That time is already on an invoice');
    return row;
  });
  app.delete('/api/time/:id', owner, async (req) => {
    const { id } = parse(idParam, req.params);
    const [row] = await sql`delete from time_entries where id = ${id} and billed_document_id is null returning id`;
    if (!row) throw notFound('Time');
    return { ok: true };
  });

  /** Puts unbilled time on an invoice or quote as lines (one per job at its rate); the time is marked billed. */
  app.post('/api/time/bill', owner, async (req) => {
    const user = userOrThrow(req);
    const { documentId, ids } = parse(z.object({ documentId: z.string().uuid(), ids: z.array(z.string().uuid()).min(1).max(500) }), req.body);
    const [doc] = await sql<{ status: string; kind: string; number: string }[]>`select status, kind, number from documents where id = ${documentId}`;
    // A quote, or an invoice not yet issued: an issued one (a sale's too) says what was charged, and
    // changes only by a credit note and a new invoice (and never in a closed period).
    if (!doc || !(doc.kind === 'quote' ? doc.status !== 'declined' : doc.kind === 'invoice' && doc.status === 'draft')) {
      throw badRequest('Time goes on a quote or a draft invoice: an issued invoice changes through a credit note and a new invoice');
    }
    return sql.begin(async (tx) => {
      const rows = await tx<{ projectId: string | null; projectName: string | null; rate: number; minutes: number }[]>`
        select t.project_id, p.name as project_name, coalesce(nullif(p.hourly_rate_cents, 0), (select hourly_rate_cents from settings where id), 0)::bigint as rate, sum(t.minutes)::int as minutes
        from time_entries t left join projects p on p.id = t.project_id
        where t.id = any(${ids}::uuid[]) and t.billed_document_id is null and t.ended_at is not null
        group by t.project_id, p.name, p.hourly_rate_cents`;
      if (!rows.length) throw badRequest('That time is already on an invoice');
      // The time goes on after the lines there, and the totals are worked out again the way any
      // change to the document works them out (each line's VAT class, prices with or without VAT).
      const [d] = await tx<{ vatRateBp: number; pricesIncludeVat: boolean }[]>`select vat_rate_bp, prices_include_vat from documents where id = ${documentId} for update`;
      const lines = await tx<{ category: string; description: string; qty: string; unit: string; unitPriceCents: string; vatCode: string; itemId: string | null }[]>`
        select category, description, qty, unit, unit_price_cents, vat_code, item_id from document_lines where document_id = ${documentId} order by sort`;
      const time = rows.map((r) => ({ category: 'labour', description: `Time${r.projectName ? `: ${r.projectName}` : ''}`, qty: String(Math.round((r.minutes / 60) * 100) / 100), unit: 'hour', unitPriceCents: String(r.rate), vatCode: 'standard', itemId: null }));
      await rewriteLines(tx, documentId, [...lines, ...time].map((l) => ({ ...l, qty: Number(l.qty), unitPriceCents: Number(l.unitPriceCents) })) as never, Number(d!.vatRateBp), d!.pricesIncludeVat);
      await tx`update time_entries set billed_document_id = ${documentId} where id = any(${ids}::uuid[]) and billed_document_id is null`;
      await audit(tx, { userId: user.id, action: 'bill_time', entity: doc.kind, entityId: documentId, ip: req.ip, details: { number: doc.number, lines: rows.length, minutes: rows.reduce((t, r) => t + Number(r.minutes), 0) } });
      return { lines: rows.length };
    });
  });
}
