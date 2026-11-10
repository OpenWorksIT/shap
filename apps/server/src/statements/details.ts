/**
 * The words around the figures (packages/shared/src/financial-statements.ts): kept once for the
 * business, each with Shap's default until the owner or accountant changes it. The defaults
 * follow the IFRS for SMEs Accounting Standard (sections 2, 3, 11, 13, 17, 18, 20, 23, 28, 29) and,
 * for companies, the Companies Act 71 of 2008 (s30: statements approved by the board, signed by
 * an authorised director, with a directors' report; s30(2A): an owner-managed company is exempt
 * from audit and independent review).
 * https://www.ifrs.org/issued-standards/ifrs-for-smes/
 * https://www.acts.co.za/companies-act-2008/30_annual_financial_statements
 */
import { entity, formatZar, statementDetailsInput, type BusinessType, type PolicyKey, type StatementDetailsInput } from '@shap/shared';
import type { Db } from '../db/index.js';

export type StatementDetails = StatementDetailsInput;

export interface PolicyContext {
  /** Each class of asset on the register and how long it's depreciated over. */
  lives: { category: string; months: number }[];
  employees: boolean;
  leases: boolean;
  deferredTax: boolean;
}

const COMPANYISH: BusinessType[] = ['company', 'inc', 'cc', 'npc', 'coop'];

/**
 * The Act an incorporated business keeps its books and reports under (null for anyone else): a
 * company under the Companies Act, a close corporation under the Close Corporations Act (with its
 * accounting officer's report, s62), a co-operative under the Co-operatives Act.
 */
export const lawFor = (t: BusinessType): { full: string; short: string } | null =>
  t === 'company' || t === 'inc' || t === 'npc'
    ? { full: 'the Companies Act 71 of 2008', short: 'the Companies Act' }
    : t === 'cc'
      ? { full: 'the Close Corporations Act 69 of 1984', short: 'the Close Corporations Act' }
      : t === 'coop'
        ? { full: 'the Co-operatives Act 14 of 2005', short: 'the Co-operatives Act' }
        : null;

/** Who governs the business, as the statements name them (and whether that's one person). */
export const governingFor = (t: BusinessType) =>
  ({
    sole_prop: { one: 'owner', many: 'owner', signs: 'Owner', plural: false, poss: 'owner’s' },
    partnership: { one: 'partner', many: 'partners', signs: 'Partner', plural: true, poss: 'partners’' },
    company: { one: 'director', many: 'directors', signs: 'Director', plural: true, poss: 'directors’' },
    inc: { one: 'director', many: 'directors', signs: 'Director', plural: true, poss: 'directors’' },
    cc: { one: 'member', many: 'members', signs: 'Member', plural: true, poss: 'members’' },
    trust: { one: 'trustee', many: 'trustees', signs: 'Trustee', plural: true, poss: 'trustees’' },
    npc: { one: 'director', many: 'directors', signs: 'Director', plural: true, poss: 'directors’' },
    coop: { one: 'director', many: 'directors', signs: 'Director', plural: true, poss: 'directors’' },
  })[t];

