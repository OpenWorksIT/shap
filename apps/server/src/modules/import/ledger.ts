/**
 * Another package's books (Shap Accountant phase 2, docs/ACCOUNTANT.md): the trial balance and the
 * general ledger detail a practice exports from Xero, QuickBooks or Sage (Accounting or Pastel), read
 * into these books period by period, to check and compile here while the client stays on their
 * package. The same as CaseWare and the other working-paper packages do with those exports.
 *
 * Files are read by what's in them, not by a fixed layout: the heading row is found among the first
 * rows, each column by the names the packages give it, and whether it's a trial balance (no dates)
 * or ledger lines (dates) by its columns. Ledger lines come flat (an Account column on every line:
 * QuickBooks' Journal report, Xero's Journal report) or grouped under each account's name (the
 * General Ledger and Account Transactions reports), with their opening, total and closing rows
 * skipped. A trial balance's own "as at" date and a ledger's "from … to" are read from its title
 * rows when they're there.
 *
 * Xero's trial balance has a month's Debit and Credit and the year's YTD Debit and YTD Credit: the
 * YTD columns are the balances (CData: https://cdn.cdata.com/help/DXM/py/pg_accountingtable-trialbalance.htm).
 */
import ExcelJS from 'exceljs';
import type { AccountType, StatementLineKey } from '@shap/shared';
import { badRequest } from '../../lib/errors.js';
import { parseCsv } from '../clients.js';
import { guessDayOrder, parseDate, parseMoney, type DayOrder } from '../movein.js';

export type LedgerSource = 'Xero' | 'QuickBooks' | 'Sage' | 'Pastel' | 'a spreadsheet';
export interface LedgerAccount {
  code: string;
  name: string;
  /** From a chart-of-accounts export, or the type its package gave it, when the file says. */
  type: AccountType | null;
  /** The package's own words for its type ("Fixed Asset", "Non-current Liability"), when the file says. */
  typeWords?: string;
}
/** A trial balance line: debit positive. */
export interface TbLine extends LedgerAccount {
  cents: number;
}
/** A ledger line: debit positive, with the key of the transaction it's part of. */
export interface GlLine extends LedgerAccount {
  date: string;
  description: string;
  reference: string;
  cents: number;
  group: string;
}
export interface LedgerFile {
  name: string;
  kind: 'trialBalance' | 'ledger' | 'unknown';
  source: LedgerSource;
  /** A trial balance's date, from its title rows. */
  asAt: string | null;
  /** A ledger's period, from its title rows or its first and last lines. */
  from: string | null;
  to: string | null;
  tb: TbLine[];
  lines: GlLine[];
  /** Rows not read, and why (shown in the preview). */
  skipped: string[];
  /** Ledger lines dated outside the file's own period (from its title): refused. */
  outside: number;
  /** Which of its columns the figures were read from (shown in the preview). */
  columns: string;
}

const MAX_ROWS = 200_000;
const MAX_COLUMNS = 200;

/* ---------------------------------------------------------------- the file as rows */

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  // A whole number as it is (an account code); any other to its cents, so "1234.567" isn't read as thousands.
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'object') {
    if ('result' in v) return cellText((v as { result: ExcelJS.CellValue }).result);
    if ('richText' in v) return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join('').trim();
    if ('text' in v) return String((v as { text: string }).text).trim();
  }
  return '';
}

/** How much an Excel file (a zip) unpacks to, from its own directory, before anything is unpacked. */
export function unpackedSize(bytes: Buffer): number | null {
  // The end of the central directory: its signature, within the last 64 KB (a comment may follow it).
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (bytes.readUInt32LE(i) !== 0x06054b50) continue;
    const entries = bytes.readUInt16LE(i + 10);
    let at = bytes.readUInt32LE(i + 16);
    let total = 0;
    for (let n = 0; n < entries; n++) {
      if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== 0x02014b50) return null;
      const size = bytes.readUInt32LE(at + 24);
      // A ZIP64 entry (0xFFFFFFFF) is bigger than any export Shap reads.
      if (size === 0xffffffff) return Number.MAX_SAFE_INTEGER;
      total += size;
      at += 46 + bytes.readUInt16LE(at + 28) + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    }
    return total;
  }
  return null;
}
const MAX_UNPACKED = 200 * 1024 * 1024;

