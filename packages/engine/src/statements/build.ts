/**
 * The annual financial statements, built from the books (IFRS for SMEs Accounting Standard,
 * https://www.ifrs.org/issued-standards/ifrs-for-smes/), for the year ending on a date, with the
 * year before as comparatives (3.14):
 *   the statement of financial position (section 4), current and non-current (4.4);
 *   the statement of comprehensive income, a single statement, expenses by function (cost of sales
 *   apart: 5.2(a), 5.11(b));
 *   the statement of changes in equity (section 6);
 *   the statement of cash flows by the indirect method (7.7, 7.8);
 *   notes, the accounting policies first (section 8).
 * Each account lands on its statement line (accounts.statement_line, statement-lines.ts). The
 * statements read the ledger as reported, year-end adjustments included, so an agreed year shows
 * its agreed figures. Amounts are in cents throughout and shown to the cent, so every statement
 * adds up exactly to the books and to each other (the checks at the end prove it).
 */
import {
  addDays,
  addMonths,
  monthEnd,
  companyRate,
  estimateTax,
  assessedLossSetOff,
  SBC_GROSS_INCOME_LIMIT_CENTS,
  sbcApplies,
  sha256Hex,
  PI_APPLIES,
  publicInterestScore,
  whatScoreMeans,
  type PiMeaning,
  entity,
  featureOn,
  formatZar,
  vatRateOn,
  flipOf,
  formatDate,
  INDUSTRIES,
  SECTION_LABELS,
  STATEMENT_LINES,
  statementLineLabel,
  type AccountType,
  type BusinessType,
  type PolicyKey,
  type StatementLineKey,
  type StatementSection,
} from '@shap/shared';
import type { Db } from '../db/index.js';
import { assessedLossBefore, freshTotals, getSettings, sbcAnswer } from '../lib/books.js';
import { defaultPolicies, directorsReport, governingFor, type StatementDetails, loadDetails } from './details.js';

export interface Amounts {
  current: number;
  prior: number;
}
export interface Line extends Amounts {
  key: string;
  label: string;
  note?: number;
}
export interface Block extends Amounts {
  key: string;
  label: string;
  lines: Line[];
}
export interface Note {
  number: number;
  key: string;
  title: string;
  paragraphs: string[];
  tables: { head?: string[]; rows: { label: string; current: number | null; prior: number | null; bold?: boolean }[] }[];
}

/**
 * How the statements are drawn: 2 from 1.23, whose fingerprint is of the books themselves (so a
 * later Shap that draws the same books differently still finds signed statements unchanged).
 * Snapshots without it were signed on 1.22 or before.
 */
export const BUILDER = 2;

export interface Statements {
  /** BUILDER when drawn (none on a snapshot from before 1.23). */
  builder?: number;
  /** A fingerprint of what the statements are drawn from: each account's figures for both years, and the kind of business. */
  books?: string;
  fyEnd: string;
  fyStart: string;
  priorEnd: string;
  priorStart: string;
  hasPrior: boolean;
  title: string;
  /** "for the year ended 28 February 2026" */
  period: string;
  company: {
    name: string;
    tradingName: string;
    businessType: BusinessType;
    kind: string;
    regNumber: string;
    taxNumber: string;
    vatNumber: string;
    address: string;
    email: string;
    phone: string;
  };
  /** Directors, members, trustees, partners or the owner, as the statements name them. */
  governing: { one: string; many: string; signs: string };
  details: StatementDetails;
  sfp: { assets: Block[]; equity: Block; liabilities: Block[]; totalAssets: Amounts; totalEquityAndLiabilities: Amounts; totalLiabilities: Amounts };
  sci: {
    revenue: Line[];
    costOfSales: Line[];
    grossProfit: Amounts;
    otherIncome: Line[];
    operatingExpenses: Line[];
    operatingProfit: Amounts;
    financeIncome: Line[];
    financeCosts: Line[];
    profitBeforeTax: Amounts;
    incomeTax: Amounts;
    profit: Amounts;
  };
  soce: { columns: { key: string; label: string }[]; rows: { label: string; values: number[]; total: number; bold?: boolean }[] };
  scf: {
    operating: Line[];
    netOperating: Amounts;
    investing: Line[];
    netInvesting: Amounts;
    financing: Line[];
    netFinancing: Amounts;
    netChange: Amounts;
    opening: Amounts;
    closing: Amounts;
  };
  directorsReport: { title: string; text: string }[];
  notes: Note[];
  detailed: { label: string; lines: { code: string; name: string; current: number; prior: number }[]; total: Amounts }[];
  /**
   * What's checked before the statements can be signed (they must all be ok), and what's for the
   * accountant to look at (`look`: shown, never stopping anything).
   */
  checks: { label: string; ok: boolean; detail: string; level?: 'look' }[];
  /** For a business taxed on its own profit with none booked for the year: Shap's estimate of the year's tax (an estimate only). */
  /**
   * The year's income tax as Shap estimates it, when none is booked. `sbc`: on the small business
   * corporation table (true), at the company rate (false), or not said (null: both figures given,
   * and `taxCents` is at the company rate).
   */
  taxEstimate: { profitCents: number; assessedLossCents: number; taxableCents: number; taxCents: number; sbc: boolean | null; sbcTaxCents?: number; standardTaxCents?: number } | null;
  /** The legal form, as the general information states it (IFRS for SMEs 3.24(a)). */
  legalForm: string;
  /** Which edition of the IFRS for SMEs Accounting Standard the year is prepared under. */
  edition: string;
  /**
   * The public interest score (Companies Regulations 26(2)) for a company or CC, and what it points
   * to (an estimate from the books, for the business and its accountant to confirm).
   */
  publicInterest: {
    employees: number;
    employeesWorkedOut: number;
    liabilitiesCents: number;
    shareholderLoansCents: number;
    turnoverCents: number;
    holders: number;
    parts: { employees: number; liabilities: number; turnover: number; holders: number };
    score: number;
    meaning: PiMeaning;
  } | null;
  /** Shap's wording of each policy for this business (what a blank one in the details gives). */
  policyDefaults: Record<PolicyKey, string>;
}

interface Acc {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  systemKey: string | null;
  statementLine: StatementLineKey;
}

const PL: AccountType[] = ['income', 'cost_of_sales', 'expense'];
const sum = (xs: number[]) => xs.reduce((t, x) => t + x, 0);
const add = (a: Amounts, b: Amounts): Amounts => ({ current: a.current + b.current, prior: a.prior + b.prior });
const neg = (a: Amounts): Amounts => ({ current: -a.current, prior: -a.prior });
const zero = (): Amounts => ({ current: 0, prior: 0 });
const total = (ls: Amounts[]): Amounts => ls.reduce(add, zero());
const nonZero = <T extends Amounts>(ls: T[]) => ls.filter((l) => l.current !== 0 || l.prior !== 0);

/** The first day of a year that ends on this date (the twelve months to it, as the ledger takes years). */
export function yearStartOf(fyEnd: string): string {
  const [y, m] = fyEnd.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 - 11, 1));
  return d.toISOString().slice(0, 10);
}

export { governingFor } from './details.js';

