/**
 * The kinds of South African business Shap keeps books for, and what each one changes: the
 * names of the owners' accounts, who pays the income tax and on which table, how owners take
 * money out, the year end, turnover tax, and which returns are due.
 *
 * Sources (checked November 2026):
 * - Company 27%, SBC table, trusts 45% (years ending 2026/27):
 *   https://www.sars.gov.za/tax-rates/income-tax/companies-trusts-and-small-business-corporations-sbc/
 * - A partnership isn't a taxpayer; each partner is taxed on their share:
 *   https://www.taxtim.com/za/guides/income-tax-and-a-partnership
 * - Turnover tax: natural persons (sole proprietors, partners), companies including CCs and
 *   co-operatives; not trusts or public benefit organisations:
 *   https://www.sars.gov.za/faq/faq-what-are-the-requirements-for-a-micro-business-to-qualify-for-turnover-tax/
 * - Trust returns (ITR12T), 2026 season 19 September 2026 to 22 January 2027:
 *   https://www.sars.gov.za/latest-news/trust-filing-season-opens-on-19-september-2026/
 * - Approved PBOs file the IT12EI within 12 months of year end:
 *   https://www.taxfaculty.ac.za/news/read/exempt-institutions-and-submission-of-annual-returns-it12ei
 * - CIPC annual returns (companies and CCs) within 30 business days of the anniversary, with
 *   beneficial ownership up to date first:
 *   https://accountingacademy.co.za/news/read/cipc-enforcing-beneficial-ownership-information-with-annual-return-filings-for-companies-and-ccs
 */

export const BUSINESS_TYPES = ['sole_prop', 'partnership', 'company', 'inc', 'cc', 'trust', 'npc', 'coop'] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

/** Who pays the income tax, and on which table. */
export type TaxedAs = 'individual' | 'partners' | 'company' | 'trust' | 'npc';
/** How the owners take money out. */
export type Payout = 'drawings' | 'dividends' | 'member_distributions' | 'beneficiary_distributions' | 'none';

/** The standard names of the accounts each kind of business names its own way. */
export interface EntityAccounts {
  share_capital: string;
  retained_earnings: string;
  owner_loan: { name: string; type: 'liability' | 'equity' };
  dividends: string;
  dividends_payable: string;
  director_salary: string;
}

export interface EntityRules {
  key: BusinessType;
  /** As in a picker: "Private company ((Pty) Ltd)". */
  label: string;
  /** In a sentence: "the company", "the CC". */
  the: string;
  /** One line on who it's for, in plain words. */
  description: string;
  taxedAs: TaxedAs;
  /** May qualify for the small business corporation table (if it meets SARS's other tests). */
  sbcPossible: boolean;
  payout: Payout;
  /** Payouts carry dividends tax (20%), withheld and paid to SARS. */
  dividendsTax: boolean;
  /** The year of assessment always ends on the last day of February. */
  febYearEnd: boolean;
  /** May register for turnover tax (if it meets SARS's other tests). */
  turnoverTax: boolean;
  /** The people the books are about, as the screens name them. */
  owner: { one: string; many: string };
  /** An example name, for the setup questions. */
  example: string;
  /** How money moves between the owners and the business, in one plain sentence. */
  ownerMoney: string;
  /** What the registration number is called on documents, or null when there isn't one. */
  regLabel: string | null;
  accounts: EntityAccounts;
}

// The names Shap has always used: a company's and a sole proprietor's books keep them.
const STANDARD: EntityAccounts = {
  share_capital: 'Share capital',
  retained_earnings: 'Retained earnings',
  owner_loan: { name: 'Owner’s loan account', type: 'liability' },
  dividends: 'Dividends declared',
  dividends_payable: 'Dividends owed to shareholders',
  // Spelt as the chart of accounts has always had it (a straight apostrophe).
  director_salary: "Director's remuneration",
};

