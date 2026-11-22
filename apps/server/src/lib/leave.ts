/**
 * Leave records read for the payroll and the books: each employee's leave terms, their leave and
 * what was paid out when they left, the balances on a day (packages/shared leave.ts), and the
 * annual leave pay owed on a day (IFRS for SMEs 28.6). docs/LEAVE.md.
 */
import { bceaAnnualDays, dailyRateCents, leaveBalances, type LeaveBalances, type LeaveEmployee, type LeaveKind, type LeaveRecord } from '@shap/shared';
import type { Db } from '../db/index.js';

interface EmployeeLeaveRow {
  id: string;
  name: string;
  isDirector: boolean;
  salaryCents: number;
  startDate: string;
  endDate: string | null;
  leaveDaysPerWeek: string | number;
  annualLeaveDays: string | number | null;
  familyLeaveDays: string | number;
  leaveFrom: string | null;
  leaveOpeningAnnual: string | number;
  leaveOpeningSick: string | number;
  leaveOpeningFamily: string | number;
}

export interface LeaveEntryRow {
  id: string;
  employeeId: string;
  kind: LeaveKind;
  adjustment: boolean;
  fromDate: string;
  toDate: string;
  days: number;
  paid: boolean;
  certificate: boolean;
  reason: '' | 'child_sick' | 'death';
  note: string;
}

/** An employee's leave terms, as the shared rules take them. */
export function leaveTerms(e: EmployeeLeaveRow): LeaveEmployee {
  const dpw = Number(e.leaveDaysPerWeek) || 5;
  return {
    startDate: e.startDate,
    endDate: e.endDate,
    daysPerWeek: dpw,
    annualDays: e.annualLeaveDays == null ? bceaAnnualDays(dpw) : Number(e.annualLeaveDays),
    familyDays: Number(e.familyLeaveDays),
    openingDate: e.leaveFrom,
    openingAnnualDays: Number(e.leaveOpeningAnnual),
    openingSickDays: Number(e.leaveOpeningSick),
    openingFamilyDays: Number(e.leaveOpeningFamily),
  };
}

const EMPLOYEE_COLUMNS = `id, name, is_director, salary_cents, start_date::text, end_date::text, leave_days_per_week, annual_leave_days, family_leave_days, leave_from::text,
  leave_opening_annual, leave_opening_sick, leave_opening_family`;

export interface EmployeeLeave {
  employee: EmployeeLeaveRow;
  terms: LeaveEmployee;
  entries: LeaveEntryRow[];
  /** Annual leave paid out in final pay runs, by pay date (a run left out: the one being worked out). */
  paidOut: { date: string; days: number; runId: string }[];
}

/** Everyone's leave (or one person's): terms, entries and what final pay runs paid out. */
export async function loadLeave(db: Db, employeeId?: string): Promise<EmployeeLeave[]> {
  const people = await db.unsafe<EmployeeLeaveRow[]>(`select ${EMPLOYEE_COLUMNS} from employees ${employeeId ? 'where id = $1' : ''} order by active desc, name`, employeeId ? [employeeId] : []);
  if (!people.length) return [];
  const ids = people.map((p) => p.id);
  const entries = await db<LeaveEntryRow[]>`
    select id, employee_id, kind, adjustment, from_date::text, to_date::text, days::float8 as days, paid, certificate, reason, note
    from leave_entries where employee_id = any(${ids}) order by from_date, created_at`;
  const out = await db<{ employeeId: string; date: string; days: number; runId: string }[]>`
    select l.employee_id, r.pay_date::text as date, l.leave_paid_out_days::float8 as days, r.id as run_id
    from pay_lines l join pay_runs r on r.id = l.run_id
    where r.status = 'final' and l.employee_id = any(${ids}) and l.leave_paid_out_days > 0`;
  return people.map((p) => ({
    employee: p,
    terms: leaveTerms(p),
    entries: entries.filter((x) => x.employeeId === p.id).map((x) => ({ ...x, days: Number(x.days) })),
    paidOut: out.filter((x) => x.employeeId === p.id).map((x) => ({ date: x.date, days: Number(x.days), runId: x.runId })),
  }));
}

