/**
 * Shap Accountant, phase 5 (docs/ACCOUNTANT.md, "Engagement letters and working papers"): the
 * practice's own records about each client, in the practice's database, never in the client's books.
 *
 * - **Engagement letters**: drafted from the client's details (lib/engagement.ts), changed as the
 *   practice likes while a draft, sent, accepted by the client (a signed copy kept with it, or the
 *   acceptance recorded), looked at again for each later year (ISRS 4410 (Revised) para 26), ended.
 *   For whoever manages the practice's clients; anyone given the client reads them.
 * - **Working papers** for each year the client's books have ended: review notes (raised, answered,
 *   cleared by whoever raised them or an owner), each account at the year end ticked as prepared and
 *   reviewed (books on this server: not a client on its own Shap, whose trial balance doesn't come
 *   here), and the year signed off as prepared, reviewed and by the engagement partner (an owner),
 *   none of the last two over an open note. Everything is said to have changed when the books
 *   have since. The year's file downloads as a PDF (ISRS 4410 para 38's record).
 *
 * Nothing here stops anyone compiling or filing: on the practice's list and the compile form, what's
 * missing is a check, not a lock (the owner's choice).
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { addDays, attachmentInput, financialYear, LETTER_NOTE, SERVICES, SIGNOFFS, type BusinessType, type Level, type Service, type Signoff } from '@shap/shared';
import { z } from 'zod';
import { requireAccess, userOrThrow, type AuthUser } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Sql } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { getSettings, today } from '../lib/books.js';
import { letterSections, type LetterInput, type LetterSection } from '../lib/engagement.js';
import { renderFilePdf, renderLetterPdf } from '../lib/engagement-pdf.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import type { ClientHealth } from '../lib/practice.js';
import { parse } from '../lib/validate.js';
import { lastEnded } from '../lib/papers.js';
import { accountantTermsAccepted, ACCOUNTANT_TERMS_NEEDED, levelFor, practiceOn, type ClientRow } from './practice.js';
import { trialBalance } from './reports.js';
import { fileBytes } from './settings.js';

const uuid = z.string().uuid();
const yearEnd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ARCHIVED = 'That client is archived: its letters and working papers are kept as they are.';
const OPEN_NOTES = 'There are review notes still open on this year: they’re cleared (by whoever raised them) before it’s signed off as reviewed or by the engagement partner.';

/** What the client is, as the letter and the file need it: from its own books, or from what its linked Shap last sent. */
interface ClientFacts {
  name: string;
  businessType: BusinessType;
  fyEndMonth: number;
  /** The books' first year end (a client whose books are here), if any. */
  firstYearEnd: string | null;
}

/** A year end is the last day of the client's year-end month. */
const isYearEnd = (d: string, fyEndMonth: number) => financialYear(d, fyEndMonth).end === d;

/** The trial balance's fingerprint: its accounts and balances, in order. */
const tbHash = (rows: { code: string; balanceCents: number }[]) =>
  createHash('sha256')
    .update(rows.map((r) => `${r.code}:${r.balanceCents}`).join('\n'))
    .digest('hex');

