/**
 * What the annual financial statements say besides the figures (statements are built in the
 * server's statements/build.ts): who governs the business, who compiles the statements, and the
 * wording of the policies and notes, each with Shap's default until someone changes it.
 */
import { z } from 'zod';

export const ASSURANCE = ['compiled', 'independent_review', 'audit', 'none'] as const;
export type Assurance = (typeof ASSURANCE)[number];
export const ASSURANCE_LABELS: Record<Assurance, string> = {
  compiled: 'Compiled by an accountant (not audited or reviewed)',
  independent_review: 'Independently reviewed',
  audit: 'Audited',
  none: 'Prepared by the business itself',
};

export const POLICY_KEYS = ['basis', 'going_concern', 'revenue', 'ppe', 'intangibles', 'inventories', 'financial_instruments', 'tax', 'leases', 'employee_benefits', 'judgements'] as const;
export type PolicyKey = (typeof POLICY_KEYS)[number];
export const POLICY_LABELS: Record<PolicyKey, string> = {
  basis: 'Basis of preparation',
  going_concern: 'Going concern',
  revenue: 'Revenue',
  ppe: 'Property, plant and equipment',
  intangibles: 'Intangible assets',
  inventories: 'Inventories',
  financial_instruments: 'Financial instruments',
  tax: 'Income tax',
  leases: 'Leases',
  employee_benefits: 'Employee benefits',
  judgements: 'Estimates and judgements',
};

const t = (max: number) => z.string().trim().max(max);

export const compilerInput = z.object({
  name: t(120).default(''),
  qualification: t(120).default(''),
  body: t(120).default(''),
  number: t(40).default(''),
  practice: t(160).default(''),
  address: t(400).default(''),
  email: t(200).default(''),
});
export type Compiler = z.infer<typeof compilerInput>;

export const statementDetailsInput = z.object({
  assurance: z.enum(ASSURANCE).default('compiled'),
  /** Every shareholder is also a director: exempt from audit and independent review (Companies Act s30(2A)). */
  ownerManaged: z.boolean().default(true),
  natureOfBusiness: t(1000).default(''),
  directors: z.array(z.object({ name: t(120), role: t(60).default('') })).max(20).default([]),
  secretary: t(160).default(''),
  registeredAddress: t(400).default(''),
  postalAddress: t(400).default(''),
  bankers: t(160).default(''),
  holdingCompany: t(160).default(''),
  shareCapital: t(1000).default(''),
  loanTerms: t(1000).default(''),
  taxNote: t(1000).default(''),
  eventsAfter: t(2000).default(''),
  goingConcern: t(2000).default(''),
  preparedBy: t(200).default(''),
  // prefault: an empty compiler is parsed, so each of its fields takes its own default.
  compiler: compilerInput.prefault({}),
  accountantEmail: z.union([z.literal(''), z.string().trim().email('That email address doesn’t look right').max(200)]).default(''),
  /** For the public interest score: how many individuals hold shares (a CC's members); blank: one per director (member). */
  piHolders: z.number().int().min(0).max(1_000_000).nullable().default(null),
  /** The average number of employees in the year, if not what Shap works out from payroll and the days logged. */
  piEmployees: z.number().min(0).max(1_000_000).nullable().default(null),
  /** Somebody in the business compiles the statements (not an independent accountant): it matters to the score's meaning. */
  internallyCompiled: z.boolean().default(false),
  // Only the policies changed from Shap's wording (a record over an enum wants every key).
  policies: z.partialRecord(z.enum(POLICY_KEYS), t(4000)).default({}),
});
export type StatementDetailsInput = z.infer<typeof statementDetailsInput>;

/** Signing the compiler's report in Shap (the accountant, signed in as themselves). */
export const compileInput = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), compiler: compilerInput.refine((c) => c.name.trim() && c.qualification.trim(), 'Your name and professional designation go on the report') });
/** The signed compiler's report (or the whole signed set) from the accountant, uploaded. */
export const compilerReportInput = z.object({ attachmentId: z.string().uuid(), compilerName: t(120).min(2, 'Who signed it?'), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
/** The directors (members, trustees…) approve the statements and sign: the year is then finished. */
export const approveStatementsInput = z.object({ name: t(120).min(2, 'Your name, as it’s signed'), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
export const sendStatementsInput = z.object({ to: z.string().trim().email('That email address doesn’t look right').max(200), message: t(4000).default('') });
export const reopenStatementsInput = z.object({ reason: t(300).min(2, 'Say why they’re reopened') });

export const STATEMENT_STATUS_LABELS = {
  draft: 'Draft',
  sent: 'Sent to the accountant',
  compiled: 'Compiled: waiting for approval',
  approved: 'Approved and signed: the year is finished',
} as const;
export type StatementStatus = keyof typeof STATEMENT_STATUS_LABELS;
