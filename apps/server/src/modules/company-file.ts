/**
 * The company file: everything that sets Shap up for a company, without its day-to-day records.
 * Trading names (with logos), company details, numbering and terms, the chart of accounts and
 * lists, clients, and the accountant's agreed year ends. Use it to move a setup from the test
 * stack to the real server, keep a copy, or set up from a prepared file.
 *
 * Restoring merges: things are matched by name (accounts by code, clients by code then name)
 * and updated; nothing is deleted.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Tx } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { getSettings } from '../lib/books.js';
import { badRequest } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

const FORMAT = 'shap-company/1';

const str = z.string().max(4000).default('');
const logo = z.object({ mime: z.enum(['image/png', 'image/jpeg']), dataBase64: z.string().max(8_000_000) }).nullable().default(null);
const fileSchema = z.object({
  format: z.literal(FORMAT),
  settings: z.record(z.string(), z.unknown()).default({}),
  defaultBrand: z.string().nullable().default(null),
  brands: z
    .array(z.object({ name: z.string().min(1), legalLine: str, email: str, phone: str, website: str, address: str, bankDetails: str, accent: z.string().default('#e8731c'), active: z.boolean().default(true), logo }))
    .default([]),
  accounts: z.array(z.object({ code: z.string().min(1), name: z.string().min(1), type: z.enum(['asset', 'liability', 'equity', 'income', 'cost_of_sales', 'expense']), active: z.boolean().default(true) })).default([]),
  sources: z.array(z.object({ name: z.string().min(1), kind: z.enum(['bank', 'card', 'cash', 'owner', 'other']), account: z.string(), active: z.boolean().default(true) })).default([]),
  categories: z.array(z.object({ name: z.string().min(1), kind: z.enum(['materials', 'demo', 'overhead', 'asset', 'personal']), account: z.string(), active: z.boolean().default(true) })).default([]),
  workTypes: z.array(z.object({ name: z.string().min(1), active: z.boolean().default(true) })).default([]),
  clients: z
    .array(z.object({ code: z.string().nullable().default(null), name: z.string().min(1), contactPerson: str, email: str, phone: str, address: str, vatNumber: str, notes: str, brand: z.string().nullable().default(null), active: z.boolean().default(true) }))
    .default([]),
  /** Jobs to link to a client or trading name, by job name (applied when the jobs exist). */
  jobs: z.array(z.object({ name: z.string(), client: z.string().nullable().default(null), brand: z.string().nullable().default(null) })).default([]),
  /** Agreed year ends: amounts by account code, debit positive (as in the ledger). */
  yearEnds: z.array(z.object({ fyEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: str, figures: z.record(z.string(), z.number().int()) })).default([]),
});
export type CompanyFile = z.input<typeof fileSchema>;

const SETTINGS_KEYS = [
  'companyName', 'tradingName', 'regNumber', 'vatNumber', 'address', 'phone', 'email', 'website', 'bankDetails', 'vatRegistered', 'vatRateBp', 'fyEndMonth',
  'invoicePrefix', 'invoicePad', 'quotePrefix', 'quotePad', 'paymentDays', 'quoteValidDays', 'invoiceTerms', 'quoteTerms', 'markupBp', 'lockDate',
] as const;
const SETTINGS_COLUMNS: Record<(typeof SETTINGS_KEYS)[number], string> = {
  companyName: 'company_name', tradingName: 'trading_name', regNumber: 'reg_number', vatNumber: 'vat_number', address: 'address', phone: 'phone', email: 'email',
  website: 'website', bankDetails: 'bank_details', vatRegistered: 'vat_registered', vatRateBp: 'vat_rate_bp', fyEndMonth: 'fy_end_month', invoicePrefix: 'invoice_prefix',
  invoicePad: 'invoice_pad', quotePrefix: 'quote_prefix', quotePad: 'quote_pad', paymentDays: 'payment_days', quoteValidDays: 'quote_valid_days',
  invoiceTerms: 'invoice_terms', quoteTerms: 'quote_terms', markupBp: 'markup_bp', lockDate: 'lock_date',
};

