import { businessDayOnOrBefore } from './dates.js';
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
  {
    // Years ending 1 April 2022 – 31 March 2023 (the top band at the company rate: 27% for a year
    // ending on 31 March 2023, 28% before).
    from: '2022-04-01',
    bands: [
      { upTo: 91_250, base: 0, rate: 0, over: 0 },
      { upTo: 365_000, base: 0, rate: 0.07, over: 91_250 },
      { upTo: 550_000, base: 19_163, rate: 0.21, over: 365_000 },
      { upTo: null, base: 58_013, rate: 0.28, over: 550_000 },
    ],
  },
  {
    // Years ending 1 April 2021 – 31 March 2022.
    from: '2021-04-01',
    bands: [
      { upTo: 87_300, base: 0, rate: 0, over: 0 },
      { upTo: 365_000, base: 0, rate: 0.07, over: 87_300 },
      { upTo: 550_000, base: 19_439, rate: 0.21, over: 365_000 },
      { upTo: null, base: 58_289, rate: 0.28, over: 550_000 },
    ],
  },
  {
    // Years ending 1 April 2020 – 31 March 2021 (and, as the nearest, any earlier year).
    from: '2020-04-01',
    bands: [
      { upTo: 83_100, base: 0, rate: 0, over: 0 },
      { upTo: 365_000, base: 0, rate: 0.07, over: 83_100 },
      { upTo: 550_000, base: 19_733, rate: 0.21, over: 365_000 },
      { upTo: null, base: 58_583, rate: 0.28, over: 550_000 },
    ],
  },
];
/**
 * A small business corporation (Income Tax Act s12E): among its tests, gross income for the year
 * of no more than R20 million. The others (every shareholder a natural person holding no shares in
 * another company, no more than 20% investment income and personal services, not a personal service
 * provider) are the business’s to say. https://www.sars.gov.za/tax-rates/income-tax/companies-trusts-and-small-business-corporations-sbc/
 */
export const SBC_GROSS_INCOME_LIMIT_CENTS = 2_000_000_000;
/**
 * Whether the small business corporation rates apply to a year: the business says whether it
 * qualifies (null: it hasn't said), and gross income over R20 million rules them out whatever it said.
 */
export function sbcApplies(qualifies: boolean | null | undefined, grossIncomeCents: number): boolean | null {
  if (grossIncomeCents > SBC_GROSS_INCOME_LIMIT_CENTS) return false;
  return qualifies ?? null;
}
/**
 * The last day of the latest year of assessment whose SARS figures in Shap were checked against
 * what SARS published (docs/SARS.md, the SARS review in CPDAUDIT.md): the tables for years up to it
 * are known right. From the day after (1 March), the tests fail until the next year's figures are
 * checked, put in and this moved on: the standard update for a new tax year (CPDAUDIT.md).
 */
export const SARS_CHECKED_TO = '2027-02-28';

/** The company rate: 27% for years of assessment ending on or after 31 March 2023, 28% before. */
export const COMPANY_RATE = 0.27;
export const companyRate = (fyEnd: string) => (fyEnd >= '2023-03-31' ? 0.27 : 0.28);

/** Tax in cents on a taxable income in cents, for a year of assessment ending `fyEnd`. */
export function companyTax(taxableCents: number, fyEnd: string, sbc: boolean): number {
  if (taxableCents <= 0) return 0;
  const r = taxableCents / 100;
  if (!sbc) return Math.round(r * companyRate(fyEnd) * 100);
  const band = sbcTableFor(fyEnd).find((b) => b.upTo == null || r <= b.upTo)!;
  return Math.round((band.base + (r - band.over) * band.rate) * 100);
}