/** A CSV or Excel file (its first sheet) as rows of cell text. */
export async function sheetRows(name: string, bytes: Buffer): Promise<string[][]> {
  if (/\.xlsx$/i.test(name) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    // A small file that unpacks to something huge isn't an export: refused before it's opened.
    const size = unpackedSize(bytes);
    if (size == null || size > MAX_UNPACKED) throw badRequest(`“${name}” isn’t a spreadsheet Shap can read: export it again as Excel (.xlsx) or CSV.`);
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    } catch {
      throw badRequest(`“${name}” isn’t a spreadsheet Shap can read: export it again as Excel (.xlsx) or CSV.`);
    }
    const ws = wb.worksheets[0];
    if (!ws) return [];
    if (ws.rowCount > MAX_ROWS || ws.columnCount > MAX_COLUMNS) throw badRequest(`“${name}” is too big to read (${MAX_ROWS.toLocaleString('en-ZA')} rows and ${MAX_COLUMNS} columns at most)`);
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const cells: string[] = [];
      for (let c = 1; c <= Math.min(ws.columnCount, MAX_COLUMNS); c++) cells.push(cellText(row.getCell(c).value));
      rows[n - 1] = cells;
    });
    return Array.from(rows, (r) => r ?? []);
  }
  if (/\.xls$/i.test(name)) throw badRequest(`“${name}” is an old Excel file: save it as .xlsx or CSV and try again.`);
  const rows = parseCsv(bytes.toString('utf8'));
  if (rows.length > MAX_ROWS) throw badRequest(`“${name}” is too big to read (${MAX_ROWS.toLocaleString('en-ZA')} rows at most)`);
  return rows;
}

/* ---------------------------------------------------------------- columns */

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
const COLUMNS = {
  date: ['date', 'transactiondate', 'txndate', 'journaldate', 'postingdate', 'entrydate'],
  account: ['account', 'accountname', 'accountdescription', 'ledgeraccount', 'glaccount', 'description1'],
  code: ['accountcode', 'accountno', 'accountnumber', 'code', 'glcode', 'ledgercode', 'accno'],
  type: ['accounttype', 'type', 'class'],
  description: ['description', 'memodescription', 'memo', 'details', 'narration', 'name', 'transactiondescription'],
  reference: ['reference', 'ref', 'num', 'no', 'number', 'documentnumber', 'docno', 'transactionnumber', 'journalnumber', 'journal'],
  source: ['source', 'transactiontype', 'txntype', 'documenttype', 'sourcetype'],
  debit: ['debit', 'debits', 'debitamount', 'dr'],
  credit: ['credit', 'credits', 'creditamount', 'cr'],
  ytdDebit: ['ytddebit', 'debitytd', 'debityeartodate', 'yeartodatedebit'],
  ytdCredit: ['ytdcredit', 'credityeartodate', 'creditytd', 'yeartodatecredit'],
  amount: ['amount', 'netamount', 'value'],
  balance: ['balance', 'closingbalance', 'netbalance', 'ytdbalance', 'endingbalance', 'balanceatend'],
  opening: ['openingbalance', 'opening', 'balancebf', 'broughtforward', 'beginningbalance', 'balanceatstart'],
  closingDebit: ['closingdebit', 'debitclosing', 'closingbalancedebit', 'endingdebit'],
  closingCredit: ['closingcredit', 'creditclosing', 'closingbalancecredit', 'endingcredit'],
} as const;
type Col = keyof typeof COLUMNS;

