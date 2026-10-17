export const ROLES = ['owner', 'capture', 'accountant'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  capture: 'Site capture',
  accountant: 'Accountant (read only)',
};
export const ROLE_HINTS: Record<Role, string> = {
  owner: 'Everything, including settings and users.',
  capture: 'Logs labour and costs, sees projects. No money reports.',
  accountant: 'Sees and exports everything, changes nothing.',
};

export const PROJECT_STATUSES = ['lead', 'quoted', 'active', 'invoiced', 'done', 'cancelled'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  lead: 'Lead',
  quoted: 'Quoted',
  active: 'In progress',
  invoiced: 'Invoiced',
  done: 'Paid & done',
  cancelled: 'Cancelled',
};

/** The three ways a job's money is split, as in the tracker, plus anything else. */
export const LINE_CATEGORIES = ['labour', 'materials', 'demo', 'other'] as const;
export type LineCategory = (typeof LINE_CATEGORIES)[number];
export const LINE_CATEGORY_LABELS: Record<LineCategory, string> = {
  labour: 'Labour',
  materials: 'Materials',
  demo: 'Demo',
  other: 'Other',
};

export const DOC_KINDS = ['quote', 'invoice'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined'] as const;
export const INVOICE_STATUSES = ['draft', 'issued', 'void'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export type DocStatus = QuoteStatus | InvoiceStatus;
export const DOC_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  sent: 'Sent',
  accepted: 'Accepted',
  declined: 'Declined',
  issued: 'Issued',
  void: 'Void',
  unpaid: 'Unpaid',
  part_paid: 'Part paid',
  paid: 'Paid',
  overdue: 'Overdue',
};

export const WORKER_KINDS = ['permanent', 'casual', 'subcontractor'] as const;
export type WorkerKind = (typeof WORKER_KINDS)[number];
export const WORKER_KIND_LABELS: Record<WorkerKind, string> = {
  permanent: 'Regular',
  casual: 'Casual',
  subcontractor: 'Subcontractor',
};

/** How a cost category behaves in the books. */
export const CATEGORY_KINDS = ['materials', 'demo', 'overhead', 'asset', 'personal'] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];
export const CATEGORY_KIND_LABELS: Record<CategoryKind, string> = {
  materials: 'Job materials (cost of sales)',
  demo: 'Job demo / removal (cost of sales)',
  overhead: 'Running cost (expense)',
  asset: 'Asset (balance sheet)',
  personal: 'Personal (against owner’s loan)',
};

export const SOURCE_KINDS = ['bank', 'card', 'cash', 'owner', 'other'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  bank: 'Business bank account',
  card: 'Card',
  cash: 'Cash',
  owner: 'Owner paid personally',
  other: 'Other',
};

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'cost_of_sales', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  asset: 'Asset',
  liability: 'Liability',
  equity: 'Equity',
  income: 'Income',
  cost_of_sales: 'Cost of sales',
  expense: 'Expense',
};
export const PROFIT_AND_LOSS_TYPES: AccountType[] = ['income', 'cost_of_sales', 'expense'];

export const ASSET_CATEGORIES = ['tools', 'vehicles', 'equipment', 'computers', 'other'] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];
export const ASSET_CATEGORY_LABELS: Record<AssetCategory, string> = {
  tools: 'Tools',
  vehicles: 'Vehicles',
  equipment: 'Plant & equipment',
  computers: 'Computers & phones',
  other: 'Other',
};

export const PAYMENT_METHODS = ['eft', 'cash', 'card', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  eft: 'EFT',
  cash: 'Cash',
  card: 'Card',
  other: 'Other',
};

export const LEDGER_SOURCE_LABELS: Record<string, string> = {
  invoice: 'Invoice',
  receipt: 'Payment received',
  cost: 'Cost',
  labour: 'Labour',
  wage_payment: 'Wage payment',
  journal: 'Journal',
  asset: 'Asset',
  depreciation: 'Depreciation',
  disposal: 'Asset disposal',
  year_end: 'Year-end adjustment',
};
