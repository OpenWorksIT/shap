/**
 * The annual financial statements, from draft to signed (docs/STATEMENTS.md). Switched on in
 * Settings → What you use (or in setup) when Shap is to prepare them; off when the accountant
 * prepares them in their own package.
 *
 *   draft     always built from the books as they are, with checks (it balances, the cash flows
 *             tie, nothing in suspense, the books audit)
 *   sent      emailed (or downloaded) for the accountant to compile
 *   compiled  the accountant signed the compiler's report: in Shap, signed in as themselves, or on
 *             paper, the signed report uploaded. The figures are frozen as they were signed.
 *   approved  the directors (members, trustees…) approve and sign: Shap checks the books still
 *             give exactly the signed figures, agrees the year at them, closes it, and keeps the
 *             signed set. Reopening is the owner's, with a reason, in the audit log.
 */
import type { FastifyInstance } from 'fastify';
import {
  addDays,
  approveStatementsInput,
  compileInput,
  compilerReportInput,
  financialYear,
  isoDate,
  reopenStatementsInput,
  sha256Hex,
  sendStatementsInput,
  statementDetailsInput,
  type StatementStatus,
} from '@shap/shared';
import { z } from 'zod';
import { can, requireAccess, requireRole, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { freshTotals, getSettings, today } from '../lib/books.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { auditBooks } from '../audit/books.js';
import { buildStatements, yearStartOf, type Statements } from '../statements/build.js';
import { loadDetails, saveDetails, type StatementDetails } from '../statements/details.js';
import { renderStatementsPdf, type Signatures } from '../statements/pdf.js';
import { agreeYear } from './yearend.js';
import { requireFeature } from './sales.js';

const fyParam = z.object({ fyEnd: isoDate });
const readers = { preHandler: requireRole('owner', 'accountant') };
const owner = { preHandler: requireRole('owner') };

interface Row {
  fyEnd: string;
  status: StatementStatus;
  snapshot: Statements | null;
  snapshotHash: string | null;
  sentTo: string;
  sentAt: Date | null;
  compiledBy: string | null;
  compiler: Signatures['compiler'] | null;
  compiledOn: string | null;
  compilerReportId: string | null;
  approvedName: string;
  approvedOn: string | null;
  finalPdfId: string | null;
}

/**
 * The fingerprint of a set (what's signed): from 1.23 (builder 2), of the books it was drawn from
 * (each account's figures, both years: the same from a later Shap that draws them differently, as
 * long as it works out `books` the same way); before, of its statements and notes as they were drawn.
 */
export const figuresHash = (s: Statements) =>
  sha256Hex(
    (s.builder ?? 1) >= 2
      ? JSON.stringify({ books: s.books })
      : JSON.stringify({ sfp: s.sfp, sci: s.sci, soce: s.soce, scf: s.scf, notes: s.notes.map((n) => n.tables), detailed: s.detailed }),
  );

/** JSON with every object's keys in order (a snapshot comes back from jsonb in its own order). */
const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v ?? null);

/**
 * Whether the books still give a signed set's figures. A set signed on 1.22 or before is compared
 * by what it shows, drawn now: the four statements and each of its notes' tables (1.23 draws the
 * cash flows differently from the same books and adds a note on non-cash transactions, which
 * isn't the books changing).
 */
export function stillSigned(signed: { snapshot: Statements; snapshotHash: string | null }, now: Statements): boolean {
  if ((signed.snapshot.builder ?? 1) >= 2) return Boolean(now.books) && now.books === signed.snapshot.books;
  const four = (s: Statements) => canonical({ sfp: s.sfp, sci: s.sci, soce: s.soce, detailed: s.detailed });
  if (four(signed.snapshot) !== four(now)) return false;
  const notesNow = new Map(now.notes.map((n) => [n.key, canonical(n.tables)]));
  return signed.snapshot.notes.filter((n) => n.key !== 'non_cash').every((n) => notesNow.get(n.key) === canonical(n.tables));
}

async function row(db: Db, fyEnd: string): Promise<Row | null> {
  const [r] = await db<Row[]>`select *, fy_end::text as fy_end, compiled_on::text as compiled_on, approved_on::text as approved_on from financial_statements where fy_end = ${fyEnd}::date`;
  return r ?? null;
}

