/**
 * Reads a bank or card statement exported as CSV, OFX (QFX) or QIF. South African banks each
 * have their own CSV layout (FNB, Standard Bank, Absa, Nedbank, Capitec…), and some exports have
 * no header row, so the columns are found by name where there is a header and by their contents
 * where not. OFX and QIF are the same everywhere, so they're read by their tags.
 */
import { MAX_CSV_CELL, MAX_CSV_ROWS, parseCsv } from '../clients.js';

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
  /** Card transactions not yet cleared: left out until a later statement shows them settled. */
  pending: number;
  dateOrder: DateOrder;
}

/** Day first (South African) or month first (some banks' exports, e.g. Discovery's 10-17-26). */
export type DateOrder = 'dmy' | 'mdy';

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, '0');
const valid = (y: number, m: number, d: number) => {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null;
};

/** Dates as banks write them. Numeric day/month order follows `order` (day first unless told). */
export function parseStatementDate(raw: string, order: DateOrder = 'dmy'): string | null {
  // No date is this long; checking first keeps the patterns below cheap on a crafted cell.
  if (raw.length > 64) return null;
  const s = raw.trim().replace(/^'+|'+$/g, '');
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(s);
  if (m) return valid(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:\s.*)?$/.exec(s);
  if (m) {
    const y = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!;
    return order === 'mdy' ? valid(y, +m[1]!, +m[2]!) : valid(y, +m[2]!, +m[1]!);
  }
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
  if (raw.length > 64) return null;
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
  // With both, the last one is the decimal point: 1,234.56 or 1.234,56.
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (/,\d{2}$/.test(s) && (s.match(/,/g) ?? []).length === 1) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');
  if (!/^(\d+(\.\d+)?|\.\d+)$/.test(s)) return null;
  return sign * Math.round(Number(s) * 100);
}

/**
 * Which way round a file's numeric dates are: the reading under which every date is valid,
 * none is in the future, and (when both qualify) the dates run in order. Day first otherwise.
 */
export function detectDateOrder(cells: string[], today = new Date().toISOString().slice(0, 10)): DateOrder {
  const limit = new Date(Date.parse(today) + 3 * 86_400_000).toISOString().slice(0, 10);
  const score = (order: DateOrder) => {
    const ds = cells.map((c) => parseStatementDate(c, order)).filter((d): d is string => d != null);
    if (ds.length < cells.length) return -1;
    let pts = ds.every((d) => d <= limit) ? 2 : 0;
    const asc = ds.every((d, i) => i === 0 || d >= ds[i - 1]!);
    const desc = ds.every((d, i) => i === 0 || d <= ds[i - 1]!);
    if (asc || desc) pts += 1;
    return pts;
  };
  const d = score('dmy');
  const m = score('mdy');
  return m > d ? 'mdy' : 'dmy';
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z]/g, ' ').replace(/\s+/g, ' ').trim();
const SKIP = /^(opening|closing) balance|balance (brought|carried) forward|^balance b\/?f/i;

