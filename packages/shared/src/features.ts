/**
 * Parts of the app a one-person business can switch off. A designer has no workers and maybe
 * no jobs; an electrician has jobs and maybe a helper. Off means hidden, never deleted: switch
 * it back on and everything is still there.
 */
export const FEATURES = {
  jobs: { label: 'Jobs', hint: 'Track each job’s quote, costs and profit', default: true },
  quotes: { label: 'Quotes', hint: 'Send quotes and turn them into invoices', default: true },
  workers: { label: 'Casual workers', hint: 'Log days worked by helpers paid by the day, and pay them', default: false },
  payroll: { label: 'Payroll', hint: 'Employees on a salary: payslips, PAYE, UIF and SDL', default: false },
  dividends: { label: 'Dividends', hint: 'Pay the company’s shareholders (you) dividends, with dividends tax', default: false },
  bank: { label: 'Bank statements', hint: 'Import statements and tick off what’s been captured', default: true },
  assets: { label: 'Assets', hint: 'Tools, vehicles and equipment, with wear and tear', default: true },
  brands: { label: 'More than one trading name', hint: 'Invoice under different names and logos', default: false },
  creditNotes: { label: 'Credit notes', hint: 'Take back part or all of an invoice (a refund or discount), with the VAT', default: true },
  proformas: { label: 'Pro-forma invoices', hint: 'Ask to be paid before the work starts, without a tax invoice', default: false },
  payshap: { label: 'PayShap', hint: 'Print your ShapID on invoices so clients pay instantly from their banking app', default: false },
  reminders: { label: 'Payment reminders', hint: 'Overdue invoices on Home, with a reminder ready to send', default: true },
  bills: { label: 'Supplier bills', hint: 'Bills you’ll pay later: what you owe, and when it’s due', default: false },
  logbook: { label: 'Travel logbook', hint: 'SARS’s logbook for your vehicle: trips, kilometres, business share', default: false },
  timeTracker: { label: 'Time tracker', hint: 'A clock per job, an hourly rate, and the time onto the invoice', default: false },
  guides: { label: 'SARS filing guides', hint: 'Step by step through VAT201, provisional tax, EMP201 and returns', default: true },
} as const;

/** How the switches are grouped in Settings. */
export const FEATURE_GROUPS: { label: string; keys: Feature[] }[] = [
  { label: 'Work', keys: ['jobs', 'quotes', 'timeTracker', 'workers', 'payroll'] },
  { label: 'Invoicing', keys: ['proformas', 'creditNotes', 'reminders', 'payshap', 'brands'] },
  { label: 'Money and tax', keys: ['bills', 'bank', 'assets', 'dividends', 'logbook', 'guides'] },
];

export type Feature = keyof typeof FEATURES;
export const FEATURE_KEYS = Object.keys(FEATURES) as Feature[];

export function featureOn(features: Partial<Record<string, boolean>> | null | undefined, f: Feature): boolean {
  const v = features?.[f];
  return typeof v === 'boolean' ? v : FEATURES[f].default;
}
