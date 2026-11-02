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
  { key: 'other', label: 'Something else', workflow: 'quote_invoice' },
] as const satisfies readonly { key: string; label: string; workflow: Workflow }[];

export type IndustryKey = (typeof INDUSTRIES)[number]['key'];

export const WORKFLOWS: { key: Workflow; label: string; hint: string }[] = [
  { key: 'quote_job_invoice', label: 'Quote → job → invoice', hint: 'Jobs track what each one costs and makes: parts, time, profit' },
  { key: 'quote_invoice', label: 'Quote → invoice', hint: 'Send a quote, turn it into the invoice. No jobs to manage' },
  { key: 'invoice', label: 'Just invoices', hint: 'Bill clients when the work’s done' },
];

/** The switches the answers add up to. */
export function featuresFor(a: { workflow: Workflow; employees: boolean; casual: boolean; company: boolean; dividends?: boolean }): Partial<Record<Feature, boolean>> {
  return {
    jobs: a.workflow === 'quote_job_invoice',
    quotes: a.workflow !== 'invoice',
    payroll: a.employees,
    workers: a.casual,
    dividends: a.company && (a.dividends ?? true),
  };
}

/** The line Shap signs off quotes, invoices and payslips with, unless switched off in Settings. */
export const SHAP_LINE = 'Made with Shap: keeps the books lekker so South Africa can get to work. Always free, always open, never ads.';
export const SHAP_URL = 'https://www.openworks.co.za/shap/';
