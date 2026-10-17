import type { FastifyInstance } from 'fastify';
import { allocateInput, labourBatchInput, labourEntryInput, savingsInput, wagePaymentInput, workerInput } from '@shap/shared';
import { z } from 'zod';
import { requireRole, seesMoney, userOrThrow, type AuthUser } from '../auth.js';
import type { Ctx } from '../context.js';
import { pgCode, PG, type Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { assertOpen, isIsoDate, q } from '../lib/books.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

const idParam = z.object({ id: z.string().uuid() });

/** Site capture logs days; the wage comes from the worker's rates, never from the phone. */
async function ratesFor(db: Db, workerIds: string[]) {
  const rows = await db<{ id: string; dayRateCents: number; allowanceCents: number }[]>`
    select id, day_rate_cents, allowance_cents from workers where id = any(${workerIds}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r]));
}

function checkTarget(projectId: string | null | undefined, workTypeId: string | null | undefined) {
  if (projectId && workTypeId) throw badRequest('Choose a job or a type of general work, not both');
}

export function registerWorkerRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;

  app.get('/api/workers', { preHandler: requireRole() }, async (req) => {
    const user = userOrThrow(req);
    if (!seesMoney(user)) return sql`select id, name, kind, active from workers order by active desc, name`;
    return sql`
      select w.*,
        coalesce(e.earned, 0)::bigint as earned_cents,
        coalesce(p.paid, 0)::bigint as paid_cents,
        (coalesce(e.earned, 0) - coalesce(p.paid, 0))::bigint as balance_cents,
        coalesce(sv.held, 0)::bigint as savings_cents,
        coalesce(m.days, 0)::float as days_this_month,
        e.last_date as last_worked
      from workers w
      left join lateral (select sum(wage_cents + allowance_cents) as earned, max(date) as last_date from labour_entries where worker_id = w.id) e on true
      left join lateral (select sum(amount_cents) as paid from wage_payments where worker_id = w.id) p on true
      left join lateral (select sum(amount_cents) as held from worker_savings where worker_id = w.id) sv on true
      left join lateral (select sum(days) as days from labour_entries where worker_id = w.id and date >= date_trunc('month', current_date)) m on true
      order by w.active desc, e.last_date desc nulls last, w.name
    `;
  });

  /** The tracker's Wages Breakdown for one worker: per month days, wages, allowances, paid, saved/(advance). */
  app.get('/api/workers/:id', { preHandler: requireRole('owner', 'accountant') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const [worker] = await sql`select * from workers where id = ${id}`;
    if (!worker) throw notFound('Worker');
    const months = await sql`
      with m as (
        select to_char(date, 'YYYY-MM') as month, sum(days)::float as days, sum(wage_cents)::bigint as wages,
               sum(allowance_cents)::bigint as allowances, 0::bigint as paid
        from labour_entries where worker_id = ${id} group by 1
        union all
        select to_char(date, 'YYYY-MM'), 0, 0, 0, sum(amount_cents)::bigint from wage_payments where worker_id = ${id} group by 1
      )
      select month, sum(days)::float as days, sum(wages)::bigint as wage_cents, sum(allowances)::bigint as allowance_cents,
             (sum(wages) + sum(allowances))::bigint as earned_cents, sum(paid)::bigint as paid_cents
      from m group by month order by month desc
    `;
    const [entries, payments, savings, byProject] = await Promise.all([
      sql`select e.*, p.name as project_name, p.number as project_number, wt.name as work_type_name
          from labour_entries e left join projects p on p.id = e.project_id left join work_types wt on wt.id = e.work_type_id
          where e.worker_id = ${id} order by e.date desc, e.created_at desc limit 5000`,
      sql`select wp.*, s.name as source_name from wage_payments wp join payment_sources s on s.id = wp.source_id
          where wp.worker_id = ${id} order by wp.date desc, wp.created_at desc limit 5000`,
      sql`select * from worker_savings where worker_id = ${id} order by date desc, created_at desc`,
      sql`select coalesce(p.name, wt.name, 'Not allocated yet') as name, p.id as project_id, sum(e.days)::float as days,
            sum(e.wage_cents + e.allowance_cents)::bigint as cost_cents
          from labour_entries e left join projects p on p.id = e.project_id left join work_types wt on wt.id = e.work_type_id
          where e.worker_id = ${id} group by 1, 2 order by days desc`,
    ]);
    return { worker, months, entries, payments, savings, byProject };
  });

  app.post('/api/workers', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const input = parse(workerInput, req.body);
    try {
      const [row] = await sql`insert into workers ${sql(input)} returning *`;
      await audit(sql, { userId: user.id, action: 'create', entity: 'worker', entityId: row!.id, ip: req.ip });
      return row;
    } catch (err) {
      if (pgCode(err) === PG.uniqueViolation) throw conflict('There’s already a worker with that name');
      throw err;
    }
  });

  app.put('/api/workers/:id', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const input = parse(workerInput, req.body);
    try {
      const [row] = await sql`update workers set ${sql(input)} where id = ${id} returning *`;
      if (!row) throw notFound('Worker');
      await audit(sql, { userId: user.id, action: 'update', entity: 'worker', entityId: id, ip: req.ip });
      return row;
    } catch (err) {
      if (pgCode(err) === PG.uniqueViolation) throw conflict('There’s already a worker with that name');
      throw err;
    }
  });

  // ---- labour
  app.get('/api/labour', { preHandler: requireRole('owner', 'accountant') }, async (req) => {
    const { from, to, worker, project, unallocated } = q(req);
    return sql`
      select e.*, w.name as worker_name, p.name as project_name, p.number as project_number, wt.name as work_type_name
      from labour_entries e join workers w on w.id = e.worker_id
      left join projects p on p.id = e.project_id left join work_types wt on wt.id = e.work_type_id
      where (${isIsoDate(from) ? from : null}::date is null or e.date >= ${isIsoDate(from) ? from : null}::date)
        and (${isIsoDate(to) ? to : null}::date is null or e.date <= ${isIsoDate(to) ? to : null}::date)
        and (${worker ?? null}::uuid is null or e.worker_id = ${worker ?? null}::uuid)
        and (${project ?? null}::uuid is null or e.project_id = ${project ?? null}::uuid)
        and (${unallocated === '1'} = false or (e.project_id is null and e.work_type_id is null))
      order by e.date desc, w.name limit 1000
    `;
  });

  /** Labour with no job and no general-work type: the hours that used to fall through the cracks. */
  app.get('/api/labour/unallocated', { preHandler: requireRole('owner', 'accountant') }, async () => {
    const rows = await sql`
      select e.*, w.name as worker_name from labour_entries e join workers w on w.id = e.worker_id
      where e.project_id is null and e.work_type_id is null order by e.date desc, w.name
    `;
    return rows;
  });

  /** Log a day for one or more workers. */
  app.post('/api/labour', { preHandler: requireRole('owner', 'capture') }, async (req) => {
    const user = userOrThrow(req);
    const input = parse(labourBatchInput, req.body);
    checkTarget(input.projectId, input.workTypeId);
    await assertOpen(sql, input.date);
    const rates = user.role === 'capture' ? await ratesFor(sql, input.entries.map((e) => e.workerId)) : null;
    const ids = await sql.begin(async (tx) => {
      const out: string[] = [];
      for (const e of input.entries) {
        const r = rates?.get(e.workerId);
        const wage = r ? Math.round(r.dayRateCents * e.days) : e.wageCents;
        const allowance = r ? Math.round(r.allowanceCents * Math.ceil(e.days)) : e.allowanceCents;
        const [row] = await tx<{ id: string }[]>`
          insert into labour_entries (date, worker_id, project_id, work_type_id, days, wage_cents, allowance_cents, note, created_by)
          values (${input.date}, ${e.workerId}, ${input.projectId ?? null}, ${input.workTypeId ?? null}, ${e.days}, ${wage}, ${allowance}, ${input.note}, ${user.id})
          returning id`;
        out.push(row!.id);
      }
      await audit(tx, { userId: user.id, action: 'create', entity: 'labour', ip: req.ip, details: { count: out.length, date: input.date } });
      return out;
    });
    return { ids };
  });

  const ownEntryOrOwner = async (user: AuthUser, table: 'labour_entries' | 'costs', id: string) => {
    if (user.role === 'owner') return;
    const [row] = await sql<{ createdBy: string | null; createdAt: Date }[]>`select created_by, created_at from ${sql(table)} where id = ${id}`;
    // Site capture can fix its own entries for a day, then they're the owner's to change.
    if (!row || row.createdBy !== user.id || Date.now() - row.createdAt.getTime() > 24 * 3600_000) throw forbidden('Ask the owner to change this entry');
  };

  app.put('/api/labour/:id', { preHandler: requireRole('owner', 'capture') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const input = parse(labourEntryInput, req.body);
    checkTarget(input.projectId, input.workTypeId);
    await ownEntryOrOwner(user, 'labour_entries', id);
    const [old] = await sql<{ date: string }[]>`select date from labour_entries where id = ${id}`;
    if (!old) throw notFound('Labour entry');
    await assertOpen(sql, old.date, input.date);
    let { wageCents, allowanceCents } = input;
    if (user.role === 'capture') {
      const r = (await ratesFor(sql, [input.workerId])).get(input.workerId)!;
      wageCents = Math.round(r.dayRateCents * input.days);
      allowanceCents = Math.round(r.allowanceCents * Math.ceil(input.days));
    }
    const [row] = await sql`
      update labour_entries set date = ${input.date}, worker_id = ${input.workerId}, project_id = ${input.projectId ?? null},
        work_type_id = ${input.workTypeId ?? null}, days = ${input.days}, wage_cents = ${wageCents}, allowance_cents = ${allowanceCents},
        note = ${input.note}
      where id = ${id} returning *`;
    await audit(sql, { userId: user.id, action: 'update', entity: 'labour', entityId: id, ip: req.ip });
    return row;
  });

  app.delete('/api/labour/:id', { preHandler: requireRole('owner', 'capture') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    await ownEntryOrOwner(user, 'labour_entries', id);
    const [old] = await sql<{ date: string }[]>`select date from labour_entries where id = ${id}`;
    if (!old) throw notFound('Labour entry');
    await assertOpen(sql, old.date);
    await sql`delete from labour_entries where id = ${id}`;
    await audit(sql, { userId: user.id, action: 'delete', entity: 'labour', entityId: id, ip: req.ip });
    return { ok: true };
  });

  app.post('/api/labour/allocate', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const input = parse(allocateInput, req.body);
    checkTarget(input.projectId, input.workTypeId);
    if (!input.projectId && !input.workTypeId) throw badRequest('Choose a job or a type of general work');
    const dates = await sql<{ date: string }[]>`select date from labour_entries where id = any(${input.ids}::uuid[])`;
    await assertOpen(sql, ...dates.map((d) => d.date));
    const res = await sql`
      update labour_entries set project_id = ${input.projectId ?? null}, work_type_id = ${input.workTypeId ?? null}
      where id = any(${input.ids}::uuid[])`;
    await audit(sql, { userId: user.id, action: 'allocate', entity: 'labour', ip: req.ip, details: { count: res.count, projectId: input.projectId, workTypeId: input.workTypeId } });
    return { updated: res.count };
  });

  // ---- wage payments
  app.post('/api/wage-payments', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const input = parse(wagePaymentInput, req.body);
    await assertOpen(sql, input.date);
    const [row] = await sql`insert into wage_payments ${sql({ ...input, createdBy: user.id })} returning *`;
    await audit(sql, { userId: user.id, action: 'create', entity: 'wage_payment', entityId: row!.id, ip: req.ip });
    return row;
  });
  app.put('/api/wage-payments/:id', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const input = parse(wagePaymentInput, req.body);
    const [old] = await sql<{ date: string }[]>`select date from wage_payments where id = ${id}`;
    if (!old) throw notFound('Payment');
    await assertOpen(sql, old.date, input.date);
    const [row] = await sql`update wage_payments set ${sql(input)} where id = ${id} returning *`;
    await audit(sql, { userId: user.id, action: 'update', entity: 'wage_payment', entityId: id, ip: req.ip });
    return row;
  });
  app.delete('/api/wage-payments/:id', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const [old] = await sql<{ date: string }[]>`select date from wage_payments where id = ${id}`;
    if (!old) throw notFound('Payment');
    await assertOpen(sql, old.date);
    await sql`delete from wage_payments where id = ${id}`;
    await audit(sql, { userId: user.id, action: 'delete', entity: 'wage_payment', entityId: id, ip: req.ip });
    return { ok: true };
  });

  // ---- savings held for a worker
  app.post('/api/savings', { preHandler: requireRole('owner') }, async (req) => {
    const input = parse(savingsInput, req.body);
    const [row] = await sql`insert into worker_savings ${sql(input)} returning *`;
    return row;
  });
  app.delete('/api/savings/:id', { preHandler: requireRole('owner') }, async (req) => {
    const { id } = parse(idParam, req.params);
    await sql`delete from worker_savings where id = ${id}`;
    return { ok: true };
  });
}