export async function exportCompanyFile(tx: Tx | import('../db/index.js').Sql): Promise<CompanyFile> {
  const settings = await getSettings(tx);
  const brands = await tx<{ id: string; name: string; legalLine: string; email: string; phone: string; website: string; address: string; bankDetails: string; accent: string; active: boolean; logoMime: string | null; logoBytes: Buffer | null }[]>`
    select b.*, a.mime as logo_mime, a.bytes as logo_bytes from brands b left join attachments a on a.id = b.logo_id order by b.sort`;
  const accounts = await tx<{ code: string; name: string; type: 'asset'; active: boolean }[]>`select code, name, type, active from accounts order by code`;
  const sources = await tx<{ name: string; kind: 'bank'; account: string; active: boolean }[]>`select s.name, s.kind, a.code as account, s.active from payment_sources s join accounts a on a.id = s.account_id order by s.sort`;
  const categories = await tx<{ name: string; kind: 'overhead'; account: string; active: boolean }[]>`select c.name, c.kind, a.code as account, c.active from cost_categories c join accounts a on a.id = c.account_id order by c.sort`;
  const workTypes = await tx<{ name: string; active: boolean }[]>`select name, active from work_types order by sort`;
  const clients = await tx<{ code: string | null; name: string; contactPerson: string; email: string; phone: string; address: string; vatNumber: string; notes: string; brand: string | null; active: boolean }[]>`
    select c.code, c.name, c.contact_person, c.email, c.phone, c.address, c.vat_number, c.notes, b.name as brand, c.active
    from clients c left join brands b on b.id = c.brand_id order by c.name`;
  const jobs = await tx<{ name: string; client: string | null; brand: string | null }[]>`
    select p.name, coalesce(c.code, c.name) as client, b.name as brand from projects p left join clients c on c.id = p.client_id left join brands b on b.id = p.brand_id
    where p.brand_id is not null order by p.number`;
  const ye = await tx<{ fyEnd: string; note: string }[]>`select fy_end, note from year_ends order by fy_end`;
  const yearEnds = [];
  for (const y of ye) {
    const figs = await tx<{ code: string; amountCents: number }[]>`select a.code, f.amount_cents from year_end_figures f join accounts a on a.id = f.account_id where f.fy_end = ${y.fyEnd}`;
    yearEnds.push({ fyEnd: y.fyEnd, note: y.note, figures: Object.fromEntries(figs.map((f) => [f.code, f.amountCents])) });
  }
  const s = settings as unknown as Record<string, unknown>;
  return {
    format: FORMAT,
    settings: Object.fromEntries(SETTINGS_KEYS.map((k) => [k, s[k]])),
    defaultBrand: brands.find((b) => b.id === settings.defaultBrandId)?.name ?? null,
    brands: brands.map((b) => ({
      name: b.name, legalLine: b.legalLine, email: b.email, phone: b.phone, website: b.website, address: b.address, bankDetails: b.bankDetails, accent: b.accent, active: b.active,
      logo: b.logoBytes ? { mime: b.logoMime as 'image/png', dataBase64: b.logoBytes.toString('base64') } : null,
    })),
    accounts,
    sources,
    categories,
    workTypes,
    clients,
    jobs,
    yearEnds,
  };
}

