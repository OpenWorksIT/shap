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
  kind: 'company' | 'individual';
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
export function estimateTax(f: TaxEstimateFigures) {
  if (f.kind === 'company') {
    const taxableCents = Math.max(0, f.profitCents - f.assessedLossCents);
    return { taxableCents, retirementDeductionCents: 0, taxCents: companyTax(taxableCents, f.fyEnd, f.sbc ?? true) };
  }
  const before = f.profitCents + (f.otherIncomeCents ?? 0) - f.assessedLossCents;
  const retirementDeductionCents = retirementDeduction(f.retirementCents ?? 0, before);
  const taxableCents = Math.max(0, before - retirementDeductionCents);
  return { taxableCents, retirementDeductionCents, taxCents: individualTax(taxableCents, f.fyEnd, f.ageBand ?? 'under65') };
}
