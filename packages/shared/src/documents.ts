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

/**
 * Whether its PDF and message ask to be paid (bank details, a card link, PayShap): an issued
 * invoice, not one paid at the counter, and a pro-forma. Not a draft or a voided invoice.
 */
export const asksForPayment = (d: { kind: string; status: string; proforma?: boolean | null; counter?: boolean | null }) =>
  d.kind === 'invoice' ? d.status === 'issued' && !d.counter : d.kind === 'quote' && Boolean(d.proforma);

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

export interface MessageDocument extends NamedDocument {
  number: string;
  clientName?: string | null;
  payLink?: string | null;
  counter?: boolean | null;
  creditedInvoiceNumber?: string | null;
  creditReason?: string | null;
}

/**
 * The note that goes with a PDF shared from the phone: named as its PDF is, and asking to be paid
 * (PayShap, a card link) only where its PDF does. `payshapId` only when PayShap is switched on.
 */
export function shareMessage(d: MessageDocument, opts: { from: string; payLink?: string | null; payshapId?: string | null }): string {
  const pays = asksForPayment(d);
  const link = pays ? d.payLink || opts.payLink || '' : '';
  const payshap = pays ? opts.payshapId || '' : '';
  const credits = d.kind === 'credit_note' && d.creditedInvoiceNumber ? ` It credits invoice ${d.creditedInvoiceNumber}${d.creditReason ? ` (${d.creditReason})` : ''}.` : '';
  return (
    `Good day${d.clientName ? ` ${d.clientName}` : ''},\n\nPlease find ${documentName(d).toLowerCase()} ${d.number} attached.${credits}` +
    (payshap ? `\n\nPay instantly with PayShap to ${payshap} (reference ${d.number}).` : '') +
    (link ? `\n\nPay by card: ${link}` : '') +
    `\n\nKind regards,\n${opts.from}`
  );
}
