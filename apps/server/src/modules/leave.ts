/**
 * Leave: each employee's leave taken and owed (packages/shared leave.ts), and the annual leave pay
 * owed at a year end in the books (IFRS for SMEs 28.6). docs/LEAVE.md.
 *
 *   GET  /api/leave                 everyone's balances on a day, with what to look at
 *   GET  /api/leave/employee/:id    one person's leave records and balances
 *   POST /api/leave                 leave taken (or an annual leave adjustment, with its reason)
 *   PUT, DELETE /api/leave/:id
 *   GET  /api/leave/pay-owed        the leave pay owed at a year end, worked out and as booked
 *   POST /api/leave/pay-owed        book it (the owner, once the year has ended)
 *   DELETE /api/leave/pay-owed/:fyEnd
 *
 * The year end's journal (kind leave_pay) moves Leave pay owed to what's owed then, against
 * salaries (and a director's remuneration for a director's): the change in the year, so a year's
 * employee costs carry the leave earned in it. Shap keeps the records and works the figures out
 * from them: what a business owes its people is the owner's and their adviser's to check.
 */
import { addDays, addMonths, financialYear, formatDate, formatDays, LEAVE_KIND_INFO, leaveInput, workingDays } from '@shap/shared';
import { z } from 'zod';
import { requireAccess, requireRole, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Db, Tx } from '../db/index.js';
import type { FastifyInstance } from 'fastify';
import { audit } from '../lib/audit.js';
import { assertOpen, effectiveLock, getSettings, isIsoDate, q, today } from '../lib/books.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { balancesOn, leaveOwedAt, loadLeave, type EmployeeLeave } from '../lib/leave.js';
import { parse } from '../lib/validate.js';
import { recomputeDrafts } from './payroll.js';

const idParam = z.object({ id: z.string().uuid() });

/** What to look at in someone's leave, in words (none when all's well). */
export function leaveWarnings(l: EmployeeLeave, on: string): string[] {
  const b = balancesOn(l, on);
  const out: string[] = [];
  const left = l.terms.endDate && l.terms.endDate < on;
  if (left && b.annual.owedDays > 0)
    out.push(`Left on ${formatDate(l.terms.endDate, 'long')} with ${formatDays(b.annual.owedDays)} of annual leave owed: it’s paid out on leaving (BCEA s40), in their last pay run. If it was paid some other way, record an adjustment saying so.`);
  if (!left && b.annual.overdueDays > 0)
    out.push(`${formatDays(b.annual.overdueDays)} of annual leave owed is from a cycle that ended more than six months ago: the BCEA says annual leave is granted within six months of its cycle’s end (s20(4)). Agree when it’s taken; whether any can lapse is for the contract and a labour adviser.`);
  if (b.annual.owedDays < 0) out.push(`${formatDays(-b.annual.owedDays)} more annual leave taken than earned so far: leave in advance, by agreement.`);
  if (b.sick.leftDays < 0)
    out.push(`${formatDays(-b.sick.leftDays)} more paid sick leave than the BCEA gives ${b.sick.firstSixMonths ? 'in the first six months (a day for every 26 worked)' : `in the cycle to ${formatDate(b.sick.cycle.end, 'long')}`}: the rest can be unpaid (mark it unpaid), or taken as annual leave if you both agree.`);
  if (b.family.takenDays > 0 && !b.family.eligible)
    out.push(`Family responsibility leave in the BCEA is for someone employed over four months who works at least four days a week (s27(1)): this was by agreement.`);
  else if (b.family.leftDays < 0) out.push(`${formatDays(-b.family.leftDays)} more family responsibility leave than the ${formatDays(b.family.allowedDays)} this cycle gives (to ${formatDate(b.family.cycle.end, 'long')}).`);
  const since = addMonths(on, -12);
  const long = l.entries.filter((x) => x.kind === 'sick' && x.paid && !x.certificate && x.toDate >= since && x.days > 2);
  if (long.length)
    out.push(`Sick leave of more than two days in a row without a medical certificate (${long.map((x) => formatDate(x.fromDate)).join(', ')}): the BCEA lets you ask for one before paying it (s23). Don’t write down what the illness is: that’s their health information.`);
  return out;
}

