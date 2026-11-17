/**
 * The 1.31.0 reviews of the engagement letter Shap drafts (lib/engagement.ts): the law it states, for
 * each kind of business and each service, and what it promises. Each check failed on the letter as
 * the reviews found it. The law: Close Corporations Act s58(3) (51 per cent), s58(2A), s59-62;
 * Co-operatives Act s47; Companies Regulations 28 and 29; TAA s29, s32, s46, s240; FICA s29(3);
 * SARS on the IT12EI, turnover tax and objections. All data made up.
 */
import { describe, expect, it } from 'vitest';
import { accountantTermsPoints, ACCOUNTANT_TERMS_MEANS, LETTER_NOTE, SERVICE_WORDS, type BusinessType, type Service } from '@shap/shared';
import { letterSections, servicesFor, type LetterInput } from '../../src/lib/engagement.js';

const letter = (o: { bt: BusinessType; services: Service[]; kind?: LetterInput['kind']; approvedPbo?: boolean; turnoverTax?: boolean; registered?: boolean }) =>
  letterSections({
    practice: { body: 'SAIPA', registered: o.registered ?? false },
    client: { businessType: o.bt, approvedPbo: o.approvedPbo ?? false, turnoverTax: o.turnoverTax ?? false },
    kind: o.kind ?? 'kept',
    services: o.services,
    other: '',
    fromYearEnd: '2026-02-28',
    fees: '',
  });
const text = (o: Parameters<typeof letter>[0]) =>
  letter(o)
    .map((s) => [s.heading, ...s.paragraphs].join('\n'))
    .join('\n');
const part = (o: Parameters<typeof letter>[0], heading: string) => {
  const s = letter(o).find((x) => x.heading === heading);
  return s ? s.paragraphs.join('\n') : null;
};
const ALL: Service[] = ['books', 'payroll', 'vat', 'income_tax', 'compile', 'accounting_officer'];
const KINDS: BusinessType[] = ['sole_prop', 'partnership', 'company', 'inc', 'cc', 'trust', 'npc', 'coop'];

