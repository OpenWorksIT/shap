/**
 * What a quote, invoice or credit note is called: the heading on its PDF, its file's name and the
 * message that goes with it, so the three always agree.
 *
 * Its own VAT rate says whether the business was a VAT vendor for it, not whether it is today: a
 * vendor's invoice is a tax invoice even when everything on it is zero-rated (VAT Act s20(4)(a)),
 * and one from before registering still reprints as a plain invoice. A draft invoice or credit
 * note isn't issued, so it isn't a tax invoice or a credit note yet (s20(1), s21(3)) and isn't in
 * the books: it says Draft, and its PDF asks for no payment.
 */
export interface NamedDocument {
  kind: 'quote' | 'invoice' | 'credit_note';
  status: string;
  vatRateBp: number | string;
  proforma?: boolean | null;
  legacySale?: boolean | null;
}

/** A draft invoice or credit note: not issued, so not in the books. Send offers to issue it first. */
export const notIssuedYet = (d: Pick<NamedDocument, 'kind' | 'status'>) => (d.kind === 'invoice' || d.kind === 'credit_note') && d.status === 'draft';

/** The heading on its PDF. */
export function documentHeading(d: NamedDocument): string {
  if (d.kind === 'credit_note') return d.status === 'draft' ? 'Draft credit note' : 'Credit note';
  if (d.kind === 'invoice') {
    if (d.status === 'draft') return 'Draft invoice';
    const vat = Number(d.vatRateBp) > 0;
    return vat ? 'Tax invoice' : d.legacySale ? 'Sale' : 'Invoice';
  }
  return d.proforma ? 'Pro-forma invoice' : 'Quotation';
}

/** What it's called in its file's name and in a message: the heading, with a quotation as a quote. */
export function documentName(d: NamedDocument): string {
  const h = documentHeading(d);
  return h === 'Quotation' ? 'Quote' : h;
}

/** It has gone out to someone: issued or sent, or shared from the phone while still a draft. */
export const hasGoneOut = (d: { status: string; sentAt?: string | null }) => d.status !== 'draft' || Boolean(d.sentAt);