/** The leave pay owed at a year end, worked out now and as booked. */
async function payOwed(db: Db, fy: { start: string; end: string; label: string }) {
  const owed = await leaveOwedAt(db, fy.end);
  const [booked] = await db<{ owedCents: string; journalId: string | null; createdAt: string; people: unknown }[]>`
    select owed_cents, journal_id, created_at, people from leave_pay_years where fy_end = ${fy.end}`;
  const [books] = await db<{ t: string }[]>`
    select coalesce(-sum(l.amount_cents), 0)::bigint as t from ledger l join accounts a on a.id = l.account_id
    where a.system_key = 'leave_payable' and l.date <= ${fy.end}::date`;
  const lock = await effectiveLock(db);
  return {
    fy,
    ended: fy.end < today(),
    locked: Boolean(lock && lock >= fy.end),
    owed,
    booked: booked ? { owedCents: Number(booked.owedCents), journalId: booked.journalId, createdAt: booked.createdAt } : null,
    booksCents: Number(books!.t),
  };
}

/**
 * Books the leave pay owed at a year end: the change in Leave pay owed from what the books say
 * the day before, against salaries (a director's part against their remuneration). Replaces what
 * was booked for the year.
 */
async function bookYear(tx: Tx, fy: { end: string; label: string }, userId: string): Promise<{ owedCents: number; movedCents: number }> {
  const [old] = await tx<{ journalId: string | null }[]>`select journal_id from leave_pay_years where fy_end = ${fy.end}`;
  if (old?.journalId) await tx`delete from journals where id = ${old.journalId}`;
  await tx`delete from leave_pay_years where fy_end = ${fy.end}`;
  const owed = await leaveOwedAt(tx, fy.end);
  const [bal] = await tx<{ t: string }[]>`
    select coalesce(-sum(l.amount_cents), 0)::bigint as t from ledger l join accounts a on a.id = l.account_id
    where a.system_key = 'leave_payable' and l.date <= ${fy.end}::date`;
  const moved = owed.cents - Number(bal!.t);
  // The directors' part of the change: theirs now, less theirs at the year booked before.
  const [prev] = await tx<{ people: { isDirector: boolean; cents: number }[] }[]>`select people from leave_pay_years where fy_end < ${fy.end}::date order by fy_end desc limit 1`;
  const directorsBefore = (prev?.people ?? []).filter((p) => p.isDirector).reduce((t, p) => t + Number(p.cents), 0);
  const directorsMoved = owed.directorsCents - directorsBefore;
  const employeesMoved = moved - directorsMoved;
  let journalId: string | null = null;
  if (moved !== 0 || directorsMoved !== 0) {
    const [j] = await tx<{ id: string }[]>`
      insert into journals (date, description, kind, created_by) values (${fy.end}, ${`Annual leave pay owed at ${formatDate(fy.end, 'long')} (${fy.label})`}, 'leave_pay', ${userId}) returning id`;
    journalId = j!.id;
    const line = async (key: string, cents: number, memo: string) => {
      if (!cents) return;
      const [acc] = await tx<{ id: string }[]>`select id from accounts where system_key = ${key}`;
      await tx`insert into journal_lines (journal_id, account_id, debit_cents, credit_cents, memo) values (${journalId}, ${acc!.id}, ${cents > 0 ? cents : 0}, ${cents < 0 ? -cents : 0}, ${memo})`;
    };
    await line('salaries', employeesMoved, 'Annual leave earned less taken (employees)');
    await line('director_salary', directorsMoved, 'Annual leave earned less taken (directors)');
    await line('leave_payable', -moved, 'Leave pay owed');
  }
  await tx`insert into leave_pay_years (fy_end, journal_id, owed_cents, people, created_by) values (${fy.end}, ${journalId}, ${owed.cents}, ${tx.json(owed.people as never)}, ${userId})`;
  return { owedCents: owed.cents, movedCents: moved };
}

/** The checks a leave entry goes through before it's saved (the rest are the schema's). */
async function checkEntry(db: Db, input: z.infer<typeof leaveInput>, self?: string) {
  const [e] = await db<{ startDate: string; endDate: string | null; leaveFrom: string | null; leaveDaysPerWeek: string }[]>`
    select start_date::text, end_date::text, leave_from::text, leave_days_per_week from employees where id = ${input.employeeId}`;
  if (!e) throw notFound('Employee');
  if (input.fromDate < e.startDate) throw badRequest(`They started on ${formatDate(e.startDate, 'long')}: leave starts on or after that`);
  if (e.leaveFrom && input.fromDate < e.leaveFrom && !input.adjustment) throw badRequest(`Shap’s leave records for them start on ${formatDate(e.leaveFrom, 'long')}: leave before then is in the opening balances (Employees)`);
  if (e.endDate && input.toDate > e.endDate) throw badRequest(`They left on ${formatDate(e.endDate, 'long')}: leave ends by then`);
  const span = Math.round((Date.parse(`${input.toDate}T00:00:00Z`) - Date.parse(`${input.fromDate}T00:00:00Z`)) / 86_400_000) + 1;
  if (!input.adjustment && input.days > span) throw badRequest(`${formatDays(input.days)} won’t fit in ${span} day${span === 1 ? '' : 's'} from ${formatDate(input.fromDate)} to ${formatDate(input.toDate)}`);
  if (!input.adjustment) {
    const [clash] = await db<{ fromDate: string; kind: string }[]>`
      select from_date::text, kind from leave_entries where employee_id = ${input.employeeId} and not adjustment and id <> ${self ?? '00000000-0000-0000-0000-000000000000'}
        and from_date <= ${input.toDate}::date and to_date >= ${input.fromDate}::date limit 1`;
    if (clash) throw conflict(`They’re already on ${LEAVE_KIND_INFO[clash.kind as keyof typeof LEAVE_KIND_INFO].label.toLowerCase()} from ${formatDate(clash.fromDate, 'long')}: change that entry, or pick other days`);
  }
  await assertOpen(db, input.fromDate);
  return { daysPerWeek: Number(e.leaveDaysPerWeek) || 5 };
}

