/**
 * Day labour and the law (docs/CASUAL_LABOUR.md). Shap records a worker's days and pay; it doesn't
 * work out, deduct or pay UIF, employees' tax or the Compensation Fund's assessment for them (that's
 * Payroll's, for employees on it). What's here are reminders of where the law starts to apply,
 * worked out from the days logged: not advice, and the business's own to check.
 */
import type { WorkerKind } from './enums.js';

/**
 * The national minimum wage for an ordinary hour (National Minimum Wage Act, 2018, as adjusted
 * each year by the Minister of Employment and Labour), from the date it applies. Checked each year
 * with the SARS tables (CPDAUDIT.md section 2).
 */
export const NATIONAL_MINIMUM_WAGE: readonly { from: string; centsPerHour: number; source: string }[] = [
  { from: '2025-03-01', centsPerHour: 2_879, source: 'https://acts.co.za/news/blog/2026/02/new-national-minimum-wage-rates-1-march-2026' },
  { from: '2026-03-01', centsPerHour: 3_023, source: 'https://acts.co.za/news/blog/2026/02/new-national-minimum-wage-rates-1-march-2026' },
];

/** The national minimum wage an hour on a date (the earliest known before it). */
export function minimumWageOn(date: string): number {
  let rate = NATIONAL_MINIMUM_WAGE[0]!.centsPerHour;
  for (const r of NATIONAL_MINIMUM_WAGE) if (date >= r.from) rate = r.centsPerHour;
  return rate;
}

/** Shap logs days, not hours: a day logged is taken as a full working day of this many hours. */
export const HOURS_A_DAY = 8;

/**
 * From 24 hours a month with one employer, UIF applies (Unemployment Insurance Contributions Act
 * s4(1)(a)), and so does all of the BCEA's working-time chapter (BCEA s6(1)(c)).
 */
export const LAW_HOURS_A_MONTH = 24;

export interface LabourLooks {
  /** Day labour (a regular or casual worker), not a subcontractor running their own business. */
  employee: boolean;
  /** About this many hours in the month, from the days logged. */
  hours: number;
  /** 24 hours or more this month: UIF and the BCEA apply. */
  lawApplies: boolean;
  /** The national minimum wage for a full day on the date. */
  minimumDayCents: number;
  /** The day rate is under the national minimum wage for a full day. */
  belowMinimumWage: boolean;
}

/** What the law asks about a worker for a month's days logged, at their day rate, on a date. */
export function labourLooks(w: { kind: WorkerKind; dayRateCents: number; daysInMonth: number; on: string }): LabourLooks {
  const employee = w.kind !== 'subcontractor';
  const hours = Math.round(w.daysInMonth * HOURS_A_DAY * 10) / 10;
  const minimumDayCents = minimumWageOn(w.on) * HOURS_A_DAY;
  return {
    employee,
    hours,
    lawApplies: employee && hours >= LAW_HOURS_A_MONTH,
    minimumDayCents,
    belowMinimumWage: employee && w.dayRateCents > 0 && w.dayRateCents < minimumDayCents,
  };
}

/**
 * Said wherever day labour is set up and paid. OpenWorks IT aren't accountants or labour lawyers:
 * the law's the business's to follow, and this only says where it starts.
 */
export function casualLabourNote(on: string): string {
  const r = (minimumWageOn(on) / 100).toFixed(2);
  return `Someone who works for you 24 hours or more a month is your employee in the law, however you pay them: UIF (1% from them and 1% from you), the Basic Conditions of Employment Act, the national minimum wage (R${r} an hour now), employees' tax (often a flat 25% for someone working under 22 hours a week) and the Compensation Fund all apply. Shap records their days and pay: it doesn't work out or pay UIF or tax for them. Someone who works for you regularly belongs on Payroll. Shap is free software from OpenWorks IT, who are not accountants or labour lawyers: check how you employ and pay your workers with your accountant or a labour practitioner.`;
}

/** Said of a subcontractor: someone else's business, unless you run their work. */
export const SUBCONTRACTOR_NOTE =
  'A subcontractor runs their own business and invoices you. If you decide how, when and where they work, SARS and the labour laws may see them as your employee (SARS Interpretation Note 17): check with your accountant.';
