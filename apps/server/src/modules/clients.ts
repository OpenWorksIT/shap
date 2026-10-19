import type { FastifyInstance } from 'fastify';
import { clientInput } from '@shap/shared';
import { z } from 'zod';
import { requireRole, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import { paymentStateSql } from './documents.js';
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
           sum(d.total_cents - d.written_off_cents - coalesce((select sum(r.amount_cents) from receipts r where r.invoice_id = d.id), 0)) as outstanding,
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
      select d.id, d.kind, d.number, d.status, d.issue_date, d.total_cents, d.written_off_cents, d.title, p.name as project_name,
        coalesce(r.paid, 0)::bigint as paid_cents, ${sql.unsafe(paymentStateSql)} as payment_state
      from documents d left join projects p on p.id = d.project_id
      left join lateral (select sum(amount_cents) as paid from receipts where invoice_id = d.id) r on true
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
   * Fill in client details from a CSV (an Invoice Ninja client export, or any CSV with a Name
   * column). Step 1 suggests which existing client each row is; step 2 applies what you confirm.
   */
  app.post('/api/clients/import-csv/preview', { preHandler: requireRole('owner') }, async (req) => {
    const { csv } = parse(z.object({ csv: z.string().min(5).max(5_000_000) }), req.body);
    const rows = readClientCsv(csv);
    const clients = await sql<MatchClient[]>`
      select c.id, c.code, c.name, coalesce(array_agg(p.name) filter (where p.id is not null), '{}') as projects
      from clients c left join projects p on p.client_id = c.id group by c.id order by c.name`;
    const jobsWithoutClient = await sql<{ id: string; name: string }[]>`select id, name from projects where client_id is null order by number`;
    const matched = suggestMatches(rows, clients);
    // Jobs with no client yet: suggest the row whose name appears in the job's name.
    const jobs = jobsWithoutClient.map((j) => {
      const jw = new Set(words(j.name));
      const row = matched.find((r) => words(r.name).filter((w) => w.length >= 4 && !['road', 'body', 'corp', 'ltd'].includes(w)).some((w) => jw.has(w)));
      return { ...j, suggestedRow: row?.index ?? null };
    });
    return { rows: matched, clients: clients.map((c) => ({ id: c.id, code: c.code, name: c.name, projects: c.projects.slice(0, 4) })), jobsWithoutClient: jobs };
  });

  app.post('/api/clients/import-csv', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const input = parse(
      z.object({
        csv: z.string().min(5).max(5_000_000),
        // row index → existing client id, 'new' or 'skip'
        matches: z.record(z.string(), z.union([z.string().uuid(), z.literal('new'), z.literal('skip')])),
        // job id → client row index: link jobs that had no client
        jobs: z.record(z.string().uuid(), z.number().int().min(0)).default({}),
      }),
      req.body,
    );
    const rows = readClientCsv(input.csv);
    let updated = 0;
    let added = 0;
    let linked = 0;
    await sql.begin(async (tx) => {
      const idForRow = new Map<number, string>();
      for (const r of rows) {
        const m = input.matches[String(r.index)] ?? 'skip';
        if (m === 'skip') continue;
        const fields = { contactPerson: r.contact, email: r.email, phone: r.phone, address: r.address, vatNumber: r.vatNumber };
        if (m === 'new') {
          const [row] = await tx<{ id: string }[]>`insert into clients ${tx({ name: r.name, code: null, ...fields, notes: r.ref ? `Invoice Ninja no. ${r.ref}` : '' })} returning id`;
          idForRow.set(r.index, row!.id);
          added++;
        } else {
          await tx`update clients set name = ${r.name},
            email = case when ${r.email} <> '' then ${r.email} else email end,
            phone = case when ${r.phone} <> '' then ${r.phone} else phone end,
            contact_person = case when ${r.contact} <> '' then ${r.contact} else contact_person end,
            address = case when ${r.address} <> '' then ${r.address} else address end,
            vat_number = case when ${r.vatNumber} <> '' then ${r.vatNumber} else vat_number end
            where id = ${m}`;
          idForRow.set(r.index, m);
          updated++;
        }
      }
      for (const [jobId, rowIndex] of Object.entries(input.jobs)) {
        const clientId = idForRow.get(rowIndex);
        if (!clientId) continue;
        const res = await tx`update projects set client_id = ${clientId} where id = ${jobId} and client_id is null`;
        await tx`update documents set client_id = ${clientId} where project_id = ${jobId} and client_id is null`;
        linked += res.count;
      }
      await audit(tx, { userId: user.id, action: 'import_csv', entity: 'client', ip: req.ip, details: { updated, added, linked } });
    });
    return { updated, added, linked };
  });
}

export interface ClientCsvRow {
  index: number;
  name: string;
  contact: string;
  email: string;
  phone: string;
  address: string;
  vatNumber: string;
  ref: string;
}

