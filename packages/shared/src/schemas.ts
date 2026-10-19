import { z } from 'zod';
import {
  ACCOUNT_TYPES,
  ASSET_CATEGORIES,
  CATEGORY_KINDS,
  LINE_CATEGORIES,
  PAYMENT_METHODS,
  PROJECT_STATUSES,
  QUOTE_STATUSES,
  ROLES,
  SOURCE_KINDS,
  WORKER_KINDS,
} from './enums.js';

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-03-31')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Not a real date');
export const uuid = z.string().uuid();
const cents = z.number().int().min(-1_000_000_000_00).max(1_000_000_000_00);
const positiveCents = z.number().int().min(0).max(1_000_000_000_00);
const text = (max = 200) => z.string().trim().max(max);
const optionalUuid = uuid.nullable().optional();

export const loginInput = z.object({
  email: z.string().trim().toLowerCase().email('Enter your email address'),
  password: z.string().min(1, 'Enter your password').max(200),
});

export const userInput = z.object({
  name: text(100).min(1, 'Name is needed'),
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  role: z.enum(ROLES),
  password: z.string().min(10, 'At least 10 characters').max(200).optional(),
  active: z.boolean().optional(),
});

export const settingsInput = z.object({
  companyName: text(120).min(1, 'Company name is needed'),
  tradingName: text(120).default(''),
  regNumber: text(60).default(''),
  vatNumber: text(30).default(''),
  address: text(400).default(''),
  phone: text(40).default(''),
  email: z.string().trim().max(120).default(''),
  website: text(120).default(''),
  bankDetails: text(600).default(''),
  vatRegistered: z.boolean().default(false),
  vatRateBp: z.number().int().min(0).max(5000).default(1500),
  fyEndMonth: z.number().int().min(1).max(12).default(2),
  invoicePrefix: text(12).default(''),
  invoiceNext: z.number().int().min(1).max(10_000_000),
  invoicePad: z.number().int().min(0).max(8).default(0),
  quotePrefix: text(12).default('Q'),
  quoteNext: z.number().int().min(1).max(10_000_000),
  quotePad: z.number().int().min(0).max(8).default(4),
  paymentDays: z.number().int().min(0).max(365).default(7),
  quoteValidDays: z.number().int().min(0).max(365).default(30),
  invoiceTerms: text(2000).default(''),
  quoteTerms: text(2000).default(''),
  defaultReceiptSourceId: optionalUuid,
  defaultWageSourceId: optionalUuid,
  defaultCostSourceId: optionalUuid,
  defaultBrandId: optionalUuid,
  lockDate: isoDate.nullable().optional(),
  markupBp: z.number().int().min(0).max(100000).default(0),
});
export type SettingsInput = z.infer<typeof settingsInput>;

export const clientInput = z.object({
  code: text(30).default(''),
  name: text(150).min(1, 'Name is needed'),
  contactPerson: text(120).default(''),
  email: z.string().trim().max(150).default(''),
  phone: text(40).default(''),
  address: text(400).default(''),
  vatNumber: text(30).default(''),
  notes: text(2000).default(''),
  active: z.boolean().default(true),
  brandId: optionalUuid,
});

export const projectInput = z.object({
  name: text(150).min(1, 'Give the job a name'),
  clientId: optionalUuid,
  status: z.enum(PROJECT_STATUSES).default('active'),
  siteAddress: text(300).default(''),
  startDate: isoDate.nullable().optional(),
  endDate: isoDate.nullable().optional(),
  estLabourCents: positiveCents.default(0),
  estMaterialsCents: positiveCents.default(0),
  estDemoCents: positiveCents.default(0),
  notes: text(4000).default(''),
  brandId: optionalUuid,
});

export const workerInput = z.object({
  name: text(100).min(1, 'Name is needed'),
  kind: z.enum(WORKER_KINDS).default('permanent'),
  dayRateCents: positiveCents.default(0),
  allowanceCents: positiveCents.default(0),
  phone: text(40).default(''),
  notes: text(2000).default(''),
  active: z.boolean().default(true),
});

