/**
 * Suggests what each statement line is. A slip is captured item by item (bricks, cement,
 * sand) but the bank shows one total, so besides one-for-one matches this looks for groups
 * of costs from the same supplier and day, and then for any handful of nearby costs, that
 * add up to the statement amount.
 */
import { formatZar } from '@shap/shared';

export interface BankLine {
  id: string;
  date: string;
  description: string;
  amountCents: number;
  sourceId: string;
}
export interface CostCandidate {
  id: string;
  date: string;
  amountCents: number;
  supplier: string;
  description: string;
  sourceId: string | null;
  /** The account it says it was paid from (shown when that isn't the statement's). */
  sourceName?: string | null;
  projectName?: string | null;
}
export interface ReceiptCandidate {
  id: string;
  date: string;
  amountCents: number;
  sourceId: string;
  label: string;
}
export interface WageCandidate {
  id: string;
  date: string;
  amountCents: number;
  sourceId: string;
  workerName: string;
}
export interface InvoiceCandidate {
  id: string;
  number: string;
  clientName: string;
  balanceCents: number;
  depositOutstandingCents: number;
  issueDate: string;
}
export interface Suggestion {
  kind: 'cost' | 'receipt' | 'wage_payment' | 'invoice';
  ids: string[];
  score: number;
  label: string;
}

const STOP = new Set(['pty', 'ltd', 'the', 'and', 'store', 'shop', 'cc', 'inc', 'co', 'sa', 'za', 'south', 'africa', 'online', 'www', 'com']);
export const tokens = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));

/** Does the statement description mention this supplier? */
export function similar(description: string, supplier: string): boolean {
  const desc = description.toLowerCase();
  const squashed = desc.replace(/[^a-z0-9]/g, '');
  return tokens(supplier).some((t) => desc.includes(t) || squashed.includes(t));
}

/** Suppliers and banks sometimes round: totals within this many cents still count as a match. */
export const ROUNDING_CENTS = 50;
const near = (a: number, b: number) => Math.abs(a - b) <= ROUNDING_CENTS;

const days = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);
const zar = (c: number) => formatZar(c);

/** Finds a set of 2–10 amounts (from at most 18) that add up to the target, give or take rounding. */
function subsetSum(items: { id: string; amountCents: number }[], target: number): string[] | null {
  const pool = [...items].sort((a, b) => b.amountCents - a.amountCents).slice(0, 18);
  const suffix = pool.map((_, i) => pool.slice(i).reduce((s, x) => s + x.amountCents, 0));
  const picked: string[] = [];
  let steps = 0;
  const walk = (i: number, left: number): boolean => {
    if (++steps > 200_000) return false;
    if (Math.abs(left) <= ROUNDING_CENTS && picked.length >= 2) return true;
    if (i >= pool.length || picked.length >= 10 || suffix[i]! < left - ROUNDING_CENTS) return false;
    const x = pool[i]!;
    if (x.amountCents <= left + ROUNDING_CENTS) {
      picked.push(x.id);
      if (walk(i + 1, left - x.amountCents)) return true;
      picked.pop();
    }
    return walk(i + 1, left);
  };
  return walk(0, target) ? [...picked] : null;
}

/** A suggestion as a key, to remember that you said it's wrong for that line. */
export const suggestionKey = (s: { kind: string; ids: string[] }) => `${s.kind}:${[...s.ids].sort().join(',')}`;

