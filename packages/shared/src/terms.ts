/**
 * The terms of use. The full terms are published on the website (TERMS_URL); every copy of the
 * app shows the key points below at the end of setup, and again whenever TERMS_VERSION changes,
 * and can't be used until they're accepted. What was accepted (the version and when) is kept in
 * the books' own settings and audit log, so each set of books records its own agreement; nothing
 * is sent anywhere.
 *
 * Change TERMS_VERSION when the published terms change in a way people must agree to again.
 */
import { TURNOVER_TAX_PROFESSIONAL } from './setup.js';
export const TERMS_VERSION = '2026-11-09';
export const TERMS_URL = 'https://www.openworks.co.za/shap/terms/';
export const DISCLAIMER_URL = 'https://www.openworks.co.za/shap/disclaimer/';

/**
 * Said with every figure Shap works out under tax law or company law (provisional tax, VAT, payroll
 * taxes, turnover tax, the public interest score, the draft statements' tax): on the screens, on the
 * PDFs and in the tax pack, the same words in Shap and Shap Pocket.
 */
export const ESTIMATE_NOTE =
  'An estimate worked out from your books, as an aid. Shap is free software from OpenWorks IT, who are not accountants, tax practitioners or auditors, and this is not advice: check it with your accountant or tax practitioner before you rely on it or file anything.';
/** The practice's list (Shap Accountant): what its checks find and the returns it shows. */
export const PRACTICE_NOTE =
  'What Shap’s checks find and the returns shown are worked out from what’s captured in each client’s books and its settings, and from Shap’s tables of SARS, CIPC and Compensation Fund dates, which may be out of date. They’re aids for you to check, not advice, and not every check or return: Shap lists only those it can work out. Shap files nothing with SARS, CIPC or the Compensation Fund and signs nothing. Shap is free software from OpenWorks IT, who are not accountants, tax practitioners or auditors.';
/** Said back before Shap Accountant is switched on: what the practice answers for. */
export const PRACTICE_CAUTION =
  'Shap Accountant keeps your clients’ books on this server. Their backups, who in your practice opens them, and their personal information (POPIA) are your practice’s responsibility, what Shap’s checks find and the returns it shows are aids for your practitioners to check, not advice, and books brought in from another package are for you to check against it. Completing returns or giving tax advice for a fee generally needs registration with SARS and a recognised controlling body (Tax Administration Act s240, which has exceptions, such as work under a registered tax practitioner’s supervision): that’s your practice’s own, and Shap doesn’t check it.';
/** Where a practice's Shap runs (docs/ACCOUNTANT.md): said in setup, on Practice and in the docs. */
export const PRACTICE_OWN_SERVER =
  'Shap Accountant needs Shap on a server of its own: a VPS (a server rented online) or a computer that only your practice uses, run by your practice or someone it chooses. Not a company added to a Shap server that other businesses use. The server’s security, its backups, and who can reach your clients’ books are then your practice’s to look after.';
/** Where this Shap's database login can't make the clients' databases, and Shap can't ask the server to allow it. */
export const SERVER_NOT_MANAGED =
  'This Shap’s database login isn’t allowed to make databases, and Shap can’t ask this server to allow it. Where Settings → Updates & backups looks after the server, Shap can ask it for this; anywhere else, whoever runs the server allows it (docs/ACCOUNTANT.md, on Shap’s GitHub).';
/**
 * With each Shap Pocket share brought in (Practice): what Shap does and doesn't do with one. The
 * disclaimer's "Sharing your books with your accountant (Shap Pocket)" says the same.
 */
export const POCKET_SHARE_NOTE =
  'Shap reads a share as it finds it. It doesn’t check it against the client’s records, and the figures stay theirs, to change in Shap Pocket. Shap is free software from OpenWorks IT, who are not accountants, tax practitioners or auditors, and this is not advice.';
/**
 * On Accounts → From another package (books-import.ts): what bringing books in does and doesn't do.
 * The disclaimer's "Books from another accounting package" says the same (openworks.co.za/shap/disclaimer).
 */
export const IMPORT_NOTE =
  'Shap reads these files as it finds them and suggests where each account goes. It doesn’t check them against the package or the client’s records, and the figures stay the package’s. After bringing them in, compare these books’ trial balance with the package’s before you rely on them. Shap is free software from OpenWorks IT, who are not accountants, tax practitioners or auditors, and this is not advice.';