export const ENTITIES: Record<BusinessType, EntityRules> = {
  sole_prop: {
    key: 'sole_prop',
    label: 'Sole proprietor (in your own name)',
    the: 'the business',
    description: 'You, trading in your own name. The profit is your own income, taxed on SARS’s tables for individuals.',
    taxedAs: 'individual',
    sbcPossible: false,
    payout: 'drawings',
    dividendsTax: false,
    febYearEnd: true,
    turnoverTax: true,
    owner: { one: 'owner', many: 'owners' },
    example: 'e.g. Thandi’s Hair Studio, or your own name',
    ownerMoney: 'Money you put in or take out goes to your owner’s account (capital and drawings): what you take out isn’t a cost.',
    regLabel: null,
    accounts: { ...STANDARD, owner_loan: { name: 'Owner’s capital and drawings', type: 'equity' } },
  },
  partnership: {
    key: 'partnership',
    label: 'Partnership',
    the: 'the partnership',
    description: 'Two or more people in business together. The partnership pays no income tax: each partner is taxed on their share of the profit.',
    taxedAs: 'partners',
    sbcPossible: false,
    payout: 'drawings',
    dividendsTax: false,
    febYearEnd: true,
    turnoverTax: true,
    owner: { one: 'partner', many: 'partners' },
    example: 'e.g. Mokoena & Botha Electrical',
    ownerMoney: 'Each partner has a capital account and a current account. Each year’s profit is shared into their current accounts at the year end, and what a partner takes out is drawings from theirs, not a cost.',
    regLabel: null,
    accounts: { ...STANDARD, retained_earnings: 'Profit not yet shared between partners', owner_loan: { name: 'Loans from partners', type: 'liability' } },
  },
  company: {
    key: 'company',
    label: 'Private company ((Pty) Ltd)',
    the: 'the company',
    description: 'A registered company owned by shareholders. It pays company tax (27%, or the small business corporation table) and pays its owners dividends.',
    taxedAs: 'company',
    sbcPossible: true,
    payout: 'dividends',
    dividendsTax: true,
    febYearEnd: false,
    turnoverTax: true,
    owner: { one: 'shareholder', many: 'shareholders' },
    example: 'e.g. Sparky Electrical (Pty) Ltd',
    ownerMoney: 'Money between you and the company goes on your loan account. The company can pay you a salary, and dividends out of its profit.',
    regLabel: 'Registration number',
    accounts: STANDARD,
  },
  inc: {
    key: 'inc',
    label: 'Personal liability company (Inc.)',
    the: 'the company',
    description: 'A company for professionals (attorneys, engineers, accountants) whose directors share liability for its debts. Taxed like any company.',
    taxedAs: 'company',
    sbcPossible: true,
    payout: 'dividends',
    dividendsTax: true,
    febYearEnd: false,
    // Professional services above 20% of receipts rule turnover tax out for nearly every Inc.
    turnoverTax: false,
    owner: { one: 'shareholder', many: 'shareholders' },
    example: 'e.g. Mokoena Attorneys Inc.',
    ownerMoney: 'Money between directors and the company goes on their loan accounts. The company can pay directors a salary, and dividends out of its profit.',
    regLabel: 'Registration number',
    accounts: { ...STANDARD, director_salary: 'Directors’ remuneration' },
  },
  cc: {
    key: 'cc',
    label: 'Close corporation (CC)',
    the: 'the CC',
    description: 'An existing close corporation (no new ones have been registered since 2011). Taxed like a company; what it pays its members carries dividends tax.',
    taxedAs: 'company',
    sbcPossible: true,
    payout: 'member_distributions',
    dividendsTax: true,
    febYearEnd: false,
    turnoverTax: true,
    owner: { one: 'member', many: 'members' },
    example: 'e.g. Sparky Electrical CC',
    ownerMoney: 'Money between members and the CC goes on their loan accounts. The CC can pay members a salary, and distributions out of its profit (with dividends tax).',
    regLabel: 'CK number',
    accounts: {
      share_capital: 'Members’ contributions',
      retained_earnings: 'Retained income',
      owner_loan: { name: 'Members’ loan accounts', type: 'liability' },
      dividends: 'Distributions to members',
      dividends_payable: 'Distributions owed to members',
      director_salary: 'Members’ remuneration',
    },
  },
  trust: {
    key: 'trust',
    label: 'Business (trading) trust',
    the: 'the trust',
    description: 'A trust that trades, run by its trustees for its beneficiaries. Income kept in the trust is taxed at 45%; this year’s income given to beneficiaries who live in South Africa is taxed in their hands instead.',
    taxedAs: 'trust',
    sbcPossible: false,
    payout: 'beneficiary_distributions',
    dividendsTax: false,
    febYearEnd: true,
    turnoverTax: false,
    owner: { one: 'beneficiary', many: 'beneficiaries' },
    example: 'e.g. Sparky Trading Trust',
    ownerMoney: 'The trust gives income to beneficiaries as distributions (no dividends tax: a beneficiary living in South Africa is taxed on this year’s income they’re given; for one abroad, the trust pays). Money lent to the trust goes on loan accounts, and trustees can be paid fees.',
    regLabel: 'Master’s reference (IT number)',
    accounts: {
      share_capital: 'Trust capital',
      retained_earnings: 'Accumulated profit',
      owner_loan: { name: 'Loans from beneficiaries', type: 'liability' },
      dividends: 'Distributions to beneficiaries',
      dividends_payable: 'Owed to beneficiaries',
      director_salary: 'Trustees’ fees',
    },
  },
  npc: {
    key: 'npc',
    label: 'Non-profit company (NPC)',
    the: 'the NPC',
    description: 'A company for a public benefit or community purpose, with no owners to pay. Tax-free on most income once SARS approves it as a public benefit organisation (PBO); otherwise taxed like a company.',
    taxedAs: 'npc',
    sbcPossible: false,
    payout: 'none',
    dividendsTax: false,
    febYearEnd: false,
    turnoverTax: false,
    owner: { one: 'member', many: 'members' },
    example: 'e.g. Ubuntu Builders NPC',
    ownerMoney: 'A non-profit company can’t pay out its profits: everything goes back into its purpose. Directors can be paid for work they do.',
    regLabel: 'Registration number',
    accounts: {
      ...STANDARD,
      share_capital: 'Funds contributed',
      retained_earnings: 'Accumulated funds',
      owner_loan: { name: 'Loans from directors', type: 'liability' },
      director_salary: 'Directors’ remuneration',
    },
  },
  coop: {
    key: 'coop',
    label: 'Co-operative',
    the: 'the co-operative',
    description: 'A business owned and run by its members for their benefit. Taxed like a company; what it pays its members out of profit is a dividend. Bonuses paid in proportion to the business each member did with the co-op (patronage) are taxed differently: ask your accountant.',
    taxedAs: 'company',
    sbcPossible: true,
    payout: 'dividends',
    dividendsTax: true,
    febYearEnd: false,
    turnoverTax: true,
    owner: { one: 'member', many: 'members' },
    example: 'e.g. Sparky Builders Co-operative Ltd',
    ownerMoney: 'Money between members and the co-op goes on their loan accounts. Profit paid to members is a dividend.',
    regLabel: 'Registration number',
    accounts: {
      share_capital: 'Members’ shares',
      retained_earnings: 'Reserves',
      owner_loan: { name: 'Members’ loan accounts', type: 'liability' },
      dividends: 'Payments to members',
      dividends_payable: 'Owed to members',
      director_salary: 'Directors’ remuneration',
    },
  },
};

