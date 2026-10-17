import type { FastifyInstance } from 'fastify';
import { assignSourceInput, costInput, vatIncluded } from '@shap/shared';
import { z } from 'zod';
import { requireRole, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import { audit } from '../lib/audit.js';
import { assertOpen, getSettings, isIsoDate, q } from '../lib/books.js';
import { forbidden, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

const idParam = z.object({ id: z.string().uuid() });

export function registerCostRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;

  app.get('/api/costs', { preHandler: requireRole('owner', 'accountant') }, async (req) => {
    const { from, to, category, project, source, search, kind } = q(req);
    const f = isIsoDate(from) ? from : null;
    const t = isIsoDate(to) ? to : null;
    const s = search?.trim() || null;
    return sql`
      select c.*, k.name as category_name, k.kind as category_kind, src.name as source_name,
        p.name as project_name, p.number as project_number, a.id as asset_id
      from costs c join cost_categories k on k.id = c.category_id left join payment_sources src on src.id = c.source_id
      left join projects p on p.id = c.project_id left join assets a on a.cost_id = c.id
      where (${f}::date is null or c.date >= ${f}::date) and (${t}::date is null or c.date <= ${t}::date)
        and (${category ?? null}::uuid is null or c.category_id = ${category ?? null}::uuid)
        and (${project ?? null}::uuid is null or c.project_id = ${project ?? null}::uuid)
        and (${source && source !== 'none' ? source : null}::uuid is null or c.source_id = ${source && source !== 'none' ? source : null}::uuid)
        and (${source === 'none'} = false or c.source_id is null)
        and (${kind ?? null}::text is null or k.kind = ${kind ?? null}::text)
        and (${kind === 'materials-unallocated'} = false or (k.kind = 'materials' and c.project_id is null))
        and (${s}::text is null or c.description ilike '%' || ${s} || '%' or c.supplier ilike '%' || ${s} || '%')
      order by c.date desc, c.created_at desc
      limit 2000
    `;
  });

  /** Suppliers you've used, most used first, for the picker on the phone. */
  app.get('/api/costs/suppliers', { preHandler: requireRole() }, async () => {
    const rows = await sql<{ supplier: string }[]>`
      select supplier from costs where supplier <> '' group by supplier order by count(*) desc, supplier limit 200`;
    return rows.map((r) => r.supplier);
  });

  app.get('/api/costs/:id', { preHandler: requireRole() }, async (req) => {
    const { id } = parse(idParam, req.params);
    const [row] = await sql`select c.*, a.id as asset_id from costs c left join assets a on a.cost_id = c.id where c.id = ${id}`;
    if (!row) throw notFound('Cost');
    return row;
  });

  app.post('/api/costs', { preHandler: requireRole('owner', 'capture') }, async (req) => {
    const user = userOrThrow(req);
    const input = parse(costInput, req.body);
    await assertOpen(sql, input.date);
    const settings = await getSettings(sql);
    // Not a VAT vendor: no input VAT to claim, whatever the slip says.
    const vat = settings.vatRegistered ? input.vatCents : 0;
    const [row] = await sql`
      insert into costs ${sql({ ...input, vatCents: vat, projectId: input.projectId ?? null, receiptId: input.receiptId ?? null, plannedItemId: input.plannedItemId ?? null, createdBy: user.id })}
      returning *`;
    await audit(sql, { userId: user.id, action: 'create', entity: 'cost', entityId: row!.id, ip: req.ip });
    return row;
  });

  app.put('/api/costs/:id', { preHandler: requireRole('owner', 'capture') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const input = parse(costInput, req.body);
    const [old] = await sql<{ date: string; createdBy: string | null; createdAt: Date }[]>`select date, created_by, created_at from costs where id = ${id}`;
    if (!old) throw notFound('Cost');
    if (user.role !== 'owner' && (old.createdBy !== user.id || Date.now() - old.createdAt.getTime() > 24 * 3600_000)) throw forbidden('Ask the owner to change this cost');
    await assertOpen(sql, old.date, input.date);
    const settings = await getSettings(sql);
    const vat = settings.vatRegistered ? input.vatCents : 0;
    const [row] = await sql`
      update costs set ${sql({ ...input, vatCents: vat, projectId: input.projectId ?? null, receiptId: input.receiptId ?? null, plannedItemId: input.plannedItemId ?? null })}
      where id = ${id} returning *`;
    await audit(sql, { userId: user.id, action: 'update', entity: 'cost', entityId: id, ip: req.ip });
    return row;
  });

  app.delete('/api/costs/:id', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const [old] = await sql<{ date: string }[]>`select date from costs where id = ${id}`;
    if (!old) throw notFound('Cost');
    await assertOpen(sql, old.date);
    await sql.begin(async (tx) => {
      await tx`update assets set cost_id = null, source_id = coalesce(source_id, (select source_id from costs where id = ${id})) where cost_id = ${id}`;
      await tx`delete from costs where id = ${id}`;
      await audit(tx, { userId: user.id, action: 'delete', entity: 'cost', entityId: id, ip: req.ip });
    });
    return { ok: true };
  });

  /** Say which account or card paid a batch of costs that weren't captured yet. */
  app.post('/api/costs/assign-source', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const input = parse(assignSourceInput, req.body);
    const dates = await sql<{ date: string }[]>`select date from costs where id = any(${input.ids}::uuid[])`;
    await assertOpen(sql, ...dates.map((d) => d.date));
    const res = await sql`update costs set source_id = ${input.sourceId} where id = any(${input.ids}::uuid[])`;
    await audit(sql, { userId: user.id, action: 'assign_source', entity: 'cost', ip: req.ip, details: { count: res.count, sourceId: input.sourceId } });
    return { updated: res.count };
  });

  /** Helper for the phone: the VAT inside an amount at the company's rate. */
  app.get('/api/costs/vat-in', { preHandler: requireRole() }, async (req) => {
    const settings = await getSettings(sql);
    const amount = Number(q(req).amount ?? 0);
    return { vatCents: settings.vatRegistered ? vatIncluded(amount, settings.vatRateBp) : 0 };
  });
}
