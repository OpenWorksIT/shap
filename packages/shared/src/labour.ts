/**
 * Day labour and the law (docs/CASUAL_LABOUR.md). Shap records a worker's days and pay; it doesn't
 * work out, deduct or pay UIF, PAYE (employees' tax) or the Compensation Fund for them (Payroll
 * works out PAYE, UIF and SDL for employees put on it, as aids). What's here are reminders of where
 * the law comes in, worked out from the days logged: not advice, and the business's own to check.
 */
import type { WorkerKind } from './enums.js';
import { formatZar } from './money.js';
import { taxYearEnd } from './payroll.js';

/**
 * The national minimum wage for an ordinary hour (National Minimum Wage Act, 2018, as adjusted
 * each year by the Minister of Employment and Labour), from the date it applies. Checked each year
 * with the SARS tables (CPDAUDIT.md section 2).
 */
export const NATIONAL_MINIMUM_WAGE: readonly { from: string; centsPerHour: number; source: string }[] = [
  { from: '2025-03-01', centsPerHour: 2_879, source: 'https://www.gov.za/news/media-statements/minister-nomakhosazana-meth-adjusts-national-minimum-wage-r2879-hour-05-feb' },
  { from: '2026-03-01', centsPerHour: 3_023, source: 'https://www.gov.za/sites/default/files/gcis_document/202602/54075rg11941gon7083.pdf' },
];

/** The national minimum wage an hour on a date (the earliest known before it). */
export function minimumWageOn(date: string): number {
  let rate = NATIONAL_MINIMUM_WAGE[0]!.centsPerHour;
  for (const r of NATIONAL_MINIMUM_WAGE) if (date >= r.from) rate = r.centsPerHour;
  return rate;
}

/**
 * PAYE on a day labourer's pay (the Fourth Schedule, paras 1 and 9(1); SARS's guide for employers):
 * someone working at least 22 hours a week for one employer is in standard employment, and so is
 * (deemed) someone working at least 5 hours a day for less than this a day, or under 22 hours a
 * week with a written declaration that they work for no other employer: SARS's tables apply, and a
 * low wage may come to no tax. Anyone else: a flat 25%. By the tax year (ending February).
 */
export const DEEMED_STANDARD_DAY: readonly { taxYearEnd: string; cents: number; source: string }[] = [
  { taxYearEnd: '2027-02-28', cents: 39_400, source: 'https://www.sars.gov.za/paye-gen-01-g21-guide-for-employers-iro-employees-tax-for-2027-external-guide/' },
];

/** The deemed standard employment day pay for the tax year a date is in, if Shap has it. */
export function deemedStandardDayOn(date: string): number | null {
  return DEEMED_STANDARD_DAY.find((r) => r.taxYearEnd === taxYearEnd(date))?.cents ?? null;
}

/** Shap logs days, not hours: a day logged is taken as an 8-hour day (the BCEA allows up to 9 ordinary hours). */
export const HOURS_A_DAY = 8;

/**
 * From 24 hours a month with one employer, UIF applies (Unemployment Insurance Contributions Act
 * s4(1)(a)), and so do the BCEA's chapters on working time and leave (s6(1)(c), s19(1)).
 */
export const LAW_HOURS_A_MONTH = 24;

export interface LabourLooks {
  /** Day labour (a regular or casual worker), not a subcontractor running their own business. */
  employee: boolean;
  /** About this many hours in the month, from the days logged. */
  hours: number;
  /** About 24 hours or more logged in the month: UIF and the BCEA's hours and leave may apply. */
  lawApplies: boolean;
  /** The national minimum wage for an 8-hour day on the date. */
  minimumDayCents: number;
  /** The day rate is under the national minimum wage for an 8-hour day. */
  belowMinimumWage: boolean;
}

/** Where the law comes in for a worker, from a month's days logged, at their day rate, on a date. */
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
 * the law's the business's to follow, and this only says where it comes in.
 */
export function casualLabourNote(on: string): string {
  const day = deemedStandardDayOn(on);
  const deemed = day ? `, or at least 5 hours a day for under ${formatZar(day, { cents: false })} a day` : ', or at least 5 hours a day for a low day wage';
  return [
    `Someone you pay by the day is usually your employee in the law, however few days they work. The national minimum wage (${formatZar(minimumWageOn(on))} an hour now) applies to every worker, and PAYE and the Compensation Fund to employees' pay; from 24 hours a month with you, UIF (1% from them and 1% from you) and the Basic Conditions of Employment Act's rules on working hours and leave too.`,
    `For PAYE, SARS's tables usually apply to day labour (22 hours a week or more for you${deemed}), and a low wage may come to no tax; otherwise it's a flat 25%, unless they give you a written declaration that they work for no other employer.`,
    'Shap records their days and pay only: it doesn’t work out, deduct or pay UIF, PAYE or the Compensation Fund for them. What Workers flags is a reminder worked out from the days logged, not advice: Shap is free software from OpenWorks IT, who are not accountants or labour lawyers. Check how you employ and pay your workers with your accountant or a labour practitioner.',
  ].join(' ');
}

/** On a worker's page: the months, from the days logged, that UIF and the BCEA's hours and leave may apply. */
export function lawMonthsNote(name: string, months: number): string {
  return `From the days logged, ${name} worked about ${LAW_HOURS_A_MONTH} hours or more in ${months} month${months === 1 ? '' : 's'} (marked ●, at ${HOURS_A_DAY} hours a day). From that much work with you, UIF and the Basic Conditions of Employment Act's rules on working hours and leave apply to an employee. A reminder, not advice: check with your accountant or a labour practitioner.`;
}

/** Said of a subcontractor: someone else's business, unless you run their work. */
export const SUBCONTRACTOR_NOTE =
  'A subcontractor runs their own business and invoices you. If you decide how, when and where they work, they may be your employee for SARS (Interpretation Note 17) and for the labour laws (LRA s200A): check with your accountant or a labour practitioner.';