describe('the engagement letter states the law rightly', () => {
  it('a close corporation’s statements are approved by members holding at least 51 per cent of the members’ interest (s58(3))', () => {
    const cc = text({ bt: 'cc', services: ['compile'] });
    expect(cc).toMatch(/at least 51 per cent of the members’ interest/);
    expect(cc).not.toMatch(/at least half/);
    // The same in the points shown before a practice accepts the terms, and what accepting means.
    expect(accountantTermsPoints().map((p) => p.body).join(' ')).toMatch(/for a close corporation, members holding at least 51 per cent of the members’ interest/);
    expect(accountantTermsPoints().map((p) => p.body).join(' ')).not.toMatch(/at least half/);
    expect(ACCOUNTANT_TERMS_MEANS).toMatch(/drafted engagement letters and working papers are aids and estimates, not advice/);
  });

  it('a sole proprietor’s letter is good English for one owner', () => {
    const t = text({ bt: 'sole_prop', services: ['compile'] });
    expect(t).not.toMatch(/The owner are|the owner give|\(its owner\)|\(its trustees\)/);
    expect(t).toMatch(/The owner is responsible for the financial statements/);
    expect(t).toMatch(/such internal control as the owner finds necessary/);
    expect(t).toMatch(/approving them \(by its owner\)/);
    expect(text({ bt: 'trust', services: ['compile'] })).toMatch(/approving them \(by its trustees\)/);
  });

  it('a sole proprietor’s, a partnership’s or a trust’s statements are special purpose: for them and SARS, and the report will say they may not suit other purposes', () => {
    for (const bt of ['sole_prop', 'partnership', 'trust'] as const) {
      const t = part({ bt, services: ['compile'] }, 'Compiling the annual financial statements')!;
      expect(t).toMatch(/special purpose financial statements/);
      expect(t).toMatch(/and the South African Revenue Service/);
      expect(t).toMatch(/may not be suitable for other purposes/);
      // No wider use promised (the bank was).
      expect(t).not.toMatch(/such as SARS, CIPC and the bank/);
    }
    expect(part({ bt: 'sole_prop', services: ['compile'] }, 'Compiling the annual financial statements')).toMatch(/prepared for the owner and the South African Revenue Service \(for the owner’s income tax\)/);
    expect(part({ bt: 'trust', services: ['compile'] }, 'Compiling the annual financial statements')).toMatch(/prepared for the trustees, the beneficiaries and the South African Revenue Service \(for the trust’s income tax\)/);
    // A company's are general purpose, under the IFRS for SMEs Accounting Standard and its Act.
    const co = part({ bt: 'company', services: ['compile'] }, 'Compiling the annual financial statements')!;
    expect(co).not.toMatch(/special purpose/);
    expect(co).toMatch(/in accordance with the IFRS for SMEs Accounting Standard and the requirements of the Companies Act 71 of 2008/);
  });

  it('the letter says whom the compilation report is addressed to (para 40(b)), and who gave the information', () => {
    const want: Record<BusinessType, string> = { company: 'shareholders', inc: 'shareholders', npc: 'directors', cc: 'members', coop: 'members', sole_prop: 'owner', partnership: 'partners', trust: 'trustees' };
    for (const bt of KINDS) expect(part({ bt, services: ['compile'] }, 'Compiling the annual financial statements')).toMatch(new RegExp(`addressed to the ${want[bt]} of the business`));
    expect(part({ bt: 'company', services: ['compile'] }, 'Compiling the annual financial statements')).toMatch(/compiled them from the information the directors gave us/);
    expect(part({ bt: 'cc', services: ['compile'] }, 'Compiling the annual financial statements')).toMatch(/compiled them from the information you gave us/);
  });

  it('an audit or review: in addition for a company, always for an NPC, where the regulations ask for a CC, by category for a co-op', () => {
    const report = (bt: BusinessType) => part({ bt, services: ['compile'] }, 'Compiling the annual financial statements')!;
    for (const bt of ['company', 'inc'] as const) {
      expect(report(bt)).toMatch(/must also be audited or independently reviewed is worked out each year/);
      expect(report(bt)).toMatch(/a separate engagement, and a compilation is neither/);
      expect(report(bt)).not.toMatch(/must instead/);
    }
    expect(report('npc')).toMatch(/A non-profit company’s statements are always audited or independently reviewed as well/);
    expect(report('cc')).toMatch(/Close Corporations Act, section 58\(2A\), and Companies Regulation 28/);
    expect(report('coop')).toMatch(/independently reviewed if it’s a category B co-operative, unless it’s a category A co-operative \(Co-operatives Act, section 47\)/);
    for (const bt of ['sole_prop', 'partnership', 'trust'] as const) expect(report(bt)).not.toMatch(/audited/);
  });

  it('the accounting officer’s duties, as sections 59 to 62 of the Close Corporations Act have them', () => {
    const ao = part({ bt: 'cc', services: ['accounting_officer'] }, 'Accounting officer')!;
    for (const said of [
      /registers our appointment with CIPC, in an amended founding statement \(sections 15 and 59\)/,
      /all its members consent to it in writing \(section 60\(3\)\)/,
      /access to the accounting records, and the information and explanations we need \(section 61\)/,
      /Within three months of the annual financial statements being completed/,
      /whether they agree with the accounting records/,
      /whether the accounting policies presented to us as applied are appropriate/,
      /describes any contravention of the Act/,
      /says so if any of us is a member or employee/,
      /report it to CIPC straight away by registered post \(section 62\(3\)\)/,
      /liabilities exceed its assets/,
      /isn’t an audit or a review/,
    ])
      expect(ao).toMatch(said);
    // Only a close corporation's: not drafted for anyone else.
    for (const bt of KINDS.filter((k) => k !== 'cc')) expect(part({ bt, services: ALL }, 'Accounting officer')).toBeNull();
  });
});

