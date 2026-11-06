import { splitByShares } from './entities.js';
/**
 * South African company income tax, for provisional tax estimates.
 * Source: SARS, "Companies, Trusts and Small Business Corporations (SBC)"
 * https://www.sars.gov.za/tax-rates/income-tax/companies-trusts-and-small-business-corporations-sbc/
 * A table applies to years of assessment ending on or after `from`.
 */
interface Band {
  upTo: number | null; // rand, inclusive
  base: number; // rand of tax at the bottom of the band
  rate: number; // on the amount above `over`
  over: number;
}
const SBC_TABLES: { from: string; bands: Band[] }[] = [
  {
    from: '2026-04-01',
    bands: [
      { upTo: 99_000, base: 0, rate: 0, over: 0 },
      { upTo: 365_000, base: 0, rate: 0.07, over: 99_000 },
      { upTo: 550_000, base: 18_620, rate: 0.21, over: 365_000 },
      { upTo: null, base: 57_470, rate: 0.27, over: 550_000 },
    ],
  },
  {
    from: '2023-04-01',
    bands: [
      { upTo: 95_750, base: 0, rate: 0, over: 0 },
      { upTo: 365_000, base: 0, rate: 0.07, over: 95_750 },
      { upTo: 550_000, base: 18_848, rate: 0.21, over: 365_000 },
      { upTo: null, base: 57_698, rate: 0.27, over: 550_000 },
    ],
  },
];
export const COMPANY_RATE = 0.27;

/** Tax in cents on a taxable income in cents, for a year of assessment ending `fyEnd`. */
export function companyTax(taxableCents: number, fyEnd: string, sbc: boolean): number {
  if (taxableCents <= 0) return 0;
  const r = taxableCents / 100;
  if (!sbc) return Math.round(r * COMPANY_RATE * 100);
  const table = SBC_TABLES.find((t) => fyEnd >= t.from) ?? SBC_TABLES[SBC_TABLES.length - 1]!;
  const band = table.bands.find((b) => b.upTo == null || r <= b.upTo)!;
  return Math.round((band.base + (r - band.over) * band.rate) * 100);
}

export function sbcTableFor(fyEnd: string) {
  return (SBC_TABLES.find((t) => fyEnd >= t.from) ?? SBC_TABLES[SBC_TABLES.length - 1]!).bands;
}

// ---------------------------------------------------------------- individuals (sole proprietors)
/**
 * A sole proprietor's business profit is taxed as the owner's own income, on the tables for
 * individuals. The year of assessment ends on the last day of February.
 * Source: SARS, "Rates of tax for individuals"
 * https://www.sars.gov.za/tax-rates/income-tax/rates-of-tax-for-individuals/
 * A table applies to years of assessment ending on or after `from`.
 */
export type AgeBand = 'under65' | '65to74' | '75plus';
export const AGE_BAND_LABELS: Record<AgeBand, string> = { under65: 'Under 65', '65to74': '65 to 74', '75plus': '75 or older' };
const INDIVIDUAL_TABLES: { from: string; label: string; bands: Band[]; rebates: { primary: number; secondary: number; tertiary: number } }[] = [
  {
    from: '2027-02-28',
    label: '2027 (1 March 2026 – 28 February 2027)',
    bands: [
      { upTo: 245_100, base: 0, rate: 0.18, over: 0 },
      { upTo: 383_100, base: 44_118, rate: 0.26, over: 245_100 },
      { upTo: 530_200, base: 79_998, rate: 0.31, over: 383_100 },
      { upTo: 695_800, base: 125_599, rate: 0.36, over: 530_200 },
      { upTo: 887_000, base: 185_215, rate: 0.39, over: 695_800 },
      { upTo: 1_878_600, base: 259_783, rate: 0.41, over: 887_000 },
      { upTo: null, base: 666_339, rate: 0.45, over: 1_878_600 },
    ],
    rebates: { primary: 17_820, secondary: 9_765, tertiary: 3_249 },
  },
  {
    // 2025 and 2026 had no changes from 2024.
    from: '2024-02-29',
    label: '2024 to 2026',
    bands: [
      { upTo: 237_100, base: 0, rate: 0.18, over: 0 },
      { upTo: 370_500, base: 42_678, rate: 0.26, over: 237_100 },
      { upTo: 512_800, base: 77_362, rate: 0.31, over: 370_500 },
      { upTo: 673_000, base: 121_475, rate: 0.36, over: 512_800 },
      { upTo: 857_900, base: 179_147, rate: 0.39, over: 673_000 },
      { upTo: 1_817_000, base: 251_258, rate: 0.41, over: 857_900 },
      { upTo: null, base: 644_489, rate: 0.45, over: 1_817_000 },
    ],
    rebates: { primary: 17_235, secondary: 9_444, tertiary: 3_145 },
  },
];