export const records = (l: EmployeeLeave): LeaveRecord[] => l.entries.map((x) => ({ kind: x.kind, fromDate: x.fromDate, toDate: x.toDate, days: x.days, paid: x.paid, adjustment: x.adjustment }));

/** Balances on a day, leaving out what one pay run paid out (the one being worked out). */
export function balancesOn(l: EmployeeLeave, on: string, exceptRun?: string): LeaveBalances {
  return leaveBalances(l.terms, records(l), l.paidOut.filter((p) => p.runId !== exceptRun), on);
}

/** The month's salary a day's pay is worked out from on a day: the last final pay run's up to then, else what's on file. */
export async function salaryOn(db: Db, employeeId: string, on: string, fallback: number): Promise<number> {
  const [r] = await db<{ s: string }[]>`
    select l.salary_cents::text as s from pay_lines l join pay_runs r on r.id = l.run_id
    where l.employee_id = ${employeeId} and r.status = 'final' and r.pay_date <= ${on}::date order by r.pay_date desc limit 1`;
  return r ? Number(r.s) : Number(fallback);
}

export interface LeaveOwed {
  on: string;
  people: { employeeId: string; name: string; isDirector: boolean; days: number; dayCents: number; cents: number; left: boolean }[];
  cents: number;
  directorsCents: number;
}

/**
 * The annual leave pay owed on a day (IFRS for SMEs 28.6): each employee's annual leave owed, at a
 * day's pay from their salary then (BCEA s35), undiscounted. Someone who left and wasn't paid out
 * is still owed theirs (s40). Sick, family and parents' leave don't carry over to be paid: none.
 */
export async function leaveOwedAt(db: Db, on: string): Promise<LeaveOwed> {
  const people: LeaveOwed['people'] = [];
  for (const l of await loadLeave(db)) {
    // Not started yet, or before Shap's leave records for them start (nothing to go on).
    if (l.employee.startDate > on || (l.terms.openingDate && l.terms.openingDate > on)) continue;
    const b = balancesOn(l, on);
    const days = Math.max(0, b.annual.owedDays);
    if (days <= 0) continue;
    const salary = await salaryOn(db, l.employee.id, on, l.employee.salaryCents);
    const dayCents = Math.round(dailyRateCents(salary, l.terms.daysPerWeek));
    people.push({ employeeId: l.employee.id, name: l.employee.name, isDirector: l.employee.isDirector, days, dayCents, cents: Math.round(days * dailyRateCents(salary, l.terms.daysPerWeek)), left: Boolean(l.employee.endDate && l.employee.endDate < on) });
  }
  return { on, people, cents: people.reduce((t, p) => t + p.cents, 0), directorsCents: people.filter((p) => p.isDirector).reduce((t, p) => t + p.cents, 0) };
}

/**
 * The year's change in leave pay owed, booked by Shap's year-end journals (kind leave_pay): an
 * increase isn't deductible until the leave pay is paid (Income Tax Act s7B: variable remuneration,
 * leave pay included, is incurred when paid), so the tax estimates add it back (a decrease comes off).
 */
export async function leavePayAddBack(db: Db, from: string, to: string): Promise<number> {
  const [r] = await db<{ t: string }[]>`
    select coalesce(sum(jl.credit_cents - jl.debit_cents), 0)::bigint as t from journal_lines jl join journals j on j.id = jl.journal_id join accounts a on a.id = jl.account_id
    where j.kind = 'leave_pay' and a.system_key = 'leave_payable' and j.date between ${from}::date and ${to}::date`;
  return Number(r!.t);
}

/** Each year end's change in leave pay owed before a day (for walking earlier years' tax). */
export async function leavePayAddBacks(db: Db, before: string): Promise<{ date: string; cents: number }[]> {
  const rows = await db<{ date: string; t: string }[]>`
    select j.date::text as date, sum(jl.credit_cents - jl.debit_cents)::bigint as t from journal_lines jl join journals j on j.id = jl.journal_id join accounts a on a.id = jl.account_id
    where j.kind = 'leave_pay' and a.system_key = 'leave_payable' and j.date < ${before}::date group by j.date`;
  return rows.map((r) => ({ date: r.date, cents: Number(r.t) }));
}