function mapColumns(headers: string[]): Partial<Record<Col, number>> {
  const n = headers.map(norm);
  const out: Partial<Record<Col, number>> = {};
  for (const c of Object.keys(COLUMNS) as Col[]) {
    for (const name of COLUMNS[c]) {
      const i = n.findIndex((h, j) => h === name && !Object.values(out).includes(j));
      if (i >= 0) {
        out[c] = i;
        break;
      }
    }
  }
  // "Debit - Year to date", "Credit YTD": the year's, not the month's.
  if (out.ytdDebit == null) {
    const i = n.findIndex((h) => h.includes('debit') && (h.includes('ytd') || h.includes('yeartodate')));
    if (i >= 0) out.ytdDebit = i;
  }
  if (out.ytdCredit == null) {
    const i = n.findIndex((h) => h.includes('credit') && (h.includes('ytd') || h.includes('yeartodate')));
    if (i >= 0) out.ytdCredit = i;
  }
  // A heading-less first column (QuickBooks' reports) holds the account.
  if (out.account == null && out.code == null && n[0] === '' && (out.debit != null || out.amount != null || out.ytdDebit != null)) out.account = 0;
  return out;
}

/** The row with the headings: the first of the first 25 with a money column and an account or date column. */
function findHeader(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const m = mapColumns(rows[i] ?? []);
    const money = m.debit != null || m.credit != null || m.amount != null || m.ytdDebit != null || m.balance != null;
    if (money && (m.account != null || m.code != null || m.date != null)) return i;
  }
  return -1;
}

/* ---------------------------------------------------------------- reading values */

/** A cell that's only an account number ("1000/000", "4000"). */
const CODE_ONLY = /^[0-9][0-9./-]{0,19}$/;

/** "Sales (200)", "200 - Sales", "1000/000 Bank", "4000 · Sales", or a separate code → { code, name }. */
export function splitAccount(cell: string, codeCell = ''): { code: string; name: string } {
  const text = cell.trim();
  if (codeCell.trim()) return { code: codeCell.trim(), name: text || codeCell.trim() };
  if (CODE_ONLY.test(text)) return { code: text, name: text };
  let m = /^(.*\S)\s*\(([A-Za-z0-9./-]{1,20})\)$/.exec(text);
  if (m && /\d/.test(m[2]!)) return { code: m[2]!, name: m[1]! };
  m = /^([0-9][0-9./-]{0,19})\s*(?:[-–·:]\s*)?(\S.*)$/.exec(text);
  if (m) return { code: m[1]!, name: m[2]!.trim() };
  return { code: '', name: text };
}

/** A package's account type, in its own words, as one of Shap's. */
export function typeFromWords(words: string): AccountType | null {
  const w = words.toLowerCase();
  if (!w) return null;
  if (/cost of (goods sold|sales)|direct cost|cogs|purchases/.test(w)) return 'cost_of_sales';
  if (/revenue|^income|other income|^sales|turnover/.test(w)) return 'income';
  if (/expense|overhead|depreciation(?! accum)|other expense/.test(w)) return 'expense';
  if (/equity|capital|retained|drawings|reserve/.test(w)) return 'equity';
  if (/liabilit|payable|credit card|a\/p|loan|overdraft|vat|tax/.test(w)) return 'liability';
  if (/asset|bank|receivable|a\/r|inventory|stock|cash|prepayment|fixed|accumulated/.test(w)) return 'asset';
  return null;
}

/**
 * Where a new account sits on the statements, from the package's type words and its name: Xero's,
 * QuickBooks' and Sage's types say more than Shap's six (a fixed asset, a non-current liability,
 * the bank), and the statements need it (IFRS for SMEs 4.4: current and non-current). Null: the
 * books' own default for the type.
 */
