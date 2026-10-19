/**
 * Reads a bank or card statement exported as CSV. South African banks each have their own
 * layout (FNB, Standard Bank, Absa, Nedbank, Capitec…), and some exports have no header row,
 * so the columns are found by name where there is a header and by their contents where not.
 */
import { parseCsv } from '../clients.js';

export interface StatementRow {
  date: string; // YYYY-MM-DD
  description: string;
  amountCents: number; // money in positive, money out negative
  balanceCents: number | null;
}

export interface ParsedStatement {
  rows: StatementRow[];
  columns: { date: string; description: string; amount: string; balance: string | null };
  skipped: number;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, '0');
const valid = (y: number, m: number, d: number) => {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null;
};

/** Dates as South African banks write them. Day comes before month when it's ambiguous. */
export function parseStatementDate(raw: string): string | null {
  const s = raw.trim().replace(/^'+|'+$/g, '');
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(s);
  if (m) return valid(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:\s.*)?$/.exec(s);
  if (m) return valid(m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!, +m[2]!, +m[1]!);
  m = /^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s-,]+(\d{2,4})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[2]!.toLowerCase().slice(0, m[2]!.toLowerCase().startsWith('sept') ? 4 : 3)];
    if (mon) return valid(m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!, mon, +m[1]!);
  }
  m = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[1]!.toLowerCase().slice(0, 3)];
    if (mon) return valid(+m[3]!, mon, +m[2]!);
  }
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return valid(+m[1]!, +m[2]!, +m[3]!);
  return null;
}

/** "R 1 234.56", "-1,234.56", "1234,56", "(120.00)", "120.00 Dr" → cents. */
export function parseStatementAmount(raw: string): number | null {
  let s = raw.trim().replace(/^'+|'+$/g, '');
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) (sign = -1), (s = s.slice(1, -1));
  const drcr = /\s*(dr|cr|db)\.?$/i.exec(s);
  if (drcr) {
    if (drcr[1]!.toLowerCase() !== 'cr') sign = -sign;
    s = s.slice(0, drcr.index);
  }
  s = s.replace(/[R\s ]/g, '');
  if (s.endsWith('-')) (sign = -sign), (s = s.slice(0, -1));
  if (s.startsWith('-')) (sign = -sign), (s = s.slice(1));
  else if (s.startsWith('+')) s = s.slice(1);
  if (s.includes(',') && s.includes('.')) s = s.replace(/,/g, '');
  else if (/,\d{2}$/.test(s) && (s.match(/,/g) ?? []).length === 1) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return sign * Math.round(Number(s) * 100);
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z]/g, ' ').replace(/\s+/g, ' ').trim();
const SKIP = /^(opening|closing) balance|balance (brought|carried) forward|^balance b\/?f/i;

