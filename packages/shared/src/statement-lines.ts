/**
 * Where each account shows on the financial statements (IFRS for SMEs, sections 4 and 5): its
 * line, and so whether it's current or non-current, and how its movement shows in the statement
 * of cash flows (section 7, the indirect method). Every account carries one, set by Shap for the
 * accounts it keeps and chosen when an account is added, so the statements build themselves.
 *
 * An account whose balance is the other way round from its line's at the reporting date shows on
 * the matching line on the other side instead (a bank account in overdraft is a current
 * liability; VAT refundable is a receivable; a loan to a shareholder is an asset).
 *
 * IFRS for SMEs Accounting Standard: https://www.ifrs.org/issued-standards/ifrs-for-smes/
 */
import type { AccountType } from './enums.js';
import type { BusinessType } from './entities.js';

export type StatementSection =
  | 'non_current_assets'
  | 'current_assets'
  | 'equity'
  | 'non_current_liabilities'
  | 'current_liabilities'
  | 'revenue'
  | 'cost_of_sales'
  | 'other_income'
  | 'operating_expenses'
  | 'finance_income'
  | 'finance_costs'
  | 'income_tax';

/** How a line's movement shows in the statement of cash flows. */
export type CashFlowClass =
  | 'cash'
  | 'working_capital'
  | 'tax'
  | 'ppe'
  | 'intangibles'
  | 'investing_other'
  | 'owner_loans'
  | 'borrowings'
  | 'capital'
  | 'distributions'
  | 'retained'
  | 'profit';

export interface StatementLineRule {
  label: string;
  section: StatementSection;
  /** The account types that may go on it. */
  types: readonly AccountType[];
  cash: CashFlowClass;
  /** Where an account goes at the reporting date when its balance is the other way round (a line key). */
  flip?: string;
}

export const STATEMENT_LINES = {
  // Statement of financial position: non-current assets
  ppe: { label: 'Property, plant and equipment', section: 'non_current_assets', types: ['asset'], cash: 'ppe' },
  intangibles: { label: 'Intangible assets', section: 'non_current_assets', types: ['asset'], cash: 'intangibles' },
  investments: { label: 'Investments', section: 'non_current_assets', types: ['asset'], cash: 'investing_other' },
  loans_receivable: { label: 'Loans receivable', section: 'non_current_assets', types: ['asset'], cash: 'investing_other' },
  deferred_tax_asset: { label: 'Deferred tax', section: 'non_current_assets', types: ['asset'], cash: 'tax', flip: 'deferred_tax_liability' },
  // current assets
  inventories: { label: 'Inventories', section: 'current_assets', types: ['asset'], cash: 'working_capital' },
  trade_receivables: { label: 'Trade and other receivables', section: 'current_assets', types: ['asset'], cash: 'working_capital', flip: 'trade_payables' },
  current_tax_asset: { label: 'Current tax receivable', section: 'current_assets', types: ['asset'], cash: 'tax', flip: 'current_tax_liability' },
  other_current_assets: { label: 'Other current assets', section: 'current_assets', types: ['asset'], cash: 'working_capital', flip: 'other_current_liabilities' },
  cash: { label: 'Cash and cash equivalents', section: 'current_assets', types: ['asset'], cash: 'cash', flip: 'bank_overdraft' },
  // equity
  share_capital: { label: 'Share capital', section: 'equity', types: ['equity'], cash: 'capital' },
  owners_contributions: { label: 'Owners’ capital', section: 'equity', types: ['equity'], cash: 'owner_loans' },
  reserves: { label: 'Other reserves', section: 'equity', types: ['equity'], cash: 'capital' },
  retained_earnings: { label: 'Retained earnings', section: 'equity', types: ['equity'], cash: 'retained' },
  // Declared out of retained earnings: on the statement of changes in equity, not a line of its own.
  distributions: { label: 'Dividends', section: 'equity', types: ['equity'], cash: 'distributions' },
  // non-current liabilities
  shareholder_loans: { label: 'Loans from shareholders', section: 'non_current_liabilities', types: ['liability'], cash: 'owner_loans', flip: 'loans_to_shareholders' },
  borrowings_non_current: { label: 'Loans and borrowings', section: 'non_current_liabilities', types: ['liability'], cash: 'borrowings' },
  deferred_tax_liability: { label: 'Deferred tax', section: 'non_current_liabilities', types: ['liability'], cash: 'tax', flip: 'deferred_tax_asset' },
  provisions_non_current: { label: 'Provisions', section: 'non_current_liabilities', types: ['liability'], cash: 'working_capital' },
  // current liabilities
  trade_payables: { label: 'Trade and other payables', section: 'current_liabilities', types: ['liability'], cash: 'working_capital', flip: 'trade_receivables' },
  shareholder_loans_current: { label: 'Loans from shareholders', section: 'current_liabilities', types: ['liability'], cash: 'owner_loans', flip: 'loans_to_shareholders' },
  borrowings_current: { label: 'Current portion of loans and borrowings', section: 'current_liabilities', types: ['liability'], cash: 'borrowings' },
  current_tax_liability: { label: 'Current tax payable', section: 'current_liabilities', types: ['liability'], cash: 'tax', flip: 'current_tax_asset' },
  dividends_payable: { label: 'Dividends payable', section: 'current_liabilities', types: ['liability'], cash: 'distributions' },
  provisions_current: { label: 'Provisions', section: 'current_liabilities', types: ['liability'], cash: 'working_capital' },
  bank_overdraft: { label: 'Bank overdraft', section: 'current_liabilities', types: ['liability'], cash: 'cash', flip: 'cash' },
  other_current_liabilities: { label: 'Other current liabilities', section: 'current_liabilities', types: ['liability'], cash: 'working_capital', flip: 'other_current_assets' },
  // Only where another line's account lands when it's the other way round.
  loans_to_shareholders: { label: 'Loans to shareholders', section: 'current_assets', types: [], cash: 'owner_loans', flip: 'shareholder_loans_current' },
  // Statement of comprehensive income (expenses by function: cost of sales apart, 5.11(b))
  revenue: { label: 'Revenue', section: 'revenue', types: ['income'], cash: 'profit' },
  cost_of_sales: { label: 'Cost of sales', section: 'cost_of_sales', types: ['cost_of_sales', 'expense'], cash: 'profit' },
  other_income: { label: 'Other income', section: 'other_income', types: ['income'], cash: 'profit' },
  operating_expenses: { label: 'Operating expenses', section: 'operating_expenses', types: ['expense', 'cost_of_sales'], cash: 'profit' },
  finance_income: { label: 'Investment income', section: 'finance_income', types: ['income'], cash: 'profit' },
  finance_costs: { label: 'Finance costs', section: 'finance_costs', types: ['expense'], cash: 'profit' },
  income_tax: { label: 'Income tax expense', section: 'income_tax', types: ['expense'], cash: 'profit' },
} as const satisfies Record<string, StatementLineRule>;