export function registerWorkingPaperRoutes(app: FastifyInstance, ctx: Ctx): void {
  const real: Sql = ctx.dbs.real;
  const clients = ctx.clients;
  const view = { preHandler: requireAccess('practice.clients') };
  const manage = { preHandler: requireAccess('practice.manage') };
  const limit = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute' } });

  const assertOn = async () => {
    if (!(await practiceOn(real))) throw badRequest('Shap Accountant is off. The owner switches it on under Settings → Features.');
    if (!(await accountantTermsAccepted(real))) throw badRequest(ACCOUNTANT_TERMS_NEEDED, { needsAccountantTerms: true });
  };
  /** The client, if this person may open it, and how. */
  const given = async (req: FastifyRequest, user: AuthUser) => {
    await assertOn();
    const { id } = parse(z.object({ id: uuid }), req.params);
    const [c] = await real<ClientRow[]>`select * from practice_clients where id = ${id} and (db_name is not null or kind = 'linked')`;
    if (!c) throw notFound('Client');
    const level = await levelFor(real, user, c.id);
    if (!level) throw forbidden('You haven’t been given this client: the practice’s owner, or whoever manages the clients, gives it to you (Who opens it).');
    return { c, level };
  };
  const notArchived = (c: ClientRow) => {
    if (c.archivedAt) throw badRequest(ARCHIVED);
  };
  /** Its books' own Sql (books on this server), or null (on its own Shap). */
  const booksOf = (c: ClientRow): Sql | null => {
    if (c.kind === 'linked' || !c.dbName) return null;
    if (c.migrateError) throw badRequest('Shap couldn’t bring this client’s books up to date when it last started: their working papers open again once it can.');
    return clients.get(c.dbName);
  };
  const factsOf = async (c: ClientRow): Promise<ClientFacts> => {
    const books = booksOf(c);
    if (books) {
      const s = await getSettings(books);
      const [first] = await books<{ d: string | null }[]>`select min(date)::text as d from ledger_totals where amount_cents <> 0`;
      return { name: s.companyName || c.name, businessType: s.businessType as BusinessType, fyEndMonth: s.fyEndMonth, firstYearEnd: first?.d ? financialYear(first.d, s.fyEndMonth).end : null };
    }
    const inputs = (c.health as ClientHealth | null)?.deadlineInputs;
    if (!inputs) throw badRequest('Shap doesn’t know this client’s business or year end yet: run the checks first (their Shap sends them).');
    return { name: c.name, businessType: inputs.businessType, fyEndMonth: inputs.fyEndMonth, firstYearEnd: null };
  };
  /** The years whose working papers there can be: each ended year of the books (or the last four, on their own Shap), and any with papers already. */
  const yearsOf = async (c: ClientRow, f: ClientFacts): Promise<string[]> => {
    const last = lastEnded(f.fyEndMonth, today());
    const out = new Set<string>();
    const first = f.firstYearEnd && f.firstYearEnd <= last ? f.firstYearEnd : null;
    let end = last;
    for (let n = 0; n < 30 && end >= (first ?? '0000') && (first || n < 4); n++) {
      out.add(end);
      end = financialYear(addDays(financialYear(end, f.fyEndMonth).start, -1), f.fyEndMonth).end;
    }
    const kept = await real<{ fyEnd: string }[]>`
      select fy_end::text as fy_end from practice_notes where client_id = ${c.id}
      union select fy_end::text from practice_signoffs where client_id = ${c.id}
      union select fy_end::text from practice_ticks where client_id = ${c.id}`;
    for (const k of kept) out.add(k.fyEnd);
    return [...out].sort().reverse();
  };
  const tbOf = async (c: ClientRow, fyEnd: string) => {
    const books = booksOf(c);
    if (!books) return null;
    const tb = await trialBalance(books, fyEnd);
    return tb.rows.map((r) => ({ code: r.code, name: r.name, type: r.type, balanceCents: Number(r.balanceCents) }));
  };
  const names = async () => new Map((await real<{ id: string; name: string }[]>`select id, name from users`).map((u) => [u.id, u.name]));

  /* ------------------------------------------------------------------ letters */

  const letterInput = z.object({
    services: z.array(z.enum(SERVICES)).max(6),
    other: z.string().trim().max(2000).default(''),
    fromYearEnd: yearEnd,
    fees: z.string().trim().max(2000).default(''),
    body: z.string().trim().max(200).default(''),
  });
  const sections = z
    .array(z.object({ heading: z.string().trim().max(200), paragraphs: z.array(z.string().trim().max(4000)).max(40) }))
    .min(1)
    .max(30);
  const letterOr404 = async (clientId: string, lid: string) => {
    if (!uuid.safeParse(lid).success) throw notFound('Letter');
    const [l] = await real<LetterRow[]>`select ${letterCols(real)} from practice_letters where id = ${lid} and client_id = ${clientId}`;
    if (!l) throw notFound('Letter');
    return l;
  };
  const practiceName = async () => {
    const s = await getSettings(real);
    return { name: (s.tradingName || s.companyName || 'Our practice').slice(0, 200), address: s.address ?? '' };
  };

  app.get('/api/practice/clients/:id/letters', view, async (req) => {
    const user = userOrThrow(req);
    const { c } = await given(req, user);
    const who = await names();
    const letters = await real<LetterRow[]>`select ${letterCols(real)} from practice_letters where client_id = ${c.id} order by created_at desc`;
    const years = await real<{ letterId: string; fyEnd: string; confirmedBy: string | null; confirmedAt: Date }[]>`
      select letter_id, fy_end::text as fy_end, confirmed_by, confirmed_at from practice_letter_years where letter_id = any(${letters.map((l) => l.id)}::uuid[]) order by fy_end`;
    return {
      note: LETTER_NOTE,
      letters: letters.map((l) => ({
        ...l,
        createdBy: who.get(l.createdBy ?? '') ?? null,
        sentBy: who.get(l.sentBy ?? '') ?? null,
        acceptedBy: who.get(l.acceptedBy ?? '') ?? null,
        endedBy: who.get(l.endedBy ?? '') ?? null,
        years: years.filter((y) => y.letterId === l.id).map((y) => ({ fyEnd: y.fyEnd, by: who.get(y.confirmedBy ?? '') ?? null, at: y.confirmedAt })),
      })),
    };
  });

  /** A new letter, drafted from the client's details: the practice reads it and changes it before it's sent. */
  app.post('/api/practice/clients/:id/letters', { ...manage, config: limit(20) }, async (req) => {
    const user = userOrThrow(req);
    const { c } = await given(req, user);
    notArchived(c);
    const input = parse(letterInput, req.body);
    const f = await factsOf(c);
    if (!isYearEnd(input.fromYearEnd, f.fyEndMonth)) throw badRequest('Choose one of the client’s year ends: the last day of its year-end month.');
    const services = [...new Set(input.services)].filter((s) => s !== 'accounting_officer' || f.businessType === 'cc') as Service[];
    if (!services.length && !input.other) throw badRequest('Tick what your practice will do for them (or say it under Anything else).');
    const p = await practiceName();
    const body = letterSections({ practice: { name: p.name, partner: user.name, body: input.body }, client: { name: f.name, businessType: f.businessType }, kind: c.kind as LetterInput['kind'], services, other: input.other, fromYearEnd: input.fromYearEnd, fees: input.fees });
    const [l] = await real<{ id: string }[]>`
      insert into practice_letters (client_id, services, other, from_year_end, body, created_by)
      values (${c.id}, ${services}::text[], ${input.other}, ${input.fromYearEnd}, ${real.json(body as never)}, ${user.id}) returning id`;
    await audit(real, { userId: user.id, action: 'letter_draft', entity: 'practice_letter', entityId: l!.id, ip: req.ip, details: { client: c.id, services, fromYearEnd: input.fromYearEnd } });
    return { id: l!.id };
  });

  /** The draft's words, as the practice changes them. */
  app.put('/api/practice/clients/:id/letters/:lid', { ...manage, config: limit(60) }, async (req) => {
    const user = userOrThrow(req);
    const { c } = await given(req, user);
    notArchived(c);
    const l = await letterOr404(c.id, (req.params as { lid: string }).lid);
    if (l.status !== 'draft') throw badRequest('Only a draft is changed: this letter has been sent. Make a new one to change the terms.');
    const { body } = parse(z.object({ body: sections }), req.body);
    await real`update practice_letters set body = ${real.json(body as never)} where id = ${l.id}`;
    await audit(real, { userId: user.id, action: 'letter_edit', entity: 'practice_letter', entityId: l.id, ip: req.ip });
    return { ok: true };
  });

  app.delete('/api/practice/clients/:id/letters/:lid', manage, async (req) => {
    const user = userOrThrow(req);
    const { c } = await given(req, user);
    const l = await letterOr404(c.id, (req.params as { lid: string }).lid);
    if (l.status !== 'draft') throw badRequest('A letter that has been sent is kept: end it instead.');
    await real`delete from practice_letters where id = ${l.id}`;
    await audit(real, { userId: user.id, action: 'letter_delete', entity: 'practice_letter', entityId: l.id, ip: req.ip });
    return { ok: true };
  });

  /** Sent to the client (as the practice sends it: its PDF, from its own email). Its words are then kept as they are. */
  app.post('/api/practice/clients/:id/letters/:lid/sent', manage, async (req) => {
    const user = userOrThrow(req);
    const { c } = await given(req, user);
    notArchived(c);
    const l = await letterOr404(c.id, (req.params as { lid: string }).lid);
    if (l.status !== 'draft') throw badRequest('This letter was sent already.');
    await real`update practice_letters set status = 'sent', sent_at = now(), sent_by = ${user.id} where id = ${l.id}`;
    await audit(real, { userId: user.id, action: 'letter_sent', entity: 'practice_letter', entityId: l.id, ip: req.ip });
    return { ok: true };
  });

  /** The client's acceptance: a signed copy, or recorded (who accepted, in what capacity, and when). */
  app.post('/api/practice/clients/:id/letters/:lid/accept', { ...manage, bodyLimit: 9 * 1024 * 1024, config: limit(20) }, async (req) => {
    const user = userOrThrow(req);
    const { c } = await given(req, user);
    notArchived(c);
    const l = await letterOr404(c.id, (req.params as { lid: string }).lid);
    if (l.status !== 'sent') throw badRequest(l.status === 'draft' ? 'Send the letter first: it’s accepted as it was sent.' : 'This letter is accepted already, or ended.');
    const input = parse(
      z.object({ on: yearEnd, name: z.string().trim().min(1).max(200), capacity: z.string().trim().max(200).default(''), how: z.enum(['signed', 'recorded']), signed: attachmentInput.optional() }),
      req.body,
    );
    if (input.on > today()) throw badRequest('The day they accepted it can’t be after today.');
    if (input.on < (l.sentAt ? l.sentAt.toISOString().slice(0, 10) : '0000')) throw badRequest('The day they accepted it is after the day it was sent.');
    if (input.how === 'signed' && !input.signed) throw badRequest('Upload the signed copy (a PDF or a photo), or record the acceptance instead.');
    const bytes = input.how === 'signed' && input.signed ? fileBytes(input.signed) : null;
    await real`update practice_letters set status = 'accepted', accepted_on = ${input.on}, accepted_name = ${input.name}, accepted_capacity = ${input.capacity},
      accepted_how = ${input.how}, accepted_by = ${user.id},
      signed_name = ${bytes ? input.signed!.filename : null}, signed_mime = ${bytes ? input.signed!.mime : null}, signed_bytes = ${bytes}
      where id = ${l.id}`;
    await audit(real, { userId: user.id, action: 'letter_accepted', entity: 'practice_letter', entityId: l.id, ip: req.ip, details: { on: input.on, how: input.how } });
    return { ok: true };
  });

  /** The terms looked at again for a later year, and still fitting (ISRS 4410 (Revised) para 26). */
  app.post('/api/practice/clients/:id/letters/:lid/years', manage, async (req) => {
    const user = userOrThrow(req);
    const { c } = await given(req, user);
    notArchived(c);
    const l = await letterOr404(c.id, (req.params as { lid: string }).lid);
    const { fyEnd } = parse(z.object({ fyEnd: yearEnd }), req.body);
    if (l.status !== 'accepted') throw badRequest('Only an accepted letter, not ended, runs on to later years.');
    const f = await factsOf(c);
    if (!isYearEnd(fyEnd, f.fyEndMonth) || fyEnd <= l.fromYearEnd) throw badRequest('Choose a later year end of the client’s.');
    await real`insert into practice_letter_years (letter_id, fy_end, confirmed_by) values (${l.id}, ${fyEnd}, ${user.id}) on conflict do nothing`;
    await audit(real, { userId: user.id, action: 'letter_year', entity: 'practice_letter', entityId: l.id, ip: req.ip, details: { fyEnd } });
    return { ok: true };
  });

  app.post('/api/practice/clients/:id/letters/:lid/end', manage, async (req) => {
    const user = userOrThrow(req);
    const { c } = await given(req, user);
    const l = await letterOr404(c.id, (req.params as { lid: string }).lid);
    if (l.status === 'draft' || l.status === 'ended') throw badRequest(l.status === 'draft' ? 'A draft is deleted, not ended.' : 'This letter has ended already.');
    await real`update practice_letters set status = 'ended', ended_at = now(), ended_by = ${user.id} where id = ${l.id}`;
    await audit(real, { userId: user.id, action: 'letter_ended', entity: 'practice_letter', entityId: l.id, ip: req.ip });
    return { ok: true };
  });

  app.get('/api/practice/clients/:id/letters/:lid/pdf', { ...view, config: limit(30) }, async (req, reply) => {
    const user = userOrThrow(req);
    const { c } = await given(req, user);
    const l = await letterOr404(c.id, (req.params as { lid: string }).lid);
    const p = await practiceName();
    const pdf = await renderLetterPdf({ practice: p, client: c.name, letter: l });
    reply.header('content-type', 'application/pdf');
    reply.header('content-disposition', `attachment; filename="${`Engagement letter ${c.name}`.replace(/[^\w.\- ]/g, '').slice(0, 120)}.pdf"`);
    reply.header('cache-control', 'no-store');
    return reply.send(pdf);
  });

  app.get('/api/practice/clients/:id/letters/:lid/signed', { ...view, config: limit(30) }, async (req, reply) => {
    const user = userOrThrow(req);
    const { c } = await given(req, user);
    const l = await letterOr404(c.id, (req.params as { lid: string }).lid);
    const [f] = await real<{ signedName: string | null; signedMime: string | null; signedBytes: Buffer | null }[]>`select signed_name, signed_mime, signed_bytes from practice_letters where id = ${l.id}`;
    if (!f?.signedBytes) throw notFound('Signed copy');
    reply.header('content-type', f.signedMime ?? 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename="${(f.signedName ?? 'signed letter').replace(/[^\w.\- ]/g, '_')}"`);
    reply.header('content-security-policy', "script-src 'none'; object-src 'none'; frame-ancestors 'none'");
    reply.header('cache-control', 'no-store');
    return reply.send(f.signedBytes);
  });

  /* ----------------------------------------------------------- working papers */

  /** The year's working papers: its letter's standing, the trial balance with its ticks, the notes, the sign-offs. */
  const fileOf = async (c: ClientRow, level: Level, user: AuthUser, fyEnd: string | undefined) => {
    const f = await factsOf(c);
    const years = await yearsOf(c, f);
    const year = fyEnd ?? years[0];
    if (!year || !isYearEnd(year, f.fyEndMonth) || year > lastEnded(f.fyEndMonth, today())) throw badRequest('Choose a year of theirs that has ended.');
    const who = await names();
    const tb = await tbOf(c, year);
    const ticks = await real<TickRow[]>`select * from practice_ticks where client_id = ${c.id} and fy_end = ${year}`;
    const notes = await real<NoteRow[]>`select * from practice_notes where client_id = ${c.id} and fy_end = ${year} order by raised_at`;
    const replies = await real<ReplyRow[]>`select * from practice_note_replies where note_id = any(${notes.map((n) => n.id)}::uuid[]) order by at`;
    const signs = await real<{ role: Signoff; userId: string; at: Date; tbHash: string | null }[]>`select role, user_id, at, tb_hash from practice_signoffs where client_id = ${c.id} and fy_end = ${year}`;
    const hash = tb ? tbHash(tb) : null;
    const byCode = new Map(ticks.map((t) => [t.accountCode, t]));
    const lines = tb?.map((r) => {
      const t = byCode.get(r.code);
      return {
        ...r,
        prepared: t?.preparedBy ? { by: who.get(t.preparedBy) ?? 'Someone', at: t.preparedAt, changed: Number(t.preparedCents) !== r.balanceCents } : null,
        reviewed: t?.reviewedBy ? { by: who.get(t.reviewedBy) ?? 'Someone', at: t.reviewedAt, changed: Number(t.reviewedCents) !== r.balanceCents, samePerson: t.reviewedBy === t.preparedBy } : null,
      };
    });
    // Accounts ticked that are no longer in the trial balance (their balance went to nothing since).
    const gone = tb ? ticks.filter((t) => !tb.some((r) => r.code === t.accountCode)).map((t) => ({ code: t.accountCode, name: t.accountName })) : [];
    const letters = await real<LetterRow[]>`select ${letterCols(real)} from practice_letters where client_id = ${c.id} and status = 'accepted' and from_year_end <= ${year}`;
    const confirmed = await real<{ letterId: string }[]>`select letter_id from practice_letter_years where fy_end = ${year} and letter_id = any(${letters.map((l) => l.id)}::uuid[])`;
    const compiling = letters.filter((l) => l.services.includes('compile'));
    return {
      client: { id: c.id, name: c.name, kind: c.kind, archived: c.archivedAt != null },
      level,
      owner: user.role === 'owner',
      years,
      fyEnd: year,
      ticksHere: tb !== null,
      letter: {
        accepted: letters.length > 0,
        compiling: compiling.length > 0,
        // A later year than the letter's first: its terms looked at again for this one (ISRS 4410 para 26).
        termsLooked: letters.length > 0 && letters.every((l) => l.fromYearEnd === year || confirmed.some((x) => x.letterId === l.id)),
      },
      lines: lines ?? null,
      gone,
      notes: notes.map((n) => ({
        id: n.id,
        account: n.accountCode ? { code: n.accountCode, name: n.accountName } : null,
        text: n.text,
        raisedBy: who.get(n.raisedBy) ?? 'Someone',
        raisedAt: n.raisedAt,
        mine: n.raisedBy === user.id,
        cleared: n.clearedBy ? { by: who.get(n.clearedBy) ?? 'Someone', at: n.clearedAt } : null,
        replies: replies.filter((r) => r.noteId === n.id).map((r) => ({ text: r.text, by: who.get(r.byUser) ?? 'Someone', at: r.at })),
      })),
      signoffs: Object.fromEntries(
        SIGNOFFS.map((role) => {
          const s = signs.find((x) => x.role === role);
          return [role, s ? { by: who.get(s.userId) ?? 'Someone', mine: s.userId === user.id, userId: s.userId, at: s.at, changed: hash !== null && s.tbHash !== null && s.tbHash !== hash } : null];
        }),
      ) as Record<Signoff, { by: string; mine: boolean; userId: string; at: Date; changed: boolean } | null>,
      hash,
    };
  };

  app.get('/api/practice/clients/:id/file', view, async (req) => {
    const user = userOrThrow(req);
    const { c, level } = await given(req, user);
    const { fy } = parse(z.object({ fy: yearEnd.optional() }), req.query);
    const { hash: _h, ...file } = await fileOf(c, level, user, fy);
    return file;
  });

  /** An account at the year end ticked (or unticked) as prepared or reviewed, at its balance now. */
  app.post('/api/practice/clients/:id/file/ticks', { ...view, config: limit(240) }, async (req) => {
    const user = userOrThrow(req);
    const { c, level } = await given(req, user);
    notArchived(c);
    const { fyEnd, code, which, on } = parse(z.object({ fyEnd: yearEnd, code: z.string().min(1).max(40), which: z.enum(['prepared', 'reviewed']), on: z.boolean() }), req.body);
    if (which === 'prepared' && level !== 'books') throw forbidden('Ticking an account as prepared is for whoever writes up their books.');
    const tb = await tbOf(c, fyEnd);
    if (!tb) throw badRequest('Their books are on their own Shap, so their trial balance isn’t here to tick: use review notes and the year’s sign-offs.');
    const f = await factsOf(c);
    if (!isYearEnd(fyEnd, f.fyEndMonth) || fyEnd > lastEnded(f.fyEndMonth, today())) throw badRequest('Choose a year of theirs that has ended.');
    const line = tb.find((r) => r.code === code);
    if (on && !line) throw badRequest('That account has no balance at the year end.');
    const [t] = await real<TickRow[]>`select * from practice_ticks where client_id = ${c.id} and fy_end = ${fyEnd} and account_code = ${code}`;
    if (!on && t && (which === 'prepared' ? t.preparedBy : t.reviewedBy) !== user.id && user.role !== 'owner') throw forbidden('A tick is taken off by whoever ticked it, or an owner.');
    if (which === 'prepared')
      await real`insert into practice_ticks (client_id, fy_end, account_code, account_name, prepared_by, prepared_at, prepared_cents)
        values (${c.id}, ${fyEnd}, ${code}, ${line?.name ?? t?.accountName ?? code}, ${on ? user.id : null}, ${on ? new Date() : null}, ${on ? line!.balanceCents : null})
        on conflict (client_id, fy_end, account_code) do update set account_name = excluded.account_name, prepared_by = excluded.prepared_by, prepared_at = excluded.prepared_at, prepared_cents = excluded.prepared_cents`;
    else
      await real`insert into practice_ticks (client_id, fy_end, account_code, account_name, reviewed_by, reviewed_at, reviewed_cents)
        values (${c.id}, ${fyEnd}, ${code}, ${line?.name ?? t?.accountName ?? code}, ${on ? user.id : null}, ${on ? new Date() : null}, ${on ? line!.balanceCents : null})
        on conflict (client_id, fy_end, account_code) do update set account_name = excluded.account_name, reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at, reviewed_cents = excluded.reviewed_cents`;
    await real`delete from practice_ticks where client_id = ${c.id} and fy_end = ${fyEnd} and account_code = ${code} and prepared_by is null and reviewed_by is null`;
    await audit(real, { userId: user.id, action: on ? 'file_tick' : 'file_untick', entity: 'practice_client', entityId: c.id, ip: req.ip, details: { fyEnd, code, which, balanceCents: line?.balanceCents ?? null } });
    return { ok: true };
  });

  /** A review note on the year, or on one of its accounts. */
  app.post('/api/practice/clients/:id/file/notes', { ...view, config: limit(60) }, async (req) => {
    const user = userOrThrow(req);
    const { c } = await given(req, user);
    notArchived(c);
    const input = parse(z.object({ fyEnd: yearEnd, account: z.object({ code: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(200) }).nullable().default(null), text: z.string().trim().min(1).max(4000) }), req.body);
    const f = await factsOf(c);
    if (!isYearEnd(input.fyEnd, f.fyEndMonth) || input.fyEnd > lastEnded(f.fyEndMonth, today())) throw badRequest('Choose a year of theirs that has ended.');
    const [n] = await real<{ id: string }[]>`
      insert into practice_notes (client_id, fy_end, account_code, account_name, text, raised_by)
      values (${c.id}, ${input.fyEnd}, ${input.account?.code ?? null}, ${input.account?.name ?? null}, ${input.text}, ${user.id}) returning id`;
    await audit(real, { userId: user.id, action: 'file_note', entity: 'practice_client', entityId: c.id, ip: req.ip, details: { fyEnd: input.fyEnd, note: n!.id } });
    return { id: n!.id };
  });

  const noteOr404 = async (clientId: string, nid: string) => {
    if (!uuid.safeParse(nid).success) throw notFound('Review note');
    const [n] = await real<NoteRow[]>`select * from practice_notes where id = ${nid} and client_id = ${clientId}`;
    if (!n) throw notFound('Review note');
    return n;
  };

  app.post('/api/practice/clients/:id/file/notes/:nid/replies', { ...view, config: limit(60) }, async (req) => {
    const user = userOrThrow(req);
    const { c } = await given(req, user);
    notArchived(c);
    const n = await noteOr404(c.id, (req.params as { nid: string }).nid);
    if (n.clearedBy) throw badRequest('That note is cleared: open it again first (whoever raised it, or an owner).');
    const { text } = parse(z.object({ text: z.string().trim().min(1).max(4000) }), req.body);
    await real`insert into practice_note_replies (note_id, text, by_user) values (${n.id}, ${text}, ${user.id})`;
    await audit(real, { userId: user.id, action: 'file_note_reply', entity: 'practice_client', entityId: c.id, ip: req.ip, details: { note: n.id } });
    return { ok: true };
  });

  /** Cleared (or opened again) by whoever raised it, or an owner. */
  app.post('/api/practice/clients/:id/file/notes/:nid/clear', { ...view, config: limit(60) }, async (req) => {
    const user = userOrThrow(req);
    const { c } = await given(req, user);
    notArchived(c);
    const n = await noteOr404(c.id, (req.params as { nid: string }).nid);
    const { cleared } = parse(z.object({ cleared: z.boolean() }), req.body);
    if (n.raisedBy !== user.id && user.role !== 'owner') throw forbidden('A review note is cleared by whoever raised it, or an owner.');
    await real`update practice_notes set cleared_by = ${cleared ? user.id : null}, cleared_at = ${cleared ? new Date() : null} where id = ${n.id}`;
    // Opened again: the year's review and partner sign-offs no longer stand over it.
    if (!cleared) await real`delete from practice_signoffs where client_id = ${c.id} and fy_end = ${n.fyEnd} and role in ('reviewed', 'partner')`;
    await audit(real, { userId: user.id, action: cleared ? 'file_note_cleared' : 'file_note_opened', entity: 'practice_client', entityId: c.id, ip: req.ip, details: { note: n.id } });
    return { ok: true };
  });

  /** The year signed off (or the sign-off taken back) as prepared, reviewed, or by the engagement partner. */
  app.put('/api/practice/clients/:id/file/signoffs', { ...view, config: limit(60) }, async (req) => {
    const user = userOrThrow(req);
    const { c, level } = await given(req, user);
    notArchived(c);
    const { fyEnd, role, on } = parse(z.object({ fyEnd: yearEnd, role: z.enum(SIGNOFFS), on: z.boolean() }), req.body);
    const file = await fileOf(c, level, user, fyEnd);
    const was = file.signoffs[role];
    if (!on) {
      if (!was) return { ok: true };
      if (!was.mine && user.role !== 'owner') throw forbidden('A sign-off is taken back by whoever gave it, or an owner.');
      await real`delete from practice_signoffs where client_id = ${c.id} and fy_end = ${fyEnd} and role = ${role}`;
      await audit(real, { userId: user.id, action: 'file_signoff_removed', entity: 'practice_client', entityId: c.id, ip: req.ip, details: { fyEnd, role } });
      return { ok: true };
    }
    if (role === 'prepared' && level !== 'books') throw forbidden('Signing the year off as prepared is for whoever writes up their books.');
    if (role === 'partner' && user.role !== 'owner') throw forbidden('The engagement partner’s sign-off is an owner’s (the practice’s partners are its owners in Shap).');
    if (role !== 'prepared' && file.notes.some((n) => !n.cleared)) throw badRequest(OPEN_NOTES);
    await real`insert into practice_signoffs (client_id, fy_end, role, user_id, tb_hash) values (${c.id}, ${fyEnd}, ${role}, ${user.id}, ${file.hash})
      on conflict (client_id, fy_end, role) do update set user_id = excluded.user_id, at = now(), tb_hash = excluded.tb_hash`;
    await audit(real, { userId: user.id, action: 'file_signoff', entity: 'practice_client', entityId: c.id, ip: req.ip, details: { fyEnd, role } });
    return { ok: true };
  });

  /** The year's file as a PDF: the practice's record of the engagement (ISRS 4410 (Revised) para 38). */
  app.get('/api/practice/clients/:id/file/pdf', { ...view, config: limit(20) }, async (req, reply) => {
    const user = userOrThrow(req);
    const { c, level } = await given(req, user);
    const { fy } = parse(z.object({ fy: yearEnd.optional() }), req.query);
    const file = await fileOf(c, level, user, fy);
    const p = await practiceName();
    const pdf = await renderFilePdf({ practice: p.name, file });
    await audit(real, { userId: user.id, action: 'file_pdf', entity: 'practice_client', entityId: c.id, ip: req.ip, details: { fyEnd: file.fyEnd } });
    reply.header('content-type', 'application/pdf');
    reply.header('content-disposition', `attachment; filename="${`Working papers ${c.name} ${file.fyEnd}`.replace(/[^\w.\- ]/g, '').slice(0, 120)}.pdf"`);
    reply.header('cache-control', 'no-store');
    return reply.send(pdf);
  });
}

/** A letter's columns, its days as text (YYYY-MM-DD), without the signed copy's bytes. */
const letterCols = (sql: Sql) =>
  sql`id, client_id, services, other, from_year_end::text as from_year_end, body, status, created_by, created_at, sent_at, sent_by,
    accepted_on::text as accepted_on, accepted_name, accepted_capacity, accepted_how, accepted_by, ended_at, ended_by, signed_name`;

export interface LetterRow {
  id: string;
  clientId: string;
  services: Service[];
  other: string;
  fromYearEnd: string;
  body: LetterSection[];
  status: 'draft' | 'sent' | 'accepted' | 'ended';
  createdBy: string | null;
  createdAt: Date;
  sentAt: Date | null;
  sentBy: string | null;
  acceptedOn: string | null;
  acceptedName: string | null;
  acceptedCapacity: string | null;
  acceptedHow: 'signed' | 'recorded' | null;
  acceptedBy: string | null;
  endedAt: Date | null;
  endedBy: string | null;
  signedName: string | null;
}
interface TickRow {
  accountCode: string;
  accountName: string;
  preparedBy: string | null;
  preparedAt: Date | null;
  preparedCents: number | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewedCents: number | null;
}
interface NoteRow {
  id: string;
  fyEnd: string;
  accountCode: string | null;
  accountName: string | null;
  text: string;
  raisedBy: string;
  raisedAt: Date;
  clearedBy: string | null;
  clearedAt: Date | null;
}
interface ReplyRow {
  noteId: string;
  text: string;
  byUser: string;
  at: Date;
}