/** One or more workers on the same day. Either a project or a general work type (or neither: to allocate later). */
export const labourBatchInput = z.object({
  date: isoDate,
  projectId: optionalUuid,
  workTypeId: optionalUuid,
  note: text(300).default(''),
  entries: z
    .array(
      z.object({
        workerId: uuid,
        days: z.number().min(0).max(31).default(1),
        wageCents: positiveCents,
        allowanceCents: positiveCents.default(0),
      }),
    )
    .min(1, 'Pick at least one worker'),
});

export const labourEntryInput = z.object({
  date: isoDate,
  workerId: uuid,
  projectId: optionalUuid,
  workTypeId: optionalUuid,
  days: z.number().min(0).max(31),
  wageCents: positiveCents,
  allowanceCents: positiveCents.default(0),
  note: text(300).default(''),
});

export const allocateInput = z.object({
  ids: z.array(uuid).min(1).max(2000),
  projectId: optionalUuid,
  workTypeId: optionalUuid,
});

export const wagePaymentInput = z.object({
  date: isoDate,
  workerId: uuid,
  amountCents: cents.refine((v) => v !== 0, 'Enter an amount'),
  sourceId: uuid,
  note: text(300).default(''),
});

export const savingsInput = z.object({
  date: isoDate,
  workerId: uuid,
  amountCents: cents.refine((v) => v !== 0, 'Enter an amount'),
  note: text(300).default(''),
});

export const costInput = z.object({
  date: isoDate,
  description: text(200).min(1, 'What was it?'),
  amountCents: cents.refine((v) => v !== 0, 'Enter the amount'),
  vatCents: cents.default(0),
  supplier: text(120).default(''),
  categoryId: uuid,
  /** null = not captured yet: you'll say later which account or card paid it. */
  sourceId: uuid.nullable(),
  projectId: optionalUuid,
  note: text(1000).default(''),
  receiptId: optionalUuid,
  plannedItemId: optionalUuid,
});

export const attachmentInput = z.object({
  filename: text(200).min(1),
  mime: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  dataBase64: z.string().min(10).max(8_000_000),
});

export const plannedItemInput = z.object({
  description: text(200).min(1, 'Describe the item'),
  qty: z.number().min(0).max(1_000_000).default(1),
  unit: text(20).default(''),
  unitCostCents: positiveCents.default(0),
  supplier: text(120).default(''),
  category: z.enum(['materials', 'demo']).default('materials'),
  note: text(300).default(''),
});

export const documentLineInput = z.object({
  category: z.enum(LINE_CATEGORIES).default('labour'),
  description: text(1000).min(1, 'Describe the line'),
  qty: z.number().min(-1_000_000).max(1_000_000).default(1),
  unit: text(20).default(''),
  unitPriceCents: cents,
});

export const documentInput = z.object({
  brandId: optionalUuid,
  projectId: optionalUuid,
  clientId: optionalUuid,
  issueDate: isoDate,
  dueDate: isoDate.nullable().optional(),
  title: text(200).default(''),
  notes: text(4000).default(''),
  terms: text(4000).default(''),
  lines: z.array(documentLineInput).max(300).default([]),
  number: text(30).optional(),
  /** Deposit asked for up front: a percentage (basis points) or a fixed amount, not both. */
  depositBp: z.number().int().min(1).max(10000).nullable().default(null),
  depositCents: z.number().int().min(1).max(1_000_000_000_00).nullable().default(null),
  depositShowBalance: z.boolean().default(true),
}).refine((d) => !(d.depositBp && d.depositCents), { message: 'Give the deposit as a percentage or an amount, not both', path: ['depositCents'] });

/** Delinquent: write off what's left on an invoice (the client won't pay the rest). */
export const writeOffInput = z.object({
  date: isoDate,
  reason: text(300).default(''),
});

export const quoteStatusInput = z.object({ status: z.enum(QUOTE_STATUSES) });

export const receiptInput = z.object({
  date: isoDate,
  amountCents: cents.refine((v) => v !== 0, 'Enter the amount'),
  sourceId: uuid,
  method: z.enum(PAYMENT_METHODS).default('eft'),
  reference: text(120).default(''),
  note: text(300).default(''),
});

