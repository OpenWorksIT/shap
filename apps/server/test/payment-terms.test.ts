/** One-tap payment terms: the due date, and the terms wording kept in step. */
import { describe, expect, it } from 'vitest';
import { dueFor, termOf, withPaymentTerm, withQuoteValidity, QUOTE_VALID_DAYS } from '@shap/shared';

describe('payment terms', () => {
  it('works out the due date for each term', () => {
    expect(dueFor('2026-11-09', 0)).toBe('2026-11-09');
    expect(dueFor('2026-11-09', 30)).toBe('2026-12-09');
    expect(dueFor('2026-11-09', 'month-end')).toBe('2026-11-30');
    expect(dueFor('2026-02-10', 'month-end')).toBe('2026-02-28');
  });

  it('recognises a due date as one of the usual terms, or none', () => {
    expect(termOf('2026-11-09', '2026-11-16')).toBe(7);
    expect(termOf('2026-11-09', '2026-11-30')).toBe('month-end');
    expect(termOf('2026-11-09', '2026-11-20')).toBeNull();
    expect(termOf('2026-11-30', '2026-11-30')).toBe(0); // the last day of the month: on receipt
    expect(termOf('2026-11-09', '2027-01-08', QUOTE_VALID_DAYS)).toBe(60);
    expect(termOf('2026-11-09', null)).toBeNull();
  });

  it('changes the period in the invoice terms, and leaves wording without one alone', () => {
    const usual = 'Payment due within 7 days. Please use the invoice number as your reference.';
    expect(withPaymentTerm(usual, 30)).toBe('Payment due within 30 days. Please use the invoice number as your reference.');
    expect(withPaymentTerm(usual, 0)).toBe('Payment due on receipt. Please use the invoice number as your reference.');
    expect(withPaymentTerm(withPaymentTerm(usual, 'month-end'), 14)).toBe('Payment due within 14 days. Please use the invoice number as your reference.');
    expect(withPaymentTerm('Thank you. Payment is due within 7 days of the invoice date.', 30)).toBe('Thank you. Payment due within 30 days of the invoice date.');
    expect(withPaymentTerm('', 7)).toBe('Payment due within 7 days.');
    expect(withPaymentTerm('Strictly COD.', 30)).toBe('Strictly COD.');
  });

  it('changes how long a quote is valid in the quote terms', () => {
    const usual = 'This quote is valid for 30 days. A deposit may be required before materials are ordered.';
    expect(withQuoteValidity(usual, 14)).toBe('This quote is valid for 14 days. A deposit may be required before materials are ordered.');
    expect(withQuoteValidity('', 60)).toBe('This quote is valid for 60 days.');
    expect(withQuoteValidity('Prices may change.', 7)).toBe('Prices may change.');
  });
});