async function checkYear(db: Db, fyEnd: string): Promise<void> {
  const s = await getSettings(db);
  const [known] = await db`select 1 from year_ends where fy_end = ${fyEnd}::date union all select 1 from financial_statements where fy_end = ${fyEnd}::date limit 1`;
  if (financialYear(fyEnd, s.fyEndMonth).end !== fyEnd && !known) throw badRequest('That date isn’t the end of a financial year');
  if (fyEnd >= today()) throw badRequest('The statements are for a year that has ended');
}

/** The set as it stands: the signed one once compiled, the books as they are before. */
export async function currentStatements(db: Db, fyEnd: string): Promise<{ statements: Statements; row: Row | null }> {
  const r = await row(db, fyEnd);
  if (r?.snapshot && (r.status === 'compiled' || r.status === 'approved')) return { statements: r.snapshot, row: r };
  return { statements: await buildStatements(db, fyEnd), row: r };
}

const signaturesOf = (r: Row | null): Signatures => ({
  compiler: r?.compiler ?? null,
  approved: r?.status === 'approved' && r.approvedOn ? { name: r.approvedName, date: r.approvedOn } : null,
});

/** Ready to sign: the statements add up and the books audit finds nothing to fix. */
async function readyToSign(db: Ctx['sql'], fyEnd: string): Promise<Statements> {
  const s = await buildStatements(db, fyEnd);
  // What's for the accountant to look at never stops anything; the rest must pass.
  const stops = s.checks.filter((c) => !c.ok && c.level !== 'look');
  if (stops.length) throw badRequest(`The statements aren’t ready to sign: ${stops.map((c) => c.label.toLowerCase()).join('; ')}`);
  const fails = (await auditBooks(db, fyEnd)).filter((i) => i.level === 'fail');
  if (fails.length) throw badRequest(`The books audit found something to fix first: ${fails[0]!.text}`);
  return s;
}

async function freeze(db: Db, s: Statements, patch: Record<string, unknown>): Promise<Statements> {
  const fyEnd = s.fyEnd;
  await db`
    insert into financial_statements (fy_end, status, snapshot, snapshot_hash, updated_at)
    values (${fyEnd}::date, 'compiled', ${db.json(s as never)}, ${figuresHash(s)}, now())
    on conflict (fy_end) do update set status = 'compiled', snapshot = excluded.snapshot, snapshot_hash = excluded.snapshot_hash, updated_at = now()`;
  await db`update financial_statements set ${db(patch as never)} where fy_end = ${fyEnd}::date`;
  return s;
}