export const accountInput = z.object({
  code: text(10).min(1, 'Give it a code, e.g. 6200'),
  name: text(120).min(1, 'Name is needed'),
  type: z.enum(ACCOUNT_TYPES),
  active: z.boolean().default(true),
});

export const sourceInput = z.object({
  name: text(80).min(1, 'Name is needed'),
  kind: z.enum(SOURCE_KINDS),
  accountId: uuid,
  active: z.boolean().default(true),
  /** Keep this account's monthly bank statement (PDF) on file, from this month on. */
  statementsRequired: z.boolean().default(false),
  statementsFrom: isoDate.nullable().default(null),
});

export const statementFileInput = z.object({
  sourceId: uuid,
  month: z.string().regex(/^\d{4}-\d{2}$/, 'Choose the month'),
  filename: text(200).min(1),
  mime: z.literal('application/pdf', { message: 'Upload the statement as a PDF' }),
  dataBase64: z.string().min(10).max(8_000_000),
});

export const categoryInput = z.object({
  name: text(80).min(1, 'Name is needed'),
  kind: z.enum(CATEGORY_KINDS),
  accountId: uuid,
  active: z.boolean().default(true),
});

export const workTypeInput = z.object({
  name: text(80).min(1, 'Name is needed'),
  active: z.boolean().default(true),
});

export const journalInput = z.object({
  date: isoDate,
  description: text(300).min(1, 'Say what this journal is for'),
  reference: text(60).default(''),
  lines: z
    .array(
      z.object({
        accountId: uuid,
        debitCents: positiveCents.default(0),
        creditCents: positiveCents.default(0),
        memo: text(200).default(''),
      }),
    )
    .min(2, 'A journal needs at least two lines'),
});

export const assetInput = z.object({
  name: text(150).min(1, 'Name is needed'),
  category: z.enum(ASSET_CATEGORIES).default('tools'),
  purchaseDate: isoDate,
  costCents: positiveCents.refine((v) => v > 0, 'Enter the cost'),
  sourceId: optionalUuid,
  costId: optionalUuid,
  lifeMonths: z.number().int().min(1).max(600).default(36),
  residualCents: positiveCents.default(0),
  disposedOn: isoDate.nullable().optional(),
  disposalProceedsCents: positiveCents.default(0),
  disposalSourceId: optionalUuid,
  notes: text(1000).default(''),
});

export const balanceCheckInput = z.object({
  accountId: uuid,
  date: isoDate,
  statementBalanceCents: cents,
  note: text(300).default(''),
});

export const brandInput = z.object({
  name: text(80).min(1, 'Give the trading name'),
  legalLine: text(200).default(''),
  email: z.string().trim().max(150).default(''),
  phone: text(40).default(''),
  website: text(120).default(''),
  address: text(400).default(''),
  bankDetails: text(600).default(''),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #e8731c').default('#e8731c'),
  active: z.boolean().default(true),
});

export const assignSourceInput = z.object({
  ids: z.array(uuid).min(1).max(5000),
  sourceId: uuid,
});

/** Accountant's figures for a closed year: natural signs (income, liabilities and equity positive). */
export const yearEndInput = z.object({
  fyEnd: isoDate,
  note: text(500).default(''),
  lock: z.boolean().default(true),
  figures: z.array(z.object({ accountId: uuid, amountCents: cents })).max(500),
});

export const taxEstimateInput = z.object({
  fyEnd: isoDate,
  period: z.number().int().min(1).max(3),
  asAt: isoDate,
  note: text(1000).default(''),
  lines: z
    .array(
      z.object({
        accountId: uuid.nullable(),
        name: text(120),
        type: z.enum(['income', 'cost_of_sales', 'expense']),
        actualCents: cents,
        projectedCents: cents,
      }),
    )
    .max(300),
  assessedLossCents: positiveCents.default(0),
  paidCents: positiveCents.default(0),
  sbc: z.boolean().default(true),
});