/** The SBC table for a year ending `fyEnd`: its top band at the company rate for that year (27% from 31 March 2023). */
export function sbcTableFor(fyEnd: string) {
  const bands = (SBC_TABLES.find((t) => fyEnd >= t.from) ?? SBC_TABLES[SBC_TABLES.length - 1]!).bands;
  return bands.map((b) => (b.upTo == null ? { ...b, rate: companyRate(fyEnd) } : b));
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
  {
    // The year to 28 February 2023 (and, as the nearest, any earlier year).
    from: '2023-02-28',
    label: '2023 (1 March 2022 – 28 February 2023)',
    bands: [
      { upTo: 226_000, base: 0, rate: 0.18, over: 0 },
      { upTo: 353_100, base: 40_680, rate: 0.26, over: 226_000 },
      { upTo: 488_700, base: 73_726, rate: 0.31, over: 353_100 },
      { upTo: 641_400, base: 115_762, rate: 0.36, over: 488_700 },
      { upTo: 817_600, base: 170_734, rate: 0.39, over: 641_400 },
      { upTo: 1_731_600, base: 239_452, rate: 0.41, over: 817_600 },
      { upTo: null, base: 614_192, rate: 0.45, over: 1_731_600 },
    ],
    rebates: { primary: 16_425, secondary: 9_000, tertiary: 2_997 },
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

/**
 * The yearly cap on deductible retirement contributions: R430 000 from the year to
 * 28 February 2027 (Budget 2026; SARS applies it from 1 March 2026), R350 000 before.
 * https://www.sars.gov.za/about/sars-tax-and-customs-system/budget/budget-2026-frequently-asked-questions/
 */
export const retirementCapCents = (yearEnd: string) => (yearEnd >= '2027-02-28' ? 43_000_000 : 35_000_000);

/** Retirement annuity (and pension) contributions: deductible up to 27.5% of income, at most the year's cap. */
export function retirementDeduction(contributedCents: number, incomeCents: number, yearEnd: string): number {
  return Math.max(0, Math.min(contributedCents, Math.round(Math.max(0, incomeCents) * 0.275), retirementCapCents(yearEnd)));
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
 * `lineOn`: the date whose line the 12 months are held against (when they ended).
 */
export function vatWatch(last12Cents: number, pace12Cents: number, on: string, lineOn = on): { state: VatWatchState; compulsoryCents: number; voluntaryCents: number } {
  const t = vatThresholds(lineOn);
  const state: VatWatchState =
    last12Cents > t.compulsoryCents ? 'over' : last12Cents >= t.compulsoryCents * 0.8 || pace12Cents > t.compulsoryCents ? 'near' : last12Cents >= t.voluntaryCents ? 'voluntary' : null;
  return { state, compulsoryCents: t.compulsoryCents, voluntaryCents: t.voluntaryCents };
}

// ---------------------------------------------------------------- the assessed loss
/** Years ending on or after this limit a company's assessed loss (s20(1)(a)(ii)). */
export const ASSESSED_LOSS_LIMIT_FROM = '2023-03-31';
/**
 * How much of an assessed loss a year's taxable income (before the loss) uses up: all of it up to
 * that income, but a company's (a CC's, a co-op's, an NPC's) only up to the greater of R1 million
 * and 80% of it, for years ending on or after 31 March 2023 (Income Tax Act s20(1)(a)(ii)).
 * https://www.sars.gov.za/legal-intr-r-bgr-73-meaning-of-taxable-income-for-purposes-of-setting-off-the-balance-of-an-assessed-loss-by-a-company (BGR 73)
 */
export function assessedLossSetOff(kind: TaxEstimateFigures['kind'], incomeCents: number, lossCents: number, fyEnd: string): number {
  if (incomeCents <= 0 || lossCents <= 0) return 0;
  const limited = (kind === 'company' || kind === 'npc') && fyEnd >= ASSESSED_LOSS_LIMIT_FROM;
  return Math.min(lossCents, limited ? Math.min(incomeCents, Math.max(100_000_000, Math.round(incomeCents * 0.8))) : incomeCents);
}
/**
 * The assessed loss carried into a year, from the earlier years' results (profit positive): each
 * year's loss adds to it, and only a later year's income uses it up (there's no carry-back), as
 * far as the set-off allows. A partnership has none (each year's loss is the partners').
 */
export function assessedLossCarried(kind: TaxEstimateFigures['kind'], years: readonly { fyEnd: string; profitCents: number }[]): number {
  if (kind === 'partners') return 0;
  let loss = 0;
  for (const y of [...years].sort((a, b) => (a.fyEnd < b.fyEnd ? -1 : a.fyEnd > b.fyEnd ? 1 : 0))) {
    if (y.profitCents < 0) loss += -y.profitCents;
    else loss -= assessedLossSetOff(kind, y.profitCents, loss, y.fyEnd);
  }
  return loss;
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
  /** Companies: small business corporation rates (left out: the flat company rate). */
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
    // Only the year's income is the beneficiaries' (s25B): giving out more doesn't make a loss.
    const kept = f.profitCents - Math.min(f.distributedCents ?? 0, Math.max(0, f.profitCents));
    const taxableCents = Math.max(0, kept - assessedLossSetOff('trust', kept, f.assessedLossCents, f.fyEnd));
    return { taxableCents, retirementDeductionCents: 0, taxCents: Math.round(taxableCents * 0.45) };
  }
  if (f.kind === 'npc') {
    const taxableCents = f.approvedPbo ? 0 : Math.max(0, f.profitCents - assessedLossSetOff('npc', f.profitCents, f.assessedLossCents, f.fyEnd));
    return { taxableCents, retirementDeductionCents: 0, taxCents: companyTax(taxableCents, f.fyEnd, false) };
  }
  if (f.kind === 'company') {
    const taxableCents = Math.max(0, f.profitCents - assessedLossSetOff('company', f.profitCents, f.assessedLossCents, f.fyEnd));
    // The small business corporation table only when it's said to apply (s12E): the flat rate otherwise.
    return { taxableCents, retirementDeductionCents: 0, taxCents: companyTax(taxableCents, f.fyEnd, f.sbc ?? false) };
  }
  const before = f.profitCents + (f.otherIncomeCents ?? 0) - f.assessedLossCents;
  const retirementDeductionCents = retirementDeduction(f.retirementCents ?? 0, before, f.fyEnd);
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
/** The most turnover a micro business may have: R2.3 million from the year to 28 February 2027, R1 million before. */
export const turnoverTaxLimit = (yearEnd: string) => (yearEnd >= '2027-02-28' ? TURNOVER_TAX_LIMIT_CENTS : 1_000_000_00);

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
/**
 * SARS's VAT categories (tax periods): https://www.sars.gov.za/types-of-tax/value-added-tax/tax-periods-for-vat-vendors/
 * D is mainly for small farmers and micro businesses on turnover tax; E for some companies, trusts
 * and lessors (VAT 404, chapter 3).
 */
export const VAT_CATEGORIES = ['A', 'B', 'C', 'D', 'E'] as const;
export type VatCategory = (typeof VAT_CATEGORIES)[number];
export function vatPeriod(on: string, category: VatCategory, fyEndMonth = 2): { start: string; end: string } {
  const [y, m] = on.split('-').map(Number) as [number, number];
  // How many months a period is, and a month one ends in: A every two months ending Jan, Mar…;
  // B ending Feb, Apr…; C monthly; D six-monthly ending Feb and Aug; E yearly at the year end.
  const [months, endsIn] = ({ A: [2, 1], B: [2, 2], C: [1, 1], D: [6, 2], E: [12, fyEndMonth] } as const)[category];
  let endMonth = m;
  while ((((endMonth - endsIn) % months) + months) % months !== 0) endMonth++;
  const end = new Date(Date.UTC(y, endMonth, 0));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - (months - 1), 1));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

/** VAT201 due date when filed and paid on eFiling: the last business day of the month after the period. */
export function vat201Due(periodEnd: string): string {
  const [y, m] = periodEnd.split('-').map(Number) as [number, number];
  return businessDayOnOrBefore(new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10));
}

/** The last business day of a month, public holidays included (turnover tax and provisional tax payments). */
export function lastBusinessDay(year: number, month: number): string {
  return businessDayOnOrBefore(new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10));
}

/**
 * What a provisional tax payment comes to (SARS): the first is half the year's tax less half a
 * year's employees' tax (PAYE taken off a salary); the second (and a top-up) is the year's tax less
 * the year's employees' tax, less what was paid earlier.
 * https://www.sars.gov.za/types-of-tax/provisional-tax/
 */
export function provisionalPayable(p: { taxCents: number; payeCents?: number; period: number; paidCents?: number }): { dueCents: number; payableCents: number } {
  const paye = Math.max(0, p.payeCents ?? 0);
  const dueCents = p.period === 1 ? Math.round(p.taxCents / 2) - Math.round(paye / 2) : p.taxCents - paye;
  return { dueCents, payableCents: Math.max(0, dueCents - (p.period === 1 ? 0 : (p.paidCents ?? 0))) };
}
