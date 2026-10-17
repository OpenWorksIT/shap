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