describe('the letter’s tax follows how the client is taxed', () => {
  it('an approved PBO: the IT12EI, and no provisional tax', () => {
    const t = text({ bt: 'npc', services: ['income_tax'], approvedPbo: true });
    expect(t).toMatch(/IT12EI/);
    expect(t).toMatch(/isn’t a provisional taxpayer/);
    expect(t).not.toMatch(/ITR14|IRP6/);
    expect(t).not.toMatch(SERVICE_WORDS.income_tax);
  });

  it('turnover tax: the TT02 and TT03, not the ITR14 or IRP6; a sole proprietor’s ITR12 for other income; each partner’s own', () => {
    const co = text({ bt: 'company', services: ['income_tax'], turnoverTax: true });
    expect(co).toMatch(/TT02 interim payments and the TT03 annual return/);
    expect(co).not.toMatch(/ITR14|IRP6/);
    const sp = text({ bt: 'sole_prop', services: ['income_tax'], turnoverTax: true });
    expect(sp).toMatch(/TT03/);
    expect(sp).toMatch(/Your own income tax return \(the ITR12\), for any income outside the business/);
    expect(sp).not.toMatch(/IRP6/);
    const pt = text({ bt: 'partnership', services: ['income_tax'], turnoverTax: true });
    expect(pt).toMatch(/each partner registered for turnover tax files their own/);
    // The list says the same as the paragraph (the checks of the fixes).
    expect(pt).not.toMatch(/• Prepare the turnover tax returns/);
    expect(pt).toMatch(/• Give each partner the partnership’s figures for their own turnover tax returns \(TT02 and TT03\)\./);
    // A company, CC or co-op on turnover tax still pays dividends tax beyond what turnover tax exempts.
    for (const bt of ['company', 'cc', 'coop'] as const) expect(text({ bt, services: ['income_tax'], turnoverTax: true })).toMatch(/Dividends tax returns \(DTR01\) for dividends it pays \(turnover tax exempts the first R200 000 a year\) aren’t included unless they’re listed above/);
    // The statements serve turnover tax, not income tax.
    const compiled = part({ bt: 'sole_prop', services: ['compile'], turnoverTax: true }, 'Compiling the annual financial statements')!;
    expect(compiled).toMatch(/\(for the owner’s turnover tax\)/);
    expect(compiled).not.toMatch(/income tax/);
    expect(part({ bt: 'partnership', services: ['compile'], turnoverTax: true }, 'Compiling the annual financial statements')).toMatch(/\(for the partners’ turnover tax\)/);
  });

  it('a partnership isn’t a taxpayer: each partner’s returns are their own, prepared only as agreed with them', () => {
    const t = text({ bt: 'partnership', services: ['income_tax'] });
    expect(t).toMatch(/A partnership isn’t itself a taxpayer/);
    expect(t).toMatch(/prepared only as agreed with that partner/);
    expect(t).not.toMatch(/The returns are yours/);
  });

  it('a trust’s IT3(t); a company’s dividends tax only if it’s listed', () => {
    expect(text({ bt: 'trust', services: ['income_tax'] })).toMatch(/ITR12T.*IT3\(t\)/s);
    expect(text({ bt: 'company', services: ['income_tax'] })).toMatch(/Dividends tax returns \(DTR01\) aren’t included unless they’re listed above/);
  });

  it('dealing with SARS, for every tax service: section 240 as it is, eFiling authority, SARS letters, penalties', () => {
    for (const services of [['vat'], ['payroll'], ['income_tax']] as Service[][]) {
      // That its people are registered is the practice's to say: only when it ticks that it's so.
      expect(part({ bt: 'company', services }, 'Dealing with SARS')).not.toMatch(/are registered tax practitioners/);
      const sars = part({ bt: 'company', services, registered: true }, 'Dealing with SARS')!;
      expect(sars).toMatch(/complete, or help complete, your returns, or advise you on tax, are registered tax practitioners or work under the direct supervision of one \(Tax Administration Act, section 240\)/);
      expect(sars).toMatch(/on SARS eFiling, for the tax types you choose; you can withdraw that/);
      expect(sars).toMatch(/80 business days/);
      expect(sars).toMatch(/Penalties and interest SARS charges are yours to pay/);
    }
    expect(part({ bt: 'company', services: ['compile'] }, 'Dealing with SARS')).toBeNull();
    // Filing isn't said to go "through a registered tax practitioner".
    expect(text({ bt: 'company', services: ['income_tax'] })).not.toMatch(/through a registered tax practitioner/);
  });

  it('the payroll: UIF and SDL where they apply, the Department of Employment and Labour, the certificates, and labour law is theirs', () => {
    const pay = part({ bt: 'company', services: ['payroll'] }, 'The payroll')!;
    expect(pay).toMatch(/UIF and SDL where they apply/);
    expect(pay).toMatch(/pays UIF to the Unemployment Insurance Fund instead/);
    expect(pay).toMatch(/Department of Employment and Labour/);
    expect(pay).toMatch(/IRP5 and IT3\(a\) certificates/);
    expect(pay).toMatch(/keeping to labour law/);
    expect(SERVICE_WORDS.payroll).not.toMatch(/UIF and SDL returns/);
  });
});