export function individualTableFor(yearEnd: string) {
  return INDIVIDUAL_TABLES.find((t) => yearEnd >= t.from) ?? INDIVIDUAL_TABLES[INDIVIDUAL_TABLES.length - 1]!;
}

/** The rebate for an age on the last day of the year of assessment. */
export function individualRebate(yearEnd: string, age: AgeBand): number {
  const r = individualTableFor(yearEnd).rebates;
  return Math.round((r.primary + (age !== 'under65' ? r.secondary : 0) + (age === '75plus' ? r.tertiary : 0)) * 100);
}

/** Below this taxable income (cents) no tax is payable: where the table's tax equals the rebate. */
export function individualThreshold(yearEnd: string, age: AgeBand): number {
  const rebate = individualRebate(yearEnd, age) / 100;
  const t = individualTableFor(yearEnd);
  for (const b of t.bands) {
    const at = b.over + (rebate - b.base) / b.rate;
    if (b.upTo == null || at <= b.upTo) return Math.round(at) * 100;
  }
  return 0;
}

/** Income tax in cents for an individual, after rebates (before medical scheme credits). */
export function individualTax(taxableCents: number, yearEnd: string, age: AgeBand = 'under65'): number {
  if (taxableCents <= 0) return 0;
  const r = taxableCents / 100;
  const band = individualTableFor(yearEnd).bands.find((b) => b.upTo == null || r <= b.upTo)!;
  const gross = Math.round((band.base + (r - band.over) * band.rate) * 100);
  return Math.max(0, gross - individualRebate(yearEnd, age));
}

/** Retirement annuity (and pension) contributions: deductible up to 27.5% of income, at most R350 000 a year. */
export function retirementDeduction(contributedCents: number, incomeCents: number): number {
  return Math.max(0, Math.min(contributedCents, Math.round(Math.max(0, incomeCents) * 0.275), 35_000_000));
}

// ---------------------------------------------------------------- VAT registration
/**
 * Registering for VAT is compulsory once taxable supplies in any 12 months pass the
 * compulsory threshold (or are expected to under a contract); voluntary from the lower one.
 * Source: SARS, Budget 2026 FAQ (thresholds raised from 1 April 2026)
 * https://www.sars.gov.za/about/sars-tax-and-customs-system/budget/budget-2026-frequently-asked-questions/
 */
const VAT_THRESHOLDS: { from: string; compulsoryCents: number; voluntaryCents: number }[] = [
  { from: '2026-04-01', compulsoryCents: 230_000_000, voluntaryCents: 12_000_000 },
  { from: '2009-03-01', compulsoryCents: 100_000_000, voluntaryCents: 5_000_000 },
];
export function vatThresholds(on: string) {
  return VAT_THRESHOLDS.find((t) => on >= t.from) ?? VAT_THRESHOLDS[VAT_THRESHOLDS.length - 1]!;
}

export type VatWatchState = 'over' | 'near' | 'voluntary' | null;
/**
 * Where an unregistered business stands: over the line (must register), getting near it
 * (80% of the way, or on pace to pass it in a year), past the voluntary line, or nowhere near.
 */
export function vatWatch(last12Cents: number, pace12Cents: number, on: string): { state: VatWatchState; compulsoryCents: number; voluntaryCents: number } {
  const t = vatThresholds(on);
  const state: VatWatchState =
    last12Cents > t.compulsoryCents ? 'over' : last12Cents >= t.compulsoryCents * 0.8 || pace12Cents > t.compulsoryCents ? 'near' : last12Cents >= t.voluntaryCents ? 'voluntary' : null;
  return { state, compulsoryCents: t.compulsoryCents, voluntaryCents: t.voluntaryCents };
}

