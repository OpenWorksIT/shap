/**
 * Shap Accountant, phase 5 (docs/ACCOUNTANT.md, "Engagement letters and working papers"): what a
 * practice agrees with each client, and the year's working papers it keeps for itself. The words
 * here are what the practice's screens say; the letter's own starting text is the server's
 * (lib/engagement.ts), from the client's own details.
 */
export const SERVICES = ['books', 'payroll', 'vat', 'income_tax', 'compile', 'accounting_officer'] as const;
export type Service = (typeof SERVICES)[number];

/** What the practice may agree to do for a client, as the letter's choices name it. */
export const SERVICE_WORDS: Record<Service, string> = {
  books: 'Write up the books',
  payroll: 'Run the payroll, with its PAYE, UIF and SDL returns',
  vat: 'Prepare the VAT returns',
  income_tax: 'Prepare the income tax and provisional tax returns',
  compile: 'Compile the annual financial statements (ISRS 4410 (Revised))',
  accounting_officer: 'Act as the close corporation’s accounting officer (Close Corporations Act, sections 59 to 62)',
};

/** A letter's way through: drafted, sent to the client, accepted by them, and in time ended (or replaced). */
export const LETTER_STATUSES = ['draft', 'sent', 'accepted', 'ended'] as const;
export type LetterStatus = (typeof LETTER_STATUSES)[number];

/** How a client's acceptance was had: a signed copy (kept with the letter), or recorded by the practice. */
export const ACCEPTED_HOW = ['signed', 'recorded'] as const;
export type AcceptedHow = (typeof ACCEPTED_HOW)[number];

/** Said with every letter Shap drafts: it's the practice's own letter, and its own engagement. */
export const LETTER_NOTE =
  'A starting point for your practice’s own letter, from the client’s details in Shap: read all of it, and change anything before you send it. OpenWorks IT aren’t lawyers or accountants, and the letter isn’t legal advice: it, the engagement and its terms are your practice’s own, and between your practice and the client.';

/** The year's sign-offs in the working papers, in the order they're given. */
export const SIGNOFFS = ['prepared', 'reviewed', 'partner'] as const;
export type Signoff = (typeof SIGNOFFS)[number];
export const SIGNOFF_WORDS: Record<Signoff, string> = {
  prepared: 'Prepared',
  reviewed: 'Reviewed',
  partner: 'Engagement partner',
};

/** Said on the working papers: they're the practice's own record, and Shap's marks are aids. */
export const FILE_NOTE =
  'The practice’s own record of its work on this year: kept on the practice’s server, not in the client’s books. Ticks, review notes and sign-offs are what your people record; Shap doesn’t check the work behind them, and nothing here stops anyone compiling or filing.';
