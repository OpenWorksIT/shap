/**
 * Shap Accountant, phase 5 (docs/ACCOUNTANT.md, "Engagement letters and working papers"): the
 * practice's own records about each client, in the practice's database, never in the client's books.
 *
 * - **Engagement letters**: drafted from the client's details (lib/engagement.ts), changed as the
 *   practice likes while a draft (its words and its parties), sent (Shap doesn't send it: the
 *   practice does, from its PDF), accepted by the client (a signed copy kept with it, or the
 *   acceptance recorded), looked at again for each later year (ISRS 4410 (Revised) para 26), ended
 *   (with the last year it covers). For whoever manages the practice's clients; anyone given the
 *   client reads them. What's sent is kept: each change asks for the status it expects, and the
 *   database refuses the rest (migration 052's practice_letter_kept).
 * - **Working papers** for each year the client's books have ended: review notes (raised, answered,
 *   cleared by whoever raised them or an owner), each account at the year end ticked as prepared and
 *   reviewed (books on this server: not a client on its own Shap, whose trial balance doesn't come
 *   here), and the year signed off as prepared, reviewed and by the engagement partner (an owner),
 *   none of the last two over an open note: a note raised or opened again takes them back. Each
 *   tick and sign-off keeps the trial balance as it was (by the account itself, not its code), to
 *   say when the books have changed since. The year's file downloads as a PDF: an aid towards ISRS
 *   4410 para 38's record, not the whole of it (the final set and report are kept with it too).
 *
 * Nothing here stops anyone compiling or filing: on the practice's list and the compile form, what's
 * missing is a check, not a lock (the owner's choice).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { addDays, attachmentInput, dayOf, financialYear, formatDate, LETTER_MAX_CHARS, LETTER_NOTE, NOTES_PER_YEAR, REPLIES_PER_NOTE, SERVICES, YEAR_NOTES_MAX_CHARS, SIGNOFFS, type BusinessType, type Level, type Service, type Signoff } from '@shap/shared';
import { z } from 'zod';
import { requireAccess, userOrThrow, type AuthUser } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Db, Sql } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { freshTotals, getSettings, today } from '../lib/books.js';
import { letterSections, servicesFor, type LetterInput, type LetterSection } from '../lib/engagement.js';
import { renderFilePdf, renderLetterPdf } from '../lib/engagement-pdf.js';
import { badRequest, forbidden, notFound, HttpError } from '../lib/errors.js';
import { ownRefusal, type ClientHealth } from '../lib/practice.js';
import { parse } from '../lib/validate.js';
import { lastEnded, letterStanding, tbHash, yearTb, type CoverLetter, type YearTb } from '../lib/papers.js';
import { accountantTermsAccepted, ACCOUNTANT_TERMS_NEEDED, levelFor, practiceOn, type ClientRow } from './practice.js';
import { fileBytes } from './settings.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** A route that takes less than the general upload limit: what the "too big" refusal says (app.ts). */
    uploadMb?: number;
  }
}

const uuid = z.string().uuid();
const yearEnd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ARCHIVED = 'That client is archived: its letters and working papers are kept as they are.';
const OPEN_NOTES = 'There are review notes still open on this year: they’re cleared (by whoever raised them, or an owner) before it’s signed off as reviewed or by the engagement partner.';
const NO_YEAR = 'Choose a year of theirs that has ended.';
/** A practice with no name in Settings: its letter isn't sent until it has one. */
const NO_NAME = 'Our practice';

/** What the client is, as the letter and the file need it: from its own books, or from what its linked Shap last sent. */
interface ClientFacts {
  /** Its legal name (the books' company name), or the practice's name for it. */
  name: string;
  businessType: BusinessType;
  fyEndMonth: number;
  approvedPbo: boolean;
  turnoverTax: boolean;
  /** The books' first year end (a client whose books are here), if any. */
  firstYearEnd: string | null;
}

/** A year end is the last day of the client's year-end month. */
const isYearEnd = (d: string, fyEndMonth: number) => {
  try {
    return financialYear(d, fyEndMonth).end === d;
  } catch {
    return false;
  }
};
/** The year before this year end (the twelve months before it). */
const yearBefore = (end: string, fyEndMonth: number) => financialYear(addDays(financialYear(end, fyEndMonth).start, -1), fyEndMonth).end;