/** Final pay runs in the months an unpaid entry touches: it isn't taken off them until they're reopened. */
async function finalMonths(db: Db, employeeId: string, from: string, to: string): Promise<string[]> {
  const rows = await db<{ period: string }[]>`
    select r.period from pay_runs r join pay_lines l on l.run_id = r.id
    where r.status = 'final' and l.employee_id = ${employeeId} and (r.period || '-01')::date <= ${to}::date
      and ((r.period || '-01')::date + interval '1 month' - interval '1 day')::date >= ${from}::date order by r.period`;
  return rows.map((r) => r.period);
}

const columns = (input: z.infer<typeof leaveInput>) => ({
  employeeId: input.employeeId,
  kind: input.kind,
  adjustment: input.adjustment,
  fromDate: input.fromDate,
  toDate: input.adjustment ? input.fromDate : input.toDate,
  days: input.days,
  paid: input.adjustment ? true : (input.paid ?? LEAVE_KIND_INFO[input.kind].paid),
  certificate: input.kind === 'sick' && input.certificate,
  reason: input.kind === 'family' ? input.reason : '',
  note: input.note,
});

export function registerLeaveRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;
  const view = { preHandler: requireAccess('payroll.view') };
  const run = { preHandler: requireAccess('payroll.run') };
  const owner = { preHandler: requireRole('owner') };

  app.get('/api/leave', view, async (req) => {
    const on = isIsoDate(q(req).on) ? q(req).on! : today();
    const people = (await loadLeave(sql)).map((l) => ({
      id: l.employee.id,
      name: l.employee.name,
      isDirector: l.employee.isDirector,
      startDate: l.employee.startDate,
      endDate: l.employee.endDate,
      terms: l.terms,
      balances: balancesOn(l, on),
      warnings: leaveWarnings(l, on),
    }));
    return { on, people };
  });

  app.get('/api/leave/employee/:id', view, async (req) => {
    const { id } = parse(idParam, req.params);
    const [l] = await loadLeave(sql, id);
    if (!l) throw notFound('Employee');
    const on = today();
    return { id, name: l.employee.name, terms: l.terms, balances: balancesOn(l, on), warnings: leaveWarnings(l, on), entries: [...l.entries].reverse(), paidOut: l.paidOut };
  });

  /** The working days between two dates for someone, public holidays left out: what a leave entry suggests. */
  app.get('/api/leave/days', view, async (req) => {
    const r = parse(z.object({ employeeId: z.string().uuid(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), req.query);
    const [e] = await sql<{ d: string }[]>`select leave_days_per_week as d from employees where id = ${r.employeeId}`;
    if (!e) throw notFound('Employee');
    return { days: workingDays(r.from, r.to, Number(e.d) || 5) };
  });

  app.post('/api/leave', run, async (req) => {
    const user = userOrThrow(req);
    const input = parse(leaveInput, req.body);
    await checkEntry(sql, input);
    const row = columns(input);
    const id = await sql.begin(async (tx) => {
      const [x] = await tx<{ id: string }[]>`insert into leave_entries ${tx({ ...row, createdBy: user.id } as never)} returning id`;
      await recomputeDrafts(tx, input.employeeId, row.fromDate, row.toDate);
      return x!.id;
    });
    await audit(sql, { userId: user.id, action: 'create', entity: 'leave', entityId: id, ip: req.ip, details: { employeeId: input.employeeId, kind: input.kind, fromDate: row.fromDate, days: input.days } });
    return { id, finalRuns: row.paid ? [] : await finalMonths(sql, input.employeeId, row.fromDate, row.toDate) };
  });

  app.put('/api/leave/:id', run, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const input = parse(leaveInput, req.body);
    const [was] = await sql<{ employeeId: string; fromDate: string; toDate: string }[]>`select employee_id, from_date::text, to_date::text from leave_entries where id = ${id}`;
    if (!was) throw notFound('Leave');
    if (was.employeeId !== input.employeeId) throw badRequest('Leave stays with the person it’s for: delete it and record it for the other person');
    await assertOpen(sql, was.fromDate);
    await checkEntry(sql, input, id);
    const row = columns(input);
    await sql.begin(async (tx) => {
      await tx`update leave_entries set ${tx(row as never)} where id = ${id}`;
      await recomputeDrafts(tx, input.employeeId, was.fromDate < row.fromDate ? was.fromDate : row.fromDate, was.toDate > row.toDate ? was.toDate : row.toDate);
    });
    await audit(sql, { userId: user.id, action: 'update', entity: 'leave', entityId: id, ip: req.ip, details: { kind: input.kind, fromDate: row.fromDate, days: input.days } });
    return { ok: true, finalRuns: row.paid ? [] : await finalMonths(sql, input.employeeId, row.fromDate, row.toDate) };
  });

  app.delete('/api/leave/:id', run, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const [was] = await sql<{ employeeId: string; fromDate: string; toDate: string; kind: string; days: string }[]>`select employee_id, from_date::text, to_date::text, kind, days from leave_entries where id = ${id}`;
    if (!was) throw notFound('Leave');
    await assertOpen(sql, was.fromDate);
    await sql.begin(async (tx) => {
      await tx`delete from leave_entries where id = ${id}`;
      await recomputeDrafts(tx, was.employeeId, was.fromDate, was.toDate);
    });
    await audit(sql, { userId: user.id, action: 'delete', entity: 'leave', entityId: id, ip: req.ip, details: { employeeId: was.employeeId, kind: was.kind, fromDate: was.fromDate, days: Number(was.days) } });
    return { ok: true };
  });

  // ---------------------------------------------------------------- leave pay owed, in the books
  const yearFor = async (fyEnd?: string) => {
    const s = await getSettings(sql);
    if (fyEnd && isIsoDate(fyEnd)) return financialYear(fyEnd, s.fyEndMonth);
    // The last year that has ended.
    return financialYear(addDays(financialYear(today(), s.fyEndMonth).start, -1), s.fyEndMonth);
  };

  app.get('/api/leave/pay-owed', view, async (req) => payOwed(sql, await yearFor(q(req).fyEnd)));

  app.post('/api/leave/pay-owed', owner, async (req) => {
    const user = userOrThrow(req);
    const { fyEnd } = parse(z.object({ fyEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), req.body);
    const fy = await yearFor(fyEnd);
    if (fy.end >= today()) throw badRequest('That year hasn’t ended yet: book its leave pay once it has.');
    // Later years booked already were worked out from this one's figure: they're booked again too.
    const later = (await sql<{ fyEnd: string }[]>`select fy_end::text from leave_pay_years where fy_end > ${fy.end}::date order by fy_end`).map((r) => r.fyEnd);
    await assertOpen(sql, fy.end, ...later);
    const s = await getSettings(sql);
    const done = await sql.begin(async (tx) => {
      const first = await bookYear(tx, fy, user.id);
      for (const end of later) await bookYear(tx, financialYear(end, s.fyEndMonth), user.id);
      return first;
    });
    await audit(sql, { userId: user.id, action: 'create', entity: 'leave_pay', entityId: null, ip: req.ip, details: { fyEnd: fy.end, owedCents: done.owedCents, movedCents: done.movedCents, alsoBooked: later } });
    return { ...done, alsoBooked: later };
  });

  app.delete('/api/leave/pay-owed/:fyEnd', owner, async (req) => {
    const user = userOrThrow(req);
    const { fyEnd } = parse(z.object({ fyEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), req.params);
    const [old] = await sql<{ journalId: string | null }[]>`select journal_id from leave_pay_years where fy_end = ${fyEnd}`;
    if (!old) throw notFound('Leave pay booked for that year');
    const [later] = await sql`select 1 from leave_pay_years where fy_end > ${fyEnd}::date`;
    if (later) throw badRequest('A later year’s leave pay was worked out from this one: take that one out first');
    await assertOpen(sql, fyEnd);
    await sql.begin(async (tx) => {
      if (old.journalId) await tx`delete from journals where id = ${old.journalId}`;
      await tx`delete from leave_pay_years where fy_end = ${fyEnd}`;
    });
    await audit(sql, { userId: user.id, action: 'delete', entity: 'leave_pay', entityId: null, ip: req.ip, details: { fyEnd } });
    return { ok: true };
  });
}

export { payOwed };
