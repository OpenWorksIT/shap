/**
 * The first-run questions: what kind of business, so the app starts the right size. Each kind
 * suggests which parts to switch on; the later questions (employees? quotes and jobs?) refine it,
 * and everything can be changed in Settings.
 */
import type { Feature } from './features.js';

export type Workflow = 'quote_job_invoice' | 'quote_invoice' | 'invoice';

export const INDUSTRIES = [
  { key: 'builder', label: 'Building contractor', workflow: 'quote_job_invoice' },
  { key: 'electrician', label: 'Electrician', workflow: 'quote_job_invoice' },
  { key: 'plumber', label: 'Plumber', workflow: 'quote_job_invoice' },
  { key: 'painter', label: 'Painter', workflow: 'quote_job_invoice' },
  { key: 'handyman', label: 'Handyman or maintenance', workflow: 'quote_job_invoice' },
  { key: 'mechanic', label: 'Mechanic or panel beater', workflow: 'quote_job_invoice' },
  { key: 'garden', label: 'Garden or pool services', workflow: 'quote_invoice' },
  { key: 'cleaning', label: 'Cleaning services', workflow: 'quote_invoice' },
  { key: 'hair', label: 'Hairdresser, barber or beauty', workflow: 'invoice' },
  { key: 'it', label: 'IT services', workflow: 'quote_job_invoice' },
  { key: 'design', label: 'Graphic design or creative', workflow: 'quote_invoice' },
  { key: 'photo', label: 'Photographer or videographer', workflow: 'quote_invoice' },
  { key: 'consulting', label: 'Consultant or freelancer', workflow: 'quote_invoice' },
  { key: 'tutor', label: 'Tutor or coach', workflow: 'invoice' },
  { key: 'catering', label: 'Catering or events', workflow: 'quote_invoice' },
  { key: 'health', label: 'Health or wellness practice', workflow: 'invoice' },
  { key: 'transport', label: 'Transport or deliveries', workflow: 'quote_invoice' },
  { key: 'retail', label: 'Shop, retail or trading', workflow: 'invoice' },
  { key: 'other', label: 'Something else', workflow: 'quote_invoice' },
] as const satisfies readonly { key: string; label: string; workflow: Workflow }[];

export type IndustryKey = (typeof INDUSTRIES)[number]['key'];

export const WORKFLOWS: { key: Workflow; label: string; hint: string }[] = [
  { key: 'quote_job_invoice', label: 'Quote → job → invoice', hint: 'Jobs track what each one costs and makes: parts, time, profit' },
  { key: 'quote_invoice', label: 'Quote → invoice', hint: 'Send a quote, turn it into the invoice. No jobs to manage' },
  { key: 'invoice', label: 'Just invoices', hint: 'Bill clients when the work’s done' },
];

/** The extras asked about in setup: what would help a business like this. */
export interface SetupExtras {
  /** Charges for time by the hour: the time tracker. */
  hourly: boolean;
  /** Drives for work: SARS's travel logbook. */
  travel: boolean;
  /** Buys on account from suppliers: bills to pay. */
  bills: boolean;
  /** Clients sometimes pay before the work starts: pro-forma invoices. */
  upfront: boolean;
}

const HOURLY: readonly string[] = ['it', 'design', 'photo', 'consulting', 'tutor', 'health', 'mechanic'];
const TRAVEL: readonly string[] = ['builder', 'electrician', 'plumber', 'painter', 'handyman', 'garden', 'cleaning', 'it', 'photo', 'consulting', 'catering'];
const ON_ACCOUNT: readonly string[] = ['builder', 'electrician', 'plumber', 'painter', 'mechanic', 'catering'];
const UPFRONT: readonly string[] = ['builder', 'design', 'photo', 'catering', 'it'];

/** What's usually right for a kind of business, as the starting answers (each one can be changed). */
export function extrasFor(industry: string): SetupExtras {
  return { hourly: HOURLY.includes(industry), travel: TRAVEL.includes(industry), bills: ON_ACCOUNT.includes(industry), upfront: UPFRONT.includes(industry) };
}

/** The switches the answers add up to. */
export function featuresFor(a: {
  workflow: Workflow;
  employees: boolean;
  casual: boolean;
  company: boolean;
  dividends?: boolean;
  extras?: SetupExtras;
  payshap?: boolean;
  /** Sells over the counter, and (only then) keeps its stock in Shap. */
  selling?: { sales: boolean; inventory: boolean };
  /** Shap drafts the annual financial statements (no: the accountant prepares them in their own software). */
  statements?: boolean;
}): Partial<Record<Feature, boolean>> {
  return {
    jobs: a.workflow === 'quote_job_invoice',
    quotes: a.workflow !== 'invoice',
    payroll: a.employees,
    workers: a.casual,
    dividends: a.company && (a.dividends ?? true),
    ...(a.extras ? { timeTracker: a.extras.hourly, logbook: a.extras.travel, bills: a.extras.bills, proformas: a.extras.upfront } : {}),
    ...(a.payshap != null ? { payshap: a.payshap } : {}),
    ...(a.selling ? { sales: a.selling.sales, inventory: a.selling.sales && a.selling.inventory } : {}),
    ...(a.statements != null ? { statements: a.statements } : {}),
  };
}

/** The line Shap signs off quotes, invoices and payslips with, unless switched off in Settings. */
export const SHAP_LINE = 'Made with Shap: keeps the books lekker so South Africa can get to work. Always free, always open, never ads.';
export const SHAP_URL = 'https://www.openworks.co.za/shap/';
