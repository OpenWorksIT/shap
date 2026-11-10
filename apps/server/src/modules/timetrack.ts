/**
 * Time tracker: a clock per job (one running at a time for each person), an hourly rate on the job, and the
 * unbilled time onto an invoice as a line. Time is for billing; it doesn't touch the books.
 */
import type { FastifyInstance } from 'fastify';
import { timeEntryInput } from '@shap/shared';
import { z } from 'zod';
import { can, requireAccess, userOrThrow, type AuthUser } from '../auth.js';
import type { Ctx } from '../context.js';
import { q } from '../lib/books.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

const idParam = z.object({ id: z.string().uuid() });
const minutesBetween = (a: string | Date, b: string | Date) => Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000));

export function registerTimeRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;

  /**
   * Whose time someone sees and changes: the owner everyone's; staff tracking time, their own (the
   * job's billing rate only with “See what jobs make”, or making the invoices it goes on). Whoever
   * makes the invoices sees everyone's unbilled time to put on them, and changes only their own.
   */
  const mine = (u: AuthUser) => (u.role === 'owner' ? null : u.id);

  /** Time entries (a job's, or all), newest first, and the clock if one is running. */
  app.get('/api/time', { preHandler: requireAccess('time.track') }, async (req) => {
    const user = userOrThrow(req);
    const { project, unbilled } = q(req);
    const only = unbilled === '1' && can(user, 'documents.edit') ? null : mine(user);
    const rows = await sql`
      select t.*, p.name as project_name, p.number as project_number,
        case when ${can(user, 'jobs.money') || can(user, 'documents.edit')} then coalesce(nullif(p.hourly_rate_cents, 0), (select hourly_rate_cents from settings where id))::bigint end as hourly_rate_cents,
        d.number as billed_number, u.name as user_name
      from time_entries t left join projects p on p.id = t.project_id left join documents d on d.id = t.billed_document_id left join users u on u.id = t.user_id
      where (${project ?? null}::uuid is null or t.project_id = ${project ?? null}::uuid)
        and (${unbilled === '1'} = false or (t.billed_document_id is null and t.ended_at is not null))
        and (${only}::uuid is null or t.user_id = ${only}::uuid)
      order by t.started_at desc limit 500`;
    const [running] = await sql`select t.*, p.name as project_name from time_entries t left join projects p on p.id = t.project_id where t.ended_at is null and t.user_id is not distinct from ${user.id}`;
    return { entries: rows, running: running ?? null };
  });

  /** Starts the clock for a job (stopping any other that's running). */
  app.post('/api/time/start', { preHandler: requireAccess('time.track') }, async (req) => {
    const user = userOrThrow(req);
    const { projectId, note } = parse(z.object({ projectId: z.string().uuid().nullable().default(null), note: z.string().max(300).default('') }), req.body);
    return sql.begin(async (tx) => {
      await tx`update time_entries set ended_at = now(), minutes = greatest(0, round(extract(epoch from now() - started_at) / 60))::int where ended_at is null and user_id is not distinct from ${user.id}`;
      const [row] = await tx`insert into time_entries (project_id, started_at, note, user_id) values (${projectId}, now(), ${note}, ${user.id}) returning *`;
      return row;
    });
  });

  app.post('/api/time/stop', { preHandler: requireAccess('time.track') }, async (req) => {
    const user = userOrThrow(req);
    const [row] = await sql`
      update time_entries set ended_at = now(), minutes = greatest(0, round(extract(epoch from now() - started_at) / 60))::int
      where ended_at is null and user_id is not distinct from ${user.id} returning *`;
    if (!row) throw badRequest('No clock is running');
    return row;
  });

  /** Time added or corrected by hand. */
  app.post('/api/time', { preHandler: requireAccess('time.track') }, async (req) => {
    const input = parse(timeEntryInput, req.body);
    if (!input.endedAt) throw badRequest('Give the end time');
    const minutes = minutesBetween(input.startedAt, input.endedAt);
    const [row] = await sql`insert into time_entries (project_id, started_at, ended_at, minutes, note, user_id) values (${input.projectId ?? null}, ${input.startedAt}, ${input.endedAt}, ${minutes}, ${input.note}, ${userOrThrow(req).id}) returning *`;
    return row;
  });
  app.put('/api/time/:id', { preHandler: requireAccess('time.track') }, async (req) => {
    const only = mine(userOrThrow(req));
    const { id } = parse(idParam, req.params);
    const input = parse(timeEntryInput, req.body);
    const minutes = input.endedAt ? minutesBetween(input.startedAt, input.endedAt) : null;
    const [row] = await sql`
      update time_entries set project_id = ${input.projectId ?? null}, started_at = ${input.startedAt}, ended_at = ${input.endedAt}, minutes = ${minutes}, note = ${input.note}
      where id = ${id} and billed_document_id is null and (${only}::uuid is null or user_id = ${only}::uuid) returning *`;
    if (!row) throw badRequest('That time is already on an invoice, or isn’t yours to change');
    return row;
  });
  app.delete('/api/time/:id', { preHandler: requireAccess('time.track') }, async (req) => {
    const only = mine(userOrThrow(req));
    const { id } = parse(idParam, req.params);
    const [row] = await sql`delete from time_entries where id = ${id} and billed_document_id is null and (${only}::uuid is null or user_id = ${only}::uuid) returning id`;
    if (!row) throw notFound('Time');
    return { ok: true };
  });

  /** Puts unbilled time on an invoice or quote as lines (one per job at its rate); the time is marked billed. */
  app.post('/api/time/bill', { preHandler: requireAccess('time.track') }, async (req) => {
    const user = userOrThrow(req);
    if (!can(user, 'documents.edit')) throw forbidden('Putting time on an invoice takes “Make and change them” under Quotes & invoices');
    const { documentId, ids } = parse(z.object({ documentId: z.string().uuid(), ids: z.array(z.string().uuid()).min(1).max(500) }), req.body);
    const [doc] = await sql<{ status: string; kind: string }[]>`select status, kind from documents where id = ${documentId}`;
    if (!doc || doc.status === 'void' || doc.kind === 'credit_note') throw badRequest('Choose an invoice or quote that can still be changed');
    return sql.begin(async (tx) => {
      const rows = await tx<{ projectId: string | null; projectName: string | null; rate: number; minutes: number }[]>`
        select t.project_id, p.name as project_name, coalesce(nullif(p.hourly_rate_cents, 0), (select hourly_rate_cents from settings where id), 0)::bigint as rate, sum(t.minutes)::int as minutes
        from time_entries t left join projects p on p.id = t.project_id
        where t.id = any(${ids}::uuid[]) and t.billed_document_id is null and t.ended_at is not null
        group by t.project_id, p.name, p.hourly_rate_cents`;
      if (!rows.length) throw badRequest('That time is already on an invoice');
      const [n] = await tx<{ next: number }[]>`select coalesce(max(sort), -1) + 1 as next from document_lines where document_id = ${documentId}`;
      let sort = n!.next;
      for (const r of rows) {
        const hours = Math.round((r.minutes / 60) * 100) / 100;
        const total = Math.round(hours * Number(r.rate));
        await tx`insert into document_lines (document_id, sort, category, description, qty, unit, unit_price_cents, line_total_cents)
                 values (${documentId}, ${sort++}, 'labour', ${`Time${r.projectName ? `: ${r.projectName}` : ''}`}, ${hours}, 'hour', ${r.rate}, ${total})`;
      }
      await tx`update time_entries set billed_document_id = ${documentId} where id = any(${ids}::uuid[]) and billed_document_id is null`;
      // Totals follow the lines (VAT at the document's rate).
      await tx`update documents d set subtotal_cents = x.s, vat_cents = round(x.s * d.vat_rate_bp / 10000.0), total_cents = x.s + round(x.s * d.vat_rate_bp / 10000.0), updated_at = now()
               from (select coalesce(sum(line_total_cents), 0)::bigint as s from document_lines where document_id = ${documentId}) x where d.id = ${documentId}`;
      return { lines: rows.length };
    });
  });
}