/**
 * The Shap Accountant terms of use: Shap's terms, with what applies to a practice keeping its
 * clients' books in Shap (its own work, its clients' books and information, an indemnity). Published
 * on the website (ACCOUNTANT_TERMS_URL). Only a practice accepts them: its owner, for the practice,
 * before Shap Accountant is switched on and again whenever ACCOUNTANT_TERMS_VERSION changes
 * (Practice asks; until then no client's books open, though their backups can be downloaded).
 * Recorded in the practice's settings and audit log; that acceptance covers every client's books
 * the practice keeps. Each client's books also record, in their own audit log, the practice's
 * acceptance for them, when they're set up and when Shap's terms change (PRACTICE_TERMS_TICK).
 * Shap's own terms (TERMS_VERSION) don't change with them, so nobody else is asked again. When
 * Shap's terms change, the Shap Accountant terms' Part A changes with them, and both versions go up
 * (ACCOUNTANT_TERMS_VERSION is never older than TERMS_VERSION: accountant-terms.test.ts).
 */
export const ACCOUNTANT_TERMS_VERSION = '2026-11-17.3';
export const ACCOUNTANT_TERMS_URL = 'https://www.openworks.co.za/shap/accountant-terms/';
/** The practice's owner, accepting the Shap Accountant terms for the practice. */
export const ACCOUNTANT_TERMS_TICK = 'I accept the Shap Accountant terms of use for my practice, and I’m authorised to agree to them on its behalf.';
/** In a client's books, the terms are accepted for the practice's use of Shap on them (under its owner's acceptance for the practice). */
export const PRACTICE_TERMS_TICK = 'I accept the Shap Accountant terms of use, which my practice’s owner has accepted for the practice, for my practice’s use of Shap on these books.';
/** Under the tick: what accepting the Shap Accountant terms means, with the indemnity as clause 13 has it. */
export const ACCOUNTANT_TERMS_MEANS =
  'Including that my practice’s work for its clients is its own; that Shap’s checks, returns, statements, tax figures, drafted engagement letters and working papers are aids and estimates, not advice; that my practice looks after its clients’ books and personal information; and that it indemnifies OpenWorks against claims by its clients or anyone else over that work, its use of Shap on their books, the personal information it keeps or opens there, or a breach of the terms.';

/** What the Shap Accountant terms add to Shap's, in plain words (shown before the practice agrees). */
export function accountantTermsPoints(): { title: string; body: string }[] {
  return [
    {
      title: 'Your work for your clients is your own',
      body: 'The accounting, bookkeeping, payroll, tax and compilation work your practice does for its clients, and everything it signs, issues or files, is its own, under its engagement with each client and its professional body’s rules. OpenWorks IT isn’t a party to that work and doesn’t review it.',
    },
    {
      title: 'Shap’s checks and returns are aids',
      body: 'What Shap’s checks find, the returns and due dates it lists and the statements and reports it drafts are aids for your practitioners to check: not complete, and not advice. Its tax figures (income tax, provisional tax, turnover tax, the tax pack) and the public interest score, with the audit or independent review it points to, are estimates only. Shap files nothing with SARS, the Department of Employment and Labour or CIPC. Approving a client’s financial statements is the client’s own decision, taken by those the law and its own rules give it to (for a company, its board; for a close corporation, members holding at least 51 per cent of the members’ interest; for a trust, its trustees; for a partnership, its partners; for a sole proprietor, its owner): Shap records it as your practice enters it, and on a client’s own Shap the client approves them there.',
    },
    {
      title: 'Engagement letters and working papers are aids too',
      body: 'An engagement letter Shap drafts is a starting point for your practice’s own letter: not complete, not legal advice, and not checked against the law or your professional body’s rules for the client. What it says, and the engagement it records, are between your practice and the client. The working papers’ ticks, review notes and sign-offs are what your people record: Shap doesn’t check the work behind them, and nothing there stops anyone compiling or filing.',
    },
    {
      title: 'Your clients’ books and information are in your care',
      body: 'The clients’ books your practice keeps are on its server: its security, the books’ backups, who in your practice opens which books, and your clients’ personal information (POPIA) are your practice’s responsibility. A client on its own Shap that links your practice decides what it may do there, and can unlink it at any time; who in your practice opens its books, and what your practice does there, are your practice’s responsibility, its server is the client’s, and OpenWorks doesn’t promise it can be reached. Books brought in from another package or from a client’s Shap Pocket share, and what a linked client’s Shap sends from its checks, are read as Shap finds them, for your practice to check against where they came from.',
    },
    {
      title: 'Your practice indemnifies OpenWorks',
      body: 'If a client, or anyone else, claims against OpenWorks IT or its people over your practice’s work for its clients, its use of Shap on their books, the personal information it keeps or opens there, or a breach of these terms by your practice or anyone it lets in, your practice covers them for that claim and its costs, even where the claim says Shap or OpenWorks’ negligence caused it, but not where the fraud, gross negligence or wilful misconduct of OpenWorks or its people did.',
    },
    {
      title: 'Shap’s terms of use apply too',
      body: 'Everything in Shap’s terms applies to your practice’s use of Shap, its own books included: it’s free, as is, with no warranty; OpenWorks IT are not accountants, tax practitioners or auditors, and aren’t liable for what is filed or paid; and keeping it up to date is yours.',
    },
  ];
}
/** The short form, where there's no room for the whole note. */
export const ESTIMATE_SHORT = 'An estimate only, not advice: check it with your accountant before you rely on it.';