export async function buildStatements(db: Db, fyEnd: string, detailsOverride?: StatementDetails): Promise<Statements> {
  const settings = await getSettings(db);
  const details = detailsOverride ?? (await loadDetails(db));
  const bt = settings.businessType as BusinessType;
  const fyStart = yearStartOf(fyEnd);
  const priorEnd = addDays(fyStart, -1);
  const priorStart = yearStartOf(priorEnd);
  const beforePrior = addDays(priorStart, -1);
  await freshTotals(db);
  const accounts = await db<Acc[]>`select id, code, name, type, system_key, statement_line from accounts order by code`;
  const rows = await db<{ accountId: string; source: string; atBefore: string; atPrior: string; atEnd: string; mvPrior: string; mvCur: string }[]>`
    select account_id, source,
      coalesce(sum(amount_cents) filter (where date <= ${beforePrior}::date), 0) as at_before,
      coalesce(sum(amount_cents) filter (where date <= ${priorEnd}::date), 0) as at_prior,
      coalesce(sum(amount_cents), 0) as at_end,
      coalesce(sum(amount_cents) filter (where date between ${priorStart}::date and ${priorEnd}::date), 0) as mv_prior,
      coalesce(sum(amount_cents) filter (where date between ${fyStart}::date and ${fyEnd}::date), 0) as mv_cur
    from ledger_totals where date <= ${fyEnd}::date group by account_id, source`;
  const [first] = await db<{ d: string | null }[]>`select min(date)::text as d from ledger_totals where amount_cents <> 0`;
  const hasPrior = Boolean(first?.d && first.d <= priorEnd);

  type Col = 'atBefore' | 'atPrior' | 'atEnd' | 'mvPrior' | 'mvCur';
  const byAcc = new Map<string, Record<Col, number> & { bySource: Map<string, Record<Col, number>> }>();
  for (const r of rows) {
    const e = byAcc.get(r.accountId) ?? { atBefore: 0, atPrior: 0, atEnd: 0, mvPrior: 0, mvCur: 0, bySource: new Map() };
    const v = { atBefore: Number(r.atBefore), atPrior: Number(r.atPrior), atEnd: Number(r.atEnd), mvPrior: Number(r.mvPrior), mvCur: Number(r.mvCur) };
    for (const k of Object.keys(v) as Col[]) e[k] += v[k];
    e.bySource.set(r.source, v);
    byAcc.set(r.accountId, e);
  }
  const val = (a: Acc, c: Col) => byAcc.get(a.id)?.[c] ?? 0;
  const books = sha256Hex(
    JSON.stringify([bt, accounts.filter((a) => (['atBefore', 'atPrior', 'atEnd', 'mvPrior', 'mvCur'] as Col[]).some((c) => val(a, c) !== 0)).map((a) => [a.code, a.type, a.statementLine, val(a, 'atBefore'), val(a, 'atPrior'), val(a, 'atEnd'), val(a, 'mvPrior'), val(a, 'mvCur')])]),
  );
  const src = (a: Acc, s: string, c: Col) => byAcc.get(a.id)?.bySource.get(s)?.[c] ?? 0;
  const label = (k: StatementLineKey) => statementLineLabel(k, bt);
  const isPL = (a: Acc) => PL.includes(a.type);
  const isRetained = (a: Acc) => a.statementLine === 'retained_earnings' || a.statementLine === 'distributions';
  const bsAccounts = accounts.filter((a) => !isPL(a));
  const plAccounts = accounts.filter(isPL);
  const sectionOf = (k: StatementLineKey): StatementSection => STATEMENT_LINES[k].section;

  // ---------------------------------------------------------------- statement of financial position
  // Each balance-sheet account's amount as shown (assets debit, the rest credit), on its line or,
  // the other way round, on its line's opposite.
  const placed = (a: Acc, at: 'atPrior' | 'atEnd'): { line: StatementLineKey; amount: number } => {
    const bal = val(a, at);
    const shown = a.type === 'asset' ? bal : -bal;
    const flip = flipOf(a.statementLine);
    if (shown < 0 && flip) return { line: flip, amount: -shown };
    return { line: a.statementLine, amount: shown };
  };
  const retainedAt = (at: 'atBefore' | 'atPrior' | 'atEnd') => -(sum(accounts.filter((a) => isRetained(a) || isPL(a)).map((a) => val(a, at))));
  const lineTotals = new Map<StatementLineKey, Amounts>();
  const lineAccounts = new Map<StatementLineKey, Map<string, Amounts & { name: string; code: string }>>();
  for (const a of bsAccounts) {
    if (isRetained(a)) continue;
    for (const [at, k] of [['atEnd', 'current'], ['atPrior', 'prior']] as const) {
      const p = placed(a, at);
      if (!p.amount) continue;
      const t = lineTotals.get(p.line) ?? zero();
      t[k] += p.amount;
      lineTotals.set(p.line, t);
      const m = lineAccounts.get(p.line) ?? new Map();
      const e = m.get(a.id) ?? { current: 0, prior: 0, name: a.name, code: a.code };
      e[k] += p.amount;
      m.set(a.id, e);
      lineAccounts.set(p.line, m);
    }
  }
  lineTotals.set('retained_earnings', { current: retainedAt('atEnd'), prior: retainedAt('atPrior') });
  const block = (section: StatementSection): Block => {
    const keys = (Object.keys(STATEMENT_LINES) as StatementLineKey[]).filter((k) => sectionOf(k) === section && k !== 'distributions');
    const lines = nonZero(keys.map((k) => ({ key: k, label: label(k), ...(lineTotals.get(k) ?? zero()) })));
    return { key: section, label: SECTION_LABELS[section], lines, ...total(lines) };
  };
  const assets = [block('non_current_assets'), block('current_assets')].filter((b) => b.lines.length);
  const equity = block('equity');
  const liabilities = [block('non_current_liabilities'), block('current_liabilities')].filter((b) => b.lines.length);
  const totalAssets = total(assets);
  const totalLiabilities = total(liabilities);
  const totalEquityAndLiabilities = add(equity, totalLiabilities);

  // ---------------------------------------------------------------- statement of comprehensive income
  const plLine = (k: StatementLineKey): Line[] =>
    nonZero(
      [
        {
          key: k,
          label: label(k),
          current: -sum(plAccounts.filter((a) => a.statementLine === k).map((a) => val(a, 'mvCur'))),
          prior: -sum(plAccounts.filter((a) => a.statementLine === k).map((a) => val(a, 'mvPrior'))),
        },
      ],
    );
  const revenue = plLine('revenue');
  const costOfSales = plLine('cost_of_sales');
  const grossProfit = total([...revenue, ...costOfSales]);
  const otherIncome = plLine('other_income');
  const operatingExpenses = plLine('operating_expenses');
  const operatingProfit = total([grossProfit, ...otherIncome, ...operatingExpenses]);
  const financeIncome = plLine('finance_income');
  const financeCosts = plLine('finance_costs');
  const profitBeforeTax = total([operatingProfit, ...financeIncome, ...financeCosts]);
  const incomeTax = total(plLine('income_tax'));
  const profit = add(profitBeforeTax, incomeTax);

  // ---------------------------------------------------------------- statement of changes in equity
  const colLines: { key: string; label: string; lines: StatementLineKey[] }[] = [
    { key: 'share_capital', label: label('share_capital'), lines: ['share_capital'] },
    { key: 'owners_contributions', label: label('owners_contributions'), lines: ['owners_contributions'] },
    { key: 'reserves', label: label('reserves'), lines: ['reserves'] },
  ];
  const colAt = (lines: StatementLineKey[], at: 'atBefore' | 'atPrior' | 'atEnd') => -sum(bsAccounts.filter((a) => lines.includes(a.statementLine)).map((a) => val(a, at)));
  const columns = colLines.filter((c) => (['atBefore', 'atPrior', 'atEnd'] as const).some((at) => colAt(c.lines, at) !== 0));
  const distributionsIn = (c: 'mvPrior' | 'mvCur') => -sum(bsAccounts.filter((a) => a.statementLine === 'distributions').map((a) => val(a, c)));
  const soceRows: Statements['soce']['rows'] = [];
  const reCol = { key: 'retained_earnings', label: label('retained_earnings') };
  const cols = [...columns.map((c) => ({ key: c.key, label: c.label })), reCol];
  const at = (when: 'atBefore' | 'atPrior' | 'atEnd') => [...columns.map((c) => colAt(c.lines, when)), retainedAt(when)];
  const pushRow = (lbl: string, values: number[], bold = false) => soceRows.push({ label: lbl, values, total: sum(values), bold });
  const period = (from: 'atBefore' | 'atPrior', to: 'atPrior' | 'atEnd', mv: 'mvPrior' | 'mvCur', profitFor: number, endLabel: string) => {
    const open = at(from);
    const close = at(to);
    const dividends = distributionsIn(mv);
    const profitRow = [...columns.map(() => 0), profitFor];
    const divRow = [...columns.map(() => 0), dividends];
    const other = close.map((v, i) => v - open[i]! - profitRow[i]! - divRow[i]!);
    pushRow('Profit for the year', profitRow);
    if (dividends) pushRow(label('distributions'), divRow);
    // Shares issued (or bought back) on a row of their own.
    const shareAt = columns.findIndex((c) => c.key === 'share_capital');
    if (shareAt >= 0 && other[shareAt] !== 0) {
      const row = close.map((_, i) => (i === shareAt ? other[shareAt]! : 0));
      // A CC has members' contributions, not shares (CC Act s24); a trust its capital; a co-op its members' shares.
      const words = ({ cc: ['Members’ contributions', 'Members’ contributions repaid'], trust: ['Capital contributed', 'Capital repaid'], coop: ['Members’ shares issued', 'Members’ shares repaid'] } as Partial<Record<BusinessType, [string, string]>>)[bt] ?? ['Issue of shares', 'Shares bought back'];
      pushRow(other[shareAt]! > 0 ? words[0] : words[1], row);
      other[shareAt] = 0;
    }
    if (other.some((v) => v !== 0)) pushRow(bt === 'sole_prop' || bt === 'partnership' ? 'Contributions, drawings and other changes' : 'Contributions and other changes in equity', other);
    pushRow(endLabel, close, true);
  };
  if (hasPrior) {
    pushRow(`Balance at ${formatDate(beforePrior, 'long')}`, at('atBefore'), true);
    period('atBefore', 'atPrior', 'mvPrior', profit.prior, `Balance at ${formatDate(priorEnd, 'long')}`);
  } else pushRow(`Balance at ${formatDate(priorEnd, 'long')}`, at('atPrior'), true);
  period('atPrior', 'atEnd', 'mvCur', profit.current, `Balance at ${formatDate(fyEnd, 'long')}`);

  // ---------------------------------------------------------------- statement of cash flows (indirect)
  // Cash moves by what every other account moved by (the books always balance), so each piece
  // below is what a group of accounts moved by, the other way round: together they're exactly
  // the change in cash.
  const contrib = (pred: (a: Acc) => boolean, mv: 'mvPrior' | 'mvCur', source?: (s: string) => boolean) =>
    -sum(
      bsAccounts
        .filter(pred)
        .map((a) => (source ? [...(byAcc.get(a.id)?.bySource.entries() ?? [])].filter(([s]) => source(s)).reduce((t, [, v]) => t + v[mv], 0) : val(a, mv))),
    );
  const cls = (a: Acc) => STATEMENT_LINES[a.statementLine].cash;
  const both = (f: (mv: 'mvPrior' | 'mvCur') => number): Amounts => ({ current: f('mvCur'), prior: hasPrior ? f('mvPrior') : 0 });
  const isFixed = (a: Acc) => cls(a) === 'ppe' || cls(a) === 'intangibles';
  const depreciation = both((mv) => contrib(isFixed, mv, (s) => s === 'depreciation'));
  const disposedAtBookValue = both((mv) => contrib(isFixed, mv, (s) => s === 'disposal'));
  const gainOnDisposal = both((mv) => -sum(plAccounts.map((a) => src(a, 'disposal', mv))));
  const taxExpense = neg(incomeTax);
  const wc = (line: StatementLineKey[], lbl: string): Line => ({ key: `wc_${line[0]}`, label: lbl, ...both((mv) => contrib((a) => cls(a) === 'working_capital' && line.includes(placedLine(a)), mv)) });
  // Working capital by where each account sits (receivables, payables, inventories, the rest).
  const placedLine = (a: Acc): StatementLineKey => a.statementLine;
  const wcInventories = wc(['inventories'], '(Increase) decrease in inventories');
  const wcReceivables = wc(['trade_receivables', 'other_current_assets', 'loans_to_shareholders' as StatementLineKey], '(Increase) decrease in trade and other receivables');
  const wcPayables = wc(['trade_payables', 'other_current_liabilities'], 'Increase (decrease) in trade and other payables');
  const wcProvisions = wc(['provisions_current', 'provisions_non_current'], 'Increase (decrease) in provisions');
  const taxContrib = both((mv) => contrib((a) => cls(a) === 'tax', mv));
  const operating: Line[] = nonZero([
    { key: 'pbt', label: 'Profit before taxation', ...profitBeforeTax, ...(hasPrior ? {} : { prior: 0 }) },
    { key: 'depreciation', label: 'Depreciation and amortisation', ...depreciation },
    { key: 'disposals', label: '(Profit) loss on disposal of assets', ...neg(gainOnDisposal) },
    // The accountant's year-end adjustments to assets (agreed figures) move no cash.
    { key: 'fixed_year_end', label: 'Year-end adjustments to assets', ...both((mv) => contrib(isFixed, mv, (s) => s === 'year_end')) },
    wcInventories,
    wcReceivables,
    wcPayables,
    wcProvisions,
    { key: 'tax_paid', label: 'Tax paid', ...add(neg(taxExpense), taxContrib) },
  ]);
  const additions = (c: 'ppe' | 'intangibles') => both((mv) => contrib((a) => cls(a) === c, mv, (s) => s !== 'depreciation' && s !== 'disposal' && s !== 'year_end'));
  const investing: Line[] = nonZero([
    { key: 'ppe', label: 'Purchase of property, plant and equipment', ...additions('ppe') },
    { key: 'intangibles', label: 'Purchase of intangible assets', ...additions('intangibles') },
    { key: 'proceeds', label: 'Proceeds on disposal of assets', ...add(disposedAtBookValue, gainOnDisposal) },
    { key: 'investing_other', label: 'Investments and loans made', ...both((mv) => contrib((a) => cls(a) === 'investing_other', mv)) },
  ]);
  const ownerLoansLabel = bt === 'sole_prop' || bt === 'partnership' ? `Contributions and drawings (${governingFor(bt).many})` : `Movement in ${label('shareholder_loans').toLowerCase()}`;
  const financing: Line[] = nonZero([
    { key: 'owner_loans', label: ownerLoansLabel, ...both((mv) => contrib((a) => cls(a) === 'owner_loans', mv)) },
    { key: 'borrowings', label: 'Movement in loans and borrowings', ...both((mv) => contrib((a) => cls(a) === 'borrowings', mv)) },
    { key: 'capital', label: bt === 'company' || bt === 'inc' ? 'Proceeds from shares issued' : 'Capital contributed', ...both((mv) => contrib((a) => cls(a) === 'capital', mv)) },
    { key: 'distributions', label: `${label('distributions')} paid`, ...both((mv) => contrib((a) => cls(a) === 'distributions', mv)) },
    { key: 'retained', label: 'Other movements in equity', ...both((mv) => contrib((a) => cls(a) === 'retained' && a.statementLine === 'retained_earnings', mv)) },
  ]);
  // Interest paid and received on lines of their own (7.14), in operating activities (as in profit):
  // profit before tax has them in, so they're added back above and shown as paid and received.
  const interestPaid = total(financeCosts);
  const interestReceived = total(financeIncome);
  if (interestPaid.current || interestPaid.prior || interestReceived.current || interestReceived.prior) {
    operating.splice(1, 0, ...nonZero([
      { key: 'finance_costs_back', label: 'Finance costs', ...neg(interestPaid), ...(hasPrior ? {} : { prior: 0 }) },
      { key: 'finance_income_back', label: 'Investment income', ...neg(interestReceived), ...(hasPrior ? {} : { prior: 0 }) },
    ]));
    operating.push(...nonZero([
      { key: 'interest_received', label: 'Interest and dividends received', ...interestReceived, ...(hasPrior ? {} : { prior: 0 }) },
      { key: 'interest_paid', label: 'Interest paid', ...interestPaid, ...(hasPrior ? {} : { prior: 0 }) },
    ]));
  }

  // Assets bought without the business's cash (7.18): paid personally by an owner (their loan
  // account), financed by a loan, or on a bill still unpaid at the year end. They're not cash flows,
  // so they come out of investing and out of the loan or payables they went to, and are told in a
  // note. A bill paid later is an investing outflow when it's paid. (The VAT on them stays where it was.)
  const nonCash = await nonCashAssets(db, { priorStart, priorEnd, fyStart, fyEnd, beforePrior });
  const adjust = (ls: Line[], key: string, a: Amounts, make?: Omit<Line, 'current' | 'prior'>) => {
    if (!a.current && !a.prior) return;
    const l = ls.find((x) => x.key === key);
    if (l) {
      l.current += a.current;
      l.prior += hasPrior ? a.prior : 0;
    } else if (make) ls.push({ ...make, current: a.current, prior: hasPrior ? a.prior : 0 });
  };
  for (const c of ['ppe', 'intangibles'] as const) {
    const n = nonCash.filter((x) => x.line === c);
    const all = (k: 'investing' | 'payables' | 'owner' | 'loan') => total(n.map((x) => x[k]));
    adjust(investing, c, all('investing'), { key: c, label: c === 'ppe' ? 'Purchase of property, plant and equipment' : 'Purchase of intangible assets' });
    adjust(financing, 'owner_loans', neg(all('owner')), { key: 'owner_loans', label: ownerLoansLabel });
    adjust(financing, 'borrowings', neg(all('loan')), { key: 'borrowings', label: 'Movement in loans and borrowings' });
    adjust(operating, 'wc_trade_payables', neg(all('payables')), { key: 'wc_trade_payables', label: 'Increase (decrease) in trade and other payables' });
  }
  for (const ls of [operating, investing, financing]) for (let i = ls.length - 1; i >= 0; i--) if (!ls[i]!.current && !ls[i]!.prior) ls.splice(i, 1);
  const nonCashRows = (['owner', 'loan', 'bill'] as const)
    .map((k) => ({
      label: k === 'owner' ? `Assets paid for personally by the ${governingFor(bt).many} (on their loan accounts)` : k === 'loan' ? 'Assets financed by loans' : 'Assets bought on credit, unpaid at the year end',
      current: sum(nonCash.map((x) => x.noted[k]?.current ?? 0)),
      prior: hasPrior ? sum(nonCash.map((x) => x.noted[k]?.prior ?? 0)) : 0,
    }))
    .filter((r) => r.current || r.prior);

  const netOperating = total(operating);
  const netInvesting = total(investing);
  const netFinancing = total(financing);
  const netChange = total([netOperating, netInvesting, netFinancing]);
  const cashAt = (when: 'atBefore' | 'atPrior' | 'atEnd') => sum(bsAccounts.filter((a) => cls(a) === 'cash').map((a) => val(a, when)));
  const opening = { current: cashAt('atPrior'), prior: hasPrior ? cashAt('atBefore') : 0 };
  const closing = { current: cashAt('atEnd'), prior: hasPrior ? cashAt('atPrior') : 0 };

  // ---------------------------------------------------------------- the year's income tax, as estimated
  // Section 29: for the tax note and the look item below. A company on the small business
  // corporation table if it says it qualifies that year (s12E: sbc_years) and its gross income is
  // within the limit; not said, both figures are shown. An estimate: the accountant works out the
  // tax. A business on turnover tax pays that instead of income tax on its profit.
  const taxedAs = entity(bt).taxedAs;
  const taxed = (taxedAs === 'company' || taxedAs === 'npc' || taxedAs === 'trust') && !(bt === 'npc' && settings.approvedPbo) && !settings.turnoverTax;
  const taxYear = async (end: string, start: string, pbt: number, gross: number, booked: number) => {
    const assessedLossCents = await assessedLossBefore(db, start, settings.fyEndMonth, taxedAs);
    const answer = taxedAs === 'company' ? await sbcAnswer(db, end, bt) : { sbc: false, said: false, from: null };
    const sbc = taxedAs === 'company' && entity(bt).sbcPossible ? sbcApplies(answer.sbc, gross) : false;
    // A trust is taxed on what it keeps: what it gave its beneficiaries in the year is theirs.
    const [given] = taxedAs === 'trust' ? await db<{ t: string }[]>`select coalesce(sum(gross_cents), 0)::bigint as t from dividends where conduit and declared_on between ${start}::date and ${end}::date` : [{ t: '0' }];
    const est = (onSbc: boolean) => estimateTax({ kind: taxedAs, profitCents: pbt, assessedLossCents, fyEnd: end, sbc: onSbc, approvedPbo: settings.approvedPbo, distributedCents: Number(given!.t) });
    const standard = est(false);
    const onSbc = sbc === false ? standard : est(true);
    // Near enough: within 10% of the estimate (or R100), the accountant's own figure.
    const near = (cents: number) => Math.abs(booked - cents) <= Math.max(10_000, Math.round(cents * 0.1));
    // The tax booked is on the SBC table (for the tax note's line): unless said not to, near the
    // SBC figure and not the flat rate's.
    const bookedOnSbc = sbc !== false && booked !== 0 && onSbc.taxCents !== standard.taxCents && near(onSbc.taxCents) && Math.abs(booked - onSbc.taxCents) < Math.abs(booked - standard.taxCents);
    // The assessed loss left to carry into the next year (unused tax losses, 29.41(f)).
    const loss = pbt < 0 ? assessedLossCents - pbt : assessedLossCents - assessedLossSetOff(taxedAs, pbt, assessedLossCents, end);
    return { assessedLossCents, sbc, answer, gross, standard, onSbc, booked, near, bookedOnSbc, lossCarriedCents: Math.max(0, loss), e: sbc === true ? onSbc : standard };
  };
  const grossIncome = (c: 'current' | 'prior') => sum([...revenue, ...otherIncome, ...financeIncome].map((l) => l[c]));
  const taxNow = taxed ? await taxYear(fyEnd, fyStart, profitBeforeTax.current, grossIncome('current'), -incomeTax.current) : null;
  const taxBefore = taxed && hasPrior ? await taxYear(priorEnd, priorStart, profitBeforeTax.prior, grossIncome('prior'), -incomeTax.prior) : null;

  // ---------------------------------------------------------------- notes
  const notes: Note[] = [];
  const noteFor = new Map<string, number>();
  const addNote = (n: Omit<Note, 'number'>) => {
    const number = notes.length + 1;
    notes.push({ number, ...n });
    noteFor.set(n.key, number);
    return number;
  };
  const lives = await db<{ category: string; months: number }[]>`
    select initcap(replace(category, '_', ' ')) as category, max(life_months)::int as months from assets
    where purchase_date <= ${fyEnd}::date and (disposed_on is null or disposed_on > ${priorStart}::date) group by category order by category`;
  const moved = (keys: string[]) => plAccounts.some((a) => keys.includes(a.systemKey ?? '') && (val(a, 'mvCur') !== 0 || val(a, 'mvPrior') !== 0));
  // Day labour that reached about 24 hours (3 days logged) in a month of the year, not subcontractors:
  // employees in the law, for UIF and the BCEA's leave (docs/CASUAL_LABOUR.md), though not on Payroll.
  const [dayLabour] = await db<{ months: number; wages: string }[]>`
    select count(*)::int as months, coalesce(sum(wages), 0)::bigint as wages from (
      select e.worker_id, to_char(e.date, 'YYYY-MM'), sum(e.wage_cents) as wages from labour_entries e join workers w on w.id = e.worker_id
      where w.kind <> 'subcontractor' and e.date between ${fyStart}::date and ${fyEnd}::date group by 1, 2 having sum(e.days) >= 3) x`;
  const dayEmployees = dayLabour!.months > 0;
  const policyDefaults = defaultPolicies(bt, {
    lives,
    employees: moved(['salaries', 'director_salary', 'payroll_levies']) || dayEmployees,
    leases: moved(['rent']),
    deferredTax: lineTotals.has('deferred_tax_asset') || lineTotals.has('deferred_tax_liability'),
    edition: editionFor(fyStart),
    wip: accounts.some((a) => a.systemKey === 'wip' && val(a, 'atEnd') !== 0),
  });
  // A first year has no previous year to be consistent with.
  if (!hasPrior) policyDefaults.basis = policyDefaults.basis.replace(' The accounting policies are consistent with those of the previous year.', '');
  // A policy reworded by the owner or accountant replaces Shap's (a blank one keeps Shap's).
  const policies = { ...policyDefaults, ...Object.fromEntries(Object.entries(details.policies).filter(([, v]) => typeof v === 'string' && v.trim() !== '')) };
  const policyKeys = ['basis', 'going_concern', 'revenue', 'ppe', 'intangibles', 'inventories', 'financial_instruments', 'tax', 'leases', 'employee_benefits', 'judgements'] as const;
  const shownPolicy = (k: (typeof policyKeys)[number]) =>
    k === 'ppe' ? lineTotals.has('ppe') : k === 'intangibles' ? lineTotals.has('intangibles') : k === 'inventories' ? lineTotals.has('inventories') : k === 'tax' ? incomeTax.current !== 0 || incomeTax.prior !== 0 || lineTotals.has('current_tax_liability') : true;
  addNote({
    key: 'policies',
    title: 'Basis of preparation and accounting policies',
    paragraphs: policyKeys.filter(shownPolicy).map((k) => policies[k]).filter(Boolean) as string[],
    tables: [],
  });
  // The accounts on a line (or lines), each at its balance; `against`: lines on the other side
  // (an overdraft in the cash note, a loan to a shareholder among the loans from them), taken off.
  const accountTable = (line: StatementLineKey | StatementLineKey[], against: StatementLineKey[] = []) => {
    const keys = Array.isArray(line) ? line : [line];
    const accs = new Map<string, Amounts & { name: string; code: string }>();
    for (const k of [...keys, ...against]) {
      const sign = against.includes(k) ? -1 : 1;
      for (const [id, e] of lineAccounts.get(k) ?? []) {
        const was = accs.get(id) ?? { current: 0, prior: 0, name: e.name, code: e.code };
        accs.set(id, { ...was, current: was.current + sign * e.current, prior: was.prior + sign * e.prior });
      }
    }
    const rowsOut = [...accs.values()].sort((x, y) => x.code.localeCompare(y.code)).map((e) => ({ label: e.name, current: e.current, prior: e.prior }));
    return { rows: [...rowsOut, { label: 'Total', current: sum(rowsOut.map((r) => r.current ?? 0)), prior: sum(rowsOut.map((r) => r.prior ?? 0)), bold: true }] };
  };
  const fixedNote = (c: 'ppe' | 'intangibles', title: string) => {
    if (!lineTotals.has(c)) return;
    const accs = bsAccounts.filter((a) => a.statementLine === c);
    const cost = accs.filter((a) => !/accumulated/.test(a.systemKey ?? '') && !/accumulated/i.test(a.name));
    const acc = accs.filter((a) => !cost.includes(a));
    const at = (as: Acc[], w: 'atPrior' | 'atEnd') => sum(as.map((a) => val(a, w)));
    const write = c === 'ppe' ? 'depreciation' : 'amortisation';
    const recon = (mv: 'mvPrior' | 'mvCur', open: 'atBefore' | 'atPrior', close: 'atPrior' | 'atEnd') => [
      { label: 'Carrying amount at the start of the year', current: sum(accs.map((a) => val(a, open))), prior: null },
      { label: 'Additions', current: -contrib((a) => accs.includes(a), mv, (s) => s !== 'depreciation' && s !== 'disposal' && s !== 'year_end'), prior: null },
      { label: 'Disposals', current: contrib((a) => accs.includes(a), mv, (s) => s === 'disposal') * -1, prior: null },
      { label: write === 'depreciation' ? 'Depreciation' : 'Amortisation', current: -contrib((a) => accs.includes(a), mv, (s) => s === 'depreciation'), prior: null },
      ...(contrib((a) => accs.includes(a), mv, (s) => s === 'year_end') ? [{ label: 'Adjustments at the year end', current: -contrib((a) => accs.includes(a), mv, (s) => s === 'year_end'), prior: null }] : []),
      { label: 'Carrying amount at the end of the year', current: sum(accs.map((a) => val(a, close))), prior: null, bold: true },
    ];
    addNote({
      key: c,
      title,
      paragraphs: [],
      tables: [
        {
          head: ['', formatDate(fyEnd, 'long'), formatDate(priorEnd, 'long')],
          rows: [
            ...cost.map((a) => ({ label: `${a.name}`, current: val(a, 'atEnd'), prior: val(a, 'atPrior') })).filter((r) => r.current !== 0 || r.prior !== 0),
            { label: 'Cost', current: at(cost, 'atEnd'), prior: at(cost, 'atPrior'), bold: true },
            { label: `Accumulated ${write}`, current: at(acc, 'atEnd'), prior: at(acc, 'atPrior') },
            { label: 'Carrying amount', current: at(accs, 'atEnd'), prior: at(accs, 'atPrior'), bold: true },
          ],
        },
        { head: [`Reconciliation for the year ended ${formatDate(fyEnd, 'long')}`, 'R', ''], rows: recon('mvCur', 'atPrior', 'atEnd') },
        ...(hasPrior ? [{ head: [`Reconciliation for the year ended ${formatDate(priorEnd, 'long')}`, 'R', ''], rows: recon('mvPrior', 'atBefore', 'atPrior') }] : []),
      ],
    });
  };
  fixedNote('ppe', label('ppe'));
  fixedNote('intangibles', label('intangibles'));
  if (lineTotals.has('inventories')) {
    const cogs = plAccounts.filter((a) => a.systemKey === 'cos_goods' || a.systemKey === 'stock_losses');
    const t = accountTable('inventories');
    addNote({
      key: 'inventories',
      title: label('inventories'),
      paragraphs: [],
      tables: [
        t,
        {
          rows: [
            { label: 'Inventories recognised as an expense during the year (cost of sales)', current: sum(cogs.map((a) => val(a, 'mvCur'))), prior: sum(cogs.map((a) => val(a, 'mvPrior'))) },
            ...cogs.filter((a) => a.systemKey === 'stock_losses').map((a) => ({ label: 'of which stock losses and write-downs', current: val(a, 'mvCur'), prior: val(a, 'mvPrior') })),
          ],
        },
      ],
    });
  }
  if (lineTotals.has('trade_receivables')) addNote({ key: 'trade_receivables', title: label('trade_receivables'), paragraphs: [], tables: [accountTable('trade_receivables')] });
  if (lineTotals.has('cash') || lineTotals.has('bank_overdraft'))
    addNote({
      key: 'cash',
      title: label('cash'),
      // As in the statement of cash flows: net of overdrafts repayable on demand (IFRS for SMEs 7.2).
      paragraphs: lineTotals.has('bank_overdraft') ? ['Bank overdrafts repayable on demand form part of the business’s cash management: in the statement of cash flows, cash and cash equivalents are shown net of them.'] : [],
      tables: [accountTable(['cash'], ['bank_overdraft'])],
    });
  if (lineTotals.has('share_capital')) addNote({ key: 'share_capital', title: label('share_capital'), paragraphs: [details.shareCapital || 'Authorised and issued share capital: see the share register.'].filter(Boolean), tables: [accountTable('share_capital')] });
  if (lineTotals.has('shareholder_loans') || lineTotals.has('shareholder_loans_current') || lineTotals.has('loans_to_shareholders'))
    addNote({ key: 'shareholder_loans', title: label('shareholder_loans'), paragraphs: [details.loanTerms], tables: [accountTable(['shareholder_loans', 'shareholder_loans_current'], ['loans_to_shareholders' as StatementLineKey])] });
  if (lineTotals.has('borrowings_non_current') || lineTotals.has('borrowings_current'))
    addNote({ key: 'borrowings', title: label('borrowings_non_current'), paragraphs: [], tables: [accountTable(['borrowings_non_current', 'borrowings_current'])] });
  if (lineTotals.has('trade_payables')) addNote({ key: 'trade_payables', title: label('trade_payables'), paragraphs: [], tables: [accountTable('trade_payables')] });
  const plTable = (k: StatementLineKey) => {
    const accs = plAccounts.filter((a) => a.statementLine === k);
    const r = nonZero(accs.map((a) => ({ label: a.name, current: -val(a, 'mvCur'), prior: -val(a, 'mvPrior') })));
    return { rows: [...r.map((x) => ({ ...x, current: Math.abs(x.current), prior: Math.abs(x.prior) })), { label: 'Total', current: Math.abs(sum(r.map((x) => x.current))), prior: Math.abs(sum(r.map((x) => x.prior))), bold: true }] };
  };
  if (revenue.length) addNote({ key: 'revenue', title: 'Revenue', paragraphs: [], tables: [plTable('revenue')] });
  const byKey = (keys: string[], mv: 'mvPrior' | 'mvCur') => sum(plAccounts.filter((a) => keys.includes(a.systemKey ?? '')).map((a) => val(a, mv)));
  // Subcontractors run their own businesses: their days are labour in the books, not employee costs (28.1).
  const [sub] = await db<{ cur: string; prior: string }[]>`
    select coalesce(sum(l.amount_cents) filter (where l.date between ${fyStart}::date and ${fyEnd}::date), 0)::bigint as cur,
           coalesce(sum(l.amount_cents) filter (where l.date between ${priorStart}::date and ${priorEnd}::date), 0)::bigint as prior
    from ledger l join accounts a on a.id = l.account_id join workers w on w.id = l.worker_id
    where w.kind = 'subcontractor' and a.system_key in ('general_labour', 'cos_labour')`;
  const subcontracted = { mvCur: Number(sub!.cur), mvPrior: Number(sub!.prior) };
  const stated = [
    { label: 'Depreciation and amortisation', keys: ['depreciation', 'amortisation'] },
    { label: 'Employee costs', keys: ['salaries', 'payroll_levies', 'general_labour', 'cos_labour'], less: subcontracted },
    { label: 'Subcontractors', keys: [], add: subcontracted },
    { label: `${entity(bt).accounts.director_salary}`, keys: ['director_salary'] },
    { label: 'Rent (operating leases)', keys: ['rent'] },
    { label: 'Bad debts written off', keys: ['bad_debts'] },
  ]
    .map((s: { label: string; keys: string[]; less?: { mvCur: number; mvPrior: number }; add?: { mvCur: number; mvPrior: number } }) => ({
      label: s.label,
      current: byKey(s.keys, 'mvCur') - (s.less?.mvCur ?? 0) + (s.add?.mvCur ?? 0),
      prior: byKey(s.keys, 'mvPrior') - (s.less?.mvPrior ?? 0) + (s.add?.mvPrior ?? 0),
    }))
    .filter((s) => s.current !== 0 || s.prior !== 0);
  if (stated.length) addNote({ key: 'operating_profit', title: 'Operating profit', paragraphs: ['Operating profit for the year is stated after:'], tables: [{ rows: stated }] });
  if (financeCosts.length) addNote({ key: 'finance_costs', title: 'Finance costs', paragraphs: [], tables: [plTable('finance_costs')] });
  if (incomeTax.current !== 0 || incomeTax.prior !== 0 || lineTotals.has('current_tax_liability') || (taxNow?.lossCarriedCents ?? 0) > 0)
    addNote({
      key: 'tax',
      title: 'Taxation',
      paragraphs: [
        details.taxNote,
        // Unused tax losses (29.41(f)): what Shap works out from the books, an estimate.
        taxNow && taxNow.lossCarriedCents > 0
          ? `The ${entity(bt).the.replace(/^the /, '')} has an estimated assessed loss of ${formatZar(taxNow.lossCarriedCents)} to carry forward against future taxable income (unused tax losses, worked out from the books: the assessment by SARS is what counts).`
          : '',
      ].filter(Boolean),
      tables: [
        { rows: [{ label: 'Current tax', current: -incomeTax.current, prior: -incomeTax.prior, bold: true }] },
        // How the tax expense relates to the profit: at the company rate, the small business
        // corporation rates on their own line where they apply, and what else differs.
        ...(entity(bt).taxedAs === 'company'
          ? (() => {
              const rate = (end: string) => (end >= '2023-03-31' ? 27 : 28);
              const at = { current: Math.round((profitBeforeTax.current * rate(fyEnd)) / 100), prior: hasPrior ? Math.round((profitBeforeTax.prior * rate(priorEnd)) / 100) : 0 };
              // The SBC rates' effect, for a year whose tax booked is on the SBC table: the tax on
              // its taxable income on the table, less at the company rate. Otherwise in the last line.
              const sbcEffect = (t: typeof taxNow) => (t?.bookedOnSbc ? t.onSbc.taxCents - t.standard.taxCents : 0);
              const effect = { current: sbcEffect(taxNow), prior: sbcEffect(taxBefore) };
              const sbcLine = effect.current !== 0 || effect.prior !== 0;
              // The rate changed between the years (28% to 27% for years ending from 31 March 2023): both named (29.41(d)).
              const rates = hasPrior && rate(priorEnd) !== rate(fyEnd) ? `${rate(fyEnd)}%; the previous year ${rate(priorEnd)}%` : `${rate(fyEnd)}%`;
              return [
                {
                  head: ['Reconciliation of the tax expense'],
                  rows: [
                    { label: 'Profit before taxation', current: profitBeforeTax.current, prior: hasPrior ? profitBeforeTax.prior : null },
                    { label: `Tax at the company rate (${rates})`, current: at.current, prior: hasPrior ? at.prior : null },
                    ...(sbcLine ? [{ label: 'Small business corporation rates (s12E)', current: effect.current, prior: hasPrior ? effect.prior : null }] : []),
                    {
                      label: sbcLine || !entity(bt).sbcPossible ? 'Items not deductible or not taxable, losses, and other differences' : 'Small business corporation rates, items not deductible or not taxable, and other differences',
                      current: -incomeTax.current - at.current - effect.current,
                      prior: hasPrior ? -incomeTax.prior - at.prior - effect.prior : null,
                    },
                    { label: 'Tax expense', current: -incomeTax.current, prior: hasPrior ? -incomeTax.prior : null, bold: true },
                  ],
                },
              ];
            })()
          : []),
      ],
    });
  if (nonCashRows.length)
    addNote({
      key: 'non_cash',
      title: 'Non-cash investing and financing transactions',
      paragraphs: ['These were not cash flows, so they are left out of the statement of cash flows (IFRS for SMEs 7.18):'],
      tables: [{ rows: nonCashRows }],
    });
  const dirPay = plAccounts.filter((a) => a.systemKey === 'director_salary');
  const related = [
    ...(dirPay.length ? [{ label: entity(bt).accounts.director_salary, current: sum(dirPay.map((a) => val(a, 'mvCur'))), prior: sum(dirPay.map((a) => val(a, 'mvPrior'))) }] : []),
    ...['shareholder_loans', 'shareholder_loans_current', 'loans_to_shareholders'].flatMap((k) => (lineTotals.has(k as StatementLineKey) ? [{ label: label(k as StatementLineKey), ...lineTotals.get(k as StatementLineKey)! }] : [])),
    { label: label('distributions') + ' declared', current: distributionsIn('mvCur'), prior: distributionsIn('mvPrior') },
  ].filter((r) => r.current !== 0 || r.prior !== 0);
  addNote({
    key: 'related_parties',
    title: 'Related parties',
    paragraphs: [
      `${capital(governingFor(bt).many)}: ${details.directors.map((d) => d.name).filter(Boolean).join(', ') || '(to be completed)'}.`,
      related.length ? 'Transactions and balances with them:' : `There were no transactions with the ${governingFor(bt).many} other than in the ordinary course of business.`,
    ],
    tables: related.length ? [{ rows: related }] : [],
  });
  addNote({ key: 'events_after', title: 'Events after the reporting period', paragraphs: [details.eventsAfter], tables: [] });
  addNote({ key: 'going_concern', title: 'Going concern', paragraphs: [details.goingConcern], tables: [] });

  // Line → note, for the statements' note column.
  const lineNote: Partial<Record<string, number>> = {
    ppe: noteFor.get('ppe'),
    intangibles: noteFor.get('intangibles'),
    inventories: noteFor.get('inventories'),
    trade_receivables: noteFor.get('trade_receivables'),
    cash: noteFor.get('cash'),
    bank_overdraft: noteFor.get('cash'),
    share_capital: noteFor.get('share_capital'),
    shareholder_loans: noteFor.get('shareholder_loans'),
    shareholder_loans_current: noteFor.get('shareholder_loans'),
    loans_to_shareholders: noteFor.get('shareholder_loans'),
    borrowings_non_current: noteFor.get('borrowings'),
    borrowings_current: noteFor.get('borrowings'),
    trade_payables: noteFor.get('trade_payables'),
    revenue: noteFor.get('revenue'),
    finance_costs: noteFor.get('finance_costs'),
    current_tax_liability: noteFor.get('tax'),
    income_tax: noteFor.get('tax'),
  };
  for (const b of [...assets, equity, ...liabilities]) for (const l of b.lines) l.note = lineNote[l.key];
  for (const l of [...revenue, ...financeCosts]) l.note = lineNote[l.key];

  // ---------------------------------------------------------------- detailed income statement
  const detailed = (['revenue', 'cost_of_sales', 'other_income', 'operating_expenses', 'finance_income', 'finance_costs', 'income_tax'] as StatementLineKey[])
    .map((k) => {
      const ls = plAccounts
        .filter((a) => a.statementLine === k)
        .map((a) => ({ code: a.code, name: a.name, current: -val(a, 'mvCur'), prior: -val(a, 'mvPrior') }))
        .filter((l) => l.current !== 0 || l.prior !== 0);
      return { label: label(k), lines: ls, total: total(ls) };
    })
    .filter((g) => g.lines.length);

  // ---------------------------------------------------------------- checks
  const checks: Statements['checks'] = [];
  const same = (a: Amounts, b: Amounts) => a.current === b.current && (!hasPrior || a.prior === b.prior);
  const money = (c: number) => (c / 100).toFixed(2);
  checks.push({ label: 'The statement of financial position balances', ok: same(totalAssets, totalEquityAndLiabilities), detail: `assets ${money(totalAssets.current)}, equity and liabilities ${money(totalEquityAndLiabilities.current)}` });
  checks.push({ label: 'The cash flows add up to the change in cash', ok: netChange.current === closing.current - opening.current && (!hasPrior || netChange.prior === closing.prior - opening.prior), detail: `net ${money(netChange.current)}, cash ${money(opening.current)} to ${money(closing.current)}` });
  const soceClose = soceRows.at(-1)!;
  checks.push({ label: 'The statement of changes in equity ends at the equity shown', ok: soceClose.total === equity.current, detail: `${money(soceClose.total)} and ${money(equity.current)}` });
  const suspense = accounts.filter((a) => a.systemKey === 'suspense').reduce((t, a) => t + val(a, 'atEnd'), 0);
  checks.push({ label: 'Nothing is left in suspense', ok: suspense === 0, detail: suspense ? `${money(suspense)} in suspense: sort it out before the statements are signed` : 'none' });

  // ---------------------------------------------------------------- for the accountant to look at
  // What the standard asks that Shap can't settle from the books alone: shown with the checks, never
  // stopping anything (the accountant decides, and adjusts with a journal if it's material).
  const kind = entity(bt);
  const look = (label: string, ok: boolean, detail: string) => checks.push({ label, ok, detail, level: 'look' });
  // Income tax (section 29): a business taxed on its own profit has the year's tax in the books.
  let taxEstimate: Statements['taxEstimate'] = null;
  if (taxNow) {
    const { e, sbc, standard, onSbc, assessedLossCents, near, booked, answer } = taxNow;
    const pct = Math.round(companyRate(fyEnd) * 100);
    const rates = sbc === true ? ' (small business corporation rates)' : taxedAs === 'company' ? ` (at ${pct}%${sbc === false && taxNow.gross > SBC_GROSS_INCOME_LIMIT_CENTS ? ': gross income over R20 million, so not the small business corporation table' : ''})` : '';
    const said = answer.sbc !== null && !answer.said && answer.from ? ` (as said for the year to ${formatDate(answer.from)})` : '';
    const estimate =
      sbc === null && onSbc.taxCents !== standard.taxCents
        ? `${formatZar(onSbc.taxCents)} at the small business corporation rates if the company qualifies this year (s12E), or ${formatZar(standard.taxCents)} at ${pct}% if it doesn't (say which on this screen, or on the provisional tax screen)`
        : `${formatZar(e.taxCents)} on a taxable income of ${formatZar(e.taxableCents)}${rates}${sbc === true ? said : ''}`;
    // Nothing due: on the answer given, or, not said, on either.
    const nothingDue = sbc === null ? standard.taxCents === 0 && onSbc.taxCents === 0 : e.taxCents === 0;
    const ok = booked === 0 ? nothingDue : sbc === null ? near(onSbc.taxCents) || near(standard.taxCents) : near(e.taxCents);
    if (booked === 0 && !nothingDue)
      taxEstimate = { profitCents: profitBeforeTax.current, assessedLossCents, taxableCents: e.taxableCents, taxCents: e.taxCents, sbc, sbcTaxCents: onSbc.taxCents, standardTaxCents: standard.taxCents };
    look(
      'The year’s income tax is in the books (IFRS for SMEs 29)',
      ok,
      booked === 0
        ? nothingDue
          ? 'no tax on the year’s profit (after any assessed loss), on Shap’s estimate'
          : `none booked: Shap estimates ${estimate}. An estimate only: your accountant works out the tax, and it’s booked with a journal (income tax against tax owed).`
        : ok
          ? `${formatZar(booked)} for the year`
          : `${formatZar(booked)} booked for the year; Shap estimates ${estimate}. If provisional tax paid was booked as the expense, it belongs in Income tax owed (SARS); if it’s your accountant’s figure, it stands.`,
    );
  }
  // Inventories at no more than they'll sell for (13.19, 27.2).
  if (lineTotals.has('inventories')) {
    const rate = settings.vatRegistered ? vatRateOn(fyEnd) : 0;
    const items = await db<{ description: string; qty: string; valueCents: string; unitPriceCents: string; priceIncludesVat: boolean; vatCode: string }[]>`
      select i.description, i.unit_price_cents, i.price_includes_vat, i.vat_code, coalesce(sum(m.qty), 0) as qty, coalesce(sum(m.value_cents), 0)::bigint as value_cents
      from items i join stock_moves m on m.item_id = i.id and m.date <= ${fyEnd}::date group by i.id`;
    const above = items.filter((i) => {
      const q = Number(i.qty);
      const net = rate > 0 && i.vatCode === 'standard' && i.priceIncludesVat ? Math.round((Number(i.unitPriceCents) * 10000) / (10000 + rate)) : Number(i.unitPriceCents);
      return q > 0 && Number(i.valueCents) > Math.round(q * net);
    });
    look('Stock is carried at no more than it will sell for (IFRS for SMEs 13.19, 27.2)', above.length === 0, above.length ? `${above.slice(0, 5).map((i) => i.description).join(', ')}${above.length > 5 ? ` and ${above.length - 5} more` : ''}: above the selling price at the year end. Write them down (Inventory → Valuation), or, for stock that has moved since the year end, a journal at the year end.` : 'none above its selling price');
  }
  // Work in progress (13.14 of the 2015 edition; 23 for revenue): jobs' costs waiting for their invoice.
  const wipAcc = accounts.find((a) => a.systemKey === 'wip');
  const wip = wipAcc ? val(wipAcc, 'atEnd') : 0;
  if (wip) look('Work in progress at the year end is recoverable, and work done is invoiced', false, `${formatZar(wip)} of job costs not yet invoiced at the year end, carried at cost. If a job will make a loss, write its costs down; if work was done but not invoiced, consider accruing the revenue (stage of completion).`);
  // Receivables long overdue (11.21): impaired if they won't be recovered.
  const [old] = await db<{ n: number; owing: string }[]>`
    select count(*)::int as n, coalesce(sum(owing), 0)::bigint as owing from (
      select d.total_cents - coalesce((select sum(r.amount_cents) from receipts r where r.invoice_id = d.id and r.date <= ${fyEnd}::date), 0) as owing
      from documents d where d.kind = 'invoice' and d.status = 'issued' and d.issue_date <= ${fyEnd}::date
        and (d.written_off_on is null or d.written_off_on > ${fyEnd}::date) and coalesce(d.due_date, d.issue_date) < (${fyEnd}::date - 365)) x where owing > 0`;
  look('Receivables will be recovered (IFRS for SMEs 11.21)', old!.n === 0, old!.n ? `${old!.n} invoice${old!.n === 1 ? '' : 's'} more than a year overdue at the year end (${formatZar(Number(old!.owing))}): if they won’t be paid, mark them delinquent (written off as bad debts).` : 'nothing more than a year overdue');
  // Leave pay and bonuses owed at the year end (28.6, 28.8): Shap's payroll doesn't keep leave balances.
  if (moved(['salaries']) || dayEmployees) look('Leave pay and bonuses owed to employees at the year end are provided for (IFRS for SMEs 28.6)', false, `Shap’s payroll doesn’t keep leave balances${dayEmployees ? ', and Workers doesn’t for day labour (from 24 hours a month, the BCEA’s leave applies: s19(1))' : ''}: if employees have leave owing (or a bonus earned) at the year end, your accountant provides for it with a journal.`);
  // Day labour that's employment in the law, paid outside Payroll (28.4(a)): what's owed on it isn't in the books.
  if (dayEmployees) look('UIF, PAYE and the Compensation Fund on day wages are provided for (IFRS for SMEs 28.4)', false, `Day labour reached about 24 hours in a month ${dayLabour!.months} time${dayLabour!.months === 1 ? '' : 's'} in the year (${formatZar(Number(dayLabour!.wages))} of day wages in those months). Shap doesn’t work out UIF, PAYE or the Compensation Fund on day wages: if any is owing at the year end, your accountant provides for it. A reminder from the days logged, not advice.`);

  // The public interest score (regulations 26 to 29) and what the business needs for it.
  let publicInterest: Statements['publicInterest'] = null;
  if (PI_APPLIES.includes(bt)) {
    const [emp] = await db<{ avg: string }[]>`
      with months as (select to_char(generate_series(${fyStart}::date, ${fyEnd}::date, interval '1 month'), 'YYYY-MM') as m),
      people as (
        select r.period as m, 'e' || pl.employee_id::text as who from pay_lines pl join pay_runs r on r.id = pl.run_id where r.status = 'final'
        union
        select to_char(e.date, 'YYYY-MM'), 'w' || e.worker_id::text from labour_entries e join workers w on w.id = e.worker_id
        where e.date between ${fyStart}::date and ${fyEnd}::date and w.kind <> 'subcontractor'
      )
      select coalesce(avg(n), 0)::float8 as avg from (select months.m, count(distinct p.who) as n from months left join people p on p.m = months.m group by months.m) x`;
    const employeesWorkedOut = Math.round(Number(emp!.avg) * 10) / 10;
    const employees = details.piEmployees ?? employeesWorkedOut;
    const liabilitiesCents = totalLiabilities.current;
    const shareholderLoansCents = (['shareholder_loans', 'shareholder_loans_current'] as StatementLineKey[]).reduce((t, k) => t + (lineTotals.get(k)?.current ?? 0), 0);
    const turnoverCents = sum(revenue.map((l) => l.current));
    // A company or CC has at least one holder; an NPC may have no members.
    const named = details.directors.filter((d) => d.name.trim()).length;
    const holders = details.piHolders ?? (bt === 'npc' ? named : Math.max(1, named));
    const pi = publicInterestScore({ employees, liabilitiesCents, turnoverCents, holders });
    const meaning = whatScoreMeans(pi.score, bt, { independentlyCompiled: !details.internallyCompiled, ownerManaged: details.ownerManaged });
    const { score, ...parts } = pi;
    publicInterest = { employees, employeesWorkedOut, liabilitiesCents, shareholderLoansCents, turnoverCents, holders, parts, score, meaning };
    const est = `Shap’s estimate of the public interest score is ${score}`;
    if (meaning.audit) look('The assurance fits the public interest score', details.assurance === 'audit', `${est}: the statements must be audited (${meaning.auditWhy}). Check the score with your accountant.`);
    else if (meaning.review) look('The assurance fits the public interest score', details.assurance === 'independent_review' || details.assurance === 'audit', `${est}: ${meaning.summary} Check the score with your accountant.`);
  }
  // Going concern (IFRS for SMEs 3.8, 3.9): liabilities more than assets, or the bank overdrawn,
  // at the year end is for the owners to assess, and any material uncertainty to be disclosed.
  // (A CC's accounting officer also reports a deficit to CIPC: below.)
  const deficit = totalLiabilities.current > totalAssets.current;
  const overdrawn = (lineTotals.get('bank_overdraft')?.current ?? 0) > 0;
  {
    const g = governingFor(bt);
    // Business rescue: companies (Companies Act Chapter 6), and close corporations with it (CC Act s66(1A)).
    const rescue = ['company', 'inc', 'npc', 'cc'].includes(bt);
    look(
      'The business is a going concern (IFRS for SMEs 3.8)',
      !deficit && !overdrawn,
      deficit || overdrawn
        ? `${deficit ? 'Liabilities exceed assets' : 'The bank is overdrawn'} at the year end${deficit && overdrawn ? ', and the bank is overdrawn' : ''}. The ${g.many} ${g.plural ? 'assess' : 'assesses'} whether the business can carry on for at least the next twelve months; if there's real doubt, the statements say so (IFRS for SMEs 3.9), and the going-concern wording in the details changes.${rescue ? ` A ${bt === 'cc' ? 'close corporation' : 'company'} is financially distressed if it's reasonably unlikely to pay all its debts as they fall due in the next six months, or reasonably likely to become insolvent in that time (Companies Act s128(1)(f)${bt === 'cc' ? ', with CC Act s66(1A)' : ''}); the ${g.many} then consider business rescue, or tell those affected why they aren't starting it (s129(7)).` : ''} This is a check, not an opinion on the business: talk it through with your accountant.`
        : 'assets cover the liabilities and the bank isn’t overdrawn',
    );
  }
  // Dividends (distributions) declared after the year end, up to the next one, aren't a liability at it (32.8), but are disclosed (32.10).
  const nextFyEnd = monthEnd(addMonths(fyEnd, 12));
  const [after] = await db<{ n: number; gross: string }[]>`select count(*)::int as n, coalesce(sum(gross_cents), 0)::bigint as gross from dividends where declared_on > ${fyEnd}::date and declared_on <= ${nextFyEnd}::date`;
  if (after!.n) look('Distributions declared after the year end are disclosed (IFRS for SMEs 32.8, 32.10)', false, `${formatZar(Number(after!.gross))} declared after the year end (before the next): not a liability at it. Mention it in the events after the reporting date (the details) if it's material.`);
  // Sold without keeping stock in Shap: what's on the shelf at the year end isn't in the books (13.4).
  if (featureOn(settings.features, 'sales') && !featureOn(settings.features, 'inventory') && !lineTotals.has('inventories'))
    look('Stock on hand at the year end is in the books (IFRS for SMEs 13.4)', false, 'Shap doesn’t keep this business’s stock, so goods on hand at the year end aren’t in the books: count them, and your accountant journals their cost into inventory.');
  if (bt === 'cc') {
    // Close Corporations Act: the accounting officer reports insolvency to CIPC (s62(3)(c)); a loan to a member needs every member's written consent (s52).
    look('The members’ interest is not in deficit (Close Corporations Act s62(3))', totalLiabilities.current <= totalAssets.current, totalLiabilities.current > totalAssets.current ? 'Liabilities exceed assets at the year end: the accounting officer must report this to CIPC.' : 'assets cover the liabilities');
    if (lineTotals.has('loans_to_shareholders')) look('Loans to members were consented to (Close Corporations Act s52)', false, 'A close corporation may lend to a member only with the prior written consent of all the members: keep it with the statements.');
  }

  const report = directorsReport({
    company: { name: settings.companyName, businessType: bt, kind: kind.label },
    governing: governingFor(bt),
    details,
    period: `for the year ended ${formatDate(fyEnd, 'long')}`,
    profit,
    hasPrior,
    distributions: distributionsIn('mvCur'),
    distributionsLabel: label('distributions'),
    // An owner's or partners' money in (+) and out (−) of the business during the year.
    ownersNet: bt === 'sole_prop' || bt === 'partnership' ? contrib((a) => cls(a) === 'owner_loans', 'mvCur') : null,
    taxed: kind.taxedAs === 'company',
    shareChange: colAt(['share_capital'], 'atEnd') - colAt(['share_capital'], 'atPrior'),
    industry: (INDUSTRIES as readonly { key: string; label: string }[]).find((i) => i.key === settings.industry)?.label ?? '',
  });
  const title = bt === 'company' || bt === 'inc' || bt === 'cc' || bt === 'npc' || bt === 'coop' ? 'Annual Financial Statements' : 'Financial Statements';
  return {
    builder: BUILDER,
    books,
    fyEnd,
    fyStart,
    priorEnd,
    priorStart,
    hasPrior,
    title,
    period: `for the year ended ${formatDate(fyEnd, 'long')}`,
    company: {
      name: settings.companyName,
      tradingName: settings.tradingName,
      businessType: bt,
      kind: kind.label,
      regNumber: settings.regNumber,
      taxNumber: settings.taxNumber ?? '',
      vatNumber: settings.vatRegistered ? settings.vatNumber : '',
      address: settings.address,
      email: settings.email,
      phone: settings.phone,
    },
    governing: governingFor(bt),
    details,
    sfp: { assets, equity, liabilities, totalAssets, totalEquityAndLiabilities, totalLiabilities },
    sci: { revenue, costOfSales, grossProfit, otherIncome, operatingExpenses, operatingProfit, financeIncome, financeCosts, profitBeforeTax, incomeTax, profit },
    soce: { columns: cols, rows: soceRows },
    scf: { operating, netOperating, investing, netInvesting, financing, netFinancing, netChange, opening, closing },
    directorsReport: report,
    notes,
    detailed,
    checks,
    taxEstimate,
    legalForm: legalFormOf(bt),
    edition: editionFor(fyStart),
    publicInterest,
    policyDefaults,
  };
}

