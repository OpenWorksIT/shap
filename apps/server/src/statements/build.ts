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
  companyRate,
  estimateTax,
  PI_APPLIES,
  publicInterestScore,
  whatScoreMeans,
  type PiMeaning,
  entity,
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
import { freshTotals, getSettings } from '../lib/books.js';
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

export interface Statements {
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
  taxEstimate: { profitCents: number; assessedLossCents: number; taxableCents: number; taxCents: number; sbc: boolean } | null;
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
      pushRow(other[shareAt]! > 0 ? 'Issue of shares' : 'Shares bought back', row);
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
    const by = (k: 'owner' | 'loan' | 'bill') => ({ current: sum(n.filter((x) => x.via === k).map((x) => x.current)), prior: sum(n.filter((x) => x.via === k).map((x) => x.prior)) });
    adjust(investing, c, total([by('owner'), by('loan'), by('bill')]), { key: c, label: c === 'ppe' ? 'Purchase of property, plant and equipment' : 'Purchase of intangible assets' });
    adjust(financing, 'owner_loans', neg(by('owner')), { key: 'owner_loans', label: ownerLoansLabel });
    adjust(financing, 'borrowings', neg(by('loan')), { key: 'borrowings', label: 'Movement in loans and borrowings' });
    adjust(operating, 'wc_trade_payables', neg(by('bill')), { key: 'wc_trade_payables', label: 'Increase (decrease) in trade and other payables' });
  }
  for (const ls of [operating, investing, financing]) for (let i = ls.length - 1; i >= 0; i--) if (!ls[i]!.current && !ls[i]!.prior) ls.splice(i, 1);
  const nonCashRows = (['owner', 'loan', 'bill'] as const)
    .map((k) => ({
      label: k === 'owner' ? `Assets paid for personally by the ${governingFor(bt).many} (on their loan accounts)` : k === 'loan' ? 'Assets financed by loans' : 'Assets bought on credit, unpaid at the year end',
      current: sum(nonCash.filter((x) => x.via === k).map((x) => x.added.current)),
      prior: hasPrior ? sum(nonCash.filter((x) => x.via === k).map((x) => x.added.prior)) : 0,
    }))
    .filter((r) => r.current || r.prior);

  const netOperating = total(operating);
  const netInvesting = total(investing);
  const netFinancing = total(financing);
  const netChange = total([netOperating, netInvesting, netFinancing]);
  const cashAt = (when: 'atBefore' | 'atPrior' | 'atEnd') => sum(bsAccounts.filter((a) => cls(a) === 'cash').map((a) => val(a, when)));
  const opening = { current: cashAt('atPrior'), prior: hasPrior ? cashAt('atBefore') : 0 };
  const closing = { current: cashAt('atEnd'), prior: hasPrior ? cashAt('atPrior') : 0 };

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
  const policyDefaults = defaultPolicies(bt, {
    lives,
    employees: moved(['salaries', 'director_salary', 'payroll_levies']),
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
  const stated = [
    { label: 'Depreciation and amortisation', keys: ['depreciation', 'amortisation'] },
    { label: 'Employee costs', keys: ['salaries', 'payroll_levies', 'general_labour', 'cos_labour'] },
    { label: `${entity(bt).accounts.director_salary}`, keys: ['director_salary'] },
    { label: 'Rent (operating leases)', keys: ['rent'] },
    { label: 'Bad debts written off', keys: ['bad_debts'] },
  ]
    .map((s) => ({ label: s.label, current: byKey(s.keys, 'mvCur'), prior: byKey(s.keys, 'mvPrior') }))
    .filter((s) => s.current !== 0 || s.prior !== 0);
  if (stated.length) addNote({ key: 'operating_profit', title: 'Operating profit', paragraphs: ['Operating profit for the year is stated after:'], tables: [{ rows: stated }] });
  if (financeCosts.length) addNote({ key: 'finance_costs', title: 'Finance costs', paragraphs: [], tables: [plTable('finance_costs')] });
  if (incomeTax.current !== 0 || incomeTax.prior !== 0 || lineTotals.has('current_tax_liability'))
    addNote({
      key: 'tax',
      title: 'Taxation',
      paragraphs: [details.taxNote].filter(Boolean),
      tables: [
        { rows: [{ label: 'Current tax', current: -incomeTax.current, prior: -incomeTax.prior, bold: true }] },
        // How the tax expense relates to the profit: at the company rate, and what differs (the
        // small business corporation rates, what isn't deductible or taxable).
        ...(entity(bt).taxedAs === 'company'
          ? (() => {
              const rate = (end: string) => (end >= '2023-03-31' ? 27 : 28);
              const at = { current: Math.round((profitBeforeTax.current * rate(fyEnd)) / 100), prior: hasPrior ? Math.round((profitBeforeTax.prior * rate(priorEnd)) / 100) : 0 };
              return [
                {
                  head: ['Reconciliation of the tax expense'],
                  rows: [
                    { label: 'Profit before taxation', current: profitBeforeTax.current, prior: hasPrior ? profitBeforeTax.prior : null },
                    { label: `Tax at the company rate (${rate(fyEnd)}%)`, current: at.current, prior: hasPrior ? at.prior : null },
                    { label: 'Small business corporation rates, items not deductible or not taxable, and other differences', current: -incomeTax.current - at.current, prior: hasPrior ? -incomeTax.prior - at.prior : null },
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
  if ((kind.taxedAs === 'company' || kind.taxedAs === 'npc' || kind.taxedAs === 'trust') && !(bt === 'npc' && settings.approvedPbo)) {
    const pbt = profitBeforeTax.current;
    const [lossRow] = await db<{ t: string }[]>`
      select coalesce(sum(l.amount_cents), 0)::bigint as t from ledger_totals l join accounts a on a.id = l.account_id
      where a.type in ('income', 'cost_of_sales', 'expense') and coalesce(a.system_key, '') <> 'income_tax' and l.date < ${fyStart}::date`;
    const assessedLossCents = Math.max(0, Number(lossRow!.t));
    const [est] = await db<{ lines: { sbc?: boolean } }[]>`select lines from tax_estimates where fy_end = ${fyEnd}::date order by created_at desc limit 1`;
    const sbc = kind.taxedAs === 'company' && Boolean(est?.lines?.sbc);
    const e = estimateTax({ kind: kind.taxedAs === 'company' ? 'company' : kind.taxedAs, profitCents: pbt, assessedLossCents, fyEnd, sbc, approvedPbo: settings.approvedPbo, distributedCents: 0 } as Parameters<typeof estimateTax>[0]);
    if (incomeTax.current === 0 && e.taxCents > 0) taxEstimate = { profitCents: pbt, assessedLossCents, taxableCents: e.taxableCents, taxCents: e.taxCents, sbc };
    look(
      'The year’s income tax is in the books (IFRS for SMEs 29)',
      incomeTax.current !== 0 || e.taxCents === 0,
      incomeTax.current !== 0
        ? `${formatZar(-incomeTax.current)} for the year`
        : e.taxCents === 0
          ? 'no tax on the year’s profit (after any assessed loss), on Shap’s estimate'
          : `none booked: Shap estimates ${formatZar(e.taxCents)} on a taxable income of ${formatZar(e.taxableCents)}${sbc ? ' (small business corporation rates)' : ` (at ${Math.round(companyRate(fyEnd) * 100)}%)`}. An estimate only: your accountant works out the tax, and it’s booked with a journal (income tax against tax owed).`,
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
    look('Stock is carried at no more than it will sell for (IFRS for SMEs 13.19, 27.2)', above.length === 0, above.length ? `${above.slice(0, 5).map((i) => i.description).join(', ')}${above.length > 5 ? ` and ${above.length - 5} more` : ''}: above the selling price at the year end. Write them down (Inventory → Valuation).` : 'none above its selling price');
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
  if (moved(['salaries'])) look('Leave pay and bonuses owed to employees at the year end are provided for (IFRS for SMEs 28.6)', false, 'Shap’s payroll doesn’t keep leave balances: if employees have leave owing (or a bonus earned) at the year end, your accountant provides for it with a journal.');

  // The public interest score (regulations 26 to 29) and what the business needs for it.
  let publicInterest: Statements['publicInterest'] = null;
  if (PI_APPLIES.includes(bt)) {
    const [emp] = await db<{ avg: string }[]>`
      with months as (select to_char(generate_series(${fyStart}::date, ${fyEnd}::date, interval '1 month'), 'YYYY-MM') as m),
      people as (
        select r.period as m, 'e' || pl.employee_id::text as who from pay_lines pl join pay_runs r on r.id = pl.run_id where r.status = 'final'
        union
        select to_char(e.date, 'YYYY-MM'), 'w' || e.worker_id::text from labour_entries e where e.date between ${fyStart}::date and ${fyEnd}::date
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
  const paid = billIds.length ? await db<{ costId: string; date: string; amountCents: string }[]>`select cost_id, date::text as date, amount_cents from bill_payments where cost_id = any(${billIds}::uuid[])` : [];
  const out: { line: 'ppe' | 'intangibles'; via: 'owner' | 'loan' | 'bill'; current: number; prior: number; added: Amounts }[] = [];
  const within = (d: string, from: string, to: string) => d >= from && d <= to;
  for (const b of bought) {
    const asset = Number(b.assetCents);
    const cash = b.sourceLine ? STATEMENT_LINES[b.sourceLine]?.cash : undefined;
    const via = b.role === 'bills' ? 'bill' : cash === 'owner_loans' ? 'owner' : cash === 'borrowings' ? 'loan' : null;
    if (!via || !asset) continue;
    if (via !== 'bill') {
      const cur = within(b.date, p.fyStart, p.fyEnd) ? asset : 0;
      const pri = within(b.date, p.priorStart, p.priorEnd) ? asset : 0;
      if (cur || pri) out.push({ line: b.line, via, current: cur, prior: pri, added: { current: cur, prior: pri } });
      continue;
    }
    const whole = Number(b.billCents) || asset;
    const unpaidAt = (d: string) => {
      if (d < b.date) return 0;
      const settled = paid.filter((x) => x.costId === b.costId && x.date <= d).reduce((t, x) => t + Number(x.amountCents), 0);
      return Math.round((asset * Math.max(0, whole - settled)) / whole);
    };
    const cur = unpaidAt(p.fyEnd) - unpaidAt(p.priorEnd);
    const pri = unpaidAt(p.priorEnd) - unpaidAt(p.beforePrior);
    const added = { current: within(b.date, p.fyStart, p.fyEnd) ? unpaidAt(p.fyEnd) : 0, prior: within(b.date, p.priorStart, p.priorEnd) ? unpaidAt(p.priorEnd) : 0 };
    if (cur || pri || added.current || added.prior) out.push({ line: b.line, via, current: cur, prior: pri, added });
  }
  return out;
}