export function lineFromWords(typeWords: string, name: string, type: AccountType | null): StatementLineKey | null {
  const t = typeWords.toLowerCase();
  const n = name.toLowerCase();
  const both = `${t} ${n}`;
  switch (type) {
    case 'asset':
      if (/intangible|goodwill|software|patent|trade ?mark|amortis|amortiz/.test(both)) return 'intangibles';
      if (/fixed asset|non-?current asset|property|plant|equipment|vehicle|furniture|computer|machinery|building|land\b|accumulated depreciation/.test(both)) return 'ppe';
      if (/^bank|\bbank\b|cash|petty|savings|cheque|current account/.test(t) || /^(bank|cash|petty cash)\b|savings|cheque account|business (bank|account)/.test(n)) return 'cash';
      if (/inventor|stock/.test(both)) return 'inventories';
      if (/receivable|debtor|\ba\/r\b/.test(both)) return 'trade_receivables';
      if (/investment/.test(both)) return 'investments';
      return 'other_current_assets';
    case 'liability':
      if (/overdraft/.test(both)) return 'bank_overdraft';
      if (/non-?current|long[- ]term/.test(t)) return /shareholder|director|member|owner/.test(n) ? 'shareholder_loans' : 'borrowings_non_current';
      if (/income tax|provisional tax|company tax|tax payable/.test(n)) return 'current_tax_liability';
      if (/credit card|loan|borrowing/.test(both)) return /shareholder|director|member|owner/.test(n) ? 'shareholder_loans_current' : 'borrowings_current';
      if (/payable|creditor|\ba\/p\b|vat|gst|paye|uif|sdl|accrual|wages/.test(both)) return 'trade_payables';
      return 'other_current_liabilities';
    case 'equity':
      if (/retained|current year earnings|accumulated (profit|loss)/.test(n)) return 'retained_earnings';
      if (/dividend|drawing|distribution/.test(n)) return /drawing/.test(n) ? 'owners_contributions' : 'distributions';
      if (/share capital|ordinary share|issued capital|stated capital/.test(n)) return 'share_capital';
      if (/capital|contribution|owner|partner|member|current account/.test(n)) return 'owners_contributions';
      return 'reserves';
    case 'income':
      if (/interest/.test(n)) return 'finance_income';
      if (/other income|gain|sundry income|rental income|insurance claim/.test(both)) return 'other_income';
      return 'revenue';
    case 'cost_of_sales':
      return 'cost_of_sales';
    case 'expense':
      if (/income tax|tax expense|company tax|taxation/.test(n)) return 'income_tax';
      if (/^interest|interest (paid|expense)|finance (cost|charge)/.test(n)) return 'finance_costs';
      if (/cost of (goods|sales)|direct cost|cogs|purchases/.test(both)) return 'cost_of_sales';
      return 'operating_expenses';
    default:
      return null;
  }
}

/** A row of totals in a trial balance: the whole cell is the word (an account can be called "Total…"). */
const TB_TOTAL = /^(grand )?totals?:?$|^total (for|of) /i;
/** An opening or closing row in a ledger: the whole text is the phrase ("Opening Balance Equity" is an account). */
const LEDGER_BALANCE = /^(opening|beginning|closing|ending) balance$|^balance (b\/?f|c\/?f|brought forward|carried forward)$|^(brought|carried) forward$|^net movement$/i;
/** A row of totals under an account in a grouped ledger: "Total" and the account, or "Total for …". */
const isGroupTotal = (text: string, heading: { code: string; name: string } | null) => {
  const t = text.trim().toLowerCase();
  if (/^(grand )?totals?:?$/.test(t) || /^total (for|of) /.test(t)) return true;
  if (!heading || !t.startsWith('total ')) return false;
  const rest = t.slice(6).trim();
  return rest === heading.name.toLowerCase() || rest.includes(heading.name.toLowerCase()) || (Boolean(heading.code) && rest.includes(heading.code.toLowerCase()));
};

