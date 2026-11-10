/**
 * The public interest score (Companies Regulations, 2011, regulation 26(2)) and what it points to:
 * which financial reporting framework (regulation 27), and whether the annual financial statements
 * must be audited (regulation 28) or independently reviewed (regulation 29), or a compilation is
 * enough (exempt under section 30(2A) when every shareholder is a director). A close corporation
 * works out the same score: an audit when it says so, otherwise its accounting officer's report
 * (Close Corporations Act s62).
 *
 * Shap works it out from the books as an aid: it is an estimate, not advice. The interpretation
 * (who counts as an employee, which liabilities are to third parties) is for the business and its
 * accountant. https://www.acts.co.za/companies_act_2008/r351_26__interpretation_of_regulations_affecting_transparency_and_accountability
 */
import type { BusinessType } from './entities.js';

export interface PiInputs {
  /** The average number of employees during the financial year. */
  employees: number;
  /** Liabilities to third parties at the year end, in cents. */
  liabilitiesCents: number;
  /** Turnover during the financial year, in cents. */
  turnoverCents: number;
  /** Individuals with a beneficial interest in its securities (a CC's members; an NPC's members). */
  holders: number;
}

const millionsOrPart = (cents: number) => (cents > 0 ? Math.ceil(cents / 100_000_000) : 0);

/** Regulation 26(2): employees, plus a point per R1 million (or part) of liabilities and of turnover, plus a point per holder. */
export function publicInterestScore(p: PiInputs) {
  const parts = {
    employees: Math.round(p.employees),
    liabilities: millionsOrPart(p.liabilitiesCents),
    turnover: millionsOrPart(p.turnoverCents),
    holders: Math.max(0, Math.round(p.holders)),
  };
  return { ...parts, score: parts.employees + parts.liabilities + parts.turnover + parts.holders };
}

/** Kinds of business the score applies to. */
export const PI_APPLIES: readonly BusinessType[] = ['company', 'inc', 'npc', 'cc'];

export interface PiMeaning {
  audit: boolean;
  /** Why an audit, or why not. */
  auditWhy: string;
  /** An independent review instead: by whom (null: none needed). */
  review: null | 'auditor' | 'accounting_officer';
  framework: string;
  /** What the business needs, in a sentence. */
  summary: string;
}

/**
 * What a score points to, for a private company (or a CC, an NPC): `independentlyCompiled` when an
 * independent accounting professional compiles the statements; `ownerManaged` when every
 * shareholder is also a director (s30(2A)). Not for public or state-owned companies, or a company
 * holding more than R5 million for others in a fiduciary capacity (always audited, regulation 28(2)(a)).
 */
export function whatScoreMeans(score: number, bt: BusinessType, o: { independentlyCompiled: boolean; ownerManaged: boolean }): PiMeaning {
  const audit = score >= 350 || (score >= 100 && !o.independentlyCompiled);
  const auditWhy = score >= 350 ? 'a score of 350 or more (regulation 28(2)(c)(i))' : audit ? 'a score of 100 or more with the statements compiled internally (regulation 28(2)(c)(ii))' : 'a score below 350, and below 100 or compiled independently';
  const framework =
    score >= 100 || o.independentlyCompiled
      ? 'IFRS, or the IFRS for SMEs Accounting Standard (regulation 27(4))'
      : 'the financial reporting standard the business chooses, as long as none is prescribed (regulation 27(4)); Shap uses the IFRS for SMEs Accounting Standard';
  if (bt === 'cc') {
    return {
      audit,
      auditWhy,
      review: null,
      framework,
      summary: audit ? `An audit, for ${auditWhy}.` : 'No audit: the accounting officer’s report (Close Corporations Act s62) goes with the statements.',
    };
  }
  if (audit) return { audit, auditWhy, review: null, framework, summary: `An audit, for ${auditWhy}. An audited company names each director’s remuneration (Companies Act s30(4)).` };
  if (o.ownerManaged && bt !== 'npc')
    return { audit, auditWhy, review: null, framework, summary: 'No audit or independent review: every shareholder is a director (Companies Act s30(2A)), so a compilation is enough.' };
  const review = score >= 100 ? 'auditor' : 'accounting_officer';
  return {
    audit,
    auditWhy,
    review,
    framework,
    summary:
      review === 'auditor'
        ? 'An independent review (regulation 29), by a registered auditor or a member of an accredited professional body, who didn’t compile the statements.'
        : 'An independent review (regulation 29), which may be done by someone qualified to be a close corporation’s accounting officer, who didn’t compile the statements.',
  };
}
