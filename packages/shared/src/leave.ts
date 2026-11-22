/**
 * Leave for employees on payroll, under the Basic Conditions of Employment Act 75 of 1997 (BCEA),
 * Chapter Three: what each kind gives, the cycles it runs in, and what's owed on a day.
 *
 *   Annual leave (s20): 21 consecutive days in each 12-month cycle from the start date (three
 *     weeks: 15 working days on a five-day week), granted within six months of the cycle's end, paid
 *     out only when employment ends (s20(11), s40). Shap accrues it day by day through the cycle.
 *   Sick leave (s22): in each 36-month cycle from the start date, the days the employee would work
 *     in six weeks (30 on a five-day week); in the first six months, a day for every 26 worked.
 *     A medical certificate can be asked for after more than two days in a row, or more than two
 *     occasions in eight weeks (s23).
 *   Family responsibility leave (s27): three paid days in each annual leave cycle, after four
 *     months, for someone working at least four days a week: a child is sick, or a close family
 *     member dies.
 *   Maternity (s25), parental (s25A), adoption (s25B) and commissioning parental leave (s25C): since
 *     the Constitutional Court's order in Van Wyk v Minister of Employment and Labour [2025] ZACC 20
 *     (3 October 2025), until Parliament amends the Act, the parents share four months and ten days
 *     (one employed parent alone has all of it). The BCEA doesn't make the employer pay it: the UIF
 *     pays benefits, and a contract may add pay.
 *   Unpaid leave, and other leave the business gives (study, special): as agreed.
 *
 * A day's pay (s35): a month is four and one-third weeks, so a day is the monthly salary × 3 ÷ 13
 * ÷ the days worked in a week. Sources and the rest: docs/LEAVE.md. Shap keeps the records and
 * works out the balances from them; what the law asks of a particular business (a sectoral
 * determination, a bargaining council, the contract) is the owner's and their adviser's to check.
 */
import { addDays, addMonths, publicHolidays } from './dates.js';

export const LEAVE_KINDS = ['annual', 'sick', 'family', 'maternity', 'parental', 'adoption', 'commissioning', 'unpaid', 'other'] as const;
export type LeaveKind = (typeof LEAVE_KINDS)[number];

export const LEAVE_KIND_INFO: Record<LeaveKind, { label: string; law: string; paid: boolean; hint: string }> = {
  annual: { label: 'Annual leave', law: 'BCEA s20', paid: true, hint: 'Three weeks in each year from the start date, on full pay' },
  sick: { label: 'Sick leave', law: 'BCEA s22', paid: true, hint: 'Six weeks’ working days in each three years from the start date' },
  family: { label: 'Family responsibility leave', law: 'BCEA s27', paid: true, hint: 'Three paid days a year: a child is sick, or a close family member dies' },
  maternity: { label: 'Maternity leave', law: 'BCEA s25', paid: false, hint: 'Shared parental leave since October 2025; UIF benefits, not pay, unless the contract says' },
  parental: { label: 'Parental leave (a birth)', law: 'BCEA s25A', paid: false, hint: 'Shared parental leave since October 2025; UIF benefits, not pay, unless the contract says' },
  adoption: { label: 'Adoption leave', law: 'BCEA s25B', paid: false, hint: 'A child under two: shared parental leave since October 2025; UIF benefits, unless the contract says' },
  commissioning: { label: 'Commissioning parental leave (surrogacy)', law: 'BCEA s25C', paid: false, hint: 'Shared parental leave since October 2025; UIF benefits, unless the contract says' },
  unpaid: { label: 'Unpaid leave', law: 'by agreement', paid: false, hint: 'Comes off the month’s salary' },
  other: { label: 'Other leave', law: 'by agreement', paid: true, hint: 'Study, religious or special leave the business gives' },
};

/** The parents' kinds: since Van Wyk, one shared four months and ten days. */
export const PARENT_KINDS: readonly LeaveKind[] = ['maternity', 'parental', 'adoption', 'commissioning'];

/** Family responsibility leave's occasions since 2020 (a birth is parental leave now). */
export const FAMILY_REASONS = { child_sick: 'Their child is sick', death: 'A death in the family' } as const;
export type FamilyReason = keyof typeof FAMILY_REASONS;

/** What the shared parental leave note says, wherever a parent's leave is recorded. */
export const PARENT_NOTE =
  'Since the Constitutional Court’s order of 3 October 2025 (Van Wyk), until Parliament amends the BCEA, the parents of a child born, adopted (under two) or born to a surrogate share four months and ten days of leave between them, as they agree (one employed parent alone has all of it); a birth mother may start four weeks before the birth and doesn’t work for six weeks after it. The BCEA doesn’t make the employer pay it: the UIF pays benefits, claimed with the Department of Employment and Labour. Check the details with your accountant or a labour adviser.';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The BCEA's least annual leave in a cycle, in working days: three weeks of them. */
export function bceaAnnualDays(daysPerWeek: number): number {
  return round2(3 * daysPerWeek);
}

/** The BCEA's paid sick leave in a 36-month cycle, in working days: six weeks of them. */
export function bceaSickDays(daysPerWeek: number): number {
  return round2(6 * daysPerWeek);
}