export type StatementLineKey = keyof typeof STATEMENT_LINES;
export const STATEMENT_LINE_KEYS = Object.keys(STATEMENT_LINES) as StatementLineKey[];

/** The lines an account of this type may be put on, for the picker (lines only ever flipped onto aren't offered). */
export const linesForType = (type: AccountType): StatementLineKey[] => STATEMENT_LINE_KEYS.filter((k) => (STATEMENT_LINES[k].types as readonly string[]).includes(type));

/** Where an account on this line goes when its balance is the other way round. */
export const flipOf = (key: StatementLineKey): StatementLineKey | null => ((STATEMENT_LINES[key] as StatementLineRule).flip as StatementLineKey | undefined) ?? null;

export const lineFits = (line: string, type: AccountType): line is StatementLineKey =>
  line in STATEMENT_LINES && (STATEMENT_LINES[line as StatementLineKey].types as readonly string[]).includes(type);

/** Where a new account of this type goes, until someone says otherwise. */
export const DEFAULT_LINE: Record<AccountType, StatementLineKey> = {
  asset: 'other_current_assets',
  liability: 'trade_payables',
  equity: 'reserves',
  income: 'revenue',
  cost_of_sales: 'cost_of_sales',
  expense: 'operating_expenses',
};

/** The line for each account Shap keeps itself (by its system key). */
export const SYSTEM_LINES: Record<string, StatementLineKey> = {
  bank: 'cash',
  receivables: 'trade_receivables',
  wip: 'inventories',
  inventory: 'inventories',
  supplier_claims: 'trade_receivables',
  fixed_assets: 'ppe',
  fixed_assets_vehicles: 'ppe',
  accumulated_depreciation: 'ppe',
  intangible_patents: 'intangibles',
  intangible_software: 'intangibles',
  accumulated_amortisation: 'intangibles',
  suspense: 'other_current_assets',
  payables: 'trade_payables',
  uncaptured: 'trade_payables',
  stock_clearing: 'trade_payables',
  stock_opening: 'trade_payables',
  wages_payable: 'trade_payables',
  vat: 'trade_payables',
  credit_clearing: 'trade_payables',
  paye_payable: 'trade_payables',
  uif_payable: 'trade_payables',
  sdl_payable: 'trade_payables',
  dwt_payable: 'trade_payables',
  income_tax_payable: 'current_tax_liability',
  // No fixed terms of repayment, so repayable on demand: current (IFRS for SMEs 4.7(d)). Moved to
  // non-current when the lenders have agreed in writing not to call it within twelve months.
  owner_loan: 'shareholder_loans_current',
  dividends_payable: 'dividends_payable',
  share_capital: 'share_capital',
  retained_earnings: 'retained_earnings',
  dividends: 'distributions',
  revenue_labour: 'revenue',
  revenue_materials: 'revenue',
  revenue_demo: 'revenue',
  revenue_goods: 'revenue',
  // Other lines on invoices and sales (a call-out fee, delivery): still revenue from the business's trade.
  revenue_other: 'revenue',
  interest_income: 'finance_income',
  disposal_gain_loss: 'other_income',
  cos_labour: 'cost_of_sales',
  cos_materials: 'cost_of_sales',
  cos_demo: 'cost_of_sales',
  cos_goods: 'cost_of_sales',
  stock_losses: 'cost_of_sales',
  income_tax: 'income_tax',
};

