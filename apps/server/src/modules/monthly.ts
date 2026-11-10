/**
 * Monthly invoices: an invoice that goes out again every month (hosting, maintenance, a
 * retainer). On its day each month Shap copies the latest invoice in the series (so a change
 * carries on), with the next number and the month brought up to date in its wording, then
 * either issues and emails it, or leaves it as a draft for you to check and send.
 *
 * Each month's invoice is an ordinary invoice: payments, statements and the books treat it the
 * same. One per schedule per month at most (a unique index makes sure); if the server was off
 * on the day it catches up, up to three months back.
 */
import type { FastifyInstance } from 'fastify';
import { addMonths, monthEnd } from '@shap/shared';
import { z } from 'zod';
import { requireAccess, requireRole, userOrThrow } from '../auth.js';
import { checkInUsage } from './feedback.js';
import { shareMarketRates } from './market.js';
import type { Ctx } from '../context.js';
import type { Db, Sql } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { assertOpen, today } from '../lib/books.js';
import { badRequest, notFound } from '../lib/errors.js';
import type { Mailer } from '../lib/mailer.js';
import { parse } from '../lib/validate.js';
import { assertTaxDocument, createDocument, emailDocument, loadDocument, syncProjectStatus } from './documents.js';

const ym = (iso: string) => iso.slice(0, 7);
const nextMonth = (m: string) => ym(addMonths(`${m}-01`, 1));
/** The day in that month (the 31st becomes the month's last day). */
export const dayIn = (month: string, day: number) => {
  const last = Number(monthEnd(`${month}-01`).slice(8, 10));
  return `${month}-${String(Math.min(Math.max(day, 1), last)).padStart(2, '0')}`;
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_RE = new RegExp(`\\b(${MONTHS.map((m) => `${m.slice(0, 3)}(?:${m.slice(3)})?`).join('|')})\\.?(\\s+|-)(\\d{4})\\b`, 'gi');

/** "Hosting – October 2026" becomes "Hosting – November 2026" (short names stay short). */
export function forMonth(text: string, month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return text.replace(MONTH_RE, (_all, name: string, sep: string) => {
    const full = MONTHS[m - 1]!;
    const word = name.length <= 3 ? full.slice(0, 3) : full;
    return `${name[0] === name[0]!.toUpperCase() ? word : word.toLowerCase()}${sep}${y}`;
  });
}

interface Schedule {
  id: string;
  sourceId: string;
  dayOfMonth: number;
  startsOn: string;
  endsOn: string | null;
  mode: 'send' | 'draft';
  emailTo: string;
  message: string;
  active: boolean;
}

/** The months due by `on` that haven't had their invoice yet (at most three: catching up). */
async function duePeriods(db: Db, s: Schedule, on: string): Promise<string[]> {
  const [last] = await db<{ period: string | null }[]>`select max(monthly_period) as period from documents where monthly_id = ${s.id}`;
  let m = last?.period ? nextMonth(last.period) : ym(s.startsOn);
  if (m < ym(s.startsOn)) m = ym(s.startsOn);
  const out: string[] = [];
  for (; m <= ym(on) && out.length < 3; m = nextMonth(m)) {
    const date = dayIn(m, s.dayOfMonth);
    if (date < s.startsOn) continue;
    if (s.endsOn && date > s.endsOn) break;
    if (date <= on) out.push(m);
  }
  return out;
}

/** Makes one month's invoice for a schedule. Returns its id, or null if that month already has one. */
async function makeInvoice(db: Sql, s: Schedule, month: string): Promise<string | null> {
  const issueDate = dayIn(month, s.dayOfMonth);
  return db.begin(async (tx) => {
    const [done] = await tx`select 1 from documents where monthly_id = ${s.id} and monthly_period = ${month}`;
    if (done) return null;
    // Honour the lock for drafts too, not only send-mode: nothing in a closed period, even a draft.
    await assertOpen(tx, issueDate);
    // The latest one in the series: what was sent last carries on (a new price, say).
    const [latest] = await tx<{ id: string }[]>`
      select id from documents where (monthly_id = ${s.id} or id = ${s.sourceId}) and kind = 'invoice' and status <> 'void'
      order by issue_date desc, created_at desc limit 1`;
    if (!latest) throw new Error('The invoice it copies was voided or deleted');
    const { doc, lines } = await loadDocument(tx, latest.id);
    const created = await createDocument(
      tx,
      null,
      'invoice',
      {
        brandId: doc.brandId,
        projectId: doc.projectId,
        clientId: doc.clientId,
        issueDate,
        title: forMonth(doc.title, month),
        notes: forMonth(doc.notes, month),
        terms: doc.terms,
        depositBp: null,
        depositCents: null,
        depositShowBalance: true,
        // Each line's VAT, and prices including or excluding VAT, as on the one it copies.
        pricesIncludeVat: Boolean(doc.pricesIncludeVat),
        lines: lines.map((l) => ({ category: l.category, description: forMonth(l.description, month), qty: l.qty, unit: l.unit, unitPriceCents: l.unitPriceCents, vatCode: l.vatCode ?? 'standard' })),
      },
      { status: 'draft' },
    );
    // Sent straight out: issued only once it carries what a tax invoice must (else nothing is
    // made this month, and Home says why).
    if (s.mode === 'send') {
      await assertTaxDocument(tx, created.id);
      await tx`update documents set status = 'issued', updated_at = now() where id = ${created.id}`;
    }
    await tx`update documents set monthly_id = ${s.id}, monthly_period = ${month} where id = ${created.id}`;
    await syncProjectStatus(tx, doc.projectId);
    await audit(tx, { actor: 'system', action: 'monthly_invoice', entity: 'invoice', entityId: created.id, details: { number: created.number, month, mode: s.mode } });
    return created.id;
  });
}

/**
 * Makes (and, for "send", emails) every monthly invoice that's due. Safe to run as often as
 * you like: each month's invoice is made once.
 */
export async function runMonthly(db: Sql, mailer: Mailer, opts: { emailOn: boolean; on?: string; only?: string; resend?: boolean }) {
  const on = opts.on ?? today();
  const schedules = await db<Schedule[]>`
    select id, source_id, day_of_month, starts_on::text, ends_on::text, mode, email_to, message, active from monthly_invoices
    where active and (${opts.only ?? null}::uuid is null or id = ${opts.only ?? null}::uuid)`;
  const result = { created: 0, emailed: 0, failed: 0 };
  for (const s of schedules) {
    // Asked for by hand: first email the ones that were made but couldn't be sent.
    if (opts.resend && s.mode === 'send') {
      const unsent = await db<{ id: string; period: string }[]>`
        select d.id, d.monthly_period as period from documents d join monthly_invoices m on m.id = d.monthly_id
        where m.id = ${s.id} and d.monthly_period is not null and d.created_at > m.created_at
          and d.status = 'issued' and d.sent_at is null and d.issue_date >= current_date - 62 order by d.issue_date`;
      let stop = false;
      for (const u of unsent) {
        try {
          if (!s.emailTo) throw new Error('No email address to send it to');
          if (!opts.emailOn) throw new Error('Email isn’t set up on this server (SMTP_URL), so it was made but not sent');
          await emailDocument(db, mailer, u.id, s.emailTo, forMonth(s.message, u.period));
          result.emailed++;
        } catch (err) {
          result.failed++;
          await db`update monthly_invoices set last_error = ${(err as Error).message || 'Something went wrong'}, last_error_at = now() where id = ${s.id}`;
          stop = true;
          break;
        }
      }
      if (stop) continue;
    }
    for (const month of await duePeriods(db, s, on)) {
      let id: string | null = null;
      try {
        id = await makeInvoice(db, s, month);
        if (!id) continue;
        result.created++;
        if (s.mode === 'send') {
          if (!s.emailTo) throw new Error('No email address to send it to');
          if (!opts.emailOn) throw new Error('Email isn’t set up on this server (SMTP_URL), so it was made but not sent');
          await emailDocument(db, mailer, id, s.emailTo, forMonth(s.message, month));
          result.emailed++;
        }
        await db`update monthly_invoices set last_error = null, last_error_at = null where id = ${s.id}`;
      } catch (err) {
        result.failed++;
        const why = (err as Error).message || 'Something went wrong';
        await db`update monthly_invoices set last_error = ${why}, last_error_at = now() where id = ${s.id}`;
        // An invoice made but not emailed stays (it shows as not sent); a month that couldn't be
        // made is tried again next time.
        break;
      }
    }
  }
  return result;
}

/** Monthly invoices needing a look, for Home. */
export async function monthlyAttention(db: Db) {
  const failed = await db<{ id: string; documentId: string; title: string; clientName: string | null; error: string }[]>`
    select m.id, d.title, c.name as client_name, m.last_error as error,
      coalesce((select x.id from documents x where x.monthly_id = m.id and x.status <> 'void' order by x.issue_date desc limit 1), m.source_id) as document_id
    from monthly_invoices m
    join documents d on d.id = m.source_id left join clients c on c.id = d.client_id
    where m.active and m.last_error is not null`;
  // Only the ones the schedule made: the invoice it started from was sent however it was sent.
  const waiting = await db<{ id: string; scheduleId: string; number: string; clientName: string | null; mode: string }[]>`
    select d.id, m.id as schedule_id, d.number, c.name as client_name, m.mode from documents d join monthly_invoices m on m.id = d.monthly_id
    left join clients c on c.id = d.client_id
    where d.monthly_period is not null and d.status <> 'void' and d.created_at > m.created_at
      and ((m.mode = 'draft' and d.status = 'draft') or (m.mode = 'send' and d.status = 'issued' and d.sent_at is null))
      and d.issue_date >= current_date - 62
    order by d.issue_date`;
  return { failed, waiting };
}

const scheduleInput = z.object({
  dayOfMonth: z.number().int().min(1).max(31),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  mode: z.enum(['send', 'draft']),
  emailTo: z.string().trim().max(300).default(''),
  message: z.string().max(4000).default(''),
});

export function registerMonthlyRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;
  const owner = { preHandler: requireRole('owner') };
  const check = (input: z.infer<typeof scheduleInput>) => {
    if (input.mode === 'send' && !z.string().email().safeParse(input.emailTo).success) throw badRequest('Enter the email address it goes to');
    if (input.endsOn && input.endsOn < input.startsOn) throw badRequest('It can’t end before it starts');
  };
  const list = (where: { id?: string; documentId?: string } = {}) => sql`
    select m.id, m.source_id, m.day_of_month, m.starts_on::text, m.ends_on::text, m.mode, m.email_to, m.message, m.active,
      m.last_error, m.last_error_at, d.title, d.total_cents, c.name as client_name, b.name as brand_name,
      (select json_build_object('id', x.id, 'number', x.number, 'issueDate', x.issue_date, 'status', x.status, 'sentAt', x.sent_at, 'totalCents', x.total_cents)
         from documents x where x.monthly_id = m.id and x.monthly_period is not null order by x.issue_date desc limit 1) as latest,
      (select count(*)::int from documents x where x.monthly_id = m.id and x.monthly_period is not null) as made
    from monthly_invoices m join documents d on d.id = m.source_id
    left join clients c on c.id = d.client_id left join brands b on b.id = d.brand_id
    where (${where.id ?? null}::uuid is null or m.id = ${where.id ?? null}::uuid)
      and (${where.documentId ?? null}::uuid is null or m.id = (select monthly_id from documents where id = ${where.documentId ?? null}::uuid))
    order by m.active desc, c.name, d.title`;
  const withNext = async (rows: Record<string, unknown>[]) =>
    Promise.all(
      rows.map(async (r) => {
        const s = r as unknown as Schedule;
        let next: string | null = null;
        if (s.active) {
          const [last] = await sql<{ period: string | null }[]>`select max(monthly_period) as period from documents where monthly_id = ${s.id}`;
          for (let m = last?.period ? nextMonth(last.period) : ym(s.startsOn), i = 0; i < 24; m = nextMonth(m), i++) {
            const d = dayIn(m, s.dayOfMonth);
            if (d < s.startsOn) continue;
            if (s.endsOn && d > s.endsOn) break;
            next = d;
            break;
          }
        }
        return { ...r, nextDate: next };
      }),
    );

  app.get('/api/monthly-invoices', { preHandler: requireAccess('documents.view') }, async () => withNext(await list()));

  /** The monthly schedule this invoice belongs to, if any. */
  app.get('/api/documents/:id/monthly', { preHandler: requireAccess('documents.view') }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const [row] = await withNext(await list({ documentId: id }));
    return { schedule: row ?? null, emailOn: Boolean(ctx.config.SMTP_URL) };
  });

  /** Make this invoice monthly (or, if it's already in a series, change the series and copy this one from now on). */
  app.post('/api/documents/:id/monthly', { preHandler: requireAccess('documents.edit') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const input = parse(scheduleInput, req.body);
    check(input);
    const [doc] = await sql<{ kind: string; status: string; issueDate: string; monthlyId: string | null }[]>`
      select kind, status, issue_date::text, monthly_id from documents where id = ${id}`;
    if (!doc || doc.kind !== 'invoice') throw notFound('Invoice');
    if (doc.status === 'void') throw badRequest('A voided invoice can’t be made monthly');
    const scheduleId = await sql.begin(async (tx) => {
      if (doc.monthlyId) {
        await tx`update monthly_invoices set source_id = ${id}, day_of_month = ${input.dayOfMonth}, starts_on = ${input.startsOn}, ends_on = ${input.endsOn},
            mode = ${input.mode}, email_to = ${input.emailTo}, message = ${input.message}, active = true, last_error = null where id = ${doc.monthlyId}`;
        return doc.monthlyId;
      }
      const [m] = await tx<{ id: string }[]>`
        insert into monthly_invoices (source_id, day_of_month, starts_on, ends_on, mode, email_to, message, created_by)
        values (${id}, ${input.dayOfMonth}, ${input.startsOn}, ${input.endsOn}, ${input.mode}, ${input.emailTo}, ${input.message}, ${user.id}) returning id`;
      // This invoice is its own month's: the series carries on from the next.
      await tx`update documents set monthly_id = ${m!.id}, monthly_period = ${ym(doc.issueDate)} where id = ${id}`;
      return m!.id;
    });
    await audit(sql, { userId: user.id, action: 'monthly_set', entity: 'invoice', entityId: id, ip: req.ip, details: { mode: input.mode, day: input.dayOfMonth } });
    const [row] = await withNext(await list({ id: scheduleId }));
    return row;
  });

  app.put('/api/monthly-invoices/:id', { preHandler: requireAccess('documents.edit') }, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const input = parse(scheduleInput.extend({ active: z.boolean().default(true) }), req.body);
    check(input);
    const r = await sql`update monthly_invoices set day_of_month = ${input.dayOfMonth}, starts_on = ${input.startsOn}, ends_on = ${input.endsOn},
        mode = ${input.mode}, email_to = ${input.emailTo}, message = ${input.message}, active = ${input.active},
        last_error = case when ${input.active} then last_error else null end where id = ${id}`;
    if (!r.count) throw notFound('Monthly invoice');
    await audit(sql, { userId: user.id, action: input.active ? 'monthly_update' : 'monthly_stop', entity: 'invoice', entityId: id, ip: req.ip });
    const [row] = await withNext(await list({ id }));
    return row;
  });

  /** Do what's due now, rather than waiting for the next check (also retries after a problem). */
  app.post('/api/monthly-invoices/:id/run', { preHandler: requireAccess('documents.edit') }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    await sql`update monthly_invoices set last_error = null where id = ${id}`;
    return runMonthly(sql, ctx.mailer, { emailOn: Boolean(ctx.config.SMTP_URL), only: id, resend: true });
  });
}

/** Checks for monthly invoices due every half hour (the real company only, never the demo). */
export function startMonthlyTimer(ctx: Ctx, log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void }) {
  const tick = () => {
    void runMonthly(ctx.dbs.real, ctx.mailer, { emailOn: Boolean(ctx.config.SMTP_URL) })
      .then((r) => r.created + r.failed > 0 && log.info(r, 'monthly invoices'))
      .catch((err) => log.error({ err }, 'monthly invoices failed'));
    // The real books only (never the demo company's).
    void shareMarketRates(ctx, ctx.dbs.real, { warn: (o, m) => log.info(o, m) }).catch((err) => log.error({ err }, 'market rates failed'));
    // This Shap's anonymous usage note, when it changed or monthly (only if the owner agreed).
    void checkInUsage(ctx, ctx.dbs.real, { warn: (o, m) => log.info(o, m) }).catch((err) => log.error({ err }, 'usage note failed'));
  };
  const first = setTimeout(tick, 60_000);
  const every = setInterval(tick, 30 * 60_000);
  first.unref();
  every.unref();
  return () => (clearTimeout(first), clearInterval(every));
}
