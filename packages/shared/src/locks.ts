/**
 * Locked periods (docs/LOCKS.md): everything dated on or before the lock date is closed, for
 * everyone. Someone who may close and reopen periods (the "books.lock" task) reopens it with a
 * reason, puts it right, and locks it again. A business that sells closes each month (month end);
 * a VAT vendor that doesn't sell, each VAT period: by hand, or on a day of the month after by
 * itself. Any other business closes its years.
 */
import { addDays, addMonths, monthEnd } from './dates.js';
import { vatPeriod, type VatCategory } from './tax.js';
import { z } from 'zod';

/** What a business closes as it goes: each month (it sells), each VAT period (a VAT vendor), or each year. */
export type ClosesBy = 'month' | 'vat' | 'year';
export function closesBy(s: { sells: boolean; vatRegistered: boolean }): ClosesBy {
  return s.sells ? 'month' : s.vatRegistered ? 'vat' : 'year';
}

/** The period a date is in, for a business that closes by month or VAT period. */
export function lockPeriod(on: string, closes: Exclude<ClosesBy, 'year'>, vatCategory: VatCategory, fyEndMonth: number): { start: string; end: string } {
  return closes === 'month' ? { start: `${on.slice(0, 8)}01`, end: monthEnd(on) } : vatPeriod(on, vatCategory, fyEndMonth);
}

/**
 * The last period end that has locked itself by `today` (locking on `day` of the month after the
 * period ends): a month end, or a VAT period's.
 */
export function periodLockDue(today: string, day: number, closes: Exclude<ClosesBy, 'year'>, vatCategory: VatCategory, fyEndMonth: number): string {
  const m = monthLockDue(today, day);
  if (closes === 'month') return m;
  // The last VAT period ended on or before that month end.
  const p = vatPeriod(m, vatCategory, fyEndMonth);
  return p.end === m ? m : vatPeriod(addDays(p.start, -1), vatCategory, fyEndMonth).end;
}

/** When the next period locks itself, and which period end that is. */
export function nextPeriodLock(today: string, day: number, closes: Exclude<ClosesBy, 'year'>, vatCategory: VatCategory, fyEndMonth: number): { on: string; through: string } {
  if (closes === 'month') return nextMonthLock(today, day);
  const through = vatPeriod(addDays(periodLockDue(today, day, closes, vatCategory, fyEndMonth), 1), vatCategory, fyEndMonth).end;
  return { on: `${addMonths(`${through.slice(0, 8)}01`, 1).slice(0, 8)}${String(day).padStart(2, '0')}`, through };
}

export const MONTH_END_MODES = ['manual', 'auto'] as const;
export type MonthEndMode = (typeof MONTH_END_MODES)[number];

/** The last month end a month end set to lock itself has locked by `today`: the month before last until its day, then last month. */
export function monthLockDue(today: string, day: number): string {
  const lastMonthEnd = monthEnd(addMonths(today.slice(0, 8) + '01', -1));
  return Number(today.slice(8, 10)) >= day ? lastMonthEnd : monthEnd(addMonths(today.slice(0, 8) + '01', -2));
}

/** When the next month locks itself, and which month end that is. */
export function nextMonthLock(today: string, day: number): { on: string; through: string } {
  const thisMonth = `${today.slice(0, 8)}${String(day).padStart(2, '0')}`;
  const on = Number(today.slice(8, 10)) >= day ? addMonths(thisMonth, 1) : thisMonth;
  return { on, through: monthEnd(addMonths(on.slice(0, 8) + '01', -1)) };
}

const monthEndDate = z
  .string()
  .regex(/^(19|20)\d{2}-\d{2}-\d{2}$/, 'Use a date like 2026-03-31')
  .refine((v) => monthEnd(v) === v, 'Choose a month end (the last day of a month)');

export const lockInput = z.object({ through: monthEndDate });
export const reopenInput = z.object({
  /** The books stay closed up to this month end; null reopens everything. */
  to: monthEndDate.nullable(),
  reason: z.string().trim().min(3, 'Say why it’s reopened (it’s kept with the books)').max(300),
});
export const monthEndInput = z.object({ mode: z.enum(MONTH_END_MODES), day: z.number().int().min(1).max(28) });
