/**
 * South African payroll for a small employer: PAYE on monthly salaries, UIF and SDL, and
 * dividends tax for paying the company's shareholders.
 *
 * PAYE: SARS's annualising method. A month's pay is treated as a twelfth of a year's, tax is
 * worked out on the year's tables (with the rebates for the employee's age) and divided by 12;
 * a once-off amount (a bonus) is taxed as the extra tax it adds to the year. Medical scheme fees
 * tax credits come off when the employee's medical aid goes through payroll.
 * Sources: SARS, Guide for Employers in respect of Employees' Tax (2027)
 *   https://www.sars.gov.za/guide-for-employers-in-respect-of-employees-tax-2027/
 * Medical tax credits: https://www.sars.gov.za/tax-rates/medical-tax-credit-rates/
 * UIF: https://www.sars.gov.za/types-of-tax/unemployment-insurance-fund/ (1% + 1%, up to R17 712 a month since 1 June 2021)
 * SDL: 1% of payroll, for employers whose payroll is over R500 000 a year.
 * Dividends tax: https://www.sars.gov.za/types-of-tax/dividends-tax/ (20% since 22 February 2017)
 */
import { businessDayOnOrBefore } from './dates.js';
import { individualTax, type AgeBand } from './tax.js';

export const UIF_RATE = 0.01;
export const UIF_CEILING_CENTS = 1_771_200;
export const SDL_RATE = 0.01;
export const SDL_THRESHOLD_CENTS = 50_000_000;
export const DWT_RATE_BP = 2000;

const MEDICAL_CREDITS: { from: string; main: number; first: number; more: number }[] = [
  { from: '2027-02-28', main: 37_600, first: 75_200, more: 25_400 },
  // Unchanged from the 2024 year (1 March 2023) to the 2026 one.
  { from: '2024-02-29', main: 36_400, first: 72_800, more: 24_600 },
  { from: '2023-02-28', main: 34_700, first: 69_400, more: 23_400 },
];

/** The last day of the SARS tax year (1 March to end February) a date falls in. */
export function taxYearEnd(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const end = m >= 3 ? y + 1 : y;
  const leap = (end % 4 === 0 && end % 100 !== 0) || end % 400 === 0;
  return `${end}-02-${leap ? 29 : 28}`;
}

/** The monthly medical scheme fees tax credit, in cents, for this many people on the medical aid. */
export function medicalCredit(members: number, yearEnd: string): number {
  if (members <= 0) return 0;
  const t = MEDICAL_CREDITS.find((x) => yearEnd >= x.from) ?? MEDICAL_CREDITS[MEDICAL_CREDITS.length - 1]!;
  return members === 1 ? t.main : t.first + (members - 2) * t.more;
}

export interface PayInput {
  /** The month's regular pay (salary), cents. */
  salaryCents: number;
  /** Overtime this month: regular pay, taxed with the salary as if earned all year. */
  overtimeCents?: number;
  /** Commission this month: regular pay like overtime, but not counted for UIF (UIC Act s1). */
  commissionCents?: number;
  /** Once-off pay this month (a bonus, an annual payment): taxed as the tax it adds to the year. */
  extraCents?: number;
  /** Once-off pay already paid earlier in the same tax year (so a second bonus is taxed on top of the first). */
  extraBeforeCents?: number;
  /** Paid on this date (decides the tax year). */
  payDate: string;
  age?: AgeBand;
  /** People on the employee's medical aid through payroll (0 if none). */
  medicalMembers?: number;
  uif?: boolean;
  /** The employer pays SDL (payroll over R500 000 a year). */
  sdl?: boolean;
}

export interface PayResult {
  grossCents: number;
  payeCents: number;
  uifEmployeeCents: number;
  uifEmployerCents: number;
  sdlCents: number;
  netCents: number;
}

/** One employee's month. */
export function payLine(p: PayInput): PayResult {
  const yearEnd = taxYearEnd(p.payDate);
  const age = p.age ?? 'under65';
  const salary = Math.max(0, Math.round(p.salaryCents));
  const overtime = Math.max(0, Math.round(p.overtimeCents ?? 0));
  const commission = Math.max(0, Math.round(p.commissionCents ?? 0));
  const extra = Math.max(0, Math.round(p.extraCents ?? 0));
  const before = Math.max(0, Math.round(p.extraBeforeCents ?? 0));
  const gross = salary + overtime + commission + extra;
  // SARS's tables method: the month's regular pay as a year's, the year's tax back to a month.
  const annual = (salary + overtime + commission) * 12;
  const regular = individualTax(annual, yearEnd, age) / 12;
  // An annual payment: the tax it adds to the year, on top of the year's earlier ones.
  const onceOff = extra ? individualTax(annual + before + extra, yearEnd, age) - individualTax(annual + before, yearEnd, age) : 0;
  const paye = Math.max(0, Math.round(regular + onceOff - medicalCredit(p.medicalMembers ?? 0, yearEnd)));
  const uifBase = Math.min(gross - commission, UIF_CEILING_CENTS);
  const uifEach = p.uif === false ? 0 : Math.round(uifBase * UIF_RATE);
  const sdl = p.sdl ? Math.round(gross * SDL_RATE) : 0;
  return { grossCents: gross, payeCents: paye, uifEmployeeCents: uifEach, uifEmployerCents: uifEach, sdlCents: sdl, netCents: gross - paye - uifEach };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** PAYE, UIF and SDL for a month (EMP201) are due by the 7th of the next month (earlier if that's a weekend or public holiday). */
export function emp201Due(period: string): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return businessDayOnOrBefore(iso(new Date(Date.UTC(y, m, 7))));
}

/** Dividends tax is due by the last day of the month after the dividend was paid (earlier if that isn't a business day). */
export function dwtDue(paidOn: string): string {
  const [y, m] = paidOn.split('-').map(Number) as [number, number];
  return businessDayOnOrBefore(iso(new Date(Date.UTC(y, m + 1, 0))));
}

/** Dividends tax on a dividend, cents (none when the shareholder is a South African company). */
export function dividendTax(grossCents: number, exempt = false): number {
  return exempt ? 0 : Math.round((grossCents * DWT_RATE_BP) / 10_000);
}

/**
 * A micro business on turnover tax pays no dividends tax on the first R200 000 of dividends it
 * pays in a year of assessment, all shareholders together (s64F(1)(h)); the rest is taxed as usual.
 * SARS, Tax Guide for Micro Businesses, 3.8.1.
 */
export const MICRO_DIVIDEND_EXEMPT_CENTS = 20_000_000;
export function microDividendTax(grossCents: number, paidEarlierThisYearCents: number, exempt = false): number {
  const room = Math.max(0, MICRO_DIVIDEND_EXEMPT_CENTS - Math.max(0, paidEarlierThisYearCents));
  return dividendTax(Math.max(0, grossCents - room), exempt);
}