export function suggestMatches(
  lines: BankLine[],
  c: { costs: CostCandidate[]; receipts: ReceiptCandidate[]; wages: WageCandidate[]; invoices: InvoiceCandidate[] },
  /** "lineId|key" for suggestions you turned down: the next best is offered instead. */
  rejected: Set<string> = new Set(),
): Map<string, Suggestion> {
  const options: { lineId: string; s: Suggestion }[] = [];
  for (const line of lines) {
    const amount = Math.abs(line.amountCents);
    if (line.amountCents < 0) {
      // Card and debit-order transactions reach the statement a day or more after the slip.
      const nearby = c.costs.filter((x) => (x.sourceId == null || x.sourceId === line.sourceId) && days(line.date, x.date) >= -2 && days(line.date, x.date) <= 7);
      // One for one. Any account: a cost captured as paid from elsewhere (or with the wrong
      // account) is still the same purchase, and adding it again would count it twice.
      for (const x of c.costs) {
        const d = days(line.date, x.date);
        if (d < -3 || d > 10 || !near(x.amountCents, amount)) continue;
        const sim = similar(line.description, x.supplier) || similar(line.description, x.description);
        const elsewhere = x.sourceId != null && x.sourceId !== line.sourceId;
        options.push({
          lineId: line.id,
          s: {
            kind: 'cost',
            ids: [x.id],
            score: 50 + (sim ? 30 : 0) - (x.amountCents === amount ? 0 : 10) - (elsewhere ? 15 : 0) - Math.abs(d) * 3,
            label: `${x.description}${x.supplier ? ` – ${x.supplier}` : ''}${x.projectName ? ` (${x.projectName})` : ''}${elsewhere && x.sourceName ? `, captured as paid from ${x.sourceName}` : ''}`,
          },
        });
      }
      // One slip, several items: same supplier, same day.
      const groups = new Map<string, CostCandidate[]>();
      for (const x of nearby) {
        const k = `${x.date}|${x.supplier.toLowerCase().trim()}`;
        groups.set(k, [...(groups.get(k) ?? []), x]);
      }
      for (const g of groups.values()) {
        const sum = g.reduce((s, x) => s + x.amountCents, 0);
        if (g.length < 2 || !near(sum, amount)) continue;
        const sim = similar(line.description, g[0]!.supplier) ? 30 : 0;
        options.push({
          lineId: line.id,
          s: { kind: 'cost', ids: g.map((x) => x.id), score: 48 + sim - (sum === amount ? 0 : 10) - Math.abs(days(line.date, g[0]!.date)) * 3, label: `${g.length} items${g[0]!.supplier ? ` from ${g[0]!.supplier}` : ''} on ${g[0]!.date}` },
        });
      }
      // Any handful of nearby costs that add up, the supplier's first.
      const close = nearby.filter((x) => Math.abs(days(line.date, x.date)) <= 4 && x.amountCents > 0 && x.amountCents < amount);
      const bySupplier = close.filter((x) => similar(line.description, x.supplier));
      for (const [pool, bonus] of [[bySupplier, 25], [close, 0]] as const) {
        if (pool.length < 2) continue;
        const ids = subsetSum(pool, amount);
        if (ids) {
          const picked = pool.filter((x) => ids.includes(x.id));
          const spread = Math.max(...picked.map((x) => Math.abs(days(line.date, x.date))));
          options.push({ lineId: line.id, s: { kind: 'cost', ids, score: 35 + bonus - spread * 3, label: `${ids.length} items adding up: ${picked.map((x) => x.description).slice(0, 4).join(', ')}${ids.length > 4 ? '…' : ''}` } });
          break;
        }
      }
      for (const w of c.wages) {
        if (w.sourceId !== line.sourceId || w.amountCents !== amount || Math.abs(days(line.date, w.date)) > 3) continue;
        const sim = similar(line.description, w.workerName);
        options.push({ lineId: line.id, s: { kind: 'wage_payment', ids: [w.id], score: 40 + (sim ? 25 : 0) - Math.abs(days(line.date, w.date)) * 3, label: `Wages paid to ${w.workerName}` } });
      }
    } else {
      for (const r of c.receipts) {
        if (r.sourceId !== line.sourceId || r.amountCents !== amount || days(line.date, r.date) < -3 || days(line.date, r.date) > 7) continue;
        options.push({ lineId: line.id, s: { kind: 'receipt', ids: [r.id], score: 55 - Math.abs(days(line.date, r.date)) * 3, label: r.label } });
      }
      for (const inv of c.invoices) {
        const asDeposit = inv.depositOutstandingCents === amount;
        if (inv.balanceCents !== amount && !asDeposit) continue;
        if (line.date < inv.issueDate && !asDeposit) continue;
        const named = line.description.toLowerCase().includes(inv.number.toLowerCase()) || (inv.clientName && similar(line.description, inv.clientName));
        options.push({
          lineId: line.id,
          s: { kind: 'invoice', ids: [inv.id], score: 40 + (named ? 25 : 0), label: `${asDeposit ? 'Deposit' : 'Payment'} for invoice ${inv.number}${inv.clientName ? ` (${inv.clientName})` : ''}, ${zar(amount)} owing` },
        });
      }
    }
  }
  // Best first; each record goes to one line only.
  options.sort((a, b) => b.s.score - a.s.score);
  const used = new Set<string>();
  const out = new Map<string, Suggestion>();
  for (const o of options) {
    if (out.has(o.lineId) || o.s.ids.some((id) => used.has(`${o.s.kind}:${id}`))) continue;
    if (rejected.has(`${o.lineId}|${suggestionKey(o.s)}`)) continue;
    out.set(o.lineId, o.s);
    for (const id of o.s.ids) used.add(`${o.s.kind}:${id}`);
  }
  return out;
}