export async function restoreCompanyFile(tx: Tx, raw: unknown) {
  const file = parse(fileSchema, raw);
  const done: Record<string, number> = {};
  const count = (k: string) => (done[k] = (done[k] ?? 0) + 1);

  // Company details
  for (const k of SETTINGS_KEYS) {
    if (!(k in file.settings)) continue;
    const v = file.settings[k];
    if (k === 'lockDate') {
      if (typeof v === 'string' && v) await tx`update settings set lock_date = greatest(coalesce(lock_date, ${v}::date), ${v}::date) where id`;
      continue;
    }
    await tx`update settings set ${tx(SETTINGS_COLUMNS[k])} = ${v as never} where id`;
  }

  // Trading names
  for (const b of file.brands) {
    const [row] = await tx<{ id: string }[]>`
      insert into brands (name, legal_line, email, phone, website, address, bank_details, accent, active, sort)
      values (${b.name}, ${b.legalLine}, ${b.email}, ${b.phone}, ${b.website}, ${b.address}, ${b.bankDetails}, ${b.accent}, ${b.active}, (select coalesce(max(sort), 0) + 1 from brands))
      on conflict (name) do update set legal_line = excluded.legal_line, email = excluded.email, phone = excluded.phone, website = excluded.website,
        address = excluded.address, bank_details = excluded.bank_details, accent = excluded.accent, active = excluded.active
      returning id`;
    if (b.logo) {
      const bytes = Buffer.from(b.logo.dataBase64, 'base64');
      const [a] = await tx<{ id: string }[]>`insert into attachments (filename, mime, size, bytes) values (${`${b.name} logo`}, ${b.logo.mime}, ${bytes.length}, ${bytes}) returning id`;
      await tx`update brands set logo_id = ${a!.id} where id = ${row!.id}`;
    }
    count('brands');
  }
  if (file.defaultBrand) await tx`update settings set default_brand_id = (select id from brands where name = ${file.defaultBrand}) where id`;
  // The placeholder trading name a new install starts with goes once real ones arrive.
  if (file.brands.length) {
    await tx`update brands set active = false where name = 'My company' and not exists (select 1 from documents d where d.brand_id = brands.id)
      and name <> all(${file.brands.map((b) => b.name)})`;
  }

  // Accounts and lists
  for (const a of file.accounts) {
    await tx`insert into accounts (code, name, type, active) values (${a.code}, ${a.name}, ${a.type}, ${a.active})
      on conflict (code) do update set name = excluded.name, active = excluded.active`;
  }
  const acc = async (code: string) => {
    const [r] = await tx<{ id: string }[]>`select id from accounts where code = ${code}`;
    if (!r) throw badRequest(`The company file refers to account ${code}, which isn’t in the chart of accounts`);
    return r.id;
  };
  for (const s of file.sources) {
    await tx`insert into payment_sources (name, kind, account_id, active, sort) values (${s.name}, ${s.kind}, ${await acc(s.account)}, ${s.active}, (select coalesce(max(sort), 0) + 1 from payment_sources))
      on conflict (name) do update set kind = excluded.kind, account_id = excluded.account_id, active = excluded.active`;
  }
  for (const c of file.categories) {
    await tx`insert into cost_categories (name, kind, account_id, active, sort) values (${c.name}, ${c.kind}, ${await acc(c.account)}, ${c.active}, (select coalesce(max(sort), 0) + 1 from cost_categories))
      on conflict (name) do update set kind = excluded.kind, account_id = excluded.account_id, active = excluded.active`;
  }
  for (const w of file.workTypes) {
    await tx`insert into work_types (name, active, sort) values (${w.name}, ${w.active}, (select coalesce(max(sort), 0) + 1 from work_types)) on conflict (name) do update set active = excluded.active`;
  }

  // Clients: by code, else by name
  for (const c of file.clients) {
    const [found] = await tx<{ id: string }[]>`
      select id from clients where (${c.code}::text is not null and lower(code) = lower(${c.code})) or (${c.code}::text is null and lower(name) = lower(${c.name})) limit 1`;
    const brandId = c.brand ? ((await tx<{ id: string }[]>`select id from brands where name = ${c.brand}`)[0]?.id ?? null) : null;
    const fields = { name: c.name, contactPerson: c.contactPerson, email: c.email, phone: c.phone, address: c.address, vatNumber: c.vatNumber, notes: c.notes, brandId, active: c.active };
    if (found) await tx`update clients set ${tx(fields)} where id = ${found.id}`;
    else await tx`insert into clients ${tx({ ...fields, code: c.code })}`;
    count('clients');
  }
  for (const j of file.jobs) {
    if (j.client) {
      const r = await tx`update projects set client_id = (select id from clients where lower(code) = lower(${j.client}) or lower(name) = lower(${j.client}) limit 1)
        where lower(name) = lower(${j.name}) and client_id is null`;
      await tx`update documents set client_id = p.client_id from projects p where documents.project_id = p.id and lower(p.name) = lower(${j.name}) and documents.client_id is null`;
      if (r.count) count('jobsLinked');
    }
    if (j.brand) {
      const r = await tx`update projects set brand_id = (select id from brands where name = ${j.brand}) where lower(name) = lower(${j.name})`;
      await tx`update documents set brand_id = (select id from brands where name = ${j.brand})
        where project_id in (select id from projects where lower(name) = lower(${j.name}))`;
      if (r.count) count('jobsBranded');
    }
  }

  // Documents without a trading name (an imported tracker's invoices) take the usual one now,
  // so their PDFs don't change if the default changes later.
  await tx`update documents d set brand_id = coalesce(
      (select brand_id from projects where id = d.project_id),
      (select brand_id from clients where id = d.client_id),
      (select default_brand_id from settings where id))
    where d.brand_id is null`;

  // Agreed year ends
  for (const y of file.yearEnds) {
    await tx`insert into year_ends (fy_end, note) values (${y.fyEnd}, ${y.note}) on conflict (fy_end) do update set note = excluded.note`;
    await tx`delete from year_end_figures where fy_end = ${y.fyEnd}`;
    // The tracker's own trial-balance journal is superseded by the accountant's figures.
    await tx`delete from journals where kind = 'import' and date <= ${y.fyEnd}::date`;
    for (const [code, cents] of Object.entries(y.figures)) {
      await tx`insert into year_end_figures (fy_end, account_id, amount_cents) values (${y.fyEnd}, ${await acc(code)}, ${cents})`;
    }
    await tx`update settings set lock_date = greatest(coalesce(lock_date, ${y.fyEnd}::date), ${y.fyEnd}::date) where id`;
    count('yearEnds');
  }
  return done;
}

export function registerCompanyFileRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;
  app.get('/api/company-file', { preHandler: requireRole('owner') }, async (req, reply) => {
    const file = await exportCompanyFile(sql);
    const name = String((file.settings as Record<string, unknown>).companyName ?? 'company').replace(/[^\w -]/g, '').trim() || 'company';
    reply.header('content-type', 'application/json; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${name} - Shap company file.json"`);
    return reply.send(JSON.stringify(file, null, 1));
  });

  app.post('/api/company-file', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { file } = parse(z.object({ file: z.unknown() }), req.body);
    const result = await sql.begin(async (tx) => {
      const r = await restoreCompanyFile(tx, file);
      await audit(tx, { userId: user.id, action: 'restore_company_file', entity: 'settings', ip: req.ip, details: r });
      return r;
    });
    return { restored: result };
  });
}