/** The line an account starts on: Shap's own by key; otherwise by its type (and "Interest" paid is a finance cost). */
export function defaultLineFor(a: { systemKey?: string | null; type: AccountType; name?: string }): StatementLineKey {
  if (a.systemKey === 'owner_loan' && a.type === 'equity') return 'owners_contributions';
  const own = a.systemKey ? SYSTEM_LINES[a.systemKey] : undefined;
  if (own && lineFits(own, a.type)) return own;
  if (a.type === 'expense' && /^interest\b/i.test(a.name ?? '')) return 'finance_costs';
  if (a.type === 'asset' && /\bcash\b|\bpetty\b/i.test(a.name ?? '')) return 'cash';
  return DEFAULT_LINE[a.type];
}

/** A line as this kind of business names it on its statements. */
export function statementLineLabel(key: StatementLineKey, businessType: BusinessType): string {
  const owners: Record<BusinessType, string> = {
    sole_prop: 'the owner',
    partnership: 'partners',
    company: 'shareholders',
    inc: 'shareholders',
    cc: 'members',
    trust: 'beneficiaries',
    npc: 'directors',
    coop: 'members',
  };
  if (key === 'shareholder_loans' || key === 'shareholder_loans_current') return `Loans from ${owners[businessType]}`;
  if (key === 'loans_to_shareholders') return `Loans to ${owners[businessType]}`;
  if (key === 'share_capital') return ({ cc: 'Members’ contributions', trust: 'Trust capital', npc: 'Members’ contributions', coop: 'Members’ shares' } as Partial<Record<BusinessType, string>>)[businessType] ?? 'Share capital';
  if (key === 'owners_contributions') return businessType === 'partnership' ? 'Partners’ capital and current accounts' : 'Owner’s capital and drawings';
  if (key === 'retained_earnings') return businessType === 'partnership' ? 'Profit not yet shared between partners' : businessType === 'npc' ? 'Accumulated surplus' : 'Retained earnings';
  if (key === 'distributions') return ({ cc: 'Distributions to members', trust: 'Distributions to beneficiaries', partnership: 'Drawings', sole_prop: 'Drawings' } as Partial<Record<BusinessType, string>>)[businessType] ?? 'Dividends';
  return STATEMENT_LINES[key].label;
}

/** The section headings, in order, as the statements show them. */
export const SECTION_LABELS: Record<StatementSection, string> = {
  non_current_assets: 'Non-current assets',
  current_assets: 'Current assets',
  equity: 'Equity',
  non_current_liabilities: 'Non-current liabilities',
  current_liabilities: 'Current liabilities',
  revenue: 'Revenue',
  cost_of_sales: 'Cost of sales',
  other_income: 'Other income',
  operating_expenses: 'Operating expenses',
  finance_income: 'Investment income',
  finance_costs: 'Finance costs',
  income_tax: 'Income tax expense',
};
