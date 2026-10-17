import type { FastifyInstance } from 'fastify';
import { lineTotal, plannedItemInput, projectInput, PROJECT_STATUSES } from '@shap/shared';
import { z } from 'zod';
import { requireRole, seesMoney, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import { audit } from '../lib/audit.js';
import { getSettings, q, today } from '../lib/books.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { createDocument } from './documents.js';

const idParam = z.object({ id: z.string().uuid() });

/**
 * The tracker's "Per Project" row, live: quoted (from accepted quotes, else the estimate),
 * actual (labour days + costs), invoiced (issued invoices by category) and received.
 */
export const projectSummarySql = `
  select p.id,
    coalesce(qt.labour, p.est_labour_cents)::bigint as quoted_labour_cents,
    coalesce(qt.materials, p.est_materials_cents)::bigint as quoted_materials_cents,
    coalesce(qt.demo, p.est_demo_cents)::bigint as quoted_demo_cents,
    coalesce(qt.other, 0)::bigint as quoted_other_cents,
    (qt.n is not null) as quoted_from_quote,
    coalesce(lab.cost, 0)::bigint as actual_labour_cents,
    coalesce(lab.days, 0)::float as days_worked,
    coalesce(cst.materials, 0)::bigint as actual_materials_cents,
    coalesce(cst.demo, 0)::bigint as actual_demo_cents,
    coalesce(cst.other, 0)::bigint as actual_other_cents,
    coalesce(inv.labour, 0)::bigint as invoiced_labour_cents,
    coalesce(inv.materials, 0)::bigint as invoiced_materials_cents,
    coalesce(inv.demo, 0)::bigint as invoiced_demo_cents,
    coalesce(inv.other, 0)::bigint as invoiced_other_cents,
    coalesce(inv.vat, 0)::bigint as invoiced_vat_cents,
    coalesce(rec.total, 0)::bigint as received_cents,
    coalesce(pl.total, 0)::bigint as planned_cents,
    coalesce(pl.bought, 0)::bigint as planned_bought_cents,
    inv.last_date as last_invoice_date,
    greatest(lab.last_date, cst.last_date) as last_activity
  from projects p
  left join lateral (
    select count(*) as n,
      sum(l.line_total_cents) filter (where l.category = 'labour') as labour,
      sum(l.line_total_cents) filter (where l.category = 'materials') as materials,
      sum(l.line_total_cents) filter (where l.category = 'demo') as demo,
      sum(l.line_total_cents) filter (where l.category = 'other') as other
    from documents d left join document_lines l on l.document_id = d.id
    where d.project_id = p.id and d.kind = 'quote' and d.status = 'accepted'
    having count(*) > 0
  ) qt on true
  left join lateral (
    select sum(e.wage_cents + e.allowance_cents) as cost, sum(e.days) as days, max(e.date) as last_date
    from labour_entries e where e.project_id = p.id
  ) lab on true
  left join lateral (
    select sum(c.amount_cents - c.vat_cents) filter (where k.kind = 'materials') as materials,
           sum(c.amount_cents - c.vat_cents) filter (where k.kind = 'demo') as demo,
           sum(c.amount_cents - c.vat_cents) filter (where k.kind in ('overhead', 'asset')) as other,
           max(c.date) as last_date
    from costs c join cost_categories k on k.id = c.category_id where c.project_id = p.id
  ) cst on true
  left join lateral (
    select sum(l.line_total_cents) filter (where l.category = 'labour') as labour,
           sum(l.line_total_cents) filter (where l.category = 'materials') as materials,
           sum(l.line_total_cents) filter (where l.category = 'demo') as demo,
           sum(l.line_total_cents) filter (where l.category = 'other') as other,
           (select sum(d2.vat_cents) from documents d2 where d2.project_id = p.id and d2.kind = 'invoice' and d2.status = 'issued') as vat,
           max(d.issue_date) as last_date
    from documents d join document_lines l on l.document_id = d.id
    where d.project_id = p.id and d.kind = 'invoice' and d.status = 'issued'
  ) inv on true
  left join lateral (
    select sum(r.amount_cents) as total from receipts r join documents d on d.id = r.invoice_id
    where d.project_id = p.id and d.status = 'issued'
  ) rec on true
  left join lateral (
    select sum(round(i.qty * i.unit_cost_cents)) as total,
           sum(round(i.qty * i.unit_cost_cents)) filter (where exists (select 1 from costs c where c.planned_item_id = i.id)) as bought
    from planned_items i where i.project_id = p.id
  ) pl on true
`;

export interface ProjectSummary {
  quotedLabourCents: number;
  quotedMaterialsCents: number;
  quotedDemoCents: number;
  quotedOtherCents: number;
  actualLabourCents: number;
  actualMaterialsCents: number;
  actualDemoCents: number;
  actualOtherCents: number;
  invoicedLabourCents: number;
  invoicedMaterialsCents: number;
  invoicedDemoCents: number;
  invoicedOtherCents: number;
  invoicedVatCents: number;
  receivedCents: number;
}

export function totals(s: ProjectSummary) {
  const quoted = s.quotedLabourCents + s.quotedMaterialsCents + s.quotedDemoCents + s.quotedOtherCents;
  const actual = s.actualLabourCents + s.actualMaterialsCents + s.actualDemoCents + s.actualOtherCents;
  const invoiced = s.invoicedLabourCents + s.invoicedMaterialsCents + s.invoicedDemoCents + s.invoicedOtherCents;
  const gross = invoiced - actual;
  return {
    quotedCents: quoted,
    actualCents: actual,
    invoicedCents: invoiced,
    grossProfitCents: gross,
    margin: invoiced ? gross / invoiced : null,
    outstandingCents: invoiced + s.invoicedVatCents - s.receivedCents,
  };
}

export function registerProjectRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;

  app.get('/api/projects', { preHandler: requireRole() }, async (req) => {
    const user = userOrThrow(req);
    const { status, client, search } = q(req);
    const statuses = status === 'open' ? ['lead', 'quoted', 'active', 'invoiced'] : status && (PROJECT_STATUSES as readonly string[]).includes(status) ? [status] : null;
    if (!seesMoney(user)) {
      return sql`
        select p.id, p.number, p.name, p.status, c.name as client_name
        from projects p left join clients c on c.id = p.client_id
        where p.status in ('lead', 'quoted', 'active', 'invoiced') order by p.number desc
      `;
    }
    const rows = await sql.unsafe(
      `select p.*, c.name as client_name, c.code as client_code, s.*
       from projects p left join clients c on c.id = p.client_id join (${projectSummarySql}) s on s.id = p.id
       where ($1::text[] is null or p.status = any($1::text[]))
         and ($2::uuid is null or p.client_id = $2::uuid)
         and ($3::text is null or p.name ilike '%' || $3 || '%' or c.name ilike '%' || $3 || '%' or p.number::text = $3)
       order by p.number desc`,
      [statuses as never, (client ?? null) as never, (search?.trim() || null) as never],
    );
    return rows.map((r) => ({ ...r, ...totals(r as unknown as ProjectSummary) }));
  });

  app.get('/api/projects/:id', { preHandler: requireRole() }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const [project] = await sql`select p.*, c.name as client_name from projects p left join clients c on c.id = p.client_id where p.id = ${id}`;
    if (!project) throw notFound('Job');
    const planned = await sql`
      select i.*, round(i.qty * i.unit_cost_cents)::bigint as total_cents,
        (select c.id from costs c where c.planned_item_id = i.id limit 1) as cost_id,
        (select coalesce(sum(c.amount_cents), 0) from costs c where c.planned_item_id = i.id)::bigint as bought_cents
      from planned_items i where i.project_id = ${id} order by i.sort, i.created_at
    `;
    if (!seesMoney(user)) return { project, planned };

    const [summary] = await sql.unsafe(`select * from (${projectSummarySql}) s where s.id = $1`, [id]);
    const [labour, costs, documents, workers] = await Promise.all([
      sql`select e.*, w.name as worker_name from labour_entries e join workers w on w.id = e.worker_id
          where e.project_id = ${id} order by e.date desc, w.name`,
      sql`select c.*, k.name as category_name, k.kind as category_kind, s.name as source_name
          from costs c join cost_categories k on k.id = c.category_id left join payment_sources s on s.id = c.source_id
          where c.project_id = ${id} order by c.date desc, c.created_at desc`,
      sql`select d.id, d.kind, d.number, d.status, d.issue_date, d.due_date, d.title, d.subtotal_cents, d.total_cents,
            coalesce((select sum(r.amount_cents) from receipts r where r.invoice_id = d.id), 0)::bigint as paid_cents
          from documents d where d.project_id = ${id} order by d.issue_date desc, d.created_at desc`,
      sql`select w.id, w.name, sum(e.days)::float as days, sum(e.wage_cents + e.allowance_cents)::bigint as cost_cents
          from labour_entries e join workers w on w.id = e.worker_id where e.project_id = ${id}
          group by w.id, w.name order by days desc`,
    ]);
    return { project, summary: { ...summary, ...totals(summary as unknown as ProjectSummary) }, planned, labour, costs, documents, workers };
  });

  app.post('/api/projects', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const input = parse(projectInput, req.body);
    const [next] = await sql<{ n: number }[]>`select coalesce(max(number), 0) + 1 as n from projects`;
    const [row] = await sql`
      insert into projects ${sql({ ...input, clientId: input.clientId ?? null, startDate: input.startDate ?? today(), endDate: input.endDate ?? null, number: next!.n })}
      returning *
    `;
    await audit(sql, { userId: user.id, action: 'create', entity: 'project', entityId: row!.id, ip: req.ip });
    return row;
  });

  app.put('/api/projects/:id', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const input = parse(projectInput, req.body);
    const [row] = await sql`update projects set ${sql({ ...input, clientId: input.clientId ?? null, startDate: input.startDate ?? null, endDate: input.endDate ?? null })} where id = ${id} returning *`;
    if (!row) throw notFound('Job');
    await audit(sql, { userId: user.id, action: 'update', entity: 'project', entityId: id, ip: req.ip });
    return row;
  });

  app.delete('/api/projects/:id', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const [used] = await sql<{ n: number }[]>`
      select (select count(*) from labour_entries where project_id = ${id}) + (select count(*) from costs where project_id = ${id})
           + (select count(*) from documents where project_id = ${id}) as n`;
    if (used!.n > 0) throw badRequest('This job has labour, costs or documents on it. Mark it cancelled instead, or move those first.');
    await sql`delete from projects where id = ${id}`;
    await audit(sql, { userId: user.id, action: 'delete', entity: 'project', entityId: id, ip: req.ip });
    return { ok: true };
  });

  // ---- planned parts
  app.post('/api/projects/:id/planned', { preHandler: requireRole('owner') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(plannedItemInput, req.body);
    const [next] = await sql<{ n: number }[]>`select coalesce(max(sort), 0) + 1 as n from planned_items where project_id = ${id}`;
    const [row] = await sql`insert into planned_items ${sql({ ...input, projectId: id, sort: next!.n })} returning *`;
    return row;
  });
  app.put('/api/planned/:id', { preHandler: requireRole('owner') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(plannedItemInput, req.body);
    const [row] = await sql`update planned_items set ${sql(input)} where id = ${id} returning *`;
    if (!row) throw notFound('Item');
    return row;
  });
  app.delete('/api/planned/:id', { preHandler: requireRole('owner') }, async (req) => {
    const { id } = parse(idParam, req.params);
    await sql`delete from planned_items where id = ${id}`;
    return { ok: true };
  });

  /** Draft a quote from the job's planned parts (with mark-up) and its labour estimate. */
  app.post('/api/projects/:id/quote-from-plan', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const { markupBp } = parse(z.object({ markupBp: z.number().int().min(0).max(100000).optional() }), req.body);
    const [project] = await sql<{ id: string; name: string; clientId: string | null; estLabourCents: number; estDemoCents: number }[]>`select * from projects where id = ${id}`;
    if (!project) throw notFound('Job');
    const settings = await getSettings(sql);
    const markup = markupBp ?? settings.markupBp;
    const items = await sql<{ description: string; qty: number; unit: string; unitCostCents: number; category: 'materials' | 'demo' }[]>`
      select description, qty, unit, unit_cost_cents, category from planned_items where project_id = ${id} order by sort, created_at`;
    const lines = items.map((i) => ({
      category: i.category,
      description: i.description,
      qty: i.qty,
      unit: i.unit,
      unitPriceCents: Math.round(i.unitCostCents * (1 + markup / 10000)),
    }));
    if (project.estLabourCents > 0) lines.unshift({ category: 'labour', description: 'Labour', qty: 1, unit: '', unitPriceCents: project.estLabourCents } as never);
    if (project.estDemoCents > 0 && !items.some((i) => i.category === 'demo'))
      lines.push({ category: 'demo', description: 'Demolition and rubble removal', qty: 1, unit: '', unitPriceCents: project.estDemoCents } as never);
    if (!lines.length) throw badRequest('Add planned parts or a labour estimate first');
    const doc = await sql.begin((tx) => createDocument(tx, user, 'quote', {
      projectId: id,
      clientId: project.clientId,
      issueDate: today(),
      title: project.name,
      notes: '',
      terms: settings.quoteTerms,
      lines,
    }));
    return { id: doc.id, total: lines.reduce((s, l) => s + lineTotal(l.qty, l.unitPriceCents), 0) };
  });
}