export function registerWorkingPaperRoutes(app: FastifyInstance, ctx: Ctx): void {
  const real: Sql = ctx.dbs.real;
  const clients = ctx.clients;
  const view = { preHandler: requireAccess('practice.clients') };
  const manage = { preHandler: requireAccess('practice.manage') };
  const limit = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute' } });

  const assertOn = async () => {
    if (!(await practiceOn(real))) throw badRequest('Shap Accountant is off. The owner switches it on under Settings → What you use.');
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
  const booksOf = async (c: ClientRow): Promise<Sql | null> => {
    if (c.kind === 'linked' || !c.dbName) return null;
    if (c.migrateError) throw badRequest('Shap couldn’t bring this client’s books up to date when it last started: their working papers open again once it can.');
    // Only its own database (one another login made under its name never: lib/practice.ts assertOwned).
    try {
      return await clients.openOwn(c.dbName);
    } catch (err) {
      throw new HttpError(409, ownRefusal(err), 'not_ours');
    }
  };
  const factsOf = async (c: ClientRow): Promise<ClientFacts> => {
    const books = await booksOf(c);
    if (books) {
      const s = await getSettings(books);
      await freshTotals(books);
      const [first] = await books<{ d: string | null }[]>`select min(date)::text as d from ledger_totals where amount_cents <> 0`;
      return {
        name: s.companyName || c.name,
        businessType: s.businessType as BusinessType,
        fyEndMonth: s.fyEndMonth,
        approvedPbo: Boolean(s.approvedPbo),
        turnoverTax: Boolean(s.turnoverTax),
        firstYearEnd: first?.d ? financialYear(first.d, s.fyEndMonth).end : null,
      };
    }
    const inputs = (c.health as ClientHealth | null)?.deadlineInputs;
    if (!inputs) throw badRequest('Shap doesn’t know this client’s business or year end yet: run the checks first (their Shap sends them).');
    return { name: c.name, businessType: inputs.businessType, fyEndMonth: inputs.fyEndMonth, approvedPbo: Boolean(inputs.approvedPbo), turnoverTax: Boolean(inputs.turnoverTax), firstYearEnd: null };
  };
  /**
   * The years whose working papers there can be: each ended year of the books since they start (or,
   * on their own Shap, the last four), the years the books have ended or have statements for, and any
   * with papers already. The last three stay whatever the client's year-end month is now.
   */
  const yearsOf = async (c: ClientRow, f: ClientFacts): Promise<string[]> => {
    const last = lastEnded(f.fyEndMonth, today());
    const out = new Set<string>();
    const first = f.firstYearEnd && f.firstYearEnd <= last ? f.firstYearEnd : null;
    if (first || c.kind === 'linked') for (let end = last, n = 0; n < 30 && (first ? end >= first : n < 4); n++, end = yearBefore(end, f.fyEndMonth)) out.add(end);
    const kept = await real<{ fyEnd: string }[]>`
      select fy_end::text as fy_end from practice_notes where client_id = ${c.id}
      union select fy_end::text from practice_signoffs where client_id = ${c.id}
      union select fy_end::text from practice_ticks where client_id = ${c.id}`;
    for (const k of kept) out.add(k.fyEnd);
    const books = await booksOf(c);
    if (books) {
      const ended = await books<{ fyEnd: string }[]>`
        select fy_end::text as fy_end from year_ends where fy_end < ${today()}::date
        union select fy_end::text from financial_statements where fy_end < ${today()}::date`;
      for (const e of ended) out.add(e.fyEnd);
    }
    return [...out].sort().reverse();
  };
  /** A year that's one of theirs, and has ended. */
  const yearOf = async (c: ClientRow, fyEnd: string) => {
    const f = await factsOf(c);
    if (!(await yearsOf(c, f)).includes(fyEnd)) throw badRequest(NO_YEAR);
    return f;
  };
  const tbOf = async (c: ClientRow, fyEnd: string): Promise<YearTb | null> => {
    const books = await booksOf(c);
    return books ? yearTb(books, fyEnd) : null;
  };
  const names = async () => new Map((await real<{ id: string; name: string }[]>`select id, name from users`).map((u) => [u.id, u.name]));

  /* ------------------------------------------------------------------ letters */

  const letterInput = z.object({
    services: z.array(z.enum(SERVICES)).max(6),
    other: z.string().trim().max(2000).default(''),
    fromYearEnd: yearEnd,
    fees: z.string().trim().max(2000).default(''),
    body: z.string().trim().max(200).default(''),
    /** Those of the practice who prepare returns are registered tax practitioners (or supervised by one): the practice says so, Shap doesn't. */
    registered: z.boolean().default(false),
  });
  const sections = z
    .array(z.object({ heading: z.string().trim().max(200), paragraphs: z.array(z.string().trim().max(4000)).max(40) }))
    .min(1)
    .max(30)
    .refine((ss) => ss.reduce((n, s) => n + s.heading.length + s.paragraphs.reduce((m, p) => m + p.length, 0), 0) <= LETTER_MAX_CHARS, {
      message: `A letter runs to ${LETTER_MAX_CHARS.toLocaleString('en-ZA')} characters at most, all its parts together: shorten it.`,
    });
  const parties = z.object({
    practiceName: z.string().trim().min(1).max(200),
    practiceReg: z.string().trim().max(60).default(''),
    practiceTrading: z.string().trim().max(200).default(''),
    practiceAddress: z.string().trim().max(500).default(''),
    clientName: z.string().trim().min(1).max(200),
  });
  const letterOr404 = async (clientId: string, lid: string) => {
    if (!uuid.safeParse(lid).success) throw notFound('Letter');
    const [l] = await real<LetterRow[]>`select ${letterCols(real)} from practice_letters where id = ${lid} and client_id = ${clientId}`;
    if (!l) throw notFound('Letter');
    return l;
  };
  /** A change that found the letter no longer as it expected (someone else moved it on): why. */
  const movedOn = async (lid: string, why: string): Promise<never> => {
    const [still] = await real`select 1 from practice_letters where id = ${lid}`;
    throw still ? badRequest(why) : notFound('Letter');
  };
  /** The practice as a letter names it: its legal name, registration number, trading name and address (Settings). */
  const practiceParty = async () => {
    const s = await getSettings(real);
    const name = (s.companyName || s.tradingName || NO_NAME).slice(0, 200);
    return { practiceName: name, practiceReg: (s.regNumber ?? '').slice(0, 60), practiceTrading: s.tradingName && s.tradingName !== name ? s.tradingName.slice(0, 200) : '', practiceAddress: (s.address ?? '').slice(0, 500) };
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
    const kind = c.kind as LetterInput['kind'];
    const services = servicesFor(input.services, f.businessType, kind);
    if (!services.length && !input.other) {
      if (input.services.includes('accounting_officer') && f.businessType !== 'cc') throw badRequest('An accounting officer is only a close corporation’s: tick what else your practice will do for them (or say it under Anything else).');
      if (input.services.includes('books') && kind === 'pocket') throw badRequest('A Shap Pocket client writes up their own books: tick what else your practice will do for them (or say it under Anything else).');
      throw badRequest('Tick what your practice will do for them (or say it under Anything else).');
    }
    const p = await practiceParty();
    const body = letterSections({ practice: { body: input.body, registered: input.registered }, client: { businessType: f.businessType, approvedPbo: f.approvedPbo, turnoverTax: f.turnoverTax }, kind, services, other: input.other, fromYearEnd: input.fromYearEnd, fees: input.fees });
    const [l] = await real<{ id: string }[]>`
      insert into practice_letters (client_id, services, other, from_year_end, body, practice_name, practice_reg, practice_trading, practice_address, client_name, created_by)
      values (${c.id}, ${services}::text[], ${input.other}, ${input.fromYearEnd}, ${real.json(body as never)}, ${p.practiceName}, ${p.practiceReg}, ${p.practiceTrading}, ${p.practiceAddress}, ${f.name.slice(0, 200)}, ${user.id}) returning id`;
    await audit(real, { userId: user.id, action: 'letter_draft', entity: 'practice_letter', entityId: l!.id, ip: req.ip, details: { client: c.id, services, fromYearEnd: input.fromYearEnd } });
    return { id: l!.id };
  });

  /** The draft's words and parties, as the practice changes them. */
  app.put('/api/practice/clients/:id/letters/:lid', { ...manage, config: limit(60) }, async (req) => {
    const user = userOrThrow(req);
    const { c } = await given(req, user);
    notArchived(c);
    const l = await letterOr404(c.id, (req.params as { lid: string }).lid);
    const input = parse(z.object({ body: sections, parties }), req.body);
    const p = input.parties;
    const [done] = await real`update practice_letters set body = ${real.json(input.body as never)}, practice_name = ${p.practiceName}, practice_reg = ${p.practiceReg},
      practice_trading = ${p.practiceTrading}, practice_address = ${p.practiceAddress}, client_name = ${p.clientName}
      where id = ${l.id} and status = 'draft' returning id`;
    if (!done) await movedOn(l.id, 'Only a draft is changed: this letter has been sent. Make a new one to change the terms.');
    await audit(real, { userId: user.id, action: 'letter_edit', entity: 'practice_letter', entityId: l.id, ip: req.ip });
    return { ok: true };
  });

  app.delete('/api/practice/clients/:id/letters/:lid', manage, async (req) => {
    const user = userOrThrow(req);
    const { c } = await given(req, user);
    notArchived(c);
    const l = await letterOr404(c.id, (req.params as { lid: string }).lid);
    const [done] = await real`delete from practice_letters where id = ${l.id} and status = 'draft' returning id`;
    if (!done) await movedOn(l.id, 'A letter that has been sent is kept: end it instead.');
    await audit(real, { userId: user.id, action: 'letter_delete', entity: 'practice_letter', entityId: l.id, ip: req.ip });
    return { ok: true };
  });

  /** Sent to the client (by the practice: its PDF, from its own email). Its words and parties are then kept as they are. */
  app.post('/api/practice/clients/:id/letters/:lid/sent', manage, async (req) => {
    const user = userOrThrow(req);
    const { c } = await given(req, user);
    notArchived(c);
    const l = await letterOr404(c.id, (req.params as { lid: string }).lid);
    if (l.status === 'draft' && l.practiceName === NO_NAME) throw badRequest('Name your practice in the letter first (Change the words: its legal name), or under Settings, then draft it again.');
    const [done] = await real`update practice_letters set status = 'sent', sent_at = ${new Date()}, sent_by = ${user.id} where id = ${l.id} and status = 'draft' returning id`;
    if (!done) await movedOn(l.id, 'This letter was sent already.');
    await audit(real, { userId: user.id, action: 'letter_sent', entity: 'practice_letter', entityId: l.id, ip: req.ip });
    return { ok: true };
  });

  /** The client's acceptance: a signed copy, or recorded (who accepted, in what capacity, and when). */
  app.post('/api/practice/clients/:id/letters/:lid/accept', { ...manage, bodyLimit: 9 * 1024 * 1024, config: { ...limit(20), uploadMb: 6 } }, async (req) => {
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
    const sentDay = l.sentAt ? dayOf(l.sentAt) : null;
    if (sentDay && input.on < sentDay) throw badRequest(`The day they accepted it can’t be before the day it was sent (${formatDate(sentDay, 'long')}).`);
    if (input.how === 'signed' && !input.signed) throw badRequest('Upload the signed copy (a PDF or a photo), or record the acceptance instead.');
    const bytes = input.how === 'signed' && input.signed ? fileBytes(input.signed) : null;
    const [done] = await real`update practice_letters set status = 'accepted', accepted_on = ${input.on}, accepted_name = ${input.name}, accepted_capacity = ${input.capacity},
      accepted_how = ${input.how}, accepted_by = ${user.id},
      signed_name = ${bytes ? input.signed!.filename : null}, signed_mime = ${bytes ? input.signed!.mime : null}, signed_bytes = ${bytes}
      where id = ${l.id} and status = 'sent' returning id`;
    if (!done) await movedOn(l.id, 'This letter is accepted already, or ended.');
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

  /** Ended in Shap, with the last year it covers: the practice's record (the engagement itself ends as the letter says, in writing). */
  app.post('/api/practice/clients/:id/letters/:lid/end', manage, async (req) => {
    const user = userOrThrow(req);
    const { c } = await given(req, user);
    notArchived(c);
    const l = await letterOr404(c.id, (req.params as { lid: string }).lid);
    if (l.status === 'draft' || l.status === 'ended') throw badRequest(l.status === 'draft' ? 'A draft is deleted, not ended.' : 'This letter has ended already.');
    const { lastYearEnd } = parse(z.object({ lastYearEnd: yearEnd.nullable().default(null) }), req.body ?? {});
    // Only an accepted letter covered any year; one that was only sent covered none.
    const last = l.status === 'accepted' ? lastYearEnd : null;
    if (last) {
      const f = await factsOf(c);
      const known = (await yearsOf(c, f)).includes(last);
      if (last < l.fromYearEnd || (!known && !isYearEnd(last, f.fyEndMonth)) || last > financialYear(today(), f.fyEndMonth).end)
        throw badRequest('Choose the last year end it covers: its first, or a later one that has come (or none, if it covered none).');
    }
    const [done] = await real`update practice_letters set status = 'ended', ended_at = ${new Date()}, ended_by = ${user.id}, last_year_end = ${last}
      where id = ${l.id} and status in ('sent', 'accepted') returning id`;
    if (!done) await movedOn(l.id, 'This letter has ended already.');
    await audit(real, { userId: user.id, action: 'letter_ended', entity: 'practice_letter', entityId: l.id, ip: req.ip, details: { lastYearEnd: last } });
    return { ok: true };
  });

  app.get('/api/practice/clients/:id/letters/:lid/pdf', { ...view, config: limit(30) }, async (req, reply) => {
    const user = userOrThrow(req);
    const { c } = await given(req, user);
    const l = await letterOr404(c.id, (req.params as { lid: string }).lid);
    const pdf = await renderLetterPdf({ letter: { ...l, sentDay: l.sentAt ? dayOf(l.sentAt) : null }, draftNote: LETTER_NOTE });
    await audit(real, { userId: user.id, action: 'letter_pdf', entity: 'practice_letter', entityId: l.id, ip: req.ip });
    reply.header('content-type', 'application/pdf');
    reply.header('content-disposition', `attachment; filename="${`Engagement letter ${l.clientName}${l.status === 'draft' ? ' (draft)' : ''}`.replace(/[^\w.\-() ]/g, '').slice(0, 120)}.pdf"`);
    reply.header('cache-control', 'no-store');
    return reply.send(pdf);
  });

  app.get('/api/practice/clients/:id/letters/:lid/signed', { ...view, config: limit(30) }, async (req, reply) => {
    const user = userOrThrow(req);
    const { c } = await given(req, user);
    const l = await letterOr404(c.id, (req.params as { lid: string }).lid);
    const [f] = await real<{ signedName: string | null; signedMime: string | null; signedBytes: Buffer | null }[]>`select signed_name, signed_mime, signed_bytes from practice_letters where id = ${l.id}`;
    if (!f?.signedBytes) throw notFound('Signed copy');
    await audit(real, { userId: user.id, action: 'letter_signed_copy', entity: 'practice_letter', entityId: l.id, ip: req.ip });
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
    // The year ends a new letter can start from that haven't ended yet: this year's and the next (a letter usually comes before the work).
    const thisEnd = financialYear(today(), f.fyEndMonth).end;
    const coming = [financialYear(addDays(thisEnd, 1), f.fyEndMonth).end, thisEnd];
    const head = { client: { id: c.id, name: c.name, kind: c.kind, archived: c.archivedAt != null }, level, owner: user.role === 'owner', years, coming };
    const year = fyEnd ?? years[0];
    if (!year) {
      if (fyEnd) throw badRequest(NO_YEAR);
      return { ...head, fyEnd: null, empty: true as const };
    }
    if (!years.includes(year)) throw badRequest(NO_YEAR);
    const who = await names();
    const books = await booksOf(c);
    const tb = await tbOf(c, year);
    const ticks = await real<TickRow[]>`select * from practice_ticks where client_id = ${c.id} and fy_end = ${year}`;
    const notes = await real<NoteRow[]>`select ${noteCols(real)} from practice_notes where client_id = ${c.id} and fy_end = ${year} order by raised_at`;
    const replies = await real<ReplyRow[]>`select * from practice_note_replies where note_id = any(${notes.map((n) => n.id)}::uuid[]) order by at`;
    const signs = await real<{ role: Signoff; userId: string; at: Date; tbHash: string | null }[]>`select role, user_id, at, tb_hash from practice_signoffs where client_id = ${c.id} and fy_end = ${year}`;
    const hash = tb ? tbHash(tb.rows) : null;
    const byAccount = new Map(ticks.map((t) => [t.accountId, t]));
    const lines = tb?.rows.map((r) => {
      const t = byAccount.get(r.id);
      return {
        accountId: r.id,
        code: r.code,
        name: r.name,
        type: r.type,
        debitCents: r.debitCents,
        creditCents: r.creditCents,
        balanceCents: r.balanceCents,
        // Changed since: its balance, or the kind of account it is (an expense made an asset).
        prepared: t?.preparedBy ? { by: who.get(t.preparedBy) ?? 'Someone', at: t.preparedAt, changed: Number(t.preparedCents) !== r.balanceCents || (t.preparedType !== null && t.preparedType !== r.type) } : null,
        reviewed: t?.reviewedBy ? { by: who.get(t.reviewedBy) ?? 'Someone', at: t.reviewedAt, changed: Number(t.reviewedCents) !== r.balanceCents || (t.reviewedType !== null && t.reviewedType !== r.type), samePerson: t.reviewedBy === t.preparedBy } : null,
      };
    });
    // Accounts ticked that are no longer in the trial balance (their balance went to nothing since).
    const gone = tb ? ticks.filter((t) => !tb.rows.some((r) => r.id === t.accountId)).map((t) => ({ code: t.accountCode, name: t.accountName })) : [];
    const letters = await real<CoverLetter[]>`
      select id, status, services, from_year_end::text as from_year_end, accepted_on::text as accepted_on, last_year_end::text as last_year_end, created_at from practice_letters where client_id = ${c.id}`;
    const confirmed = await real<{ letterId: string; fyEnd: string }[]>`select letter_id, fy_end::text as fy_end from practice_letter_years where fy_end = ${year} and letter_id = any(${letters.map((l) => l.id)}::uuid[])`;
    // The year's statements, where the books are here: when they were compiled and approved (a copy of the final set and report is kept with the file, para 38(c)).
    const [fs] = books ? await books<{ status: string; compiledOn: string | null; approvedOn: string | null }[]>`select status, compiled_on::text as compiled_on, approved_on::text as approved_on from financial_statements where fy_end = ${year}` : [];
    return {
      ...head,
      fyEnd: year,
      empty: false as const,
      ticksHere: tb !== null,
      letter: letterStanding(letters, confirmed, year),
      statements: books ? { status: fs?.status ?? 'draft', compiledOn: fs?.compiledOn ?? null, approvedOn: fs?.approvedOn ?? null } : null,
      lines: lines ?? null,
      totals: tb?.totals ?? null,
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
      tb: tb?.rows ?? null,
    };
  };

  /** The reviewed and engagement partner sign-offs taken back (a note raised, or opened again): each recorded. */
  const takeBack = async (clientId: string, fyEnd: string, userId: string, ip: string, note: string): Promise<Signoff[]> => {
    const gone = await real<{ role: Signoff }[]>`delete from practice_signoffs where client_id = ${clientId} and fy_end = ${fyEnd} and role in ('reviewed', 'partner') returning role`;
    for (const g of gone) await audit(real, { userId, action: 'file_signoff_removed', entity: 'practice_client', entityId: clientId, ip, details: { fyEnd, role: g.role, note } });
    return gone.map((g) => g.role);
  };

  app.get('/api/practice/clients/:id/file', view, async (req) => {
    const user = userOrThrow(req);
    const { c, level } = await given(req, user);
    const { fy } = parse(z.object({ fy: yearEnd.optional() }), req.query);
    const file = await fileOf(c, level, user, fy);
    if (file.empty) return file;
    const { hash: _h, tb: _t, ...out } = file;
    return out;
  });

  /** An account at the year end ticked (or unticked) as prepared or reviewed, at its balance now. */
  app.post('/api/practice/clients/:id/file/ticks', { ...view, config: limit(240) }, async (req) => {
    const user = userOrThrow(req);
    const { c, level } = await given(req, user);
    notArchived(c);
    const { fyEnd, accountId, which, on } = parse(z.object({ fyEnd: yearEnd, accountId: uuid, which: z.enum(['prepared', 'reviewed']), on: z.boolean() }), req.body);
    if (which === 'prepared' && level !== 'books') throw forbidden('Ticking an account as prepared is for whoever writes up their books.');
    if (!(await booksOf(c))) throw badRequest('Their books are on their own Shap, so their trial balance isn’t here to tick: use review notes and the year’s sign-offs.');
    await yearOf(c, fyEnd);
    const tb = (await tbOf(c, fyEnd))!;
    const line = tb.rows.find((r) => r.id === accountId);
    if (on && !line) throw badRequest('That account has no balance at the year end.');
    const [t] = await real<TickRow[]>`select * from practice_ticks where client_id = ${c.id} and fy_end = ${fyEnd} and account_id = ${accountId}`;
    if (!on && !t) return { ok: true };
    if (!on && t && (which === 'prepared' ? t.preparedBy : t.reviewedBy) !== user.id && user.role !== 'owner') throw forbidden('A tick is taken off by whoever ticked it, or an owner.');
    const code = line?.code ?? t!.accountCode;
    const name = line?.name ?? t!.accountName;
    if (which === 'prepared')
      await real`insert into practice_ticks (client_id, fy_end, account_id, account_code, account_name, prepared_by, prepared_at, prepared_cents, prepared_type)
        values (${c.id}, ${fyEnd}, ${accountId}, ${code}, ${name}, ${on ? user.id : null}, ${on ? new Date() : null}, ${on ? line!.balanceCents : null}, ${on ? line!.type : null})
        on conflict (client_id, fy_end, account_id) do update set account_code = excluded.account_code, account_name = excluded.account_name, prepared_by = excluded.prepared_by, prepared_at = excluded.prepared_at, prepared_cents = excluded.prepared_cents, prepared_type = excluded.prepared_type`;
    else
      await real`insert into practice_ticks (client_id, fy_end, account_id, account_code, account_name, reviewed_by, reviewed_at, reviewed_cents, reviewed_type)
        values (${c.id}, ${fyEnd}, ${accountId}, ${code}, ${name}, ${on ? user.id : null}, ${on ? new Date() : null}, ${on ? line!.balanceCents : null}, ${on ? line!.type : null})
        on conflict (client_id, fy_end, account_id) do update set account_code = excluded.account_code, account_name = excluded.account_name, reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at, reviewed_cents = excluded.reviewed_cents, reviewed_type = excluded.reviewed_type`;
    await real`delete from practice_ticks where client_id = ${c.id} and fy_end = ${fyEnd} and account_id = ${accountId} and prepared_by is null and reviewed_by is null`;
    // No account or balance in the log: the practice's audit log is open to people not given this client.
    await audit(real, { userId: user.id, action: on ? 'file_tick' : 'file_untick', entity: 'practice_client', entityId: c.id, ip: req.ip, details: { fyEnd, which } });
    return { ok: true };
  });

  /** A review note on the year, or on one of its accounts: the year's review and partner sign-offs no longer stand over it. */
  app.post('/api/practice/clients/:id/file/notes', { ...view, config: limit(60) }, async (req) => {
    const user = userOrThrow(req);
    const { c } = await given(req, user);
    notArchived(c);
    const input = parse(z.object({ fyEnd: yearEnd, account: z.object({ code: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(200) }).nullable().default(null), text: z.string().trim().min(1).max(4000) }), req.body);
    await yearOf(c, input.fyEnd);
    // Counted and added as one, the year's papers locked meanwhile: notes sent at once don't pass the caps.
    const note = await real.begin(async (tx) => {
      await lockYear(tx, c.id, input.fyEnd);
      const [{ n } = { n: 0 }] = await tx<{ n: number }[]>`select count(*)::int as n from practice_notes where client_id = ${c.id} and fy_end = ${input.fyEnd}`;
      if (n >= NOTES_PER_YEAR) throw badRequest(`A year takes ${NOTES_PER_YEAR} review notes at most (cleared ones count): add to one of those there.`);
      await roomFor(tx, c.id, input.fyEnd, input.text.length);
      const [made] = await tx<{ id: string }[]>`
        insert into practice_notes (client_id, fy_end, account_code, account_name, text, raised_by)
        values (${c.id}, ${input.fyEnd}, ${input.account?.code ?? null}, ${input.account?.name ?? null}, ${input.text}, ${user.id}) returning id`;
      return made;
    });
    await audit(real, { userId: user.id, action: 'file_note', entity: 'practice_client', entityId: c.id, ip: req.ip, details: { fyEnd: input.fyEnd, note: note!.id } });
    const removed = await takeBack(c.id, input.fyEnd, user.id, req.ip, note!.id);
    return { id: note!.id, removed };
  });

  /** A year's notes and replies, all together, run to YEAR_NOTES_MAX_CHARS at most: its file is a PDF made on the server. */
  const roomFor = async (tx: Db, clientId: string, fyEnd: string, adding: number) => {
    const [{ used } = { used: 0 }] = await tx<{ used: number }[]>`
      select (coalesce((select sum(length(text)) from practice_notes where client_id = ${clientId} and fy_end = ${fyEnd}), 0)
        + coalesce((select sum(length(r.text)) from practice_note_replies r join practice_notes n on n.id = r.note_id where n.client_id = ${clientId} and n.fy_end = ${fyEnd}), 0))::int as used`;
    if (used + adding > YEAR_NOTES_MAX_CHARS)
      throw badRequest(
        `A year’s review notes and replies run to ${YEAR_NOTES_MAX_CHARS.toLocaleString('en-ZA')} characters at most, all together: this year has ${used >= YEAR_NOTES_MAX_CHARS ? 'none' : (YEAR_NOTES_MAX_CHARS - used).toLocaleString('en-ZA')} left.`,
      );
  };
  /** One client's year's papers, locked until the transaction ends (its notes and replies counted and added as one). */
  const lockYear = (tx: Db, clientId: string, fyEnd: string) => tx`select pg_advisory_xact_lock(hashtext(${`practice-papers:${clientId}:${fyEnd}`}))`;

  const noteOr404 = async (clientId: string, nid: string) => {
    if (!uuid.safeParse(nid).success) throw notFound('Review note');
    const [n] = await real<NoteRow[]>`select ${noteCols(real)} from practice_notes where id = ${nid} and client_id = ${clientId}`;
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
    await real.begin(async (tx) => {
      await lockYear(tx, c.id, n.fyEnd);
      const [{ k } = { k: 0 }] = await tx<{ k: number }[]>`select count(*)::int as k from practice_note_replies where note_id = ${n.id}`;
      if (k >= REPLIES_PER_NOTE) throw badRequest(`A review note takes ${REPLIES_PER_NOTE} replies at most: clear it, and raise a new one if there’s more to say.`);
      await roomFor(tx, c.id, n.fyEnd, text.length);
      await tx`insert into practice_note_replies (note_id, text, by_user) values (${n.id}, ${text}, ${user.id})`;
    });
    await audit(real, { userId: user.id, action: 'file_note_reply', entity: 'practice_client', entityId: c.id, ip: req.ip, details: { note: n.id } });
    return { ok: true };
  });

  /** Cleared (or opened again) by whoever raised it, or an owner. Opened again, the year's review and partner sign-offs no longer stand over it. */
  app.post('/api/practice/clients/:id/file/notes/:nid/clear', { ...view, config: limit(60) }, async (req) => {
    const user = userOrThrow(req);
    const { c } = await given(req, user);
    notArchived(c);
    const n = await noteOr404(c.id, (req.params as { nid: string }).nid);
    const { cleared } = parse(z.object({ cleared: z.boolean() }), req.body);
    if (n.raisedBy !== user.id && user.role !== 'owner') throw forbidden('A review note is cleared by whoever raised it, or an owner.');
    await real`update practice_notes set cleared_by = ${cleared ? user.id : null}, cleared_at = ${cleared ? new Date() : null} where id = ${n.id}`;
    await audit(real, { userId: user.id, action: cleared ? 'file_note_cleared' : 'file_note_opened', entity: 'practice_client', entityId: c.id, ip: req.ip, details: { note: n.id } });
    const removed = cleared ? [] : await takeBack(c.id, n.fyEnd, user.id, req.ip, n.id);
    return { ok: true, removed };
  });

  /** The year signed off (or the sign-off taken back) as prepared, reviewed, or by the engagement partner. */
  app.put('/api/practice/clients/:id/file/signoffs', { ...view, config: limit(60) }, async (req) => {
    const user = userOrThrow(req);
    const { c, level } = await given(req, user);
    notArchived(c);
    const { fyEnd, role, on } = parse(z.object({ fyEnd: yearEnd, role: z.enum(SIGNOFFS), on: z.boolean() }), req.body);
    const file = await fileOf(c, level, user, fyEnd);
    if (file.empty) throw badRequest(NO_YEAR);
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
    // The trial balance it's given against, kept with it (and its fingerprint, to say when it has changed).
    const kept = file.tb ? file.tb.map((r) => ({ id: r.id, code: r.code, name: r.name, type: r.type, balanceCents: r.balanceCents })) : null;
    await real`insert into practice_signoffs (client_id, fy_end, role, user_id, tb_hash, tb) values (${c.id}, ${fyEnd}, ${role}, ${user.id}, ${file.hash}, ${kept ? real.json(kept as never) : null})
      on conflict (client_id, fy_end, role) do update set user_id = excluded.user_id, at = now(), tb_hash = excluded.tb_hash, tb = excluded.tb`;
    await audit(real, { userId: user.id, action: 'file_signoff', entity: 'practice_client', entityId: c.id, ip: req.ip, details: { fyEnd, role } });
    return { ok: true };
  });

  /** The year's file as a PDF: the practice's record of its work on the year, an aid towards ISRS 4410 (Revised) para 38. */
  app.get('/api/practice/clients/:id/file/pdf', { ...view, config: limit(20) }, async (req, reply) => {
    const user = userOrThrow(req);
    const { c, level } = await given(req, user);
    const { fy } = parse(z.object({ fy: yearEnd.optional() }), req.query);
    const file = await fileOf(c, level, user, fy);
    if (file.empty) throw badRequest(NO_YEAR);
    const p = await practiceParty();
    const pdf = await renderFilePdf({ practice: p.practiceTrading || p.practiceName, file });
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
    practice_name, practice_reg, practice_trading, practice_address, client_name,
    accepted_on::text as accepted_on, accepted_name, accepted_capacity, accepted_how, accepted_by, ended_at, ended_by, last_year_end::text as last_year_end, signed_name`;
const noteCols = (sql: Sql) => sql`id, client_id, fy_end::text as fy_end, account_code, account_name, text, raised_by, raised_at, cleared_by, cleared_at`;

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
  practiceName: string;
  practiceReg: string;
  practiceTrading: string;
  practiceAddress: string;
  clientName: string;
  acceptedOn: string | null;
  acceptedName: string | null;
  acceptedCapacity: string | null;
  acceptedHow: 'signed' | 'recorded' | null;
  acceptedBy: string | null;
  endedAt: Date | null;
  endedBy: string | null;
  lastYearEnd: string | null;
  signedName: string | null;
}
interface TickRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  preparedBy: string | null;
  preparedAt: Date | null;
  preparedCents: number | null;
  preparedType: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewedCents: number | null;
  reviewedType: string | null;
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