export function registerFinancialStatementRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;
  const on = () => requireFeature(sql, 'statements', 'Financial statements');

  app.get('/api/statements/details', { preHandler: requireAccess('reports.view') }, async () => loadDetails(sql));

  // The owner, or the accountant (who words the policies and notes, and is the compiler).
  app.put('/api/statements/details', readers, async (req) => {
    const user = userOrThrow(req);
    const input = parse(statementDetailsInput, req.body);
    await saveDetails(sql, input as StatementDetails);
    await audit(sql, { userId: user.id, action: 'update', entity: 'statement_details', ip: req.ip });
    return loadDetails(sql);
  });

  /** The years that have ended, newest first, each with where its statements are. */
  app.get('/api/statements', { preHandler: requireAccess('reports.view') }, async () => {
    const s = await getSettings(sql);
    await freshTotals(sql);
    const [first] = await sql<{ d: string | null }[]>`select min(date)::text as d from ledger_totals where amount_cents <> 0`;
    const rows = await sql<{ fyEnd: string; status: StatementStatus; approvedOn: string | null; compiledOn: string | null }[]>`select fy_end::text as fy_end, status, approved_on::text as approved_on, compiled_on::text as compiled_on from financial_statements`;
    const agreed = new Set((await sql<{ fyEnd: string }[]>`select fy_end::text as fy_end from year_ends`).map((r) => r.fyEnd));
    const years: { fyEnd: string; fyStart: string; status: StatementStatus; agreed: boolean; compiledOn: string | null; approvedOn: string | null }[] = [];
    if (!first?.d) return years;
    // Each year end from the one this year back to the year of the first entry in the books.
    const firstEnd = financialYear(first.d, s.fyEndMonth).end;
    for (let end = financialYear(today(), s.fyEndMonth).end, i = 0; end >= firstEnd && i < 30; end = addDays(yearStartOf(end), -1), i++) {
      if (end >= today()) continue;
      const r = rows.find((x) => x.fyEnd === end);
      years.push({ fyEnd: end, fyStart: yearStartOf(end), status: r?.status ?? 'draft', agreed: agreed.has(end), compiledOn: r?.compiledOn ?? null, approvedOn: r?.approvedOn ?? null });
    }
    return years;
  });

  app.get('/api/statements/:fyEnd', { preHandler: requireAccess('reports.view') }, async (req) => {
    const { fyEnd } = parse(fyParam, req.params);
    await checkYear(sql, fyEnd);
    const { statements, row: r } = await currentStatements(sql, fyEnd);
    // A signed set whose books have since moved: say so (it stays as signed).
    let changedSince = false;
    if (r?.snapshot && r.snapshotHash && (r.status === 'compiled' || r.status === 'approved')) changedSince = !stillSigned(r as { snapshot: Statements; snapshotHash: string }, await buildStatements(sql, fyEnd, statements.details));
    const audit = (await auditBooks(sql, fyEnd, { people: can(userOrThrow(req), 'payroll.view') })).filter((i) => i.level !== 'ok');
    return { statements, status: r?.status ?? 'draft', row: r ? { ...r, snapshot: undefined } : null, changedSince, audit };
  });

  app.get('/api/statements/:fyEnd/pdf', { preHandler: requireAccess('reports.view') }, async (req, reply) => {
    const { fyEnd } = parse(fyParam, req.params);
    await checkYear(sql, fyEnd);
    const r = await row(sql, fyEnd);
    let pdf: Buffer;
    if (r?.status === 'approved' && r.finalPdfId) pdf = (await sql<{ bytes: Buffer }[]>`select bytes from attachments where id = ${r.finalPdfId}`)[0]!.bytes;
    else {
      const { statements } = await currentStatements(sql, fyEnd);
      pdf = await renderStatementsPdf(statements, signaturesOf(r));
    }
    const s = await getSettings(sql);
    const name = `${s.companyName} ${r?.status === 'approved' ? '' : r?.status === 'compiled' ? 'for approval ' : 'DRAFT '}financial statements ${fyEnd.slice(0, 4)}.pdf`.replace(/[^\w.\- ]/g, '');
    reply.header('content-type', 'application/pdf');
    reply.header('content-disposition', `inline; filename="${name}"`);
    return reply.send(pdf);
  });

  /** Emailed to the accountant to compile, with the draft set attached. */
  app.post('/api/statements/:fyEnd/send', owner, async (req) => {
    const user = userOrThrow(req);
    const { fyEnd } = parse(fyParam, req.params);
    const input = parse(sendStatementsInput, req.body);
    await on();
    await checkYear(sql, fyEnd);
    const r = await row(sql, fyEnd);
    if (r && (r.status === 'compiled' || r.status === 'approved')) throw badRequest('These statements are already compiled');
    const s = await buildStatements(sql, fyEnd);
    const pdf = await renderStatementsPdf(s);
    const settings = await getSettings(sql);
    await ctx.mailer.send({
      to: input.to,
      fromName: settings.companyName || undefined,
      replyTo: settings.email || undefined,
      subject: `Financial statements ${s.period}: ${settings.companyName}`,
      text:
        input.message ||
        `Good day,\n\nPlease find the draft financial statements of ${settings.companyName} ${s.period} attached, prepared in Shap from our books. Once you've compiled them, please send back your signed compiler's report so we can approve the statements and close the year.\n\nKind regards,\n${user.name}`,
      attachments: [{ filename: `${settings.companyName} DRAFT financial statements ${fyEnd.slice(0, 4)}.pdf`.replace(/[^\w.\- ]/g, ''), content: pdf, contentType: 'application/pdf' }],
    });
    await sql`insert into financial_statements (fy_end, status, sent_to, sent_at) values (${fyEnd}::date, 'sent', ${input.to}, now())
      on conflict (fy_end) do update set status = 'sent', sent_to = excluded.sent_to, sent_at = now(), updated_at = now()`;
    const d = await loadDetails(sql);
    if (!d.accountantEmail) await saveDetails(sql, { ...d, accountantEmail: input.to });
    await audit(sql, { userId: user.id, action: 'send_statements', entity: 'financial_statements', entityId: fyEnd, ip: req.ip });
    return { ok: true };
  });

  /** The accountant compiles and signs, signed in to Shap as themselves. */
  app.post('/api/statements/:fyEnd/compile', readers, async (req) => {
    const user = userOrThrow(req);
    if (user.role !== 'accountant') throw forbidden('The compiler’s report is signed by the accountant, signed in as themselves');
    const { fyEnd } = parse(fyParam, req.params);
    const input = parse(compileInput, req.body);
    await on();
    await checkYear(sql, fyEnd);
    if (input.date <= fyEnd) throw badRequest('The report is signed after the year end');
    const r = await row(sql, fyEnd);
    if (r?.status === 'approved') throw badRequest('These statements are approved already');
    const d = await loadDetails(sql);
    await saveDetails(sql, { ...d, compiler: input.compiler, assurance: 'compiled' });
    const ready = await readyToSign(sql, fyEnd);
    await sql.begin(async (tx) => {
      await freeze(tx, ready, { compiledBy: user.id, compiler: tx.json({ ...input.compiler, date: input.date, how: 'in_shap' } as never), compiledOn: input.date, compiledAt: new Date(), compilerReportId: null });
      await audit(tx, { userId: user.id, action: 'compile_statements', entity: 'financial_statements', entityId: fyEnd, ip: req.ip, details: { compiler: input.compiler.name, date: input.date } });
    });
    return { ok: true };
  });

  /** The accountant's signed compiler's report (or the whole signed set), uploaded by the owner. */
  app.post('/api/statements/:fyEnd/compiler-report', owner, async (req) => {
    const user = userOrThrow(req);
    const { fyEnd } = parse(fyParam, req.params);
    const input = parse(compilerReportInput, req.body);
    await on();
    await checkYear(sql, fyEnd);
    if (input.date <= fyEnd) throw badRequest('The report is signed after the year end');
    const [file] = await sql<{ mime: string }[]>`select mime from attachments where id = ${input.attachmentId} and (created_by = ${user.id} or created_by is null)`;
    if (!file) throw badRequest('Upload the signed report first');
    if (!(file.mime === 'application/pdf' || file.mime.startsWith('image/'))) throw badRequest('The signed report as a PDF or a photo');
    const r = await row(sql, fyEnd);
    if (r?.status === 'approved') throw badRequest('These statements are approved already');
    const d = await loadDetails(sql);
    const ready = await readyToSign(sql, fyEnd);
    await sql.begin(async (tx) => {
      await freeze(tx, ready, {
        compiledBy: null,
        compiler: tx.json({ ...d.compiler, name: input.compilerName, date: input.date, how: 'uploaded' } as never),
        compiledOn: input.date,
        compiledAt: new Date(),
        compilerReportId: input.attachmentId,
      });
      await audit(tx, { userId: user.id, action: 'upload_compiler_report', entity: 'financial_statements', entityId: fyEnd, ip: req.ip, details: { compiler: input.compilerName, date: input.date } });
    });
    return { ok: true };
  });

  app.get('/api/statements/:fyEnd/compiler-report', { preHandler: requireAccess('reports.view') }, async (req, reply) => {
    const { fyEnd } = parse(fyParam, req.params);
    const r = await row(sql, fyEnd);
    if (!r?.compilerReportId) throw notFound('Signed report');
    const [f] = await sql<{ filename: string; mime: string; bytes: Buffer }[]>`select filename, mime, bytes from attachments where id = ${r.compilerReportId}`;
    if (!f) throw notFound('Signed report');
    const safe = f.mime === 'application/pdf' || /^image\/(png|jpeg|webp)$/.test(f.mime);
    reply.header('content-type', safe ? f.mime : 'application/octet-stream');
    reply.header('content-disposition', `${safe ? 'inline' : 'attachment'}; filename="${f.filename.replace(/[^\w.\- ]/g, '_')}"`);
    reply.header('content-security-policy', "script-src 'none'; object-src 'none'; frame-ancestors 'none'");
    return reply.send(f.bytes);
  });

  /** The directors approve and sign: the year is agreed at the signed figures and closed. */
  app.post('/api/statements/:fyEnd/approve', owner, async (req) => {
    const user = userOrThrow(req);
    const { fyEnd } = parse(fyParam, req.params);
    const input = parse(approveStatementsInput, req.body);
    await on();
    const r = await row(sql, fyEnd);
    if (!r || r.status !== 'compiled' || !r.snapshot) throw badRequest('The statements are approved once the accountant has compiled them');
    if (input.date < (r.compiledOn ?? fyEnd)) throw badRequest('They’re approved on or after the day they were compiled');
    const now = await buildStatements(sql, fyEnd, r.snapshot.details);
    if (!stillSigned(r as { snapshot: Statements; snapshotHash: string | null }, now)) throw badRequest('The books have changed since the statements were compiled, so they no longer give the signed figures. Send them to your accountant again.');
    const sig: Signatures = { compiler: r.compiler, approved: { name: input.name, date: input.date } };
    const pdf = await renderStatementsPdf(r.snapshot, sig);
    const settings = await getSettings(sql);
    await sql.begin(async (tx) => {
      const [agreed] = await tx`select 1 from year_ends where fy_end = ${fyEnd}::date`;
      // Agreed at the figures signed (the books as they are), unless the accountant agreed it already.
      if (!agreed) await agreeYear(tx, { fyEnd, fyStart: yearStartOf(fyEnd), note: `Financial statements approved by ${input.name} on ${input.date}`, lock: true, figures: [], keepImport: true });
      else await tx`update settings set lock_date = greatest(coalesce(lock_date, ${fyEnd}::date), ${fyEnd}::date) where id`;
      // The year is closed at exactly the figures signed, or not at all.
      if (!stillSigned(r as { snapshot: Statements; snapshotHash: string | null }, await buildStatements(tx, fyEnd, r.snapshot!.details))) {
        throw badRequest('Closing the year would change the signed figures, so it wasn’t closed. Reopen the statements and send them to your accountant again.');
      }
      const [f] = await tx<{ id: string }[]>`
        insert into attachments (filename, mime, size, bytes, created_by)
        values (${`${settings.companyName} financial statements ${fyEnd.slice(0, 4)} (signed).pdf`.replace(/[^\w.\- ]/g, '')}, 'application/pdf', ${pdf.length}, ${pdf}, ${user.id})
        returning id`;
      await tx`update financial_statements set status = 'approved', approved_by = ${user.id}, approved_name = ${input.name}, approved_on = ${input.date}::date, approved_at = now(),
        final_pdf_id = ${f!.id}, updated_at = now() where fy_end = ${fyEnd}::date`;
      await audit(tx, { userId: user.id, action: 'approve_statements', entity: 'financial_statements', entityId: fyEnd, ip: req.ip, details: { name: input.name, date: input.date, hash: r.snapshotHash } });
    });
    return { ok: true };
  });

  /** Back to draft (the year stays closed until its lock date is moved). */
  app.post('/api/statements/:fyEnd/reopen', owner, async (req) => {
    const user = userOrThrow(req);
    const { fyEnd } = parse(fyParam, req.params);
    const { reason } = parse(reopenStatementsInput, req.body);
    const r = await row(sql, fyEnd);
    if (!r || r.status === 'draft') throw badRequest('These statements are still a draft');
    await sql`update financial_statements set status = 'draft', snapshot = null, snapshot_hash = null, compiled_by = null, compiler = null, compiled_on = null,
      compiled_at = null, approved_by = null, approved_name = '', approved_on = null, approved_at = null, updated_at = now() where fy_end = ${fyEnd}::date`;
    await audit(sql, { userId: user.id, action: 'reopen_statements', entity: 'financial_statements', entityId: fyEnd, ip: req.ip, details: { reason, was: r.status } });
    return { ok: true };
  });
}