function datesInTitle(rows: string[][], upTo: number, order: DayOrder): { asAt: string | null; from: string | null; to: string | null } {
  const text = rows.slice(0, Math.max(upTo, 0)).map((r) => r.filter(Boolean).join(' ')).join('\n');
  const DATE = String.raw`(\d{1,2}[\s/.-][A-Za-z0-9]{1,9}[\s/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})`;
  const range = new RegExp(`(?:from\\s+|for\\s+the\\s+period\\s+)?${DATE}\\s*(?:to|-|–|through)\\s*${DATE}`, 'i').exec(text);
  const asAt = new RegExp(`as\\s+(?:at|of)\\s+${DATE}`, 'i').exec(text);
  // "October 1-31, 2026", "January 1 - October 31, 2026" (QuickBooks' report titles).
  const us = /([A-Za-z]{3,9})\s+(\d{1,2})\s*[-–]\s*(?:([A-Za-z]{3,9})\s+)?(\d{1,2}),?\s+(\d{4})/.exec(text);
  if (!range && !asAt && us) {
    const [, m1, d1, m2, d2, y] = us;
    return { asAt: parseDate(`${m2 ?? m1} ${d2}, ${y}`, order), from: parseDate(`${m1} ${d1}, ${y}`, order), to: parseDate(`${m2 ?? m1} ${d2}, ${y}`, order) };
  }
  return {
    asAt: asAt ? parseDate(asAt[1], order) : range ? parseDate(range[2], order) : null,
    from: range ? parseDate(range[1], order) : null,
    to: range ? parseDate(range[2], order) : null,
  };
}

function guessSource(headers: string[], title: string): LedgerSource {
  const h = headers.map(norm);
  const t = title.toLowerCase();
  if (h.includes('ytddebit') || h.includes('ytdcredit') || /account transactions|xero/.test(t)) return 'Xero';
  if (h.includes('memodescription') || h.includes('split') || h.includes('transactiontype') || /quickbooks/.test(t)) return 'QuickBooks';
  if (/pastel/.test(t) || h.includes('accountdescription')) return 'Pastel';
  if (/sage|detailed general ledger/.test(t)) return 'Sage';
  return 'a spreadsheet';
}

/* ---------------------------------------------------------------- what's in a file */