/** Reads a client CSV, Invoice Ninja's export or any with a Name column. */
export function readClientCsv(csv: string): ClientCsvRow[] {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw badRequest('That file has no rows');
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  // First heading in the list that exists wins (so "Contact Phone" beats an empty "Client Phone").
  const col = (...names: string[]) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
  const ix = {
    name: col('name', 'client', 'client name', 'company'),
    ref: col('number', 'client number', 'code', 'client code', 'account'),
    email: col('email', 'contact email', 'client email'),
    phone: col('contact phone', 'client phone', 'phone', 'work phone', 'mobile'),
    phone2: col('client phone', 'phone'),
    first: col('first name', 'contact first name'),
    last: col('last name', 'contact last name'),
    contact: col('contact', 'contact name'),
    street: col('street', 'address', 'address1', 'billing address'),
    suite: col('apt/suite', 'address2'),
    city: col('city', 'town'),
    postal: col('postal code', 'postcode', 'zip'),
    vat: col('vat number', 'vat', 'vat_number', 'tax number'),
  };
  if (ix.name < 0 && ix.first < 0) throw badRequest('Couldn’t find a "Name" column');
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  const out: ClientCsvRow[] = [];
  rows.slice(1).forEach((r, i) => {
    const contact = get(r, ix.contact) || [get(r, ix.first), get(r, ix.last)].filter(Boolean).join(' ');
    const name = get(r, ix.name) || contact;
    if (!name) return;
    const city = [get(r, ix.city), get(r, ix.postal)].filter(Boolean).join(' ');
    out.push({
      index: i,
      name,
      contact: contact === name ? '' : contact,
      email: get(r, ix.email),
      phone: get(r, ix.phone) || get(r, ix.phone2),
      address: [get(r, ix.street), get(r, ix.suite), city].filter(Boolean).join('\n'),
      vatNumber: get(r, ix.vat).replace(/^vat[:\s]*/i, ''),
      ref: get(r, ix.ref),
    });
  });
  return out;
}

interface MatchClient {
  id: string;
  code: string | null;
  name: string;
  projects: string[];
}

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);

/**
 * Suggests which existing client a CSV row is. Clients imported from a tracker are named by
 * code (Naidoo001), so the clues are: the code's letters at the start of the surname or company,
 * the person's name or street address in the client's job names ("Naidoo patio", "12 Oak Street eaves").
 */
export function suggestMatches(rows: ClientCsvRow[], clients: MatchClient[]) {
  const scored = rows.map((r) => {
    // The client's own name counts for more than the contact person's (a company's contact may be someone you know from other jobs).
    const nameWords = words(r.name);
    const contactWords = words(r.contact).filter((w) => !nameWords.includes(w));
    // "du Toit" → "dutoit", so a code like Dut001 still lines up.
    const surname = (n: string) => {
      const parts = n.toLowerCase().split(/\s+/).filter(Boolean);
      return parts.length > 1 ? parts.slice(1).join('').replace(/[^a-z]/g, '') : '';
    };
    const joined = surname(r.name);
    const contactJoined = surname(r.contact);
    const addr = r.address.toLowerCase();
    const streetNo = addr.match(/^(\d+)\s+([a-z]+)/);
    let best: { id: string; score: number; reason: string } | null = null;
    let second = 0;
    for (const c of clients) {
      let score = 0;
      const reasons: string[] = [];
      if (c.name.toLowerCase() === r.name.toLowerCase()) (score += 10), reasons.push('same name');
      if (c.code && r.ref && c.code.toLowerCase() === r.ref.toLowerCase()) (score += 10), reasons.push('same number');
      const prefix = (c.code ?? '').toLowerCase().match(/^[a-z]+/)?.[0];
      if (prefix && prefix.length >= 3) {
        if (nameWords.some((w) => w.startsWith(prefix)) || (joined && joined.startsWith(prefix))) (score += 3), reasons.push(`code ${c.code}`);
        else if (contactWords.some((w) => w.startsWith(prefix)) || (contactJoined && contactJoined.startsWith(prefix))) score += 1;
      }
      const jobText = c.projects.join(' ').toLowerCase();
      const inJobs = (w: string) => new RegExp(`\\b${w}\\b`).test(jobText);
      const hit = nameWords.find(inJobs);
      if (hit) (score += 4), reasons.push(`job “${c.projects.find((p) => p.toLowerCase().includes(hit))}”`);
      else if (contactWords.some(inJobs)) score += 2;
      if (streetNo && new RegExp(`\\b${streetNo[1]}\\s+${streetNo[2]}`).test(jobText)) (score += 6), reasons.push('street address in a job name');
      if (score > (best?.score ?? 0)) {
        second = best?.score ?? 0;
        best = { id: c.id, score, reason: reasons.join(', ') };
      } else if (score > second) second = score;
    }
    const sure = best && best.score >= 3 && best.score > second;
    return { ...r, suggestion: sure ? { clientId: best!.id, reason: best!.reason, score: best!.score } : null };
  });
  // One client per row: if two rows want the same client, keep the stronger one.
  const taken = new Map<string, number>();
  for (const r of scored) {
    if (!r.suggestion) continue;
    const prev = taken.get(r.suggestion.clientId);
    if (prev == null || scored[prev]!.suggestion!.score < r.suggestion.score) {
      if (prev != null) scored[prev]!.suggestion = null;
      taken.set(r.suggestion.clientId, scored.indexOf(r));
    } else r.suggestion = null;
  }
  return scored;
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