/** The points that limit what OpenWorks is responsible for, in plain words (shown before agreeing). */
export function termsPoints(app: 'shap' | 'pocket'): { title: string; body: string }[] {
  const where = app === 'pocket' ? 'on your phone (or in your browser)' : 'on the server you run it on';
  return [
    {
      title: 'Shap is a record-keeping tool, not an accountant',
      body: 'OpenWorks IT are not accountants, tax practitioners or auditors, and nothing in Shap is accounting, tax or legal advice. Use Shap to capture and collate your records for your accountant or tax practitioner. Its tax, VAT, payroll and other figures are estimates and aids: check them, or have them checked, before you file anything or rely on them.',
    },
    {
      title: 'You are responsible for what you file and pay',
      body: 'Your returns, declarations and payments to SARS, the Department of Employment and Labour, CIPC and the Compensation Fund (VAT201, EMP201, EMP501, IRP6, ITR14, ITR12, DTR01, UIF, annual returns, the return of earnings and others), your registrations, and meeting their deadlines are your responsibility, as are the accuracy and completeness of what you capture.',
    },
    {
      title: 'Your data is yours, and so are its backups',
      body: `Your books are kept ${where}. OpenWorks does not hold, see, back up or restore your data, and can’t recover it if it is lost. Making and keeping backups, somewhere other than where Shap runs, is your responsibility. SARS expects you to keep records for at least five years.`,
    },
    {
      title: 'Keep Shap up to date',
      body: 'Updates carry security fixes and changes to tax tables, VAT, payroll and accounting rules. Updating needs an internet connection, and installing updates is your responsibility. An out-of-date copy may work out figures on rules that no longer apply.',
    },
    {
      title: 'Free, as is, with no warranty',
      body: 'Shap is free, open-source software (GNU AGPL v3), provided as is, without any warranty, including of accuracy or fitness for a purpose. To the fullest extent the law allows, OpenWorks IT (Pty) Ltd and its directors are not liable for any loss or damage from using Shap, including penalties, interest, tax, lost profit or lost data. Nothing here excludes liability that South African law does not allow to be excluded.',
    },
    {
      title: 'Support may end',
      body: 'Shap is looked after by a small team. If OpenWorks ever stops supporting it, every copy will say so in the app, with a date, and the source code stays published so it can be kept going by anyone.',
    },
  ];
}

export type EmployerAnswer = 'yes' | 'no' | 'unsure';

/** Beside the date of incorporation (setup and Settings): what Shap does with it, and doesn't. */
export const CIPC_HINT =
  'On the registration certificate. Shap shows CIPC’s annual return on Home from five weeks before it’s due, worked out from this date: filing it, with what goes with it, is yours or your accountant’s.';
/** For a co-operative, where a company's date of incorporation would be asked. */
export const COOP_CIPC = 'A co-operative files an annual return with CIPC too. Shap doesn’t work out its date: ask your accountant.';
/** Registered with the Compensation Fund: what Shap shows, and when it can't. */
export const COIDA_REMINDER =
  'Shap shows the return of earnings on Home only for a season in its tables: each year’s update adds the Fund’s dates from the Government Gazette (usually in March or April). If there’s no reminder, the dates may not be in Shap yet: watch for the Fund’s notice, or ask your accountant.';