export function readLedger(name: string, rows: string[][]): LedgerFile {
  const empty: LedgerFile = { name, kind: 'unknown', source: 'a spreadsheet', asAt: null, from: null, to: null, tb: [], lines: [], skipped: [], outside: 0, columns: '' };
  const at = findHeader(rows);
  if (at < 0) return { ...empty, skipped: ['No row of headings with an account and a debit, credit or amount column in the first 25 rows'] };
  const headers = rows[at]!;
  const m = mapColumns(headers);
  const body = rows.slice(at + 1);
  const get = (r: string[], c: Col) => (m[c] == null ? '' : (r[m[c]!] ?? '').trim());
  const title = rows.slice(0, at).map((r) => r.filter(Boolean).join(' ')).join(' ');
  const rawDates = body.map((r) => get(r, 'date')).filter(Boolean);
  // Which way round the dates are: the way that puts every line inside the title's period, if it
  // gives one (QuickBooks set to month first, with every day 12 or less, reads either way).
  let order = guessDayOrder(rawDates);
  let period = datesInTitle(rows, at, order);
  if (period.from && period.to) {
    const fits = (o: DayOrder) => {
      const p = datesInTitle(rows, at, o);
      return p.from && p.to ? rawDates.every((d) => {
        const x = parseDate(d, o);
        return !x || (x >= p.from! && x <= p.to!);
      }) : false;
    };
    if (!fits(order)) {
      const other: DayOrder = order === 'dmy' ? 'mdy' : 'dmy';
      if (fits(other)) {
        order = other;
        period = datesInTitle(rows, at, order);
      }
    }
  }
  const { asAt, from, to } = period;
  const source = guessSource(headers, title);
  const money = (r: string[], dr: Col, cr: Col) => (parseMoney(get(r, dr)) ?? 0) - (parseMoney(get(r, cr)) ?? 0);
  const skipped: string[] = [];

  // A trial balance: no dates on its lines.
  const isTb = m.date == null || body.every((r) => !parseDate(get(r, 'date'), order));
  if (isTb) {
    // The balances: the year to date's (Xero), the closing ones (Sage with opening and closing
    // balances shown), or a debit and credit that are the balances. With an opening column, plain
    // Debit and Credit are the period's movements, not balances.
    const how =
      m.ytdDebit != null || m.ytdCredit != null
        ? 'ytd'
        : m.closingDebit != null || m.closingCredit != null
          ? 'closing'
          : m.opening != null && m.balance != null
            ? 'balance'
            : m.debit != null || m.credit != null
              ? 'dc'
              : 'balance';
    const used = { ytd: 'its year-to-date debit and credit columns', closing: 'its closing debit and credit columns', balance: 'its closing balance column', dc: 'its debit and credit columns' }[how];
    if (how === 'dc' && m.opening != null)
      return { ...empty, source, skipped: ['Its Debit and Credit columns are the period’s movements (it has an opening balance column): export it with the closing balances'], columns: used };
    const byKey = new Map<string, TbLine>();
    for (const [i, r] of body.entries()) {
      let label = get(r, 'account') || get(r, 'description');
      let codeCell = get(r, 'code');
      if (!codeCell && CODE_ONLY.test(label) && get(r, 'description')) [codeCell, label] = [label, get(r, 'description')];
      if (!label && !codeCell) continue;
      if (TB_TOTAL.test(label) || TB_TOTAL.test(codeCell)) continue;
      const cell = (c: Col) => get(r, c);
      const cents = how === 'ytd' ? money(r, 'ytdDebit', 'ytdCredit') : how === 'closing' ? money(r, 'closingDebit', 'closingCredit') : how === 'dc' ? money(r, 'debit', 'credit') : (parseMoney(get(r, 'balance')) ?? parseMoney(get(r, 'amount')) ?? 0);
      const blank = how === 'ytd' ? !cell('ytdDebit') && !cell('ytdCredit') : how === 'closing' ? !cell('closingDebit') && !cell('closingCredit') : how === 'dc' ? !cell('debit') && !cell('credit') : !cell('balance') && !cell('amount');
      if (blank) continue; // a heading such as "Assets"
      // Opening, the period's debits and credits, and closing: they must agree.
      if (how === 'balance' && m.opening != null && (m.debit != null || m.credit != null)) {
        const opening = parseMoney(get(r, 'opening')) ?? 0;
        if (opening + money(r, 'debit', 'credit') !== cents) return { ...empty, source, skipped: [`Row ${at + i + 2}: its opening balance, debit and credit don’t add up to its closing balance`], columns: used };
      }
      const a = splitAccount(label, codeCell);
      const key = `${a.code.toLowerCase()}|${a.name.toLowerCase()}`;
      const prev = byKey.get(key);
      if (prev) prev.cents += cents;
      else byKey.set(key, { ...a, type: typeFromWords(get(r, 'type')), typeWords: get(r, 'type'), cents });
      if (i > MAX_ROWS) break;
    }
    // A title "for the period 1 March 2026 to 30 June 2026" gives the year to date's start too.
    return { ...empty, kind: 'trialBalance', source, asAt, from, tb: [...byKey.values()].filter((l) => l.cents !== 0), skipped, columns: used };
  }

  // Ledger lines, flat or grouped under each account.
  const flat = (m.account != null && m.account !== 0) || m.code != null;
  // An account's type is only read from a column that says so ("Account Type"): a ledger's own
  // "Type" column is the transaction's (Sage's "Tax Invoice"), never the account's.
  const typeCol = m.type != null && /account/.test(norm(headers[m.type] ?? ''));
  let current: { code: string; name: string } | null = null;
  // Flat reports write a transaction's date, type and number on its first line only (QuickBooks'
  // Journal report): the lines after it, with an account and an amount but no date, are its too.
  let last: { date: string; source: string; reference: string; n: number } | null = null;
  let n = 0;
  const lines: GlLine[] = [];
  const hasMoney = (r: string[]) => Boolean(get(r, 'debit') || get(r, 'credit') || get(r, 'amount') || get(r, 'balance'));
  for (const [i, r] of body.entries()) {
    const first = (r[0] ?? '').trim();
    let date = parseDate(get(r, 'date'), order);
    let rowSource = get(r, 'source');
    let reference = get(r, 'reference');
    const hasAccount = !!(get(r, 'account') || get(r, 'code'));
    if (!date && flat && last && hasAccount && !get(r, 'date') && !TB_TOTAL.test(first)) ({ date, source: rowSource, reference } = last);
    else if (date) last = { date, source: rowSource, reference, n: ++n };
    if (!date) {
      // A row naming the account the lines below are in (grouped layouts: no amounts on it), or an
      // opening, closing or total row (amounts, or the phrase itself) to skip.
      if (!flat && first && !hasMoney(r) && !LEDGER_BALANCE.test(first) && !isGroupTotal(first, current)) current = splitAccount(first);
      else if (flat && !hasAccount) last = null; // a transaction's total, or the gap after it
      continue;
    }
    // A dated opening or closing row: only the phrase, with nothing to say it's a transaction.
    if (LEDGER_BALANCE.test(get(r, 'description')) && !rowSource && !reference) continue;
    const a = flat ? splitAccount(get(r, 'account'), get(r, 'code')) : current;
    if (!a || (!a.code && !a.name)) {
      skipped.push(`Row ${at + i + 2}: no account`);
      continue;
    }
    const cents = m.debit != null || m.credit != null ? money(r, 'debit', 'credit') : (parseMoney(get(r, 'amount')) ?? 0);
    if (!cents) continue;
    lines.push({
      ...a,
      type: typeCol ? typeFromWords(get(r, 'type')) : null,
      typeWords: typeCol ? get(r, 'type') : '',
      date,
      description: (get(r, 'description') || rowSource || reference).slice(0, 300),
      reference: reference.slice(0, 120),
      cents,
      // Lines filled down from one first line are one transaction even when it has no number.
      group: `${date}|${rowSource.toLowerCase()}|${reference.toLowerCase()}${flat && !reference && last ? `|#${last.n}` : ''}`,
    });
  }
  const dates = lines.map((l) => l.date).sort();
  const p = { from: from ?? dates[0] ?? null, to: to ?? dates.at(-1) ?? null };
  const outside = p.from && p.to ? lines.filter((l) => l.date < p.from! || l.date > p.to!).length : 0;
  return { ...empty, kind: 'ledger', source, from: p.from, to: p.to, lines, skipped, outside, columns: m.debit != null || m.credit != null ? 'its debit and credit columns' : 'its amount column' };
}

