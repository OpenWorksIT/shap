/**
 * Archiving a closed year: once the books for a year are locked (the accountant's done, the tax
 * is paid), its slip photos are squeezed smaller still. The phone or browser does the squeezing
 * (it has the image tools); this hands it the photos and takes the smaller ones back.
 */
import type { FastifyInstance } from 'fastify';
import { addDays, financialYear } from '@shap/shared';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { requireRole, userOrThrow } from '../auth.js';
import { audit } from '../lib/audit.js';
import type { Ctx } from '../context.js';
import { getSettings } from '../lib/books.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { wholeJpeg } from '../lib/images.js';

const fyParam = z.object({ fyEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const replaceInput = z.object({ dataBase64: z.string().min(10), mime: z.literal('image/jpeg') });

export function registerArchiveRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;
  const owner = { preHandler: requireRole('owner') };

  /** Each financial year with slips: how many, how much space, locked, archived. */
  app.get('/api/archive', owner, async () => {
    const settings = await getSettings(sql);
    const rows = await sql<{ date: string; size: number; mime: string }[]>`
      select c.date, a.size, a.mime from costs c join attachments a on a.id = c.receipt_id`;
    const archived = await sql<{ fyEnd: string; archivedAt: string; photos: number; bytesBefore: number; bytesAfter: number }[]>`select * from archived_years`;
    const years = new Map<string, { fyEnd: string; label: string; slips: number; bytes: number }>();
    for (const r of rows) {
      const fy = financialYear(r.date, settings.fyEndMonth);
      const y = years.get(fy.end) ?? { fyEnd: fy.end, label: fy.label, slips: 0, bytes: 0 };
      y.slips++;
      y.bytes += Number(r.size);
      years.set(fy.end, y);
    }
    const [total] = await sql<{ bytes: number }[]>`select coalesce(sum(size), 0)::bigint as bytes from attachments`;
    return {
      lockDate: settings.lockDate,
      totalBytes: Number(total!.bytes),
      years: [...years.values()]
        .sort((a, b) => b.fyEnd.localeCompare(a.fyEnd))
        .map((y) => ({ ...y, locked: Boolean(settings.lockDate && settings.lockDate >= y.fyEnd), archived: archived.find((a) => a.fyEnd === y.fyEnd) ?? null })),
    };
  });

  /** The year's photos (not PDFs) to squeeze. */
  app.get('/api/archive/:fyEnd/photos', owner, async (req) => {
    const { fyEnd } = parse(fyParam, req.params);
    const settings = await getSettings(sql);
    const fy = financialYear(fyEnd, settings.fyEndMonth);
    return sql<{ id: string; size: number; mime: string }[]>`
      select distinct a.id, a.size, a.mime from costs c join attachments a on a.id = c.receipt_id
      where c.date between ${fy.start}::date and ${fy.end}::date and a.mime like 'image/%'`;
  });

  /**
   * A smaller version of one slip photo in a closed year (archiving). Kept only if it really is
   * smaller and reads as a whole JPEG; the swap is in the audit log with both files' hashes.
   */
  app.put('/api/attachments/:id', owner, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const input = parse(replaceInput, req.body);
    const bytes = Buffer.from(input.dataBase64, 'base64');
    if (!wholeJpeg(bytes)) throw badRequest('That isn’t a JPEG photo');
    const [old] = await sql<{ size: number; mime: string; bytes: Buffer }[]>`select size, mime, bytes from attachments where id = ${id}`;
    if (!old) throw notFound('File');
    if (!old.mime.startsWith('image/')) throw badRequest('Only photos can be made smaller');
    const { lockDate, fyEndMonth } = await getSettings(sql);
    // A closed year, not only a closed month: the last financial year end on or before the lock.
    const fy = lockDate ? financialYear(String(lockDate), fyEndMonth) : null;
    const closedYearEnd = fy ? (fy.end === String(lockDate) ? fy.end : addDays(fy.start, -1)) : null;
    const [slip] = closedYearEnd ? await sql`select 1 from costs where receipt_id = ${id} and date <= ${closedYearEnd}::date limit 1` : [];
    if (!slip) throw badRequest('Only slips in a closed year are made smaller');
    if (bytes.length >= Number(old.size)) return { kept: false, size: Number(old.size) };
    const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    await sql.begin(async (tx) => {
      await tx`update attachments set bytes = ${bytes}, size = ${bytes.length}, mime = 'image/jpeg',
                filename = regexp_replace(filename, '\\.\\w+$', '') || '.jpg' where id = ${id}`;
      await audit(tx, { userId: user.id, action: 'shrink', entity: 'attachment', entityId: id, ip: req.ip, details: { before: hash(old.bytes), after: hash(bytes), bytesBefore: Number(old.size), bytesAfter: bytes.length } });
    });
    return { kept: true, size: bytes.length };
  });

  /** Marks a locked year archived, and gives the space back. */
  app.post('/api/archive/:fyEnd', owner, async (req) => {
    const { fyEnd } = parse(fyParam, req.params);
    const settings = await getSettings(sql);
    if (financialYear(fyEnd, settings.fyEndMonth).end !== fyEnd) throw badRequest('That isn’t the last day of a financial year');
    if (!settings.lockDate || settings.lockDate < fyEnd) throw badRequest('Lock the year first (Accounts → Locks), so nothing in it can change.');
    const body = parse(z.object({ photos: z.number().int().min(0), bytesBefore: z.number().int().min(0), bytesAfter: z.number().int().min(0) }), req.body);
    await sql`insert into archived_years (fy_end, photos, bytes_before, bytes_after) values (${fyEnd}, ${body.photos}, ${body.bytesBefore}, ${body.bytesAfter})
              on conflict (fy_end) do update set archived_at = now(), photos = excluded.photos,
                bytes_before = greatest(archived_years.bytes_before, excluded.bytes_before), bytes_after = excluded.bytes_after`;
    // Hand the freed space back (outside any transaction).
    await sql`vacuum attachments`;
    return { ok: true };
  });
}