describe('what the letter promises', () => {
  it('records: five years from each return under the TAA (longer during an audit); seven under the Companies Act for companies only', () => {
    const rec = (bt: BusinessType) => part({ bt, services: ['compile'] }, 'Records')!;
    for (const bt of KINDS) expect(rec(bt)).toMatch(/five years from the day each return they support is submitted, and longer while an audit, investigation, objection or appeal about it isn’t finished \(sections 29 and 32\)/);
    for (const bt of ['company', 'inc', 'npc'] as const) expect(rec(bt)).toMatch(/seven years under the Companies Act, section 24/);
    for (const bt of ['cc', 'coop', 'sole_prop', 'trust', 'partnership'] as const) expect(rec(bt)).not.toMatch(/Companies Act|seven/);
    expect(rec('cc')).toMatch(/as long as the Close Corporations Act asks/);
    expect(rec('coop')).toMatch(/as long as the Co-operatives Act asks/);
  });

  it('what it finds, and what it keeps confidential, give way where the law asks (FICA s29(3), TAA s46)', () => {
    expect(part({ bt: 'company', services: ['compile'] }, 'Compiling the annual financial statements')).toMatch(/we’ll tell you of any we come across, unless the law asks us not to/);
    expect(part({ bt: 'company', services: ['compile'] }, 'Personal information')).toMatch(/unless the law asks us to give it to someone, such as SARS under the Tax Administration Act, section 46/);
  });

  it('personal information: no promise to delete, and no role under POPIA picked for the practice', () => {
    for (const kind of ['kept', 'imported', 'pocket', 'linked'] as const) {
      const pi = part({ bt: 'company', services: ['compile'], kind }, 'Personal information')!;
      expect(pi).not.toMatch(/delete it|only for this engagement|for you, and only/);
      expect(pi).not.toMatch(/keep(ing)? only/);
      expect(pi).toMatch(/keep what the law and our professional body ask us to keep\./);
    }
    expect(part({ bt: 'company', services: ['compile'], kind: 'kept' }, 'Personal information')).toMatch(/we give you your books, and keep what the law/);
  });

  it('a Shap Pocket client writes up their own books: the practice doesn’t offer to', () => {
    const t = text({ bt: 'sole_prop', services: ['books', 'compile'], kind: 'pocket' });
    expect(t).not.toMatch(/We’ll write up your books/);
    expect(t).not.toMatch(new RegExp(SERVICE_WORDS.books));
    expect(t).toMatch(/you write them up yourself/);
    expect(servicesFor(['books', 'compile'], 'sole_prop', 'pocket')).toEqual(['compile']);
    expect(servicesFor(['books', 'accounting_officer'], 'company', 'kept')).toEqual(['books']);
  });

  it('LETTER_NOTE says the draft isn’t complete or checked, and to check it', () => {
    expect(LETTER_NOTE).toMatch(/not complete, and not checked against the law or your professional body’s rules/);
    expect(LETTER_NOTE).toMatch(/an attorney, for anything legal/);
    expect(LETTER_NOTE).toMatch(/OpenWorks IT aren’t lawyers, accountants or tax practitioners/);
  });

  it('names no party in its words: the letter’s own record does, and its PDF heads it with them', () => {
    const t = text({ bt: 'company', services: ALL });
    expect(t).toMatch(/what we, the practice named above, will do for you, the business named above/);
  });
});
