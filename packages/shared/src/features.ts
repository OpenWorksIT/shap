/**
 * Parts of the app a one-person business can switch off. A designer has no workers and maybe
 * no jobs; an electrician has jobs and maybe a helper. Off means hidden, never deleted: switch
 * it back on and everything is still there.
 */
export const FEATURES = {
  jobs: { label: 'Jobs', hint: 'Track each job’s quote, costs and profit', default: true },
  quotes: { label: 'Quotes', hint: 'Send quotes and turn them into invoices', default: true },
  workers: { label: 'Workers and wages', hint: 'Log days worked by helpers and pay them', default: false },
  bank: { label: 'Bank statements', hint: 'Import statements and tick off what’s been captured', default: true },
  assets: { label: 'Assets', hint: 'Tools, vehicles and equipment, with wear and tear', default: true },
  brands: { label: 'More than one trading name', hint: 'Invoice under different names and logos', default: false },
} as const;

export type Feature = keyof typeof FEATURES;
export const FEATURE_KEYS = Object.keys(FEATURES) as Feature[];

export function featureOn(features: Partial<Record<string, boolean>> | null | undefined, f: Feature): boolean {
  const v = features?.[f];
  return typeof v === 'boolean' ? v : FEATURES[f].default;
}