export function defaultPolicies(bt: BusinessType, ctx: PolicyContext = { lives: [], employees: false, leases: false, deferredTax: false }): Record<PolicyKey, string> {
  const kind = entity(bt);
  const company = COMPANYISH.includes(bt);
  const who = company ? 'The company' : `The ${kind.label.toLowerCase().replace(/\s*\(.*\)$/, '')}`;
  const lives = ctx.lives.length
    ? ` The useful lives used are: ${ctx.lives.map((l) => `${l.category} ${l.months % 12 === 0 ? `${l.months / 12} year${l.months === 12 ? '' : 's'}` : `${l.months} months`}`).join('; ')}.`
    : '';
  return {
    basis: company
      ? `The annual financial statements have been prepared in accordance with the IFRS for SMEs Accounting Standard and the requirements of ${lawFor(bt)?.full ?? 'the Companies Act 71 of 2008'} of South Africa. They are prepared on the historical cost basis and presented in South African Rand. The accounting policies are consistent with those of the previous year.`
      : `The financial statements have been prepared using the recognition and measurement principles of the IFRS for SMEs Accounting Standard, for the ${kind.owner.many} and the South African Revenue Service. They are prepared on the historical cost basis and presented in South African Rand. The accounting policies are consistent with those of the previous year.`,
    going_concern: `The financial statements are prepared on the going concern basis: ${who.toLowerCase()} is expected to continue operating for the foreseeable future.`,
    revenue:
      'Revenue is the fair value of what is received or receivable for goods sold and services rendered in the ordinary course of business, excluding value-added tax, after discounts and returns. Revenue from selling goods is recognised when the goods are delivered and their risks and rewards have passed to the buyer. Revenue from services is recognised as the work is performed.',
    ppe: `Property, plant and equipment is carried at cost less accumulated depreciation and any impairment loss. Depreciation is charged on the straight-line basis over each asset’s expected useful life to its residual value.${lives} Useful lives and residual values are reviewed when there is an indication that they have changed. The profit or loss on disposing of an asset is the difference between what it was sold for and its carrying amount.`,
    intangibles:
      'Intangible assets (patents, trade marks and software) are carried at cost less accumulated amortisation and any impairment loss, and amortised on the straight-line basis over their expected useful lives.',
    inventories:
      'Inventories are measured at the lower of cost and estimated selling price less costs to complete and sell. Cost is determined using the weighted average cost formula and includes the purchase price and the other costs of bringing the inventories to their present location and condition. When inventories are sold, their carrying amount is recognised as an expense in cost of sales. Losses, shortages found when inventories are counted, and write-downs to estimated selling price are recognised in cost of sales when they occur.',
    financial_instruments:
      'Trade and other receivables, cash and cash equivalents, trade and other payables and loans are basic financial instruments, measured at the undiscounted amount of cash expected to be received or paid, less any impairment for receivables that will not be recovered. Loans that bear no interest and have no fixed terms of repayment are measured at the amount payable.',
    tax:
      kind.taxedAs === 'partners' || kind.taxedAs === 'individual'
        ? `${who} is not itself a taxpayer: its profit is taxed in the hands of the ${kind.owner.many}, so no income tax is provided in these financial statements.`
        : `Income tax expense is the tax payable on the taxable profit for the year, at the rates enacted at the reporting date.${ctx.deferredTax ? ' Deferred tax is recognised on the differences between the carrying amounts of assets and liabilities and their tax bases, at the rates expected to apply.' : ''}`,
    leases: ctx.leases ? 'Payments under operating leases (rent) are recognised as an expense on the straight-line basis over the lease term.' : '',
    employee_benefits: ctx.employees ? 'The cost of short-term employee benefits (salaries, leave and contributions) is recognised as an expense in the period the service is rendered.' : '',
    judgements:
      'Preparing financial statements calls for estimates and judgements: chiefly the useful lives of assets, whether receivables will be recovered and, where inventories are held, their value. They are based on experience and reviewed regularly.',
  };
}

/** The defaults for a business that hasn't filled anything in yet. */
export function defaultDetails(bt: BusinessType, owners: string[] = []): StatementDetails {
  const kind = entity(bt);
  const company = COMPANYISH.includes(bt);
  const role = ({ cc: 'Member', trust: 'Trustee', partnership: 'Partner', sole_prop: 'Owner' } as Partial<Record<BusinessType, string>>)[bt] ?? 'Director';
  const g = governingFor(bt);
  return statementDetailsInput.parse({
    directors: owners.map((name) => ({ name, role })),
    loanTerms: `The loans from the ${kind.owner.many} are unsecured, bear no interest and have no fixed terms of repayment.`,
    eventsAfter: `The ${g.many} ${g.plural ? 'are' : 'is'} not aware of any material event after the reporting date that requires the financial statements to be adjusted or disclosed.`,
    goingConcern: `The financial statements have been prepared on the going concern basis. The ${g.many} ${g.plural ? 'have' : 'has'} no reason to believe that the business will not be a going concern in the year ahead.`,
    ownerManaged: true,
  });
}

export async function loadDetails(db: Db): Promise<StatementDetails> {
  const [s] = await db<{ businessType: BusinessType }[]>`select business_type from settings where id`;
  const [row] = await db<{ details: Record<string, unknown> }[]>`select details from statement_details where id`;
  const owners = (await db<{ name: string }[]>`select name from users where role = 'owner' and active order by created_at limit 4`).map((u) => u.name);
  const base = defaultDetails(s!.businessType, owners);
  if (!row) return base;
  const saved = statementDetailsInput.safeParse(row.details);
  return saved.success ? { ...base, ...Object.fromEntries(Object.entries(saved.data).filter(([, v]) => !(typeof v === 'string' && v === ''))) } as StatementDetails : base;
}