// ---------------------------------------------------------------- new costs from the statement
const PREFIXES =
  /^(pos purchase|pos local purchase|purchase|card purchase|debit order|magtape debit|acb debit:?\s*external|acb debit|fnb app payment to|fnb app transfer to|fnb ob pmt|int-banking pmt to|internet pmt to|internet payment|immediate payment to|digital payment dt|digital payment|digital transfer|scheduled pmt to|send money|payment to|payment|eft|debit|recurring payment|notific|card)\b[\s:-]*/i;

/** The supplier's name out of a bank description ("POS PURCHASE BUILDERS WAREHOUSE 4567*1234 12 OCT"). */
export function supplierFrom(description: string): string {
  let s = description.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4; i++) s = s.replace(PREFIXES, '');
  s = s
    .replace(/\b\d{4,6}\*+\d{3,4}\b|\*{2,}\d+/g, ' ')
    .replace(/\b\d{1,2}\s?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi, ' ')
    .replace(/\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/g, ' ')
    .replace(/\b\d{5,}\b|#/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = s.split(' ').filter(Boolean).slice(0, 4);
  // Short all-capitals words without vowels are names (MTN, BP); the rest read better in title case.
  return words.map((w) => (w.length <= 3 && /^[A-Z]+$/.test(w) && !/[AEIOU]/.test(w) ? w : w[0]!.toUpperCase() + w.slice(1).toLowerCase())).join(' ') || description.slice(0, 40);
}

const RULES: [RegExp, string[]][] = [
  [/interest/i, ['interest']],
  [/\bfee|charge|service fee|monthly acc|admin|cash dep|bank costs|sms notif|card fee|\bfnb\b.*fee|overdraft/i, ['bank']],
  [/insur|assur|santam|outsurance|hollard|king price|miway|budget ins|discovery ins|old mutual|momentum|sanlam|1life|clientele/i, ['insurance']],
  [/engen|shell|\bbp\b|sasol|caltex|totalenergies|\btotal\b|astron|fuel|petrol|garage|filling/i, ['petrol', 'fuel']],
  [/vodacom|\bmtn\b|telkom|cell c|\brain\b|afrihost|airtime|\bdata\b|webafrica|axxess|cool ideas/i, ['cellphone', 'airtime', 'phone']],
  [/builders|cashbuild|buco|mica|leroy|timber|hardware|plumb|tile|cement|brick|paint|steel|chamberlain|pennypinchers|penny pinchers/i, ['parts', 'materials']],
  [/tyre|autozone|midas|goldwagen|service centre|mechanic|panel beat|supa quick|tiger wheel/i, ['vehicle maintenance', 'vehicle']],
  [/accounting|accountant|sars|cipc|bookkeep/i, ['accounting']],
  [/facebook|google ads|\bmeta\b|advert|gumtree/i, ['advertising']],
  [/spur|steers|kfc|nando|mcdonald|wimpy|restaurant|coffee|cafe/i, ['entertainment']],
];

/**
 * The cost type for a new cost from a statement line: how the same supplier was captured
 * before, else a few well-known names (fees, insurers, fuel stations, cellphone networks).
 */
export function guessCategory(
  description: string,
  categories: { id: string; name: string; active: boolean }[],
  history: { supplier: string; categoryId: string }[],
  opts: { fallback?: boolean } = {},
): string | null {
  const counts = new Map<string, number>();
  for (const h of history) if (h.supplier && similar(description, h.supplier)) counts.set(h.categoryId, (counts.get(h.categoryId) ?? 0) + 1);
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best) return best[0];
  const active = categories.filter((x) => x.active);
  for (const [re, names] of RULES) {
    if (!re.test(description)) continue;
    const hit = active.find((x) => names.some((n) => x.name.toLowerCase().includes(n)));
    if (hit) return hit.id;
  }
  return opts.fallback === false ? null : (active.find((x) => /sundry/i.test(x.name))?.id ?? null);
}

/** Money in that's income rather than a client paying an invoice: interest, cashback, rewards. */
export function guessIncome(description: string, accounts: { id: string; systemKey: string | null; name: string }[]): string | null {
  if (!/interest|int\.? ?cr|cash ?back|reward|ebucks|vitality money|discovery miles/i.test(description)) return null;
  return (accounts.find((a) => a.systemKey === 'revenue_other') ?? accounts.find((a) => /other income/i.test(a.name)))?.id ?? null;
}
