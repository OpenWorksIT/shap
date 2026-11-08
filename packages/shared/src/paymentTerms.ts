/**
 * The usual payment terms on an invoice, and how long a quote stays valid: one tap each. A pick
 * sets the due (or valid-until) date and brings the terms wording in step, when the wording
 * names a period ("Payment due within 7 days", "valid for 30 days"). Wording that doesn't name
 * one is left as it is.
 */
import { addDays, monthEnd } from './dates.js';

/** Days after the invoice date, or the end of its month. */
export type PaymentTerm = number | 'month-end';

export const PAYMENT_TERMS: { term: PaymentTerm; label: string }[] = [
  { term: 0, label: 'On receipt' },
  { term: 7, label: '7 days' },
  { term: 14, label: '14 days' },
  { term: 30, label: '30 days' },
  { term: 'month-end', label: 'Month end' },
];

/** For the default in Settings: a number of days (month end is picked per invoice). */
export const PAYMENT_DAYS = [0, 7, 14, 30] as const;
export const QUOTE_VALID_DAYS = [7, 14, 30, 60] as const;

export const dayLabel = (days: number) => (days === 0 ? 'On receipt' : `${days} days`);

/** The due date for a term. */
export function dueFor(issueDate: string, term: PaymentTerm): string {
  return term === 'month-end' ? monthEnd(issueDate) : addDays(issueDate, term);
}

/** Which term a due date is, if it's one of the usual ones. */
export function termOf(issueDate: string, dueDate: string | null, terms: readonly PaymentTerm[] = PAYMENT_TERMS.map((t) => t.term)): PaymentTerm | null {
  if (!issueDate || !dueDate) return null;
  // Days first: on the last day of a month, "On receipt" and "Month end" are the same date.
  return terms.find((t) => t !== 'month-end' && addDays(issueDate, t) === dueDate) ?? (terms.includes('month-end') && monthEnd(issueDate) === dueDate ? 'month-end' : null);
}

const PAYMENT_PHRASE = /payment (?:is )?due (?:within \d+ days|on receipt|by the end of the month)/i;
const phraseFor = (term: PaymentTerm) => (term === 'month-end' ? 'by the end of the month' : term === 0 ? 'on receipt' : `within ${term} days`);

/** The invoice terms with the payment period changed to `term`; empty terms get the plain sentence. */
export function withPaymentTerm(text: string, term: PaymentTerm): string {
  const t = String(text ?? '');
  if (!t.trim()) return `Payment due ${phraseFor(term)}.`;
  return t.replace(PAYMENT_PHRASE, (m) => `${m[0] === 'p' ? 'p' : 'P'}ayment due ${phraseFor(term)}`);
}

const VALID_PHRASE = /valid for \d+ days/i;

/** The quote terms with how long it's valid changed to `days`; empty terms get the plain sentence. */
export function withQuoteValidity(text: string, days: number): string {
  const t = String(text ?? '');
  if (!t.trim()) return `This quote is valid for ${days} days.`;
  return t.replace(VALID_PHRASE, `valid for ${days} days`);
}