/** Not (or not sure if) registered with the Compensation Fund. */
export const COIDA_NOTE =
  'Most employers, casual workers included, must register under COIDA (cover for injuries at work) with the Compensation Fund, or with a licensed mutual association such as FEM, and send a return of earnings each year. Registering and filing are yours: check with your accountant or a labour practitioner. Once you’re registered with the Fund, tick it in Settings → Company.';

/** What the owner told setup that they should know the consequences of, said back before agreeing. */
export function setupCautions(a: {
  vatRegistered: boolean;
  employees: boolean;
  /** Casual labour, paid by the day (Workers). */
  casual?: boolean;
  payeRegistered?: EmployerAnswer | null;
  uifRegistered?: EmployerAnswer | null;
  sdl?: EmployerAnswer | null;
  turnoverTax?: boolean;
  paysDividends?: boolean;
  /** Registered with the Compensation Fund (asked of an employer, casual workers included). */
  coidaRegistered?: EmployerAnswer | null;
  /** A company or close corporation (CIPC's annual return), and the date of incorporation given. */
  cipc?: boolean;
  incorporatedOn?: string | null;
  /** A co-operative: an annual return to CIPC too, whose date Shap doesn't work out. */
  coop?: boolean;
}): string[] {
  const out: string[] = [];
  if (a.vatRegistered) out.push('You’re registered for VAT: Shap prepares your VAT201 figures, but you (or your accountant) check and submit them, and pay, by the due date.');
  else out.push('You’re not registered for VAT: Shap watches your income over any 12 months in a row and warns you as it nears the compulsory line, but registering on time is your responsibility.');
  if (a.employees) {
    if (a.payeRegistered !== 'yes')
      out.push('You said you’re not (or not sure if you’re) registered for PAYE. An employer must register with SARS within 21 business days of becoming an employer, unless none of its employees is liable for tax. Shap works out payslips, but won’t register you or pay SARS for you.');
    if (a.uifRegistered !== 'yes') out.push('You said you’re not (or not sure if you’re) registered for UIF. UIF applies to anyone employed for 24 hours a month or more: employers registered for PAYE register for UIF with SARS, others with the UI Commissioner. Shap works out the UIF, but declaring and paying it is up to you.');
    if (a.sdl !== 'yes') out.push('You said you don’t pay SDL. That’s right while everything you pay your employees (salaries and day wages together) is expected to stay under R500 000 over the next 12 months; once it isn’t, you must register and Shap must be told (Settings → What you use).');
    out.push('Payroll: Shap prepares EMP201 and EMP501 figures and payslips from what you capture. Submitting them, issuing IRP5s and paying SARS are your responsibility.');
  }
  if (a.casual) {
    out.push('You use casual labour: Shap records their days and pay, but doesn’t work out, deduct or pay PAYE, UIF or the Compensation Fund on day wages, or register you with anyone. Someone you pay by the day is usually your employee in the law, so these may apply: the national minimum wage to every worker, PAYE and the Compensation Fund to employees’ pay, and UIF and the Basic Conditions of Employment Act’s rules on hours and leave from 24 hours a month. Keeping to them is up to you: check with your accountant or a labour practitioner.');
    if (!a.employees) out.push('SDL: once everything you pay employees (day wages included) is expected to pass R500 000 over the next 12 months, SDL (1% of it) is usually due, registered with SARS (some employers, such as qualifying public benefit organisations, are exempt). Shap doesn’t work out SDL on day wages: check with your accountant.');
  }
  if ((a.employees || a.casual) && a.coidaRegistered != null && a.coidaRegistered !== 'yes') out.push(COIDA_NOTE);
  if (a.cipc && !a.incorporatedOn) out.push('You didn’t give the date of incorporation, so Shap won’t show CIPC’s annual return on Home. Filing it each year, with what goes with it, is yours or your accountant’s; add the date in Settings → Company to see it coming.');
  if (a.coop) out.push(COOP_CIPC);
  if (a.turnoverTax) out.push(`You’re on turnover tax: Shap estimates it from your turnover, but the TT01 registration and the TT03 return are yours to file. ${TURNOVER_TAX_PROFESSIONAL}`);
  if (a.paysDividends) out.push('Dividends: each dividend paid is declared to SARS on the DTR01 and DTR02 by the last day of the next month (an exemption is claimed on the DTR01, so exempt dividends are declared too: confirm with your accountant). Shap records them and reminds you; declaring and paying is up to you.');
  return out;
}
