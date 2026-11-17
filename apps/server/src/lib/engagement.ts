/**
 * The engagement letter Shap drafts for a practice's client (docs/ACCOUNTANT.md, "Engagement
 * letters and working papers"): a starting point, from the client's details, that the practice reads
 * and changes before it sends it (LETTER_NOTE). It's drafted to cover what ISRS 4410 (Revised) para
 * 24 asks a compilation's terms to say (the statements' intended use and distribution, and any
 * restriction on it; the framework; the engagement's objective and scope; the practitioner's
 * responsibilities, ethical ones included; management's; the report's addressee and form); whether
 * it does for an engagement is the practitioner's to check. Para 26 (a recurring engagement) is why
 * it runs on, year after year, until it's replaced.
 *
 * The parties aren't named in its words: the letter's own record keeps them (the practice's legal
 * name, registration and trading name, its address, and the client's name), changed with the draft
 * and kept as they are once it's sent, and its PDF heads the letter with them.
 *
 * The law it cites (checked for 1.31.0):
 * - Close Corporations Act 69 of 1984 s58(3) (approval by at least 51 per cent of the members'
 *   interest), s58(2A) (an audit where the Companies Regulations ask), s59-62 (the accounting officer).
 *   https://source.acts.co.za/close-corporations-act-1984/58__annual_financial_statements.php
 *   https://source.acts.co.za/close-corporations-act-1984/62__duties_of_accounting_officers.php
 * - Co-operatives Act 14 of 2005 s47 (audit, independent review, or category A's exemption).
 *   https://api.acts.co.za/co-operatives-act-2005/47__audited_report.php
 * - Companies Act 71 of 2008 s24 (records), s30 (approval; audit or review), Regulations 28 and 29.
 * - Tax Administration Act 28 of 2011 s29 and s32 (records), s46 (SARS may ask a third party), s240
 *   (registered tax practitioners).
 *   https://www.acts.co.za/tax/240__registration_of_tax_practitioners
 * - Financial Intelligence Centre Act 38 of 2001 s29(3) (a report isn't disclosed).
 * - SARS: an approved PBO files the IT12EI and isn't a provisional taxpayer; turnover tax's TT02 and
 *   TT03; an objection within 80 business days.
 *   https://www.sars.gov.za/businesses-and-employers/tax-exempt-institutions/filing-declaration-payment/
 *   https://www.sars.gov.za/types-of-tax/turnover-tax/
 *   https://www.sars.gov.za/individuals/what-if-i-do-not-agree/objections/
 */
import { entity, formatDate, SERVICE_WORDS, type BusinessType, type Service } from '@shap/shared';
import { governingFor, lawFor, reportAddressee, addresseeIsntManagement, specialPurposeFor } from '../statements/details.js';

export interface LetterSection {
  heading: string;
  paragraphs: string[];
}

export interface LetterInput {
  /** Its professional body; and whether those of it who prepare returns are registered tax practitioners (or supervised by one), as it says when it drafts the letter: Shap doesn't say it for the practice. */
  practice: { body: string; registered?: boolean };
  client: { businessType: BusinessType; approvedPbo: boolean; turnoverTax: boolean };
  /** Where the client's books are: in the practice, from Shap Pocket shares, or on its own Shap. */
  kind: 'kept' | 'imported' | 'pocket' | 'linked';
  services: readonly Service[];
  other: string;
  /** The first year end it's for. */
  fromYearEnd: string;
  fees: string;
}

const COMPANYISH: BusinessType[] = ['company', 'inc', 'cc', 'npc', 'coop'];
const COMPANIES_ACT: BusinessType[] = ['company', 'inc', 'npc'];