/** A day's pay from a monthly salary (BCEA s35(3): a month is four and one-third weeks), in cents. */
export function dailyRateCents(monthlySalaryCents: number, daysPerWeek: number): number {
  if (daysPerWeek <= 0) return 0;
  return (monthlySalaryCents * 3) / (13 * daysPerWeek);
}

/** Days from one date to another, both counted. */
function calendarDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * The working days from one date to another, both counted, leaving out public holidays: Monday
 * to Friday for a five-day week (fewer days a week are a share of those), Monday to Saturday for
 * six, every day for seven. A suggestion for a leave entry: the owner can change it.
 */
export function workingDays(from: string, to: string, daysPerWeek = 5): number {
  if (to < from) return 0;
  let n = 0;
  const holidays = new Map<number, Set<string>>();
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const y = Number(d.slice(0, 4));
    if (!holidays.has(y)) holidays.set(y, publicHolidays(y));
    if (holidays.get(y)!.has(d)) continue;
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (daysPerWeek >= 7 || (daysPerWeek >= 6 ? wd !== 0 : wd !== 0 && wd !== 6)) n += 1;
  }
  return daysPerWeek < 5 ? Math.round(n * (daysPerWeek / 5) * 2) / 2 : n;
}

/** The cycle (start and end) a day falls in, cycles of `months` from the start date. */
export function cycleOn(startDate: string, on: string, months: number): { start: string; end: string } {
  // Each cycle starts a whole number of cycles after the start date (counted from it, so a cycle
  // from 31 January or 29 February doesn't drift). Jump close, then step.
  let k = Math.max(0, Math.floor(((Number(on.slice(0, 4)) - Number(startDate.slice(0, 4))) * 12) / months) - 1);
  while (addMonths(startDate, (k + 1) * months) <= on) k += 1;
  return { start: addMonths(startDate, k * months), end: addDays(addMonths(startDate, (k + 1) * months), -1) };
}
export const annualCycle = (startDate: string, on: string) => cycleOn(startDate, on, 12);
export const sickCycle = (startDate: string, on: string) => cycleOn(startDate, on, 36);

export interface LeaveEmployee {
  startDate: string;
  endDate: string | null;
  /** Days worked in a usual week (BCEA s35): 5 if not said. */
  daysPerWeek: number;
  /** Annual leave in a cycle, in working days: at least the BCEA's three weeks (more by contract). */
  annualDays: number;
  /** Family responsibility leave in an annual leave cycle (three in the BCEA; a sectoral determination may give more). */
  familyDays: number;
  /** When Shap's leave records start, if after the start date (the balances below are on that day). */
  openingDate: string | null;
  /** Annual leave owed on the opening date. */
  openingAnnualDays: number;
  /** Paid sick days already taken in the sick leave cycle running on the opening date. */
  openingSickDays: number;
  /** Family responsibility days already taken in the annual leave cycle running on the opening date. */
  openingFamilyDays: number;
}

export interface LeaveRecord {
  kind: LeaveKind;
  fromDate: string;
  toDate: string;
  days: number;
  paid: boolean;
  /** Annual leave added (more) or taken off (fewer) without leave being taken: a correction, days forfeited by agreement, leave paid outside Shap. */
  adjustment?: boolean;
}

/** The share of an entry's days that fall from one date to another (by working days, else calendar days). */
export function daysWithin(r: Pick<LeaveRecord, 'fromDate' | 'toDate' | 'days'>, from: string, to: string, daysPerWeek = 5): number {
  const a = r.fromDate > from ? r.fromDate : from;
  const b = r.toDate < to ? r.toDate : to;
  if (b < a) return 0;
  if (a === r.fromDate && b === r.toDate) return r.days;
  const all = workingDays(r.fromDate, r.toDate, daysPerWeek);
  const part = workingDays(a, b, daysPerWeek);
  const share = all > 0 ? part / all : calendarDays(a, b) / calendarDays(r.fromDate, r.toDate);
  return round2(r.days * share);
}

/** Annual leave earned from one day to another (both counted), a cycle's days spread evenly over its days. */
export function annualAccrued(e: Pick<LeaveEmployee, 'startDate' | 'annualDays'>, from: string, to: string): number {
  if (to < from) return 0;
  let total = 0;
  let c = annualCycle(e.startDate, from);
  for (;;) {
    const a = from > c.start ? from : c.start;
    const b = to < c.end ? to : c.end;
    if (b >= a) total += (e.annualDays * calendarDays(a, b)) / calendarDays(c.start, c.end);
    if (c.end >= to) break;
    c = annualCycle(e.startDate, addDays(c.end, 1));
  }
  return total;
}

