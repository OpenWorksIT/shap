/**
 * The engagement letter Shap drafts for a practice's client (docs/ACCOUNTANT.md, "Engagement
 * letters and working papers"): a starting point, from the client's details, that the practice reads
 * and changes before it sends it (LETTER_NOTE). For compiling the statements it covers what ISRS 4410
 * (Revised) para 24 asks the terms to say: the statements' intended use and distribution, the
 * framework, the engagement's objective and scope, the practitioner's responsibilities (ethical ones
 * included), management's, and the report's expected form and content; para 26 (a recurring
 * engagement) is why it runs on, year after year, until it's replaced.
 */
import { entity, formatDate, SERVICE_WORDS, type BusinessType, type Service } from '@shap/shared';
import { governingFor, lawFor } from '../statements/details.js';

export interface LetterSection {
  heading: string;
  paragraphs: string[];
}

export interface LetterInput {
  practice: { name: string; partner: string; body: string };
  client: { name: string; businessType: BusinessType };
  /** Where the client's books are: in the practice, from Shap Pocket shares, or on its own Shap. */
  kind: 'kept' | 'imported' | 'pocket' | 'linked';
  services: readonly Service[];
  other: string;
  /** The first year end it's for. */
  fromYearEnd: string;
  fees: string;
}

const COMPANYISH: BusinessType[] = ['company', 'inc', 'cc', 'npc', 'coop'];

/** Who approves a business's statements, and under what, in a sentence. */
function approvedBy(bt: BusinessType): string {
  switch (bt) {
    case 'company':
    case 'inc':
    case 'npc':
      return 'its board of directors (Companies Act, section 30(3)(c)), signed by a director it authorises';
    case 'cc':
      return 'members holding at least half of the members’ interest (Close Corporations Act, section 58(3))';
    case 'coop':
      return 'its board of directors';
    case 'trust':
      return 'its trustees';
    case 'partnership':
      return 'its partners';
    default:
      return 'its owner';
  }
}

