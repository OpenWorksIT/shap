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
  payroll: 'Run the payroll and prepare its declarations to SARS (EMP201 and EMP501)',
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

/**
 * Said with every letter Shap drafts (on its page, in both drawers, and printed on a draft's PDF,
 * never on a sent one): it's the practice's own letter, and its own engagement.
 */
export const LETTER_NOTE =
  'A starting point for your practice’s own letter, from the client’s details in Shap: not complete, and not checked against the law or your professional body’s rules for this client (the law it cites may have changed). Read all of it, check it against your body’s guidance (and an attorney, for anything legal), and change anything before you send it. OpenWorks IT aren’t lawyers, accountants or tax practitioners, and the letter isn’t legal or professional advice: it, the engagement and its terms are your practice’s own, and between your practice and the client.';

/** Asked before a letter is marked as sent: its words are then kept, and Shap doesn't send it. */
export const LETTER_SENT_CONFIRM = 'Its words are kept as they are from now. Shap doesn’t send it: download its PDF and send it to them yourself.';

/** Asked before a letter is ended in Shap: it's the practice's record, not the engagement's end. */
export const LETTER_END_CONFIRM =
  'Ending it here records the last year it covers; it doesn’t end the engagement with the client (the letter says that’s done in writing). A newer letter for the years after it is made separately.';

/** The most a letter's words may run to, all its parts together (its PDF is made on the server). */
export const LETTER_MAX_CHARS = 60_000;
/** The most review notes on one year, and replies to one note. */
export const NOTES_PER_YEAR = 200;
export const REPLIES_PER_NOTE = 30;
/** The most a year's review notes and their replies may run to, all together (the year's file is a PDF made on the server). */
export const YEAR_NOTES_MAX_CHARS = 200_000;

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
