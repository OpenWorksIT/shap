import type { AccountType, CategoryKind, LineCategory, ProjectStatus, Role, SourceKind, WorkerKind } from '@shap/shared';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export interface Settings {
  companyName: string;
  tradingName: string;
  regNumber: string;
  vatNumber: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  bankDetails: string;
  logoId: string | null;
  vatRegistered: boolean;
  vatRateBp: number;
  fyEndMonth: number;
  invoicePrefix: string;
  invoiceNext: number;
  invoicePad: number;
  quotePrefix: string;
  quoteNext: number;
  quotePad: number;
  paymentDays: number;
  quoteValidDays: number;
  invoiceTerms: string;
  quoteTerms: string;
  markupBp: number;
  defaultReceiptSourceId: string | null;
  defaultWageSourceId: string | null;
  defaultCostSourceId: string | null;
  lockDate: string | null;
}

export interface Source {
  id: string;
  name: string;
  kind: SourceKind;
  accountId: string;
  accountCode: string;
  accountName: string;
  active: boolean;
}
export interface Category {
  id: string;
  name: string;
  kind: CategoryKind;
  accountId: string;
  accountCode: string;
  accountName: string;
  active: boolean;
}
export interface WorkType {
  id: string;
  name: string;
  active: boolean;
}
export interface Account {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  systemKey: string | null;
  active: boolean;
}

export interface Reference {
  settings: Settings;
  sources: Source[];
  categories: Category[];
  workTypes: WorkType[];
  accounts: Account[];
}

export interface ProjectRow {
  id: string;
  number: number;
  name: string;
  status: ProjectStatus;
  clientId: string | null;
  clientName: string | null;
  clientCode?: string | null;
  startDate: string | null;
  endDate: string | null;
  siteAddress: string;
  notes: string;
  estLabourCents: number;
  estMaterialsCents: number;
  estDemoCents: number;
  quotedLabourCents: number;
  quotedMaterialsCents: number;
  quotedDemoCents: number;
  quotedOtherCents: number;
  quotedFromQuote: boolean;
  actualLabourCents: number;
  actualMaterialsCents: number;
  actualDemoCents: number;
  actualOtherCents: number;
  daysWorked: number;
  invoicedLabourCents: number;
  invoicedMaterialsCents: number;
  invoicedDemoCents: number;
  invoicedOtherCents: number;
  invoicedVatCents: number;
  receivedCents: number;
  plannedCents: number;
  plannedBoughtCents: number;
  lastActivity: string | null;
  lastInvoiceDate: string | null;
  quotedCents: number;
  actualCents: number;
  invoicedCents: number;
  grossProfitCents: number;
  margin: number | null;
  outstandingCents: number;
}

export interface WorkerRow {
  id: string;
  name: string;
  kind: WorkerKind;
  dayRateCents: number;
  allowanceCents: number;
  phone: string;
  notes: string;
  active: boolean;
  earnedCents: number;
  paidCents: number;
  balanceCents: number;
  savingsCents: number;
  daysThisMonth: number;
  lastWorked: string | null;
}

export interface LabourEntry {
  id: string;
  date: string;
  workerId: string;
  workerName?: string;
  projectId: string | null;
  projectName?: string | null;
  projectNumber?: number | null;
  workTypeId: string | null;
  workTypeName?: string | null;
  days: number;
  wageCents: number;
  allowanceCents: number;
  note: string;
}

export interface CostRow {
  id: string;
  date: string;
  description: string;
  amountCents: number;
  vatCents: number;
  supplier: string;
  categoryId: string;
  categoryName: string;
  categoryKind: CategoryKind;
  sourceId: string;
  sourceName: string;
  projectId: string | null;
  projectName: string | null;
  projectNumber: number | null;
  receiptId: string | null;
  plannedItemId: string | null;
  assetId: string | null;
  note: string;
}

export interface PlannedItem {
  id: string;
  description: string;
  qty: number;
  unit: string;
  unitCostCents: number;
  supplier: string;
  category: 'materials' | 'demo';
  note: string;
  totalCents: number;
  costId: string | null;
  boughtCents: number;
}

export interface DocRow {
  id: string;
  kind: 'quote' | 'invoice';
  number: string;
  status: string;
  issueDate: string;
  dueDate: string | null;
  title: string;
  subtotalCents: number;
  vatCents?: number;
  totalCents: number;
  paidCents: number;
  paymentState: string | null;
  projectId?: string | null;
  projectName?: string | null;
  projectNumber?: number | null;
  clientId?: string | null;
  clientName?: string | null;
}

export interface DocLine {
  id?: string;
  category: LineCategory;
  description: string;
  qty: number;
  unit: string;
  unitPriceCents: number;
  lineTotalCents?: number;
}

export interface DocDetail {
  doc: DocRow & {
    notes: string;
    terms: string;
    vatRateBp: number;
    voidReason: string;
    sourceQuoteNumber: string | null;
    clientEmail: string | null;
    clientAddress: string | null;
    clientCode: string | null;
  };
  lines: DocLine[];
  receipts: { id: string; date: string; amountCents: number; sourceName: string; method: string; reference: string; note: string }[];
}

export interface ClientRow {
  id: string;
  code: string | null;
  name: string;
  contactPerson: string;
  email: string;
  phone: string;
  address: string;
  vatNumber: string;
  notes: string;
  active: boolean;
  invoicedCents: number;
  outstandingCents: number;
  labourCostCents: number;
  otherCostCents: number;
  grossProfitCents: number;
  projectCount: number;
  lastInvoice: string | null;
}

export interface Totals {
  totalCents: number;
  months: number[];
}
export interface StatementLine extends Totals {
  id: string;
  code: string;
  name: string;
  type: AccountType;
}