export function letterSections(i: LetterInput): LetterSection[] {
  const bt = i.client.businessType;
  const g = governingFor(bt);
  const companyish = COMPANYISH.includes(bt);
  const law = lawFor(bt);
  const has = (s: Service) => i.services.includes(s);
  const year = formatDate(i.fromYearEnd, 'long');
  const out: LetterSection[] = [];

  out.push({
    heading: 'What we’ll do',
    paragraphs: [
      `This letter sets out what ${i.practice.name} (“we”) will do for ${i.client.name} (“you”, “the business”), and on what terms, for the year ending ${year} and every year after it until it’s replaced or ended:`,
      ...i.services.map((s) => `• ${SERVICE_WORDS[s]}.`),
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
        'We’ll run your payroll from what you tell us about your employees and their pay, and prepare the monthly EMP201 and the EMP501 reconciliations, with their UIF and SDL. Tell us of anyone who joins or leaves, and of any change to pay, before the pay date. Paying your employees, and paying SARS what’s due by its date, are yours.',
      ],
    });
  if (has('vat'))
    out.push({
      heading: 'VAT',
      paragraphs: [
        'We’ll prepare your VAT201 returns from the books for each tax period. You keep the tax invoices and other documents the returns rely on, check each return before it’s filed, and pay what’s due by its date.',
      ],
    });
  if (has('income_tax'))
    out.push({
      heading: 'Income tax',
      paragraphs: [
        `We’ll prepare ${entity(bt).taxedAs === 'company' || entity(bt).taxedAs === 'npc' ? 'the business’s income tax return (ITR14)' : entity(bt).taxedAs === 'trust' ? 'the trust’s income tax return (ITR12T)' : entity(bt).taxedAs === 'partners' ? 'the figures for each partner’s own income tax return' : 'your income tax return (ITR12)'} and provisional tax returns (IRP6) from the books and what you tell us. The returns are yours: you give us everything they need, check them before they’re filed, and pay what’s due by its date. Where we file them or deal with SARS for you, you authorise us to, and we do so through a registered tax practitioner (Tax Administration Act, section 240).`,
      ],
    });
  if (has('compile')) {
    const framework = companyish
      ? `the IFRS for SMEs Accounting Standard and the requirements of ${law?.full ?? 'the Companies Act 71 of 2008'}`
      : 'the basis of accounting described in note 1 to them';
    out.push({
      heading: 'Compiling the annual financial statements',
      paragraphs: [
        `Their use. The annual financial statements are for the ${g.many} to approve, for the business’s own use, and for those the ${g.many} give them to (such as SARS${companyish ? ', CIPC' : ''} and the bank).`,
        `The framework. They’re prepared in accordance with ${framework}.`,
        'What we’ll do. We’ll apply our expertise in accounting and financial reporting to help you prepare and present them, in accordance with the International Standard on Related Services 4410 (Revised), Compilation Engagements, from the books and the information you give us. A compilation is not an assurance engagement: we won’t audit or review them, or verify what you give us, and we won’t express an audit opinion or a review conclusion. It isn’t designed to find errors, fraud or breaches of the law, though we’ll tell you of any we come across.',
        `Our responsibilities. We’ll compile them with due care, and comply with the relevant ethical requirements${i.practice.body.trim() ? ` (${i.practice.body.trim()}’s code of professional conduct)` : ''}, including integrity, objectivity, professional competence and due care, and confidentiality. If what you give us is incomplete or misleading, we’ll ask you for more, and may withdraw from the engagement.`,
        `Your responsibilities. The ${g.many} are responsible for the financial statements and for their preparation and presentation in accordance with the framework above; for such internal control as they find necessary; for the accuracy and completeness of the records, and of the information and explanations you give us; for the judgements needed to prepare them; and for approving them (${approvedBy(bt)}). As you approve them, you acknowledge that you’ve taken responsibility for the final version.`,
        `Our report. Our practitioner’s compilation report goes with them, in the form ISRS 4410 (Revised) sets out: it says we compiled them from the information you gave us, in accordance with that standard, and that we didn’t audit or review them.${['company', 'inc', 'npc'].includes(bt) ? ' Whether the business must instead be audited or independently reviewed (Companies Regulations 28 and 29) is worked out each year: a compilation is neither.' : ''}`,
      ],
    });
  }
  if (has('accounting_officer') && bt === 'cc')
    out.push({
      heading: 'Accounting officer',
      paragraphs: [
        'We’ll act as the close corporation’s accounting officer (Close Corporations Act, sections 59 to 62): each year we’ll report to the members on the annual financial statements as section 62 asks, and report what it asks us to report, to the members and, where it says so, to CIPC. Tell us if anything changes that the Act asks us to know of.',
      ],
    });

  out.push({
    heading: 'Your books in Shap',
    paragraphs: [
      i.kind === 'linked'
        ? 'You keep your books in your own Shap and have linked our practice to it: you choose what we may do there, and can unlink us whenever you like.'
        : i.kind === 'pocket'
          ? 'You keep your books in Shap Pocket and share them with us: we work from the latest share you give us, and your figures stay yours, to change in Shap Pocket.'
          : 'We keep your books in Shap, on our practice’s server. You can ask us for a copy at any time, and when the engagement ends we’ll give you your books.',
    ],
  });
  out.push({
    heading: 'Records',
    paragraphs: [
      `You keep the business’s records, and those we give back to you, for as long as the law asks (at least five years under the Tax Administration Act, section 29${companyish ? '; seven for a company’s under the Companies Act, section 24' : ''}). We keep our own working papers of this engagement as the law and our professional body ask.`,
    ],
  });
  out.push({
    heading: 'Personal information',
    paragraphs: [
      'Doing this work, we process personal information in your records (about your employees, customers, suppliers and others) for you, and only for this engagement. We keep it confidential and secure as the Protection of Personal Information Act asks (sections 19 to 22), tell you of any compromise, and give it back or delete it when the engagement ends, but for what the law asks us to keep.',
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