// ---------------------------------------------------------------- one estimate, either kind
export interface TaxEstimateFigures {
  /**
   * Who pays: a company (CC, co-op, Inc.), an individual (a sole proprietor; each partner is
   * worked out as one), a trust (45% on what it keeps), or a non-profit company (none once
   * approved as a PBO, else 27% without the small business table).
   */
  kind: 'company' | 'individual' | 'trust' | 'npc' | 'partners';
  /** Partnerships: the partners' shares (basis points). Each is worked out as an individual with no other income. */
  partners?: { name: string; shareBp: number }[];
  /** Trusts: income given to beneficiaries in the year (taxed in their hands, not the trust's). */
  distributedCents?: number;
  /** Non-profit companies: approved by SARS as a public benefit organisation. */
  approvedPbo?: boolean;
  profitCents: number;
  assessedLossCents: number;
  fyEnd: string;
  /** Companies: small business corporation rates. */
  sbc?: boolean;
  /** Individuals: age on the last day of the year, other taxable income, retirement contributions. */
  ageBand?: AgeBand;
  otherIncomeCents?: number;
  retirementCents?: number;
}
/** Taxable income and the year's tax, the same on the screen and when saved. */
export function estimateTax(f: TaxEstimateFigures): { taxableCents: number; retirementDeductionCents: number; taxCents: number; partners?: { name: string; shareBp: number; taxableCents: number; taxCents: number }[] } {
  if (f.kind === 'partners') {
    // The partnership pays nothing itself: each partner pays on their share, on the individual
    // tables. Shown without their other income, which only they (and SARS) know. A partnership
    // has no assessed loss of its own: each year's loss already went to the partners that year.
    const taxableCents = Math.max(0, f.profitCents);
    const list = (f.partners ?? []).map((p, i) => ({ id: String(i), name: p.name, shareBp: p.shareBp }));
    const partners = splitByShares(taxableCents, list).map(({ partner, cents }) => ({ name: partner.name, shareBp: partner.shareBp, taxableCents: cents, taxCents: individualTax(cents, f.fyEnd, 'under65') }));
    return { taxableCents, retirementDeductionCents: 0, taxCents: partners.reduce((t, p) => t + p.taxCents, 0), partners };
  }
  if (f.kind === 'trust') {
    const taxableCents = Math.max(0, f.profitCents - f.assessedLossCents - (f.distributedCents ?? 0));
    return { taxableCents, retirementDeductionCents: 0, taxCents: Math.round(taxableCents * 0.45) };
  }
  if (f.kind === 'npc') {
    const taxableCents = f.approvedPbo ? 0 : Math.max(0, f.profitCents - f.assessedLossCents);
    return { taxableCents, retirementDeductionCents: 0, taxCents: companyTax(taxableCents, f.fyEnd, false) };
  }
  if (f.kind === 'company') {
    const taxableCents = Math.max(0, f.profitCents - f.assessedLossCents);
    return { taxableCents, retirementDeductionCents: 0, taxCents: companyTax(taxableCents, f.fyEnd, f.sbc ?? true) };
  }
  const before = f.profitCents + (f.otherIncomeCents ?? 0) - f.assessedLossCents;
  const retirementDeductionCents = retirementDeduction(f.retirementCents ?? 0, before);
  const taxableCents = Math.max(0, before - retirementDeductionCents);
  return { taxableCents, retirementDeductionCents, taxCents: individualTax(taxableCents, f.fyEnd, f.ageBand ?? 'under65') };
}

/* ---------------------------------------------------------------- turnover tax (micro businesses) */

/**
 * Turnover tax: a simple tax on turnover for micro businesses (turnover up to R2.3 million from
 * 1 April 2026). It replaces income tax, provisional tax, capital gains tax and dividends tax
 * (VAT stays optional). SARS: https://www.sars.gov.za/types-of-tax/turnover-tax/
 * Bands in rand: [from, base tax, rate above from].
 */
const TURNOVER_TABLES: { from: string; bands: [number, number, number][] }[] = [
  // Years of assessment from 1 March 2026.
  { from: '2027-02-28', bands: [[0, 0, 0], [600_000, 0, 0.01], [950_000, 3_500, 0.02], [1_400_000, 12_500, 0.03]] },
  // Earlier years (unchanged since 2013).
  { from: '0000-00-00', bands: [[0, 0, 0], [335_000, 0, 0.01], [500_000, 1_650, 0.02], [750_000, 6_650, 0.03]] },
];
export const TURNOVER_TAX_LIMIT_CENTS = 2_300_000_00;

export function turnoverTaxTable(yearEnd: string) {
  return TURNOVER_TABLES.find((t) => yearEnd >= t.from)!.bands;
}

/** Turnover tax for a year's taxable turnover, in cents. */
export function turnoverTax(turnoverCents: number, yearEnd: string): number {
  const r = Math.max(0, turnoverCents) / 100;
  const bands = turnoverTaxTable(yearEnd);
  let band = bands[0]!;
  for (const b of bands) if (r > b[0]) band = b;
  return Math.round((band[1] + (r - band[0]) * band[2]) * 100);
}

/* ---------------------------------------------------------------- VAT201 periods */

/** The VAT period (two months for categories A and B, one for C) ending in or before `on`'s month. */
export function vatPeriod(on: string, category: 'A' | 'B' | 'C'): { start: string; end: string } {
  const [y, m] = on.split('-').map(Number) as [number, number];
  let endMonth = m;
  if (category === 'A' && m % 2 === 0) endMonth = m + 1; // A ends Jan, Mar, May…
  if (category === 'B' && m % 2 === 1) endMonth = m + 1; // B ends Feb, Apr, Jun…
  const end = new Date(Date.UTC(y, endMonth, 0));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - (category === 'C' ? 0 : 1), 1));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

/** VAT201 due date when filed and paid on eFiling: the last business day of the month after the period. */
export function vat201Due(periodEnd: string): string {
  const [y, m] = periodEnd.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m + 1, 0));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** The last business day of a month (turnover tax interim payments). */
export function lastBusinessDay(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 0));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
