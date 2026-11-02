/**
 * SARS travel logbook: every business trip (date, from, to, why, kilometres), and the odometer at
 * the start and end of the tax year (1 March to the end of February). The business share of the
 * kilometres is what a travel allowance or vehicle claim is worked out on.
 */
import type { FastifyInstance } from 'fastify';
import { financialYear, logbookYearInput, tripInput } from '@shap/shared';
import { z } from 'zod';
import { requireRole } from '../auth.js';
import type { Ctx } from '../context.js';
import { q, today, toCsv } from '../lib/books.js';
import { notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

const idParam = z.object({ id: z.string().uuid() });

export function registerLogbookRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;
  const owner = { preHandler: requireRole('owner') };
  const readers = { preHandler: requireRole('owner', 'accountant') };

  /** A tax year's logbook (SARS's year: March to February), with totals. CSV with ?format=csv. */
  app.get('/api/logbook', readers, async (req, reply) => {
    const { yearEnd: ye, format } = q(req);
    const year = financialYear(ye && /^\d{4}-\d{2}-\d{2}$/.test(ye) ? ye : today(), 2);
    const trips = await sql<{ id: string; date: string; fromPlace: string; toPlace: string; reason: string; km: number; business: boolean; projectId: string | null; projectName: string | null; clientName: string | null }[]>`
      select t.*, p.name as project_name, c.name as client_name from trips t
      left join projects p on p.id = t.project_id left join clients c on c.id = t.client_id
      where t.date between ${year.start}::date and ${year.end}::date order by t.date, t.created_at`;
    const [y] = await sql<{ vehicle: string; odometerStart: number | null; odometerEnd: number | null }[]>`select * from logbook_years where year_end = ${year.end}`;
    const businessKm = trips.filter((t) => t.business).reduce((s, t) => s + Number(t.km), 0);
    const loggedKm = trips.reduce((s, t) => s + Number(t.km), 0);
    const totalKm = y?.odometerStart != null && y?.odometerEnd != null ? Number(y.odometerEnd) - Number(y.odometerStart) : null;
    const summary = {
      year,
      vehicle: y?.vehicle ?? '',
      odometerStart: y?.odometerStart ?? null,
      odometerEnd: y?.odometerEnd ?? null,
      totalKm,
      loggedKm,
      businessKm,
      businessShare: totalKm && totalKm > 0 ? Math.min(1, businessKm / totalKm) : null,
    };
    if (format === 'csv') {
      const csv = toCsv(
        ['Date', 'From', 'To', 'Reason (who you saw, what for)', 'Kilometres', 'Business or private', 'Job'],
        trips.map((t) => [t.date, t.fromPlace, t.toPlace, t.reason, String(t.km), t.business ? 'Business' : 'Private', t.projectName ?? '']),
      );
      const head = toCsv(['Tax year', 'Vehicle', 'Odometer at start', 'Odometer at end', 'Total km', 'Business km', 'Business share'], [
        [year.label, summary.vehicle, String(summary.odometerStart ?? ''), String(summary.odometerEnd ?? ''), String(totalKm ?? ''), String(businessKm), summary.businessShare == null ? '' : `${Math.round(summary.businessShare * 1000) / 10}%`],
      ]);
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="Travel logbook ${year.label}.csv"`);
      return reply.send(`${head}\n${csv}`);
    }
    return { ...summary, trips };
  });

  app.put('/api/logbook/:yearEnd', owner, async (req) => {
    const { yearEnd } = parse(z.object({ yearEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), req.params);
    const input = parse(logbookYearInput, req.body);
    await sql`insert into logbook_years (year_end, vehicle, odometer_start, odometer_end) values (${yearEnd}, ${input.vehicle}, ${input.odometerStart}, ${input.odometerEnd})
              on conflict (year_end) do update set vehicle = excluded.vehicle, odometer_start = excluded.odometer_start, odometer_end = excluded.odometer_end`;
    return { ok: true };
  });

  app.post('/api/trips', owner, async (req) => {
    const input = parse(tripInput, req.body);
    const [row] = await sql`insert into trips ${sql({ ...input, projectId: input.projectId ?? null, clientId: input.clientId ?? null })} returning *`;
    return row;
  });
  app.put('/api/trips/:id', owner, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(tripInput, req.body);
    const [row] = await sql`update trips set ${sql({ ...input, projectId: input.projectId ?? null, clientId: input.clientId ?? null })} where id = ${id} returning *`;
    if (!row) throw notFound('Trip');
    return row;
  });
  app.delete('/api/trips/:id', owner, async (req) => {
    const { id } = parse(idParam, req.params);
    await sql`delete from trips where id = ${id}`;
    return { ok: true };
  });
  /** Places used before, for quick picking. */
  app.get('/api/trips/places', owner, async () => {
    const rows = await sql<{ place: string }[]>`
      select place from (select from_place as place, date from trips union all select to_place, date from trips) x
      where place <> '' group by place order by max(date) desc limit 30`;
    return rows.map((r) => r.place);
  });
}