/** Who approves a business's statements, and under what, in a phrase ("approving them, by …"). */
function approvedBy(bt: BusinessType): string {
  switch (bt) {
    case 'company':
    case 'inc':
    case 'npc':
      return 'by its board of directors, and signed by a director it authorises (Companies Act, section 30(3)(c))';
    case 'cc':
      return 'by a member or members holding at least 51 per cent of the members’ interest, who sign them (Close Corporations Act, section 58(3))';
    case 'coop':
      return 'by its board of directors';
    case 'trust':
      return 'by its trustees';
    case 'partnership':
      return 'by its partners';
    default:
      return 'by its owner';
  }
}

/** The tax a client pays on its income, as the letter's returns follow it. */
type TaxSituation = 'pbo' | 'turnover' | 'company' | 'trust' | 'partners' | 'individual';
function taxSituation(c: LetterInput['client']): TaxSituation {
  if (c.approvedPbo) return 'pbo';
  if (c.turnoverTax) return 'turnover';
  const t = entity(c.businessType).taxedAs;
  return t === 'npc' ? 'company' : t;
}

/** The service as the letter's list names it: its returns follow how the client is taxed. */
function serviceLine(s: Service, tax: TaxSituation, bt: BusinessType): string {
  if (s !== 'income_tax') return SERVICE_WORDS[s];
  switch (tax) {
    case 'pbo':
      return 'Prepare the income tax return of an approved public benefit organisation (IT12EI)';
    case 'turnover':
      return bt === 'partnership' ? 'Give each partner the partnership’s figures for their own turnover tax returns (TT02 and TT03)' : 'Prepare the turnover tax returns (TT02 and TT03)';
    case 'partners':
      return 'Give each partner the partnership’s figures for their own income tax and provisional tax returns';
    default:
      return SERVICE_WORDS[s];
  }
}

function incomeTaxParagraphs(bt: BusinessType, tax: TaxSituation): string[] {
  const yours = 'The returns are yours: you give us everything they need, check them before they’re filed, and pay what’s due by its date.';
  switch (tax) {
    case 'pbo':
      return [
        'We’ll prepare the organisation’s annual income tax return as an approved public benefit organisation (the IT12EI), from the books and what you tell us. An approved public benefit organisation isn’t a provisional taxpayer, so there are no provisional tax returns. Keeping to the conditions of its approval (section 30 of the Income Tax Act, and its founding document) is yours.',
        yours,
      ];
    case 'turnover':
      if (bt === 'partnership')
        return [
          'The partnership files no turnover tax return of its own: each partner registered for turnover tax files their own (the TT02 interim payments and the TT03 annual return). We’ll give each partner the partnership’s figures for theirs; a partner’s own returns, and their income tax return (ITR12) for any other income, are prepared only as agreed with that partner.',
          'Each partner’s returns are their own: they give us everything they need, check them before they’re filed, and pay what’s due by its date.',
        ];
      return [
        `We’ll prepare ${bt === 'sole_prop' ? 'your' : 'the business’s'} turnover tax returns from the books and what you tell us: the TT02 interim payments and the TT03 annual return. Turnover tax takes the place of ${bt === 'sole_prop' ? 'income tax and provisional tax on the business’s income' : 'the business’s income tax and provisional tax'}.${bt === 'sole_prop' ? ' Your own income tax return (the ITR12), for any income outside the business such as a salary or interest, is prepared only if it’s listed above.' : ''}${entity(bt).taxedAs === 'company' ? ' Dividends tax returns (DTR01), for dividends beyond what turnover tax exempts, aren’t included unless they’re listed above.' : ''}`,
        yours,
      ];
    case 'partners':
      return [
        'A partnership isn’t itself a taxpayer: each partner’s share of its profit is taxed in their own return. We’ll give each partner the partnership’s figures for their own income tax return (ITR12) and provisional tax returns (IRP6). A partner’s own returns take in their income from outside the partnership too, so they’re prepared only as agreed with that partner.',
        'Each partner’s returns are their own: they give us everything they need, check them before they’re filed, and pay what’s due by its date.',
      ];
    case 'trust':
      return [
        'We’ll prepare the trust’s income tax return (ITR12T), its provisional tax returns (IRP6) and its IT3(t) returns of what it distributes or vests in beneficiaries, from the books and what you tell us.',
        yours,
      ];
    case 'company':
      return [
        `We’ll prepare the business’s income tax return (ITR14) and provisional tax returns (IRP6) from the books and what you tell us.${bt === 'npc' ? '' : ' Dividends tax returns (DTR01) aren’t included unless they’re listed above.'}`,
        yours,
      ];
    default:
      return ['We’ll prepare your income tax return (ITR12) and provisional tax returns (IRP6) from the books and what you tell us.', yours];
  }
}