export function parseStatementCsv(text: string, opts: { flip?: boolean } = {}): ParsedStatement {
  const table = parseCsv(text).map((r) => r.map((c) => c.trim()));
  if (!table.length) throw new Error('The file is empty');

  // ---- a header row: a date column plus an amount (or in/out) column
  let header = -1;
  let ix: { date: number; desc: number; amount: number; debit: number; credit: number; fee: number; balance: number; status: number } | null = null;
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
        status: h.findIndex((c) => c === 'type' || c === 'status' || c === 'state' || c === 'transaction status'),
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
    const date = cols.find((c) => share((s) => (parseStatementDate(s) ?? parseStatementDate(s, 'mdy')) != null, c) > 0.7) ?? -1;
    const nums = cols.filter((c) => c !== date && share((s) => parseStatementAmount(s) != null && /\d[.,]\d{2}\b|^-?\d+$/.test(s), c) > 0.7);
    const textCols = cols.filter((c) => c !== date && !nums.includes(c));
    const avgLen = (c: number) => body.reduce((s, r) => s + (r[c]?.length ?? 0), 0) / body.length;
    const desc = textCols.sort((a, b) => avgLen(b) - avgLen(a))[0] ?? -1;
    if (date < 0 || !nums.length) {
      throw new Error('Couldn’t find the date and amount columns in this file. Export the statement as CSV from online banking and try again.');
    }
    ix = { date, desc, amount: nums[0]!, debit: -1, credit: -1, fee: -1, balance: nums[1] ?? -1, status: -1 };
  }

  const head = header >= 0 ? table[header]! : [];
  const name = (i: number, fallback: string) => (i >= 0 ? head[i] || `column ${i + 1}` : fallback);
  const body = table.slice(header + 1).filter((r) => r.some((c) => c));
  const order = detectDateOrder(body.map((r) => r[ix!.date] ?? '').filter((c) => /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/.test(c)));
  const rows: StatementRow[] = [];
  let skipped = 0;
  let pending = 0;
  for (const r of body) {
    if (ix.status >= 0 && /pending|authori[sz]|reserved|hold/i.test(r[ix.status] ?? '')) {
      pending++;
      continue;
    }
    const date = parseStatementDate(r[ix.date] ?? '', order);
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
  if (!rows.length) {
    throw new Error(pending ? `Only pending transactions in this file (${pending}). They come in once they’ve cleared: import a later statement.` : 'No transactions found in this file');
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return {
    rows,
    skipped,
    pending,
    dateOrder: order,
    columns: {
      date: name(ix.date, 'date'),
      description: name(ix.desc, 'description'),
      amount: ix.amount >= 0 ? name(ix.amount, 'amount') : `${name(ix.credit, 'in')} − ${name(ix.debit, 'out')}`,
      balance: ix.balance >= 0 ? name(ix.balance, 'balance') : null,
    },
  };
}

const FINGERPRINT_TEXT = 2000;

/** A stable key for a transaction, so a re-uploaded or overlapping statement doesn't double up. */
export function fingerprints(rows: StatementRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    // The description's first 2 000 letters and digits: enough to tell lines apart, and short
    // enough for the database's index (a longer key can't be stored).
    const base = `${r.date}|${r.amountCents}|${r.description.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, FINGERPRINT_TEXT)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return `${base}|${n}`;
  });
}

/** Which kind of file a statement is, from what's in it (not its name). */
export function statementFormat(text: string): 'ofx' | 'qif' | 'csv' {
  const head = text.slice(0, 4000);
  if (/OFXHEADER|<OFX>|<STMTTRN>/i.test(head) || /<STMTTRN>/i.test(text.slice(0, 200_000))) return 'ofx';
  if (/^\s*!(Type|Account|Option)\b/im.test(head) || /^\^\s*$/m.test(head)) return 'qif';
  return 'csv';
}

/** A statement in any of the formats Shap reads. */
export function parseStatement(text: string, opts: { flip?: boolean } = {}): ParsedStatement {
  const f = statementFormat(text);
  return f === 'ofx' ? parseStatementOfx(text, opts) : f === 'qif' ? parseStatementQif(text, opts) : parseStatementCsv(text, opts);
}

/** The same limits as a CSV's: a description as long as a cell, and as many lines as rows. */
const cap = (description: string) => (description.length > MAX_CSV_CELL ? description.slice(0, MAX_CSV_CELL) : description);
const tooMany = (n: number) => {
  if (n > MAX_CSV_ROWS) throw new Error(`That file has too many transactions (${MAX_CSV_ROWS.toLocaleString('en-ZA')} at most)`);
};
const ONE_ACCOUNT = 'This file has more than one account’s statement in it. Export one account at a time from your bank and bring each in on its own account.';

const finish = (rows: StatementRow[], opts: { flip?: boolean }, dateOrder: DateOrder, columns: ParsedStatement['columns'], skipped: number): ParsedStatement => {
  if (!rows.length) throw new Error('No transactions found in this file');
  const out = rows.map((r) => ({ ...r, amountCents: opts.flip ? -r.amountCents : r.amountCents }));
  // Stable: transactions on the same day keep the file's order.
  out.sort((a, b) => a.date.localeCompare(b.date));
  return { rows: out, skipped, pending: 0, dateOrder, columns };
};

/** Characters written as entities, decoded in one pass: "&amp;lt;" is "&lt;", never "<". */
const NAMED: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
const decodeEntities = (s: string) =>
  s.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(lt|gt|quot|apos|amp));/gi, (e, dec?: string, hex?: string, name?: string) => {
    if (name) return NAMED[name.toLowerCase()] ?? e;
    const n = dec ? Number(dec) : parseInt(hex!, 16);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : e;
  });

/** Each tag's pattern, made once. */
const TAG_PATTERNS = new Map<string, RegExp>();
/** An OFX element's text: <TAG>value (OFX 1, no closing tag) or <TAG>value</TAG> (OFX 2). */
const ofxTag = (block: string, tag: string): string | null => {
  let re = TAG_PATTERNS.get(tag);
  if (!re) TAG_PATTERNS.set(tag, (re = new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i')));
  const m = re.exec(block);
  return m ? decodeEntities(m[1]!.trim()) : null;
};

/**
 * The next place `tag` is found at or after `from`, remembered between calls so that a tag that
 * isn't there (or is far off) is looked for once, not once a transaction: a file is read in one
 * pass however it's made.
 */
const finder = (upper: string, tag: string) => {
  let at = -2;
  return (from: number) => {
    if (at === -1) return Infinity;
    if (at < from) at = upper.indexOf(tag, from);
    return at === -1 ? Infinity : at;
  };
};

/** OFX transaction types that are money out, for a file whose amounts carry no sign (the rest are money in). */
const OFX_OUT = new Set(['DEBIT', 'POS', 'FEE', 'SRVCHG', 'ATM', 'CHECK', 'PAYMENT', 'DIRECTDEBIT', 'REPEATPMT', 'CASH']);

/**
 * OFX (QFX is the same): each <STMTTRN> is a transaction with its posted date (YYYYMMDD…), a
 * signed amount (money in positive) and a name and memo. The ledger balance, when given, is the
 * balance at the end of the statement, so it goes on the last transaction up to that date.
 */
export function parseStatementOfx(text: string, opts: { flip?: boolean } = {}): ParsedStatement {
  // Upper case for finding tags, letter for letter (toUpperCase can lengthen some letters, which
  // would put the places found out of step with the text).
  const upper = text.replace(/[a-z]+/g, (w) => w.toUpperCase());
  const statements = (upper.match(/<STMTRS>|<CCSTMTRS>/g) ?? []).length;
  if (statements > 1) throw new Error(ONE_ACCOUNT);
  type Raw = { fitid: string | null; date: string | null; amount: number | null; type: string; description: string };
  const raws: Raw[] = [];
  const close = finder(upper, '</STMTTRN>');
  const list = finder(upper, '</BANKTRANLIST>');
  const next = finder(upper, '<STMTTRN>');
  for (let start = next(0); start !== Infinity; ) {
    // Every transaction counts against the limit, read or not.
    tooMany(raws.length + 1);
    const from = start + '<STMTTRN>'.length;
    const following = next(from);
    const end = Math.min(close(from), following, list(from), upper.length);
    start = following;
    const b = text.slice(from, end);
    raws.push({
      fitid: ofxTag(b, 'FITID'),
      date: parseStatementDate((ofxTag(b, 'DTPOSTED') ?? '').slice(0, 8)),
      amount: parseStatementAmount(ofxTag(b, 'TRNAMT') ?? ''),
      type: (ofxTag(b, 'TRNTYPE') ?? '').toUpperCase(),
      description: cap(
        [ofxTag(b, 'NAME'), ofxTag(b, 'MEMO')]
          .filter((x): x is string => Boolean(x))
          .filter((x, i, a) => a.indexOf(x) === i)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim(),
      ),
    });
  }
  // The amounts' signs say which way the money went. Only a file with no negative amount at all
  // (some banks write every amount positive) goes by the transaction types instead.
  const signed = raws.some((r) => r.amount != null && r.amount < 0);
  const rows: StatementRow[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const r of raws) {
    let amount = r.amount;
    if (!signed && amount != null && OFX_OUT.has(r.type)) amount = -amount;
    if (!r.date || amount == null || amount === 0) {
      skipped++;
      continue;
    }
    // The same transaction twice in one file (its bank's id, day and amount repeated) is brought in once.
    if (r.fitid) {
      const key = `${r.fitid}|${r.date}|${amount}`;
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);
    }
    rows.push({ date: r.date, description: r.description || '(no description)', amountCents: amount, balanceCents: null });
  }
  // The ledger balance: the first <LEDGERBAL>, read from the little that follows it.
  const at = upper.indexOf('<LEDGERBAL>');
  let ledger: string | null = null;
  if (at >= 0) {
    const from = at + '<LEDGERBAL>'.length;
    const w = upper.slice(from, from + 2000);
    const ends = ['</LEDGERBAL>', '<AVAILBAL>', '</STMTRS>', '</CCSTMTRS>'].map((t) => w.indexOf(t)).filter((i) => i >= 0);
    ledger = text.slice(from, from + (ends.length ? Math.min(...ends) : w.length));
  }
  const parsed = finish(rows, opts, 'dmy', { date: 'the date posted', description: 'the name and memo', amount: 'the amount', balance: ledger ? 'the ledger balance' : null }, skipped);
  if (ledger) {
    const bal = parseStatementAmount(ofxTag(ledger, 'BALAMT') ?? '');
    const asOf = parseStatementDate((ofxTag(ledger, 'DTASOF') ?? '').slice(0, 8));
    const last = [...parsed.rows].reverse().find((r) => !asOf || r.date <= asOf);
    // A card's balance owed is money out, so it flips with the amounts.
    if (bal != null && last) last.balanceCents = opts.flip ? -bal : bal;
  }
  return parsed;
}

/**
 * QIF: one field a line (D date, T or U amount, P payee, M memo), each transaction ended by "^".
 * Quicken writes some dates as 1/ 2'26 (2026); numeric dates are read day first unless every one
 * only makes sense month first.
 */
export function parseStatementQif(text: string, opts: { flip?: boolean } = {}): ParsedStatement {
  const recs: { d: string; t: string; p: string; m: string }[] = [];
  let cur = { d: '', t: '', p: '', m: '' };
  // An !Account block describes an account (its name and type), not a transaction. Between
  // !Option:AutoSwitch and !Clear:AutoSwitch is a list of accounts, not the one this file is for.
  let accounts = 0;
  let inAccount = false;
  let autoSwitch = false;
  let type: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line.startsWith('!')) {
      if (/^!Option:AutoSwitch/i.test(line)) autoSwitch = true;
      else if (/^!Clear:AutoSwitch/i.test(line)) autoSwitch = false;
      inAccount = /^!Account\b/i.test(line);
      if (inAccount && !autoSwitch && ++accounts > 1) throw new Error(ONE_ACCOUNT);
      // Transactions of a second kind of account (a bank's, then a card's) are another account's.
      const t = /^!Type:(\w+)/i.exec(line)?.[1]?.toLowerCase();
      if (t && !['class', 'cat', 'memorized', 'invitem', 'prices'].includes(t)) {
        if (type && type !== t) throw new Error(ONE_ACCOUNT);
        type = t;
      }
      continue;
    }
    if (line.startsWith('^')) {
      if (!inAccount && !autoSwitch && (cur.d || cur.t)) recs.push(cur);
      inAccount = false;
      cur = { d: '', t: '', p: '', m: '' };
      tooMany(recs.length);
      continue;
    }
    if (inAccount || autoSwitch) continue;
    const v = line.slice(1).trim();
    if (line[0] === 'D') cur.d = v.replace(/'\s*(\d{2})$/, '/20$1').replace(/\s+/g, '');
    else if (line[0] === 'T' || (line[0] === 'U' && !cur.t)) cur.t = v;
    else if (line[0] === 'P') cur.p = cap(v);
    else if (line[0] === 'M') cur.m = cap(v);
  }
  if (cur.d || cur.t) recs.push(cur);
  const order = detectDateOrder(recs.map((r) => r.d).filter((d) => /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(d)));
  const rows: StatementRow[] = [];
  let skipped = 0;
  for (const r of recs) {
    const date = parseStatementDate(r.d, order);
    const amount = parseStatementAmount(r.t);
    if (!date || amount == null || amount === 0) {
      skipped++;
      continue;
    }
    const description = cap([r.p, r.m].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(' ').replace(/\s+/g, ' ').trim());
    rows.push({ date, description: description || '(no description)', amountCents: amount, balanceCents: null });
  }
  return finish(rows, opts, order, { date: 'the date', description: 'the payee and memo', amount: 'the amount', balance: null }, skipped);
}
