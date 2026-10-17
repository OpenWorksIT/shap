import type { FastifyInstance } from 'fastify';
import { clientInput } from '@shap/shared';
import { z } from 'zod';
import { requireRole, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import { pgCode, PG } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

const idParam = z.object({ id: z.string().uuid() });

/** Turnover, labour cost and gross profit per client, all time (the tracker's Clients sheet). */
export const clientStatsSql = `
  select c.id,
    coalesce(inv.total, 0)::bigint as invoiced_cents,
    coalesce(inv.outstanding, 0)::bigint as outstanding_cents,
    coalesce(lab.total, 0)::bigint as labour_cost_cents,
    coalesce(mat.total, 0)::bigint as other_cost_cents,
    coalesce(pr.n, 0)::int as project_count,
    inv.last_invoice
  from clients c
  left join lateral (
    select sum(d.subtotal_cents) as total,
           sum(d.total_cents - coalesce((select sum(r.amount_cents) from receipts r where r.invoice_id = d.id), 0)) as outstanding,
           max(d.issue_date) as last_invoice
    from documents d where d.kind = 'invoice' and d.status = 'issued' and d.client_id = c.id
  ) inv on true
  left join lateral (
    select sum(e.wage_cents + e.allowance_cents) as total from labour_entries e join projects p on p.id = e.project_id where p.client_id = c.id
  ) lab on true
  left join lateral (
    select sum(x.amount_cents - x.vat_cents) as total from costs x join projects p on p.id = x.project_id
    join cost_categories k on k.id = x.category_id
    where p.client_id = c.id and k.kind in ('materials', 'demo')
  ) mat on true
  left join lateral (select count(*) as n from projects p where p.client_id = c.id) pr on true
`;

export function registerClientRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;

  app.get('/api/clients', { preHandler: requireRole() }, async (req) => {
    const user = userOrThrow(req);
    if (user.role === 'capture') return sql`select id, code, name from clients where active order by name`;
    return sql.unsafe(`
      select c.*, s.invoiced_cents, s.outstanding_cents, s.labour_cost_cents, s.other_cost_cents, s.project_count, s.last_invoice,
             (s.invoiced_cents - s.labour_cost_cents - s.other_cost_cents)::bigint as gross_profit_cents
      from clients c join (${clientStatsSql}) s on s.id = c.id
      order by s.invoiced_cents desc, c.name
    `);
  });

  app.get('/api/clients/:id', { preHandler: requireRole('owner', 'accountant') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const [client] = await sql`select * from clients where id = ${id}`;
    if (!client) throw notFound('Client');
    const [stats] = await sql.unsafe(`select * from (${clientStatsSql}) s where s.id = $1`, [id]);
    const projects = await sql`select id, number, name, status, start_date from projects where client_id = ${id} order by number desc`;
    const documents = await sql`
      select d.id, d.kind, d.number, d.status, d.issue_date, d.total_cents, d.title, p.name as project_name,
        coalesce((select sum(r.amount_cents) from receipts r where r.invoice_id = d.id), 0)::bigint as paid_cents
      from documents d left join projects p on p.id = d.project_id
      where d.client_id = ${id} order by d.issue_date desc, d.created_at desc
    `;
    return { client, stats, projects, documents };
  });

  app.post('/api/clients', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const input = parse(clientInput, req.body);
    try {
      const [row] = await sql`insert into clients ${sql({ ...input, code: input.code || null })} returning *`;
      await audit(sql, { userId: user.id, action: 'create', entity: 'client', entityId: row!.id, ip: req.ip });
      return row;
    } catch (err) {
      if (pgCode(err) === PG.uniqueViolation) throw conflict('Another client already has that code');
      throw err;
    }
  });

  app.put('/api/clients/:id', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const input = parse(clientInput, req.body);
    try {
      const [row] = await sql`update clients set ${sql({ ...input, code: input.code || null })} where id = ${id} returning *`;
      if (!row) throw notFound('Client');
      await audit(sql, { userId: user.id, action: 'update', entity: 'client', entityId: id, ip: req.ip });
      return row;
    } catch (err) {
      if (pgCode(err) === PG.uniqueViolation) throw conflict('Another client already has that code');
      throw err;
    }
  });

  /**
   * Fill in client details from a CSV (for example an Invoice Ninja client export).
   * Matches on the client code/number first, then on the name; adds clients it can't match.
   */
  app.post('/api/clients/import-csv', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { csv } = parse(z.object({ csv: z.string().min(5).max(5_000_000) }), req.body);
    const rows = parseCsv(csv);
    if (rows.length < 2) throw badRequest('That file has no rows');
    const header = rows[0]!.map((h) => h.trim().toLowerCase());
    const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
    const ix = {
      name: col('name', 'client', 'client name', 'company'),
      code: col('number', 'client number', 'code', 'id number', 'client code', 'account'),
      email: col('email', 'contact email', 'client email'),
      phone: col('phone', 'work phone', 'contact phone', 'mobile'),
      contact: col('contact', 'contact name', 'contact first name'),
      address: col('address', 'address1', 'street', 'billing address'),
      city: col('city', 'town'),
      vat: col('vat number', 'vat', 'vat_number', 'tax number'),
    };
    if (ix.name < 0) throw badRequest('Couldn’t find a "Name" column');
    const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
    let updated = 0;
    let added = 0;
    await sql.begin(async (tx) => {
      for (const r of rows.slice(1)) {
        const name = get(r, ix.name);
        if (!name) continue;
        const code = get(r, ix.code);
        const address = [get(r, ix.address), get(r, ix.city)].filter(Boolean).join(', ');
        const patch = { email: get(r, ix.email), phone: get(r, ix.phone), contactPerson: get(r, ix.contact), address, vatNumber: get(r, ix.vat) };
        const [match] = await tx<{ id: string; name: string; code: string | null }[]>`
          select id, name, code from clients
          where (${code} <> '' and lower(code) = lower(${code})) or lower(name) = lower(${name}) order by (lower(code) = lower(${code})) desc limit 1
        `;
        if (match) {
          // A client imported from the tracker is named after its code until the real name arrives.
          const newName = match.name === match.code ? name : match.name;
          await tx`update clients set name = ${newName},
            email = case when ${patch.email} <> '' then ${patch.email} else email end,
            phone = case when ${patch.phone} <> '' then ${patch.phone} else phone end,
            contact_person = case when ${patch.contactPerson} <> '' then ${patch.contactPerson} else contact_person end,
            address = case when ${patch.address} <> '' then ${patch.address} else address end,
            vat_number = case when ${patch.vatNumber} <> '' then ${patch.vatNumber} else vat_number end
            where id = ${match.id}`;
          updated++;
        } else {
          await tx`insert into clients ${tx({ name, code: code || null, ...patch })}`;
          added++;
        }
      }
      await audit(tx, { userId: user.id, action: 'import_csv', entity: 'client', ip: req.ip, details: { updated, added } });
    });
    return { updated, added };
  });
}

/** Minimal RFC 4180 CSV reader (quoted fields, embedded commas and newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}