export async function saveDetails(db: Db, details: StatementDetails): Promise<void> {
  await db`insert into statement_details (id, details, updated_at) values (true, ${db.json(details as never)}, now())
    on conflict (id) do update set details = excluded.details, updated_at = now()`;
}

/** The directors' (members', trustees'…) report: Companies Act s30(3)(b) (for a CC, s58 of its Act), in plain words, from the figures. */
export function directorsReport(s: {
  company: { name: string; businessType: BusinessType; kind: string };
  governing: { many: string; plural?: boolean };
  details: StatementDetails;
  period: string;
  profit: { current: number; prior: number };
  hasPrior: boolean;
  distributions: number;
  distributionsLabel: string;
  /** A sole proprietor's or partners' money put in (+) or taken out (−) during the year; null for others. */
  ownersNet?: number | null;
  /** Taxed as a company (its profit is after tax). */
  taxed?: boolean;
  shareChange: number;
  industry: string;
}): { title: string; text: string }[] {
  const bt = s.company.businessType;
  const d = s.details;
  const many = s.governing.many;
  const money = (c: number) => formatZar(Math.abs(c));
  const result = s.profit.current >= 0 ? `a profit of ${money(s.profit.current)}` : `a loss of ${money(s.profit.current)}`;
  const was = s.hasPrior ? ` (the year before: ${s.profit.prior >= 0 ? 'a profit of' : 'a loss of'} ${money(s.profit.prior)})` : '';
  const out: { title: string; text: string }[] = [
    { title: 'Nature of the business', text: d.natureOfBusiness || `${s.company.name} is a ${s.company.kind.replace(/\s*\(.*\)\s*$/, '').toLowerCase()} trading in South Africa${s.industry ? ` (${s.industry.toLowerCase()})` : ''}.` },
    { title: 'Financial results', text: `The results ${s.period} are set out in these financial statements. The year ended with ${result}${s.taxed === false ? '' : ' after tax'}${was}.` },
  ];
  if (COMPANYISH.includes(bt)) out.push({ title: bt === 'cc' ? 'Members’ contributions' : 'Share capital', text: s.shareChange === 0 ? 'There were no changes in the share capital during the year.' : `Share capital changed by ${money(s.shareChange)} during the year (note on share capital).` });
  if (s.ownersNet != null)
    out.push({
      title: 'Contributions and drawings',
      text:
        s.ownersNet === 0
          ? `The ${many}’s contributions and drawings during the year net to nothing.`.replace('s’s', 's’')
          : `The ${many} ${s.ownersNet > 0 ? 'contributed' : 'drew'} a net ${money(s.ownersNet)} ${s.ownersNet > 0 ? 'to' : 'from'} the business during the year (statement of changes in equity).`,
    });
  else out.push({ title: s.distributionsLabel, text: s.distributions ? `${s.distributionsLabel} of ${money(s.distributions)} were declared during the year.` : `No ${s.distributionsLabel.toLowerCase()} were declared during the year.` });
  out.push({ title: many.charAt(0).toUpperCase() + many.slice(1), text: d.directors.length ? d.directors.map((x) => `${x.name}${x.role ? ` (${x.role})` : ''}`).join('; ') : '(to be completed)' });
  if (d.secretary) out.push({ title: 'Secretary', text: d.secretary });
  if (d.holdingCompany) out.push({ title: 'Holding company', text: d.holdingCompany });
  out.push({ title: 'Events after the reporting period', text: d.eventsAfter });
  out.push({ title: 'Going concern', text: d.goingConcern });
  const assurance =
    d.assurance === 'compiled'
      ? `These financial statements were compiled by ${d.compiler.name || 'an independent accountant'}${d.compiler.practice ? ` of ${d.compiler.practice}` : ''}. They have not been audited or independently reviewed${bt === 'company' && d.ownerManaged ? ': every shareholder is also a director, so the company is exempt from an independent review (Companies Act s30(2A)); it would still need an audit if the Companies Regulations (its public interest score, or assets held for others) or its Memorandum of Incorporation called for one' : ''}.`
      : d.assurance === 'independent_review'
        ? 'These financial statements have been independently reviewed (the reviewer’s report is attached).'
        : d.assurance === 'audit'
          ? 'These financial statements have been audited (the auditor’s report is attached).'
          : `These financial statements were prepared by the ${many} and have not been audited, reviewed or compiled by an independent accountant.`;
  out.push({ title: 'Preparation and assurance', text: assurance });
  return out;
}