/** The legal form, for the general information (IFRS for SMEs 3.24(a)). */
export function legalFormOf(bt: BusinessType): string {
  return ({
    company: 'Private company with limited liability, incorporated in South Africa under the Companies Act 71 of 2008',
    inc: 'Personal liability company, incorporated in South Africa under the Companies Act 71 of 2008: its directors are jointly and severally liable with it for its debts and liabilities contracted during their terms of office (section 19(3))',
    npc: 'Non-profit company, incorporated in South Africa under the Companies Act 71 of 2008',
    cc: 'Close corporation, registered in South Africa under the Close Corporations Act 69 of 1984, its members’ liability limited',
    coop: 'Co-operative, registered in South Africa under the Co-operatives Act 14 of 2005',
    trust: 'Trust, registered with the Master of the High Court of South Africa',
    partnership: 'Partnership: not a separate legal person, its partners personally liable for its debts',
    sole_prop: 'Sole proprietorship: not a separate legal person, its owner personally liable for its debts',
  } as Record<BusinessType, string>)[bt];
}

/** The edition of the IFRS for SMEs Accounting Standard a year is prepared under (the third applies to years beginning on or after 1 January 2027). */
export function editionFor(yearStart: string): string {
  return yearStart >= '2027-01-01' ? 'the IFRS for SMEs Accounting Standard (third edition, 2025)' : 'the IFRS for SMEs Accounting Standard (2015 edition)';
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Assets bought during each year without the business's cash (IFRS for SMEs 7.18), with what each
 * year's statement of cash flows takes out of investing (`current`, `prior`) and what the note shows
 * (`added`): paid personally by an owner, financed by a loan, or on a bill (what of it was unpaid at
 * a year end; paying it later is an investing outflow then). Amounts before VAT, as the assets carry them.
 */
async function nonCashAssets(db: Db, p: { priorStart: string; priorEnd: string; fyStart: string; fyEnd: string; beforePrior: string }) {
  const bought = await db<{ costId: string | null; date: string; assetCents: string; billCents: string; line: 'ppe' | 'intangibles'; role: string | null; sourceLine: StatementLineKey | null }[]>`
    select c.id as cost_id, c.date::text as date, (c.amount_cents - c.vat_cents) as asset_cents, c.amount_cents as bill_cents,
      case when a.category in ('patents', 'software') or ka.statement_line = 'intangibles' then 'intangibles' else 'ppe' end as line,
      s.role, sa.statement_line as source_line
    from costs c join cost_categories k on k.id = c.category_id join accounts ka on ka.id = k.account_id
    left join assets a on a.cost_id = c.id
    left join payment_sources s on s.id = c.source_id left join accounts sa on sa.id = s.account_id
    where (a.id is not null or ka.statement_line in ('ppe', 'intangibles')) and c.date <= ${p.fyEnd}::date
    union all
    select null, a.purchase_date::text, a.cost_cents, a.cost_cents + a.vat_cents,
      case when a.category in ('patents', 'software') then 'intangibles' else 'ppe' end,
      s.role, coalesce(sa.statement_line, (select statement_line from accounts where system_key = 'owner_loan'))
    from assets a left join payment_sources s on s.id = a.source_id left join accounts sa on sa.id = s.account_id
    where a.cost_id is null and a.purchase_date <= ${p.fyEnd}::date`;
  const billIds = bought.filter((b) => b.role === 'bills' && b.costId).map((b) => b.costId!);
  // What settled each bill: money (a cash flow when it's paid), an owner paying it personally or a
  // loan (the debt moves to them: no cash), or nothing here for a supplier's credit note (the credit
  // note is a bill of its own, negative, so it already takes its part off).
  const settled = billIds.length
    ? await db<{ costId: string; date: string; amountCents: string; sourceLine: StatementLineKey | null }[]>`
        select bp.cost_id, bp.date::text as date, bp.amount_cents, sa.statement_line as source_line
        from bill_payments bp left join payment_sources s on s.id = bp.source_id left join accounts sa on sa.id = s.account_id
        where bp.cost_id = any(${billIds}::uuid[]) and bp.credit_cost_id is null`
    : [];
  // Credit notes taken off bills (no money, no cash flow): only for what the note says is still owed.
  const credits = billIds.length
    ? await db<{ costId: string; creditCostId: string; date: string; amountCents: string }[]>`
        select cost_id, credit_cost_id, date::text as date, amount_cents from bill_payments
        where credit_cost_id is not null and (cost_id = any(${billIds}::uuid[]) or credit_cost_id = any(${billIds}::uuid[]))`
    : [];
  const how = (l: StatementLineKey | null) => {
    const c = l ? STATEMENT_LINES[l]?.cash : undefined;
    return c === 'owner_loans' ? 'owner' : c === 'borrowings' ? 'loan' : 'cash';
  };
  type Via = 'owner' | 'loan' | 'bill';
  /**
   * Per asset: what comes back out of investing (`investing`), out of the payables movement
   * (`payables`), out of the owners' loans or borrowings (`owner`, `loan`), and what the note tells
   * (`noted`, by how it was bought or settled without cash).
   */
  const out: { line: 'ppe' | 'intangibles'; investing: Amounts; payables: Amounts; owner: Amounts; loan: Amounts; noted: Partial<Record<Via, Amounts>> }[] = [];
  const within = (d: string, from: string, to: string) => d >= from && d <= to;
  const zero = (): Amounts => ({ current: 0, prior: 0 });
  for (const b of bought) {
    const asset = Number(b.assetCents);
    const cash = b.sourceLine ? STATEMENT_LINES[b.sourceLine]?.cash : undefined;
    const via: Via | null = b.role === 'bills' ? 'bill' : cash === 'owner_loans' ? 'owner' : cash === 'borrowings' ? 'loan' : null;
    if (!via || !asset) continue;
    if (via !== 'bill') {
      const a = { current: within(b.date, p.fyStart, p.fyEnd) ? asset : 0, prior: within(b.date, p.priorStart, p.priorEnd) ? asset : 0 };
      if (a.current || a.prior) out.push({ line: b.line, investing: a, payables: zero(), owner: via === 'owner' ? a : zero(), loan: via === 'loan' ? a : zero(), noted: { [via]: a } });
      continue;
    }
    const whole = Number(b.billCents) || asset;
    const share = (cents: number) => Math.round((asset * cents) / whole);
    const mine = settled.filter((x) => x.costId === b.costId);
    const settledBy = (kind: 'owner' | 'loan' | 'any', d: string) =>
      mine.filter((x) => x.date <= d && (kind === 'any' || how(x.sourceLine) === kind)).reduce((t, x) => t + Number(x.amountCents), 0);
    // Still owed to the supplier (a credit note, negative, the other way), and settled by the owner
    // or a loan; not yet paid in money (so not yet a cash outflow) is the three together, each
    // rounded once so the cash flows still add up to the cent.
    const left = (paidCents: number) => (whole >= 0 ? Math.max(0, whole - paidCents) : Math.min(0, whole + paidCents));
    const owed = (d: string) => (d < b.date ? 0 : share(left(settledBy('any', d))));
    const by = (kind: 'owner' | 'loan', d: string) => (d < b.date ? 0 : share(settledBy(kind, d)));
    const notPaid = (d: string) => owed(d) + by('owner', d) + by('loan', d);
    // What the note tells as still owed: credit notes taken off count too (a credit note on another
    // cost type isn't a bill here of its own to offset it).
    const creditTaken = (d: string) => credits.filter((x) => x.costId === b.costId && x.date <= d).reduce((t, x) => t + Number(x.amountCents), 0);
    const creditUsed = (d: string) => credits.filter((x) => x.creditCostId === b.costId && x.date <= d).reduce((t, x) => t + Number(x.amountCents), 0);
    const stillOwed = (d: string) => (d < b.date ? 0 : share(whole >= 0 ? Math.max(0, whole - settledBy('any', d) - creditTaken(d)) : Math.min(0, whole + creditUsed(d))));
    const moved = (f: (d: string) => number): Amounts => ({ current: f(p.fyEnd) - f(p.priorEnd), prior: f(p.priorEnd) - f(p.beforePrior) });
    const e = { line: b.line, investing: moved(notPaid), payables: moved(owed), owner: moved((d) => by('owner', d)), loan: moved((d) => by('loan', d)) };
    const noted = {
      bill: { current: within(b.date, p.fyStart, p.fyEnd) ? stillOwed(p.fyEnd) : 0, prior: within(b.date, p.priorStart, p.priorEnd) ? stillOwed(p.priorEnd) : 0 },
      owner: e.owner,
      loan: e.loan,
    };
    if ([e.investing, e.payables, e.owner, e.loan, noted.bill].some((a) => a.current || a.prior)) out.push({ ...e, noted });
  }
  return out;
}