/** Whether the business must also be audited or reviewed, by its kind: a separate engagement. */
function assuranceSentence(bt: BusinessType): string {
  switch (bt) {
    case 'company':
    case 'inc':
      return ' Whether the business must also be audited or independently reviewed is worked out each year (Companies Act, section 30, and Companies Regulations 28 and 29): an audit or a review is a separate engagement, and a compilation is neither.';
    case 'npc':
      return ' A non-profit company’s statements are always audited or independently reviewed as well (Companies Act, section 30, and Companies Regulations 28 and 29): that’s a separate engagement, and a compilation is neither.';
    case 'cc':
      return ' A close corporation must also be audited where the Companies Regulations ask it to be (Close Corporations Act, section 58(2A), and Companies Regulation 28): an audit is a separate engagement, and a compilation isn’t one.';
    case 'coop':
      return ' A co-operative’s statements must also be audited, or independently reviewed if it’s a category B co-operative, unless it’s a category A co-operative (Co-operatives Act, section 47): that’s a separate engagement, and a compilation is neither.';
    default:
      return '';
  }
}

export function letterSections(i: LetterInput): LetterSection[] {
  const bt = i.client.businessType;
  const g = governingFor(bt);
  const companyish = COMPANYISH.includes(bt);
  const law = lawFor(bt);
  const tax = taxSituation(i.client);
  // A Shap Pocket client writes up their own books: the practice doesn't (and a CC's accounting officer is a CC's).
  const services = i.services.filter((s) => (s !== 'books' || i.kind !== 'pocket') && (s !== 'accounting_officer' || bt === 'cc'));
  const has = (s: Service) => services.includes(s);
  const year = formatDate(i.fromYearEnd, 'long');
  const are = g.plural ? 'are' : 'is';
  const out: LetterSection[] = [];

  out.push({
    heading: 'What we’ll do',
    paragraphs: [
      `This letter sets out what we, the practice named above, will do for you, the business named above, and on what terms, for the year ending ${year} and every year after it until it’s replaced or ended:`,
      ...services.map((s) => `• ${serviceLine(s, tax, bt)}.`),
      ...(i.other.trim() ? [`• ${i.other.trim()}`] : []),
      'Anything else you ask of us is agreed separately, in writing.',
    ],
  });

  if (has('books'))
    out.push({
      heading: 'Writing up the books',
      paragraphs: [
        'We’ll write up your books from the records you give us (bank statements, invoices, slips and the rest), at the times we agree. What we capture comes from what you give us: we don’t check it against its source, or look for what’s missing, unless we agree to separately. Tell us of anything we should know about (a loan, an asset bought, money taken out) as it happens.',
      ],
    });
  if (has('payroll'))
    out.push({
      heading: 'The payroll',
      paragraphs: [
        'We’ll run your payroll from what you tell us about your employees and their pay, and prepare the monthly EMP201 declarations to SARS (PAYE, and UIF and SDL where they apply), the EMP501 reconciliations, and your employees’ IRP5 and IT3(a) certificates. An employer not registered with SARS for PAYE or SDL pays UIF to the Unemployment Insurance Fund instead. Declaring your employees to the Department of Employment and Labour for UIF (uFiling) is yours, unless it’s listed above.',
        'Tell us of anyone who joins or leaves, and of any change to pay, before the pay date. Paying your employees, paying what’s due by its date, and keeping to labour law (contracts, hours, leave and the rest) are yours.',
      ],
    });
  if (has('vat'))
    out.push({
      heading: 'VAT',
      paragraphs: [
        'We’ll prepare your VAT201 returns from the books for each tax period. You keep the tax invoices and other documents the returns rely on, check each return before it’s filed, and pay what’s due by its date.',
      ],
    });
  if (has('income_tax')) out.push({ heading: tax === 'turnover' ? 'Turnover tax' : 'Income tax', paragraphs: incomeTaxParagraphs(bt, tax) });
  if (has('payroll') || has('vat') || has('income_tax'))
    out.push({
      heading: 'Dealing with SARS',
      paragraphs: [
        ...(i.practice.registered ? ['Those of us who complete, or help complete, your returns, or advise you on tax, are registered tax practitioners or work under the direct supervision of one (Tax Administration Act, section 240).'] : []),
        'Where we file your returns or deal with SARS for you, you authorise us to, on SARS eFiling, for the tax types you choose; you can withdraw that whenever you like. The returns remain your own.',
        'Send us every letter you get from SARS (a request for documents, a verification or audit, an assessment, a penalty) as soon as it comes: some have short deadlines, such as an objection to an assessment, due within 80 business days of it. Penalties and interest SARS charges are yours to pay, as the taxpayer’s, unless we agree otherwise in writing.',
      ],
    });
  if (has('compile')) {
    const purpose = specialPurposeFor(bt);
    const to = reportAddressee(bt);
    out.push({
      heading: 'Compiling the annual financial statements',
      paragraphs: [
        purpose
          ? `Their use. The financial statements are special purpose financial statements, prepared for ${purpose} (for ${bt === 'trust' ? 'the trust’s' : `the ${g.poss}`} ${tax === 'turnover' ? 'turnover tax' : 'income tax'}). If you mean to give them to anyone else, such as a bank, tell us first: our report will say they may not be suitable for other purposes.`
          : `Their use. The annual financial statements are for the ${g.many} to approve, for the business’s own use, and for those the ${g.many} give them to (such as SARS, CIPC and the bank).`,
        purpose
          ? `The framework. They’re prepared on a special purpose basis: the recognition and measurement principles of the IFRS for SMEs Accounting Standard, as note 1 to them describes.`
          : `The framework. They’re prepared in accordance with the IFRS for SMEs Accounting Standard and the requirements of ${law?.full ?? 'the Companies Act 71 of 2008'}.`,
        'What we’ll do. We’ll apply our expertise in accounting and financial reporting to help you prepare and present them, in accordance with the International Standard on Related Services 4410 (Revised), Compilation Engagements, from the books and the information you give us. A compilation is not an assurance engagement: we won’t audit or review them, or verify what you give us, and we won’t express an audit opinion or a review conclusion. It isn’t designed to find errors, fraud or breaches of the law, though we’ll tell you of any we come across, unless the law asks us not to.',
        `Our responsibilities. We’ll compile them with due care, and comply with the relevant ethical requirements${i.practice.body.trim() ? ` (${i.practice.body.trim()}’s code of professional conduct)` : ''}, including integrity, objectivity, professional competence and due care, and confidentiality. If what you give us is incomplete or misleading, we’ll ask you for more, and may withdraw from the engagement.`,
        `Your responsibilities. The ${g.many} ${are} responsible for the financial statements and for their preparation and presentation in accordance with the framework above; for such internal control as ${g.plural ? 'they find' : `the ${g.one} finds`} necessary; for the accuracy and completeness of the records, and of the information and explanations you give us; for the judgements needed to prepare them; and for approving them (${approvedBy(bt)}). As you approve them, you acknowledge that you’ve taken responsibility for the final version.`,
        `Our report. Our practitioner’s compilation report goes with them, addressed to the ${to} of the business, in the form ISRS 4410 (Revised) sets out: it says we compiled them from the information ${addresseeIsntManagement(bt) ? `the ${g.many}` : 'you'} gave us, in accordance with that standard, and that we didn’t audit or review them${purpose ? '; and, as they’re prepared for that purpose, that they may not be suitable for other purposes' : ''}.${assuranceSentence(bt)}`,
      ],
    });
  }
  if (has('accounting_officer'))
    out.push({
      heading: 'Accounting officer',
      paragraphs: [
        'We’ll act as the close corporation’s accounting officer (Close Corporations Act, sections 59 to 62). The corporation registers our appointment with CIPC, in an amended founding statement (sections 15 and 59). If any of us acting is a member or employee of the corporation, all its members consent to it in writing (section 60(3)). You give us access to the accounting records, and the information and explanations we need (section 61).',
        'Within three months of the annual financial statements being completed, we’ll work out whether they agree with the accounting records, and whether the accounting policies presented to us as applied are appropriate, and report on both to the corporation (section 62(1)). Our report describes any contravention of the Act we become aware of, and says so if any of us is a member or employee of the corporation (section 62(2)).',
        'If we come to know that the corporation isn’t carrying on business and doesn’t mean to soon, or find that a change to its founding statement wasn’t registered, or that its liabilities exceed its assets at the year end (or the statements wrongly show otherwise), we must report it to CIPC straight away by registered post (section 62(3)). An accounting officer’s report isn’t an audit or a review.',
      ],
    });

  out.push({
    heading: 'Your books in Shap',
    paragraphs: [
      i.kind === 'linked'
        ? 'You keep your books in your own Shap and have linked our practice to it: you choose what we may do there, and can unlink us whenever you like.'
        : i.kind === 'pocket'
          ? 'You keep your books in Shap Pocket and share them with us: you write them up yourself, and we work from the latest share you give us. Your figures stay yours, to change in Shap Pocket.'
          : 'We keep your books in Shap, on our practice’s server. You can ask us for a copy at any time, and when the engagement ends we’ll give you your books.',
    ],
  });
  out.push({
    heading: 'Records',
    paragraphs: [
      `You keep the business’s records, and those we give back to you, for as long as the law asks: under the Tax Administration Act, five years from the day each return they support is submitted, and longer while an audit, investigation, objection or appeal about it isn’t finished (sections 29 and 32)${COMPANIES_ACT.includes(bt) ? '; and seven years under the Companies Act, section 24' : bt === 'cc' ? '; and as long as the Close Corporations Act asks' : bt === 'coop' ? '; and as long as the Co-operatives Act asks' : ''}. We keep our own working papers of this engagement as the law and our professional body ask.`,
    ],
  });
  out.push({
    heading: 'Personal information',
    paragraphs: [
      `Doing this work, we process personal information in your records (about your employees, customers, suppliers and others). We keep it confidential (unless the law asks us to give it to someone, such as SARS under the Tax Administration Act, section 46, or to report it, as the Financial Intelligence Centre Act asks) and secure as the Protection of Personal Information Act asks, and tell you of any compromise. When the engagement ends, ${i.kind === 'kept' || i.kind === 'imported' ? 'we give you your books, and keep' : 'we keep'} what the law and our professional body ask us to keep.`,
    ],
  });
  out.push({ heading: 'Fees', paragraphs: [i.fees.trim() || 'As agreed with you separately, in writing.'] });
  out.push({
    heading: 'This letter',
    paragraphs: [
      `It applies to the year ending ${year} and to every later year until it’s replaced, or either of us ends it in writing. If what we do for you changes, or the business does, we’ll agree a new letter. Please sign a copy and return it to us, to show you accept these terms.`,
    ],
  });
  return out;
}

/** What's left of the services ticked, for this client: what the letter drafts (a Pocket client writes up their own books; an accounting officer is a CC's). */
export function servicesFor(services: readonly Service[], bt: BusinessType, kind: LetterInput['kind']): Service[] {
  return [...new Set(services)].filter((s) => (s !== 'books' || kind !== 'pocket') && (s !== 'accounting_officer' || bt === 'cc'));
}
