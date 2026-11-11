/**
 * The terms of use. The full terms are published on the website (TERMS_URL); every copy of the
 * app shows the key points below at the end of setup, and again whenever TERMS_VERSION changes,
 * and can't be used until they're accepted. What was accepted (the version and when) is kept in
 * the books' own settings and audit log, so each set of books records its own agreement; nothing
 * is sent anywhere.
 *
 * Change TERMS_VERSION when the published terms change in a way people must agree to again.
 */
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
      body: 'Your returns, declarations and payments to SARS and the Department of Employment and Labour (VAT201, EMP201, EMP501, IRP6, ITR14, ITR12, DTR01, UIF and others), your registrations, and meeting their deadlines are your responsibility, as are the accuracy and completeness of what you capture.',
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
  if (a.turnoverTax) out.push('You’re on turnover tax: Shap estimates it from your turnover, but the TT01 registration and the TT03 return are yours to file.');
  if (a.paysDividends) out.push('Dividends: each dividend paid is declared to SARS on the DTR01 and DTR02 by the last day of the next month (an exemption is claimed on the DTR01, so exempt dividends are declared too: confirm with your accountant). Shap records them and reminds you; declaring and paying is up to you.');
  return out;
}
