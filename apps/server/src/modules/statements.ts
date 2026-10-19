/**
 * The bank's own monthly statements (PDFs), kept on file for your records and the accountant.
 * Accounts marked "statements required" are checked for missing months, shown on Home.
 */
import type { FastifyInstance } from 'fastify';
import { addMonths, financialYear, statementFileInput } from '@shap/shared';
import { z } from 'zod';
import { requireRole, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { getSettings, today } from '../lib/books.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { saveAttachment } from './settings.js';

const firstOfMonth = (iso: string) => `${iso.slice(0, 7)}-01`;

/** Months (YYYY-MM) with no statement on file, per account that needs them, up to last month. */
export async function missingStatements(db: Db): Promise<{ sourceId: string; sourceName: string; months: string[] }[]> {
  const settings = await getSettings(db);
  const sources = await db<{ id: string; name: string; statementsFrom: string | null }[]>`
    select id, name, statements_from::text from payment_sources where statements_required and active order by sort, name`;
  if (!sources.length) return [];
  const lastMonth = firstOfMonth(addMonths(today(), -1));
  const have = await db<{ sourceId: string; month: string }[]>`
    select distinct source_id, to_char(month, 'YYYY-MM') as month from statement_files where source_id = any(${sources.map((s) => s.id)}::uuid[])`;
  const got = new Set(have.map((h) => `${h.sourceId}|${h.month}`));
  const out = [];
  for (const s of sources) {
    let m = firstOfMonth(s.statementsFrom ?? financialYear(today(), settings.fyEndMonth).start);
    const months: string[] = [];
    for (let i = 0; m <= lastMonth && i < 120; i++, m = firstOfMonth(addMonths(m, 1))) {
      if (!got.has(`${s.id}|${m.slice(0, 7)}`)) months.push(m.slice(0, 7));
    }
    if (months.length) out.push({ sourceId: s.id, sourceName: s.name, months });
  }
  return out;
}

export function registerStatementRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;

  app.get('/api/statement-files', { preHandler: requireRole('owner', 'accountant') }, async () => {
    const files = await sql`
      select f.id, f.source_id, s.name as source_name, to_char(f.month, 'YYYY-MM') as month, f.filename, f.attachment_id, f.created_at
      from statement_files f join payment_sources s on s.id = f.source_id order by f.month desc, s.name`;
    return { files, missing: await missingStatements(sql) };
  });

  app.post('/api/statement-files', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const input = parse(statementFileInput, req.body);
    const bytes = Buffer.from(input.dataBase64.slice(0, 16), 'base64');
    if (!bytes.toString('latin1').startsWith('%PDF')) throw badRequest('That isn’t a PDF');
    const [src] = await sql`select 1 from payment_sources where id = ${input.sourceId}`;
    if (!src) throw badRequest('Choose the account');
    const row = await sql.begin(async (tx) => {
      const attachmentId = await saveAttachment(tx, { filename: input.filename, mime: 'application/pdf', dataBase64: input.dataBase64 });
      const [r] = await tx<{ id: string }[]>`
        insert into statement_files (source_id, month, attachment_id, filename, uploaded_by)
        values (${input.sourceId}, ${`${input.month}-01`}, ${attachmentId}, ${input.filename}, ${user.id}) returning id`;
      await audit(tx, { userId: user.id, action: 'upload', entity: 'statement_file', entityId: r!.id, ip: req.ip, details: { month: input.month } });
      return r!;
    });
    return row;
  });

  app.delete('/api/statement-files/:id', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const [f] = await sql<{ attachmentId: string }[]>`delete from statement_files where id = ${id} returning attachment_id`;
    if (!f) throw notFound('Statement');
    await sql`delete from attachments where id = ${f.attachmentId}`;
    await audit(sql, { userId: user.id, action: 'delete', entity: 'statement_file', entityId: id, ip: req.ip });
    return { ok: true };
  });
}
