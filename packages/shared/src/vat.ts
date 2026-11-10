/**
 * VAT on each line: what kind of supply it is, at which rate, and how a document's totals come
 * out of its lines, with prices typed either excluding or including VAT.
 *
 * The VAT201 fields each kind lands in, and the examples: SARS's VAT 404 guide for vendors and
 * the VAT201 form (field 1 standard rate, 2 zero rate, 2A exports, 3 exempt and non-supplies;
 * input VAT in 14 and 15). https://www.sars.gov.za/types-of-tax/value-added-tax/
 */
import { roundCents } from './money.js';

/** On a quote, invoice or credit note: what kind of supply each line is. */
export const SALE_VAT_CODES = ['standard', 'zero', 'export', 'exempt'] as const;
export type SaleVatCode = (typeof SALE_VAT_CODES)[number];

export const SALE_VAT: Record<SaleVatCode, { label: string; short: string; field: string; hint: string }> = {
  standard: { label: 'Standard rate (15%)', short: '15%', field: '1', hint: 'Most goods and services: VAT is added at the standard rate.' },
  zero: {
    label: 'Zero-rated (0%)',
    short: '0%',
    field: '2',
    hint: 'A taxable supply at 0%, such as the basic foods SARS lists (brown bread, maize meal, rice, fresh fruit and vegetables, milk, eggs…), petrol and diesel, and some services to clients outside South Africa. Counted on your VAT201, but no VAT is charged.',
  },
  export: { label: 'Exported (0%)', short: '0% export', field: '2A', hint: 'Goods you export from South Africa yourself. Zero-rated, and you must keep proof that they left the country.' },
  exempt: {
    label: 'Exempt or not a supply',
    short: 'Exempt',
    field: '3',
    hint: 'No VAT, and no VAT can be claimed on what went into it: residential rent, financial services (such as interest), and some education and public transport. Also amounts that aren’t a supply at all.',
  },
};

/** On a cost or bill: what VAT was on it, and whether it can be claimed. */
export const PURCHASE_VAT_CODES = ['standard', 'zero', 'exempt', 'no_vat', 'not_claimable'] as const;
export type PurchaseVatCode = (typeof PURCHASE_VAT_CODES)[number];

export const PURCHASE_VAT: Record<PurchaseVatCode, { label: string; claim: boolean; hint: string }> = {
  standard: { label: 'Standard rate: claim the VAT', claim: true, hint: 'The slip shows VAT at 15% and the supplier’s VAT number: you claim it back on your VAT201.' },
  zero: { label: 'Zero-rated: no VAT on it', claim: false, hint: 'Basic foods, petrol and diesel, and other zero-rated goods: there is no VAT to claim.' },
  exempt: { label: 'Exempt: no VAT on it', claim: false, hint: 'Residential rent, interest and other financial services, some public transport: no VAT is charged.' },
  no_vat: { label: 'Supplier isn’t VAT registered', claim: false, hint: 'No VAT on the slip because the supplier isn’t a VAT vendor.' },
  not_claimable: {
    label: 'VAT charged, but can’t be claimed',
    claim: false,
    hint: 'SARS doesn’t allow the VAT back on entertainment, club memberships, or buying or renting a passenger car (a sedan, station wagon, minibus or double cab), among others.',
  },
};

/**
 * South Africa's standard VAT rate by date: 14% from 7 April 1993, 15% from 1 April 2018.
 * (The 2025 increase to 15.5% was withdrawn before it took effect.) A future change is added
 * here in an update; a document takes the rate for its own date.
 */
const VAT_RATES: { from: string; bp: number }[] = [
  { from: '2018-04-01', bp: 1500 },
  { from: '1993-04-07', bp: 1400 },
];
/** A full tax invoice (over R5 000) names the recipient and their address: VAT Act s20(4)(c). Up to it, an abridged one will do (s20(5)). */
export const FULL_TAX_INVOICE_CENTS = 5_000_00;
/** Paid in money and R50 or less: no tax invoice is needed at all (s20(6)). */
export const NO_TAX_INVOICE_CENTS = 50_00;

/**
 * Whether a tax invoice must be the full one, with the recipient's name and address (s20(4)):
 * over R5 000, or anything zero-rated (the abridged form "shall not apply to a supply that is
 * charged with tax under section 11", the proviso to s20(5); VAT 404 13.1), unless it's R50 or less
 * (s20(6)). https://www.sars.gov.za/businesses-and-employers/tax-invoices/
 */
export function needsFullTaxInvoice(totalCents: number, zeroRated: boolean): boolean {
  const t = Math.abs(totalCents);
  return t > FULL_TAX_INVOICE_CENTS || (zeroRated && t > NO_TAX_INVOICE_CENTS);
}

export const vatRateOn = (date: string) => (VAT_RATES.find((r) => date >= r.from) ?? VAT_RATES[VAT_RATES.length - 1]!).bp;

export interface TotalsLine {
  qty: number;
  unitPriceCents: number;
  vatCode?: SaleVatCode | null;
}

/**
 * A document's totals from its lines. Prices are typed excluding VAT, or including it. VAT is
 * worked out once on all the standard-rated lines together (so a long invoice doesn't gather
 * rounding cents), and each line's amount excluding VAT is kept so the books post revenue
 * without the VAT. With prices including VAT, the total is exactly what was typed.
 */
export function documentTotals(lines: TotalsLine[], rateBp: number, pricesIncludeVat: boolean) {
  const amounts = lines.map((l) => roundCents(l.qty * l.unitPriceCents));
  const standard = lines.map((l) => rateBp > 0 && (l.vatCode ?? 'standard') === 'standard');
  const stdAmount = amounts.reduce((t, a, i) => t + (standard[i] ? a : 0), 0);
  const vatOn = (a: number) => (rateBp > 0 ? (pricesIncludeVat ? (a * rateBp) / (10000 + rateBp) : (a * rateBp) / 10000) : 0);
  const vatCents = roundCents(vatOn(stdAmount));
  // Each standard line's own VAT (so a discount line takes its own share back), with the cent or
  // two of rounding put on the biggest line, so the shares add up to the VAT exactly.
  const lineVat = amounts.map((a, i) => (standard[i] ? roundCents(vatOn(a)) : 0));
  const left = vatCents - lineVat.reduce((t, v) => t + v, 0);
  if (left !== 0) {
    let big = -1;
    amounts.forEach((a, i) => {
      if (standard[i] && (big < 0 || Math.abs(a) > Math.abs(amounts[big]!))) big = i;
    });
    if (big >= 0) lineVat[big] = lineVat[big]! + left;
  }
  const net = amounts.map((a, i) => (pricesIncludeVat ? a - lineVat[i]! : a));
  const subtotalCents = net.reduce((t, n) => t + n, 0);
  const by = (code: SaleVatCode) => net.reduce((t, n, i) => t + ((lines[i]!.vatCode ?? 'standard') === code ? n : 0), 0);
  return {
    /** Each line as typed (qty × price), and excluding VAT. */
    lines: amounts.map((a, i) => ({ amountCents: a, netCents: net[i]!, vatCents: lineVat[i]! })),
    subtotalCents,
    vatCents,
    totalCents: subtotalCents + vatCents,
    /** Excluding VAT, by kind of supply. */
    byCode: { standard: by('standard'), zero: by('zero'), export: by('export'), exempt: by('exempt') } as Record<SaleVatCode, number>,
  };
}