export const entity = (t: string): EntityRules => ENTITIES[(BUSINESS_TYPES as readonly string[]).includes(t) ? (t as BusinessType) : 'company'];

/** The balance sheet's heading for the owners' part: "Equity", "Members' interest". */
export const equityHeading = (t: string) => ({ partnership: 'Partners’ funds', cc: 'Members’ interest', trust: 'Trust capital and reserves', npc: 'Funds', coop: 'Members’ funds' } as Record<string, string>)[t] ?? 'Equity';

/** The registration number as it's printed: "Reg. no. 2019/123456/07", "CK 1998/012345/23", "IT 1234/2015". */
export const regPrefix = (t: string) => ({ cc: 'CK', trust: 'Master’s ref.' } as Record<string, string>)[t] ?? 'Reg. no.';

/** Pays owners out of profit (a dividend or a distribution) rather than drawings. */
export const paysOutProfit = (t: string) => ['dividends', 'member_distributions', 'beneficiary_distributions'].includes(entity(t).payout);

/** A payout's name: "dividend", "distribution". */
export const payoutWord = (t: string) => (entity(t).payout === 'dividends' ? 'dividend' : 'distribution');

/**
 * The standard names an account has had for any kind of business: renaming it for another kind
 * only replaces one of these, never a name someone chose.
 */
export function standardNames(key: keyof EntityAccounts): Set<string> {
  const names = new Set<string>();
  for (const e of Object.values(ENTITIES)) {
    const a = e.accounts[key];
    names.add(typeof a === 'string' ? a : a.name);
  }
  return names;
}

/* ---------------------------------------------------------------- partners' shares */

export interface PartnerShare {
  id: string;
  name: string;
  /** Share of profit and loss, in basis points (10 000 = 100%). */
  shareBp: number;
}

/**
 * A profit (or loss) split between partners by their shares, in whole cents that add up exactly:
 * any cent left over by rounding goes to the partner with the largest share.
 */
export function splitByShares<T extends PartnerShare>(totalCents: number, partners: T[]): { partner: T; cents: number }[] {
  const sumBp = partners.reduce((s, p) => s + p.shareBp, 0);
  if (!partners.length || sumBp <= 0) return [];
  const parts = partners.map((p) => ({ partner: p, cents: Math.trunc((totalCents * p.shareBp) / sumBp) }));
  const left = totalCents - parts.reduce((s, p) => s + p.cents, 0);
  if (left) {
    const biggest = parts.reduce((a, b) => (b.partner.shareBp > a.partner.shareBp ? b : a));
    biggest.cents += left;
  }
  return parts;
}

/* ---------------------------------------------------------------- trusts */

/** Trusts other than special trusts: one flat rate (45% since the 2018 year of assessment). */
export const TRUST_RATE = 0.45;
export const trustTax = (taxableCents: number) => Math.round(Math.max(0, taxableCents) * TRUST_RATE);