export interface LeaveBalances {
  on: string;
  /** Employed on the day (started, not yet left). */
  employed: boolean;
  annual: {
    cycle: { start: string; end: string };
    earnedDays: number;
    takenDays: number;
    adjustedDays: number;
    paidOutDays: number;
    owedDays: number;
    /** Of what's owed, days from a cycle that ended more than six months ago (s20(4): to be granted by then). */
    overdueDays: number;
  };
  sick: { cycle: { start: string; end: string }; firstSixMonths: boolean; allowedDays: number; takenDays: number; leftDays: number };
  family: { cycle: { start: string; end: string }; eligible: boolean; allowedDays: number; takenDays: number; leftDays: number };
  /** Days taken this annual leave cycle of every kind. */
  thisCycle: Record<LeaveKind, number>;
}

/**
 * Each balance on a day, from the employee's terms, their leave records and the days paid out
 * when they left (final pay runs). Leave entries are counted for the part up to the day.
 */
export function leaveBalances(e: LeaveEmployee, records: readonly LeaveRecord[], paidOut: readonly { date: string; days: number }[], on: string): LeaveBalances {
  const dpw = e.daysPerWeek > 0 ? e.daysPerWeek : 5;
  const last = e.endDate && e.endDate < on ? e.endDate : on;
  const base = e.openingDate && e.openingDate > e.startDate ? e.openingDate : e.startDate;
  const upTo = (r: LeaveRecord, from: string) => daysWithin(r, from, last, dpw);
  const sum = (xs: number[]) => round2(xs.reduce((t, x) => t + x, 0));

  // Annual: what was owed on the opening day, what's been earned since, less what's been taken.
  const fromOpening = base !== e.startDate ? e.openingAnnualDays : 0;
  const earned = round2(fromOpening + (last >= base ? annualAccrued({ startDate: e.startDate, annualDays: e.annualDays }, base, last) : 0));
  const annualTaken = sum(records.filter((r) => r.kind === 'annual' && !r.adjustment && r.fromDate >= base).map((r) => upTo(r, base)));
  const adjusted = sum(records.filter((r) => r.kind === 'annual' && r.adjustment && r.fromDate >= base && r.fromDate <= last).map((r) => r.days));
  const out = sum(paidOut.filter((p) => p.date <= on).map((p) => p.days));
  const owed = round2(earned - annualTaken + adjusted - out);
  // Leave is used up oldest first: what's owed beyond the current cycle and any cycle that ended in
  // the last six months is from an older one.
  const cycle = annualCycle(e.startDate, last);
  let recentFrom = cycle.start;
  const prior = addDays(cycle.start, -1);
  if (prior >= e.startDate && addMonths(prior, 6) >= last) recentFrom = annualCycle(e.startDate, prior).start;
  const recent = annualAccrued({ startDate: e.startDate, annualDays: e.annualDays }, recentFrom > base ? recentFrom : base, last);
  const overdue = Math.max(0, round2(owed - recent));

  // Sick: the 36-month cycle; in the first six months a day for every 26 worked.
  const sc = sickCycle(e.startDate, last);
  const firstSix = last < addMonths(e.startDate, 6);
  const worked = workingDays(e.startDate, last, dpw);
  const allowedSick = firstSix ? Math.floor(worked / 26) : bceaSickDays(dpw);
  const openingSick = base !== e.startDate && base >= sc.start && base <= sc.end ? e.openingSickDays : 0;
  const sickFrom = sc.start > base ? sc.start : base;
  const sickTaken = round2(openingSick + sum(records.filter((r) => r.kind === 'sick' && r.paid && r.toDate >= sickFrom).map((r) => upTo(r, sickFrom))));

  // Family responsibility: the annual leave cycle; after four months, at least four days a week.
  const fc = annualCycle(e.startDate, last);
  const eligible = last > addMonths(e.startDate, 4) && dpw >= 4;
  const openingFamily = base !== e.startDate && base >= fc.start && base <= fc.end ? e.openingFamilyDays : 0;
  const famFrom = fc.start > base ? fc.start : base;
  const famTaken = round2(openingFamily + sum(records.filter((r) => r.kind === 'family' && r.toDate >= famFrom).map((r) => upTo(r, famFrom))));

  const thisCycle = Object.fromEntries(LEAVE_KINDS.map((k) => [k, sum(records.filter((r) => r.kind === k && !r.adjustment && r.toDate >= fc.start).map((r) => upTo(r, fc.start > base ? fc.start : base)))])) as Record<LeaveKind, number>;

  return {
    on,
    employed: e.startDate <= on && (!e.endDate || e.endDate >= on),
    annual: { cycle, earnedDays: earned, takenDays: annualTaken, adjustedDays: adjusted, paidOutDays: out, owedDays: owed, overdueDays: overdue },
    sick: { cycle: sc, firstSixMonths: firstSix, allowedDays: allowedSick, takenDays: sickTaken, leftDays: round2(allowedSick - sickTaken) },
    family: { cycle: fc, eligible, allowedDays: eligible ? e.familyDays : 0, takenDays: famTaken, leftDays: round2((eligible ? e.familyDays : 0) - famTaken) },
    thisCycle,
  };
}

/** Days rounded to the half day for showing (leave is taken in whole or half days). */
export function formatDays(days: number): string {
  const d = Math.round(days * 2) / 2;
  const s = Number.isInteger(d) ? String(d) : d.toFixed(1);
  return `${s} day${Math.abs(d) === 1 ? '' : 's'}`;
}
