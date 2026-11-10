/**
 * Locked periods (docs/LOCKS.md): everything dated on or before the lock date is closed, for
 * everyone. Someone who may close and reopen periods (the "books.lock" task) reopens it with a
 * reason, puts it right, and locks it again. A business that sells closes each month (month end),
 * by hand or on a day of the next month by itself; one that doesn't closes its years.
 */
import { addMonths, monthEnd } from './dates.js';
import { z } from 'zod';

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