/**
 * Ledger lines as balanced transactions: by their own transaction (date, source and reference);
 * where those don't balance (a reference left blank, a report that splits one), all of a day's lines
 * together; a day that still doesn't balance means accounts are missing from the file.
 */
export function transactionsOf(lines: GlLine[]): { date: string; reference: string; description: string; lines: GlLine[] }[] {
  const byGroup = new Map<string, GlLine[]>();
  for (const l of lines) {
    const g = byGroup.get(l.group);
    if (g) g.push(l);
    else byGroup.set(l.group, [l]);
  }
  const out: { date: string; reference: string; description: string; lines: GlLine[] }[] = [];
  const loose = new Map<string, GlLine[]>();
  for (const ls of byGroup.values()) {
    if (ls.reduce((s, l) => s + l.cents, 0) === 0) out.push({ date: ls[0]!.date, reference: ls[0]!.reference, description: ls.find((l) => l.description)?.description ?? '', lines: ls });
    else {
      const day = loose.get(ls[0]!.date);
      if (day) day.push(...ls);
      else loose.set(ls[0]!.date, [...ls]);
    }
  }
  for (const [date, ls] of loose) {
    const off = ls.reduce((s, l) => s + l.cents, 0);
    if (off !== 0) {
      throw badRequest(
        `The ledger lines on ${date} don’t balance (debits and credits are R ${(Math.abs(off) / 100).toFixed(2)} apart): the export is missing accounts or lines. Export the whole ledger for the period, every account, and try again.`,
      );
    }
    out.push({ date, reference: '', description: `Lines of ${date}`, lines: ls });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