export function parseStatementCsv(text: string, opts: { flip?: boolean } = {}): ParsedStatement {
  const table = parseCsv(text).map((r) => r.map((c) => c.trim()));
  if (!table.length) throw new Error('The file is empty');

  // ---- a header row: a date column plus an amount (or in/out) column
  let header = -1;
  let ix: { date: number; desc: number; amount: number; debit: number; credit: number; fee: number; balance: number } | null = null;
  for (let r = 0; r < Math.min(table.length, 40) && header < 0; r++) {
    const h = table[r]!.map(norm);
    const find = (...names: string[]) => {
      for (const n of names) {
        const i = h.findIndex((c) => c === n);
        if (i >= 0) return i;
      }
      for (const n of names) {
        const i = h.findIndex((c) => c.includes(n));
        if (i >= 0) return i;
      }
      return -1;
    };
    const date = find('transaction date', 'date', 'posting date', 'value date', 'trans date');
    const amount = find('amount', 'transaction amount', 'value');
    const debit = find('money out', 'debit', 'debits', 'withdrawal', 'withdrawals', 'paid out');
    const credit = find('money in', 'credit', 'credits', 'deposit', 'deposits', 'paid in');
    if (date >= 0 && (amount >= 0 || (debit >= 0 && credit >= 0))) {
      header = r;
      ix = {
        date,
        amount,
        debit,
        credit,
        desc: find('description', 'details', 'narrative', 'transaction description', 'transaction', 'reference', 'beneficiary'),
        fee: h.findIndex((c) => c === 'fee' || c === 'fees' || c === 'charges'),
        balance: find('balance', 'running balance', 'available balance'),
      };
    }
  }

  // ---- no header: work out the columns from what's in them
  if (!ix) {
    const body = table.filter((r) => r.length >= 3);
    const width = Math.max(...body.map((r) => r.length));
    const share = (test: (s: string) => boolean, c: number) => {
      const cells = body.map((r) => r[c] ?? '').filter(Boolean);
      return cells.length ? cells.filter(test).length / cells.length : 0;
    };
    const cols = Array.from({ length: width }, (_, c) => c);
    const date = cols.find((c) => share((s) => parseStatementDate(s) != null, c) > 0.7) ?? -1;
    const nums = cols.filter((c) => c !== date && share((s) => parseStatementAmount(s) != null && /\d[.,]\d{2}\b|^-?\d+$/.test(s), c) > 0.7);
    const textCols = cols.filter((c) => c !== date && !nums.includes(c));
    const avgLen = (c: number) => body.reduce((s, r) => s + (r[c]?.length ?? 0), 0) / body.length;
    const desc = textCols.sort((a, b) => avgLen(b) - avgLen(a))[0] ?? -1;
    if (date < 0 || !nums.length) {
      throw new Error('Couldn’t find the date and amount columns in this file. Export the statement as CSV from online banking and try again.');
    }
    ix = { date, desc, amount: nums[0]!, debit: -1, credit: -1, fee: -1, balance: nums[1] ?? -1 };
  }

  const head = header >= 0 ? table[header]! : [];
  const name = (i: number, fallback: string) => (i >= 0 ? head[i] || `column ${i + 1}` : fallback);
  const rows: StatementRow[] = [];
  let skipped = 0;
  for (const r of table.slice(header + 1)) {
    const date = parseStatementDate(r[ix.date] ?? '');
    let description = ix.desc >= 0 ? (r[ix.desc] ?? '') : '';
    // Some exports split the description over two columns ("Description", "Original Description").
    if (!description) description = r.filter((c, i) => i !== ix!.date && parseStatementAmount(c) == null).join(' ');
    let amount: number | null;
    if (ix.amount >= 0) amount = parseStatementAmount(r[ix.amount] ?? '');
    else {
      const out = parseStatementAmount(r[ix.debit] ?? '') ?? 0;
      const inn = parseStatementAmount(r[ix.credit] ?? '') ?? 0;
      amount = Math.abs(inn) - Math.abs(out);
    }
    if (amount != null && ix.fee >= 0) amount -= Math.abs(parseStatementAmount(r[ix.fee] ?? '') ?? 0);
    if (!date || amount == null || amount === 0 || SKIP.test(description.trim())) {
      if (r.some((c) => c)) skipped++;
      continue;
    }
    rows.push({
      date,
      description: description.replace(/\s+/g, ' ').trim() || '(no description)',
      amountCents: opts.flip ? -amount : amount,
      balanceCents: ix.balance >= 0 ? parseStatementAmount(r[ix.balance] ?? '') : null,
    });
  }
  if (!rows.length) throw new Error('No transactions found in this file');
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return {
    rows,
    skipped,
    columns: {
      date: name(ix.date, 'date'),
      description: name(ix.desc, 'description'),
      amount: ix.amount >= 0 ? name(ix.amount, 'amount') : `${name(ix.credit, 'in')} − ${name(ix.debit, 'out')}`,
      balance: ix.balance >= 0 ? name(ix.balance, 'balance') : null,
    },
  };
}

/** A stable key for a transaction, so a re-uploaded or overlapping statement doesn't double up. */
export function fingerprints(rows: StatementRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base = `${r.date}|${r.amountCents}|${r.description.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return `${base}|${n}`;
  });
}
