/**
 * Fills a test server's books with made-up data for the setup that was chosen (docs/TEST_SERVER.md):
 * the last full financial year and this one to date, day by day, through Shap's own API, as the
 * owner would have captured it. Every write goes through the same routes, checks and postings as
 * a person's would, so the books audit applies to it like any other books.
 *
 * What it makes depends on the setup: the kind of business (who puts money in and takes it out,
 * and how it's taxed), the trade (what it sells and buys), VAT, quotes and jobs, employees, casual
 * workers, counter sales and stock, supplier bills, the time tracker and the travel logbook.
 *
 * The same setup gives the same books: each month's made-up activity comes from a random
 * generator seeded with the setup and the month, so a month that has ended always looks the same
 * (within one financial year: the filling starts at the last full year, which moves at a year end).
 *
 * The amounts it decides for itself (drawings, dividends, how much trade a business not registered
 * for VAT does) are rough rules of thumb, made to keep the books lawful and lived in. The tax it
 * pays (provisional tax, turnover tax) is what Shap's own estimates say. None of it is advice.
 */
import {
  addDays,
  addMonths,
  businessDayOnOrBefore,
  entity,
  estimateTax,
  featureOn,
  financialYear,
  isBusinessDay,
  lastBusinessDay,
  monthEnd,
  NO_TAX_INVOICE_CENTS,
  paysOutProfit,
  provisionalPayable,
  turnoverTax,
  turnoverTaxLimit,
  vat201Due,
  vatPeriod,
  vatRateOn,
  vatThresholds,
  type Feature,
  type TaxEstimateFigures,
} from '@shap/shared';
import type { Db } from '../db/index.js';
import { CLIENTS, GENERIC_GOODS, PEOPLE, STREETS, SUBURBS, TOWN, tradeFor, WORKER_NAMES, type Good, type LineCat, type Service } from './catalogue.js';
import { idNumber, luhnNumber, rng, type Rng } from './rng.js';
import { slipPdf } from './slip.js';

/** How the generator reaches Shap: its own API, as the owner. */
export interface Io {
  get<T = any>(url: string): Promise<T>;
  send<T = any>(method: 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<T>;
}

export interface PopulateOptions {
  /** The last day to fill (today). */
  today: string;
  /** Tests: start later than the start of the last full financial year. */
  from?: string;
  /** Tests: less of everything (0.2 is about a fifth); 1 is a real business's worth. */
  scale?: number;
  progress?: (p: { done: number; total: number; step: string }) => void;
}

export interface PopulateSummary {
  from: string;
  to: string;
  invoices: number;
  quotes: number;
  sales: number;
  costs: number;
  payRuns: number;
}

const R = (rand: number) => Math.round(rand * 100);
/** Rounded down to whole hundreds of rand (provisional tax, dividends). */
const down = (cents: number, to = R(100)) => Math.floor(cents / to) * to;

interface Ref {
  settings: Record<string, any>;
  sources: { id: string; name: string; kind: string; role: string | null; till: boolean; accountId: string; active: boolean }[];
  categories: { id: string; name: string; kind: string; accountId: string; active: boolean }[];
  workTypes: { id: string; name: string; active: boolean }[];
  accounts: { id: string; code: string; name: string; type: string; systemKey: string | null }[];
}

interface OpenInvoice {
  id: string;
  number: string;
  issued: string;
  clientId: string | null;
  neverPays: boolean;
}

/** Fills the books. The route checks the books are new first. */
export async function populate(io: Io, db: Db, opts: PopulateOptions): Promise<PopulateSummary> {
  const scale = opts.scale ?? 1;
  // Rent, salaries and the like don't shrink with a test's scale as far as the trade does.
  const fixed = Math.max(0.3, Math.min(1, scale));
  const today = opts.today;
  let ref = await io.get<Ref>('/api/reference');
  const s = ref.settings;
  const kind = entity(s.businessType);
  const has = (f: Feature) => featureOn(s.features, f);
  const vat = Boolean(s.vatRegistered);
  const trade = tradeFor(s.industry);
  const fyEndMonth = Number(s.fyEndMonth);
  // The last full financial year and this one to date.
  const thisFy = financialYear(today, fyEndMonth);
  const lastFy = financialYear(addDays(thisFy.start, -1), fyEndMonth);
  const start = opts.from && opts.from > lastFy.start ? opts.from : lastFy.start;
  // The setup's answers that change what's made (not the look of the documents or the reminders).
  const SHAPES: Feature[] = ['jobs', 'quotes', 'workers', 'payroll', 'dividends', 'sales', 'inventory', 'bills', 'logbook', 'timeTracker', 'proformas', 'creditNotes'];
  const seed = ['shap-test', s.businessType, s.industry, vat ? `vat-${s.vatCategory}` : 'novat', s.turnoverTax ? 'tt' : '', s.sdl ? 'sdl' : '', `fy${fyEndMonth}`, SHAPES.filter(has).join(',')].join('|');
  const monthRng = (ym: string) => rng(`${seed}|${ym}`);
  const summary: PopulateSummary = { from: start, to: today, invoices: 0, quotes: 0, sales: 0, costs: 0, payRuns: 0 };
  const n = (range: readonly [number, number], r: Rng) => Math.max(1, Math.round(r.int(range[0], range[1]) * scale));
  /** The VAT in a VAT-inclusive amount, at the rate on the day. */
  const vatIn = (totalCents: number, date: string) => Math.round((totalCents * vatRateOn(date)) / (10_000 + vatRateOn(date)));
  /** A price before VAT, with VAT added at the rate on the day. */
  const withVat = (cents: number, date: string) => Math.round((cents * (10_000 + vatRateOn(date))) / 10_000);

  // ---------------------------------------------------------------- what's in the books already
  const acc = (key: string) => {
    const a = ref.accounts.find((x) => x.systemKey === key);
    if (!a) throw new Error(`No account for ${key}`);
    return a.id;
  };
  const source = (pred: (x: Ref['sources'][number]) => boolean, what: string) => {
    const x = ref.sources.find(pred);
    if (!x) throw new Error(`No payment account for ${what}`);
    return x.id;
  };
  const bank = source((x) => x.kind === 'bank' && x.active && !x.role, 'the bank');
  const bills = source((x) => x.role === 'bills', 'bills');
  // Paid personally: the owner's (a partner's own, in a partnership, once the partners are in).
  let ownerPaid = source((x) => x.kind === 'owner', 'paid personally');
  const category = async (name: string, kindOf: string, accountKey: string): Promise<string> => {
    const c = ref.categories.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (c) return c.id;
    const made = await io.send<{ id: string }>('POST', '/api/categories', { name, kind: kindOf, accountId: acc(accountKey) });
    ref.categories.push({ id: made.id, name, kind: kindOf, accountId: acc(accountKey), active: true });
    return made.id;
  };
  const cat = async (name: string) => {
    const c = ref.categories.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!c) throw new Error(`No cost type called ${name}`);
    return c.id;
  };

  // Reads straight from the books (balances), to keep the bank above water.
  const bankBalance = async (on: string) => {
    const [b] = await db<{ b: number }[]>`select coalesce(sum(l.amount_cents), 0)::bigint as b from ledger l where l.account_id = ${acc('bank')} and l.date <= ${on}::date`;
    return Number(b!.b);
  };
  /** Profit before tax over a period (income less costs), from the books. */
  const profit = async (from: string, to: string) => {
    const [p] = await db<{ p: number }[]>`
      select coalesce(-sum(l.amount_cents), 0)::bigint as p from ledger l join accounts a on a.id = l.account_id
      where a.type in ('income', 'cost_of_sales', 'expense') and coalesce(a.system_key, '') <> 'income_tax' and l.date between ${from}::date and ${to}::date`;
    return Number(p!.p);
  };

  // ---------------------------------------------------------------- the day-by-day plan
  let current = start;
  const plan = new Map<string, (() => Promise<unknown>)[]>();
  const on = (date: string, fn: () => Promise<unknown>) => {
    // Before the books start (the first month's earlier days) or after today: not made.
    if (date < start || date > today) return;
    // Planning a day that has already gone would lose it without a word: a mistake here, not in the books.
    if (date < current) throw new Error(`planned for ${date}, before ${current}`);
    const list = plan.get(date) ?? [];
    list.push(fn);
    plan.set(date, list);
  };
  const workdays = (from: string, to: string, saturdays = false) => {
    const out: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
      if (isBusinessDay(d) || (saturdays && dow === 6)) out.push(d);
    }
    return out;
  };
  /** Payments due by a date: the business day on or before it. */
  const byDay = (d: string) => businessDayOnOrBefore(d);
  /** Things that happen from a date: the business day on or after it. */
  const fromDay = (d: string) => {
    let x = d;
    while (!isBusinessDay(x)) x = addDays(x, 1);
    return x;
  };

  // ---------------------------------------------------------------- the people
  const people = monthRng('people');
  // A co-op has at least five members (Co-operatives Act s6(1)(a)); a partnership two partners;
  // a trust a beneficiary who is also a trustee, and another trustee.
  const owners: string[] =
    kind.key === 'partnership' ? [PEOPLE[0]!, PEOPLE[1]!]
    : kind.key === 'coop' ? PEOPLE.slice(2, 7)
    : kind.key === 'trust' ? [PEOPLE[people.int(0, 5)]!, PEOPLE[people.int(6, PEOPLE.length - 1)]!]
    : [PEOPLE[people.int(0, PEOPLE.length - 1)]!];
  const partnerList = async () => (await io.get<{ partners: { id: string; name: string; shareBp: number; capitalAccountId: string }[] }>('/api/partners')).partners;

  // ---------------------------------------------------------------- how much trade
  // A business not registered for VAT stays under the compulsory registration line, and one on
  // turnover tax under its limit: to 70% of the lower, a twelfth a month (by when it's quoted or sold).
  const capFor = (date: string): number | null => {
    const lines: number[] = [];
    if (!vat) lines.push(vatThresholds(date).compulsoryCents);
    if (s.turnoverTax) lines.push(turnoverTaxLimit(financialYear(date, fyEndMonth).end));
    return lines.length ? Math.round((Math.min(...lines) * 0.7) / 12) : null;
  };
  const traded = new Map<string, number>();
  // Spread over the month: up to the month's share so far (and a few days ahead, for a bigger job),
  // so it trades to the month's end rather than stopping once the month's twelfth is used.
  const roomFor = (date: string, cents: number) => {
    const cap = capFor(date);
    if (cap == null) return true;
    const days = Number(monthEnd(date).slice(8, 10));
    const share = Math.min(1, (Number(date.slice(8, 10)) + 3) / days);
    return (traded.get(date.slice(0, 7)) ?? 0) + cents <= cap * share;
  };
  const trade$ = (date: string, cents: number) => traded.set(date.slice(0, 7), (traded.get(date.slice(0, 7)) ?? 0) + cents);
  // A small business (under those lines) rents a smaller place and employs fewer people.
  const small = !vat || Boolean(s.turnoverTax);

  // ---------------------------------------------------------------- clients
  const clients: { id: string; name: string; vat: boolean }[] = [];
  const addClients = async () => {
    const r = monthRng('clients');
    for (const [i, c] of CLIENTS.entries()) {
      // A business's name could be a real one's: marked as made up.
      const name = c.contact ? `${c.name} (made up)` : c.name;
      const address = `${r.int(1, 120)} ${r.pick(STREETS)}\n${r.pick(SUBURBS)}\n${TOWN}`;
      const email = `${c.name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '')}@example.com`;
      const made = await io.send<{ id: string }>('POST', '/api/clients', {
        code: `TEST${String(i + 1).padStart(3, '0')}`,
        name,
        contactPerson: c.contact ?? '',
        email,
        phone: `000 ${String(r.int(100, 999))} ${String(r.int(1000, 9999))}`,
        address,
        vatNumber: c.vat ? luhnNumber(r, '4', 10) : '',
        notes: 'Made up, for testing.',
      });
      clients.push({ id: made.id, name, vat: Boolean(c.vat) });
    }
  };
  // A business's regulars come back more often than strangers.
  const pickClient = (r: Rng) => clients[r.chance(0.6) ? r.int(0, 7) : r.int(0, clients.length - 1)]!;

  // ---------------------------------------------------------------- money in from the owners
  const capitalCents = R(trade.asset === 'bakkie' || has('logbook') ? 300_000 : has('inventory') ? 220_000 : 140_000);
  const lenderLine = kind.key === 'sole_prop' ? 'Capital from the owner' : kind.key === 'npc' ? 'Loan from a director' : kind.key === 'partnership' ? 'Loan from the partners' : `Loan from ${owners[0]}`;
  const putInCapital = async (date: string) => {
    const lines: { accountId: string; debitCents?: number; creditCents?: number; memo?: string }[] = [{ accountId: acc('bank'), debitCents: capitalCents, memo: 'Money put in to start the business' }];
    if (kind.key === 'partnership') {
      const partners = await partnerList();
      let left = capitalCents;
      partners.forEach((p, i) => {
        const part = i === partners.length - 1 ? left : Math.round((capitalCents * p.shareBp) / 10_000);
        left -= part;
        lines.push({ accountId: p.capitalAccountId, creditCents: part, memo: `Capital from ${p.name}` });
      });
    } else if (kind.key === 'sole_prop' || kind.key === 'npc') {
      lines.push({ accountId: acc('owner_loan'), creditCents: capitalCents, memo: lenderLine });
    } else {
      // Shares, a CC's members' contributions, a co-op's members' shares (R1 000 each), a trust's settlement.
      const shares = R(kind.key === 'trust' ? 100 : kind.key === 'cc' ? 10_000 : kind.key === 'coop' ? 1_000 * owners.length : 1_000);
      const what = kind.key === 'trust' ? 'Trust capital (the settlement)' : kind.key === 'cc' ? 'Members’ contributions' : kind.key === 'coop' ? `Members’ shares (${owners.length} members)` : 'Shares issued';
      lines.push({ accountId: acc('share_capital'), creditCents: shares, memo: what });
      lines.push({ accountId: acc('owner_loan'), creditCents: capitalCents - shares, memo: kind.key === 'coop' ? 'Loans from the members' : lenderLine });
    }
    await io.send('POST', '/api/journals', { date, description: 'Money put in to start the business (made up)', reference: 'START', lines });
  };
  /**
   * The owners lend the business what it needs to stay out of overdraft (or, a sole proprietor,
   * put in more capital): an unfunded overdraft would be insolvent, interest-free trading.
   */
  const keepAfloat = async (date: string, needCents = 0) => {
    const floor = R(10_000) + needCents;
    const balance = await bankBalance(date);
    if (balance >= floor) return;
    const lend = Math.ceil((floor - balance + R(40_000) * fixed) / R(10_000)) * R(10_000);
    await io.send('POST', '/api/journals', {
      date,
      description: `${kind.key === 'sole_prop' ? 'More capital from the owner' : `${lenderLine.replace('Loan from', 'Further loan from')}`} (made up)`,
      reference: 'LOAN',
      lines: [{ accountId: acc('bank'), debitCents: lend }, { accountId: acc('owner_loan'), creditCents: lend }],
    });
  };

  // ---------------------------------------------------------------- costs
  /** The supplier's slip, made up, uploaded as the business would photograph it (most costs have one). */
  const slip = async (date: string, supplier: string, description: string, totalCents: number, vatCents: number, registered: boolean): Promise<string | null> => {
    const r = rng(`${seed}|slip|${date}|${supplier}|${totalCents}`);
    if (!r.chance(0.92)) return null;
    const number = `${supplier.replace(/[^A-Z]/g, '').slice(0, 3) || 'INV'}${r.int(10_000, 99_999)}`;
    const dataBase64 = await slipPdf({ supplier, vatNumber: registered ? luhnNumber(rng(`vat|${supplier}`), '4', 10) : '', date, number, description, totalCents, vatCents });
    const made = await io.send<{ id: string }>('POST', '/api/attachments', { filename: `slip-${date}-${number}.pdf`, mime: 'application/pdf', dataBase64 });
    return made.id;
  };
  const cost = async (c: { date: string; description: string; totalCents: number; category: string; supplier: string; code?: string; sourceId?: string; projectId?: string | null; billDays?: number; noSlip?: boolean }) => {
    const code = c.code ?? 'standard';
    const onAccount = c.billDays != null;
    const charged = code === 'standard' || code === 'not_claimable' ? vatIn(c.totalCents, c.date) : 0;
    if (!onAccount && (c.sourceId ?? bank) === bank) await keepAfloat(c.date, c.totalCents);
    // Drawings and the owners' own tax have no supplier's slip; a supplier not registered for VAT has no VAT number.
    const receiptId = c.noSlip ? null : await slip(c.date, c.supplier, c.description, c.totalCents, charged, code !== 'no_vat');
    const made = await io.send<{ id: string }>('POST', '/api/costs', {
      date: c.date,
      description: c.description,
      amountCents: c.totalCents,
      vatCents: vat ? charged : 0,
      vatCode: vat ? code : 'standard',
      supplier: c.supplier,
      categoryId: c.category,
      sourceId: onAccount ? bills : (c.sourceId ?? bank),
      projectId: c.projectId ?? null,
      billNumber: onAccount ? `INV-${c.date.replace(/-/g, '').slice(2)}-${String(summary.costs + 1).padStart(3, '0')}` : '',
      dueDate: onAccount ? addDays(c.date, c.billDays!) : null,
      receiptId,
    });
    summary.costs++;
    if (onAccount) on(fromDay(addDays(c.date, c.billDays!)), () => payBill(made.id));
    return made.id;
  };
  /** A supplier's bill, paid in full when it's due. */
  const payBill = async (costId: string) => {
    const c = await io.get<{ amountCents: number }>(`/api/costs/${costId}`);
    await keepAfloat(current, Number(c.amountCents));
    await io.send('POST', `/api/costs/${costId}/bill-payments`, { date: current, amountCents: Number(c.amountCents), sourceId: bank, note: 'Paid when due' });
  };

  // ---------------------------------------------------------------- quotes, jobs and invoices
  const workflow = has('jobs') ? 'jobs' : has('quotes') ? 'quotes' : 'invoices';
  const open: OpenInvoice[] = [];
  const activeJobs = new Map<string, { until: string }>();
  const hourly = has('timeTracker');
  const hourPrice = trade.services.find((x) => x[1] === 'hour')?.[2] ?? 500;

  const lineFor = (sv: Service, r: Rng) => {
    const [d, unit, price, catOf] = sv;
    const big = Math.max(1, trade.size);
    const qty =
      unit === 'hour' ? r.int(2, 6) * Math.ceil(big / 3)
      : unit === 'day' ? r.int(1, 3) * Math.ceil(big / 6)
      : unit === 'm²' || unit === 'm' ? r.int(8, 30) * Math.ceil(big / 4)
      : unit === 'km' ? r.int(40, 400)
      : unit === 'head' ? r.int(20, 120)
      : r.int(1, 2);
    return { category: catOf ?? 'labour', description: d, qty, unit, unitPriceCents: R(price), vatCode: 'standard' };
  };
  const materialLines = (r: Rng) => {
    if (!trade.materials.length || !r.chance(workflow === 'jobs' ? 0.8 : 0.4)) return [];
    const picks = new Set<number>();
    const howMany = r.int(1, Math.min(3, trade.materials.length));
    while (picks.size < howMany) picks.add(r.int(0, trade.materials.length - 1));
    return [...picks].map((i) => {
      const [d, unit, costRand] = trade.materials[i]!;
      return { category: 'materials' as LineCat, description: d, qty: r.int(1, 4) * Math.max(1, Math.ceil(trade.size / 3)), unit, unitPriceCents: R(Math.round(costRand * 1.3)), vatCode: 'standard', costCents: R(costRand) };
    });
  };
  const serviceLines = (r: Rng) => {
    const picks = new Set<number>();
    const howMany = r.int(1, Math.min(trade.services.length, 3));
    while (picks.size < howMany) picks.add(r.int(0, trade.services.length - 1));
    return [...picks].map((i) => lineFor(trade.services[i]!, r));
  };
  const valueOf = (lines: { qty: number; unitPriceCents: number }[]) => lines.reduce((t, l) => t + l.qty * l.unitPriceCents, 0);
  /** Buys the materials on a job or invoice from a supplier: paid, or a bill to pay. */
  const buyMaterials = async (date: string, mats: ReturnType<typeof materialLines>, r: Rng, projectId: string | null) => {
    if (!mats.length) return;
    // The supplier's invoice, VAT included (a VAT vendor claims it back; anyone else pays it as part of the cost).
    await cost({
      date,
      description: mats.map((m) => `${m.qty} × ${m.description}`).join(', ').slice(0, 190),
      totalCents: withVat(mats.reduce((t, m) => t + m.costCents * m.qty, 0), date),
      category: await cat('Parts'),
      supplier: r.pick(trade.suppliers),
      projectId,
      billDays: has('bills') && r.chance(0.6) ? 30 : undefined,
    });
  };
  const strip = (lines: { costCents?: number }[]) => lines.map(({ costCents: _c, ...l }) => l);

  /** Pays an invoice later as most clients do: on time, late, in two parts, or (rarely) never. */
  const schedulePayment = (inv: OpenInvoice, r: Rng) => {
    if (inv.neverPays) return;
    const late = r.chance(0.12);
    const day = addDays(inv.issued, late ? r.int(35, 70) : r.int(0, Math.max(3, Number(s.paymentDays ?? 7) + 10)));
    const inTwo = r.chance(0.06);
    if (inTwo) on(day, () => receive(inv, 0.5, r.chance(0.3) ? 'card' : 'eft'));
    on(inTwo ? addDays(day, r.int(10, 25)) : day, () => receive(inv, 1, r.chance(0.2) ? 'card' : 'eft'));
  };
  const receive = async (inv: OpenInvoice, part: number, method: string) => {
    const d = await io.get<{ doc: { totalCents: number; paidCents: number; writtenOffCents?: number; status: string } }>(`/api/documents/${inv.id}`);
    const owing = Number(d.doc.totalCents) - Number(d.doc.paidCents) - Number(d.doc.writtenOffCents ?? 0);
    if (d.doc.status !== 'issued' || owing <= 0) return;
    const amount = part >= 1 ? owing : Math.round(owing * part);
    await io.send('POST', `/api/documents/${inv.id}/receipts`, { date: current, amountCents: amount, sourceId: bank, method, reference: `Payment ${inv.number}` });
  };

  /** An invoice straight away (the "just invoices" way of working). */
  const invoiceNow = async (date: string, r: Rng) => {
    const client = pickClient(r);
    const svc = serviceLines(r);
    const mats = materialLines(r);
    if (!roomFor(date, valueOf([...svc, ...mats]))) return;
    trade$(date, valueOf([...svc, ...mats]));
    if (mats.length) await buyMaterials(date, mats, r, null);
    const timed = hourly ? svc.filter((l) => l.unit === 'hour') : [];
    if (timed.length) await logTime(date, null, timed.reduce((t, l) => t + l.qty, 0), r);
    const lines = [...svc.filter((l) => !timed.includes(l)), ...strip(mats)];
    const inv = await io.send<{ id: string; number: string }>('POST', '/api/documents', { kind: 'invoice', clientId: client.id, issueDate: date, lines, pricesIncludeVat: false, title: lines[0] ? String((lines[0] as { description: string }).description) : 'Time' });
    if (timed.length) await billTime(inv.id);
    await issue(inv, date, client.id, r);
  };
  const issue = async (inv: { id: string; number: string }, date: string, clientId: string | null, r: Rng) => {
    const issued = await io.send<{ number?: string }>('POST', `/api/documents/${inv.id}/issue`);
    summary.invoices++;
    const o: OpenInvoice = { id: inv.id, number: issued?.number ?? inv.number, issued: date, clientId, neverPays: r.chance(0.025) };
    open.push(o);
    schedulePayment(o, r);
  };

  /** Hours worked, on the time tracker: whole hours from eight in the morning, the day's next free hour on. */
  const timeEntries: string[] = [];
  const nextHour = new Map<string, number>();
  const logTime = async (lastDay: string, projectId: string | null, hours: number, r: Rng) => {
    let left = Math.max(1, Math.round(hours));
    let day = lastDay;
    while (left > 0) {
      const from = nextHour.get(day) ?? 8;
      const h = Math.min(left, r.int(2, 6), 17 - from);
      if (h <= 0 || day < start) {
        day = addDays(day, -1);
        if (day < start) break;
        continue;
      }
      const t = await io.send<{ id: string }>('POST', '/api/time', { projectId, startedAt: `${day}T${String(from).padStart(2, '0')}:00:00+02:00`, endedAt: `${day}T${String(from + h).padStart(2, '0')}:00:00+02:00`, note: 'Made up' });
      timeEntries.push(t.id);
      nextHour.set(day, from + h);
      left -= h;
      day = addDays(day, -1);
    }
  };
  const billTime = async (documentId: string) => {
    if (!timeEntries.length) return;
    await io.send('POST', '/api/time/bill', { documentId, ids: timeEntries.splice(0) });
  };

  /** A quote: accepted (then the work, then the invoice), declined, or still waiting. */
  const quoteNow = async (date: string, r: Rng) => {
    const client = pickClient(r);
    const svc = serviceLines(r);
    const mats = materialLines(r);
    if (!roomFor(date, valueOf([...svc, ...mats]))) return;
    trade$(date, valueOf([...svc, ...mats]));
    let projectId: string | null = null;
    const address = `${r.int(1, 120)} ${r.pick(STREETS)}, ${r.pick(SUBURBS)}`;
    const title = `${svc[0]!.description} at ${address}`;
    if (workflow === 'jobs') {
      const job = await io.send<{ id: string }>('POST', '/api/projects', { name: title.slice(0, 140), clientId: client.id, siteAddress: address, startDate: date, hourlyRateCents: hourly ? R(hourPrice) : 0, notes: 'Made up, for testing.' });
      projectId = job.id;
    }
    const lines = [...svc, ...strip(mats)];
    // Paid up front: a pro-forma invoice, then the tax invoice when the money comes in.
    const upfront = has('proformas') && r.chance(0.25);
    const q = await io.send<{ id: string; number: string }>('POST', '/api/documents', { kind: 'quote', clientId: client.id, projectId, issueDate: date, title, lines, pricesIncludeVat: false, proforma: upfront });
    summary.quotes++;
    await io.send('POST', `/api/documents/${q.id}/status`, { status: 'sent' });
    const roll = r.next();
    if (upfront && roll < 0.8) {
      // The materials come in and the money too; the tax invoice goes out when it's paid (VAT Act
      // s9(1)). The job's labour isn't logged on it after that: costs dated after a job's last
      // invoice would wait in work in progress for an invoice that never comes.
      on(addDays(date, r.int(1, 7)), async () => {
        await buyMaterials(current, mats, r, projectId);
        const inv = await io.send<{ id: string; number: string }>('POST', `/api/documents/${q.id}/convert`);
        await io.send('PUT', `/api/documents/${inv.id}`, { clientId: client.id, projectId, issueDate: current, title, lines, pricesIncludeVat: false });
        const issued = await io.send<{ number?: string }>('POST', `/api/documents/${inv.id}/issue`);
        summary.invoices++;
        const o: OpenInvoice = { id: inv.id, number: issued?.number ?? inv.number, issued: current, clientId: client.id, neverPays: false };
        open.push(o);
        await receive(o, 1, 'eft');
      });
    } else if (upfront) {
      on(addDays(date, r.int(5, 20)), () => io.send('POST', `/api/documents/${q.id}/status`, { status: 'declined' }));
    } else if (roll < 0.7) {
      const yes = addDays(date, r.int(2, 10));
      const days = r.int(1, Math.max(2, Math.ceil(trade.size * 1.5)));
      const done = addDays(yes, days);
      on(yes, async () => {
        await io.send('POST', `/api/documents/${q.id}/status`, { status: 'accepted' });
        if (projectId) activeJobs.set(projectId, { until: done });
        await buyMaterials(current, mats, r, projectId);
      });
      on(done, async () => {
        if (projectId) activeJobs.delete(projectId);
        const timed = hourly ? svc.filter((l) => l.unit === 'hour') : [];
        if (timed.length) await logTime(current, projectId, timed.reduce((t, l) => t + l.qty, 0), r);
        const inv = await io.send<{ id: string; number: string }>('POST', `/api/documents/${q.id}/convert`);
        const kept = [...svc.filter((l) => !timed.includes(l)), ...strip(mats)];
        await io.send('PUT', `/api/documents/${inv.id}`, { clientId: client.id, projectId, issueDate: current, title, lines: kept, pricesIncludeVat: false });
        if (timed.length) await billTime(inv.id);
        await issue(inv, current, client.id, r);
      });
    } else if (roll < 0.9) {
      on(addDays(date, r.int(5, 20)), () => io.send('POST', `/api/documents/${q.id}/status`, { status: 'declined' }));
    }
  };

  /** A discount agreed after the invoice went out: a credit note for 10% of it. */
  const creditNote = async (date: string) => {
    const recent = [...open].reverse().find((o) => o.issued >= addDays(date, -20) && o.issued <= date && !o.neverPays);
    if (!recent) return;
    const inv = await io.get<{ doc: { status: string; totalCents: number; paidCents: number; subtotalCents?: number; vatCents?: number }; lines: { category: string; description: string }[] }>(`/api/documents/${recent.id}`);
    if (inv.doc.status !== 'issued' || Number(inv.doc.paidCents) > 0) return;
    const before = Number(inv.doc.subtotalCents ?? Number(inv.doc.totalCents) - Number(inv.doc.vatCents ?? 0));
    const discount = Math.max(R(50), Math.round(before / 10 / 100) * 100);
    const cn = await io.send<{ id: string }>('POST', `/api/documents/${recent.id}/credit-note`);
    await io.send('PUT', `/api/documents/${cn.id}`, {
      clientId: recent.clientId,
      issueDate: date,
      creditedInvoiceId: recent.id,
      creditReason: 'Discount agreed with the client',
      title: `Discount on invoice ${recent.number}`,
      lines: [{ category: inv.lines[0]?.category ?? 'labour', description: `Discount agreed on invoice ${recent.number}`, qty: 1, unitPriceCents: discount, vatCode: 'standard' }],
      pricesIncludeVat: false,
    });
    await io.send('POST', `/api/documents/${cn.id}/issue`);
  };
  /** A client who never paid, written off as a bad debt. */
  const writeOff = async (date: string) => {
    const old = open.find((o) => o.neverPays && o.issued <= addDays(date, -120));
    if (!old) return;
    old.neverPays = false;
    await io.send('POST', `/api/documents/${old.id}/write-off`, { date, reason: 'The client can’t be traced: written off as a bad debt (made up)' });
  };

  // ---------------------------------------------------------------- counter sales and stock
  const sells = has('sales');
  const stocked = has('inventory');
  const goods: readonly Good[] = trade.goods ?? GENERIC_GOODS;
  const items: { id: string; good: Good; qty: number }[] = [];
  const till = ref.sources.find((x) => x.till)?.id ?? null;
  let tillCash = 0;
  const recentSales: { id: string; date: string; sourceId: string; method: string; lineIds: string[] }[] = [];
  const addItems = async () => {
    for (const g of goods) {
      const it = await io.send<{ id: string }>('POST', '/api/items', {
        description: g[0],
        sku: g[1],
        category: 'goods',
        unit: 'each',
        unitPriceCents: R(g[3]),
        priceIncludesVat: true,
        vatCode: g[4] ? 'zero' : 'standard',
        stocked,
        reorderLevel: stocked ? 15 : 0,
      });
      items.push({ id: it.id, good: g, qty: 0 });
    }
  };
  const buyStock = async (date: string, r: Rng, opening = false) => {
    const lines = items.filter((i) => opening || i.qty < 15).map((i) => ({ item: i, qty: Math.max(10, Math.round(r.int(60, 110) * (small ? 0.5 : 1))) }));
    if (!lines.length) return;
    const onAccount = has('bills') && !opening;
    const supplier = r.pick(trade.suppliers);
    // What the supplier charged: before VAT, and the VAT on the standard-rated lines.
    const before = lines.reduce((t, l) => t + R(l.item.good[2]) * l.qty, 0);
    const vatOnIt = lines.reduce((t, l) => t + (l.item.good[4] ? 0 : withVat(R(l.item.good[2]) * l.qty, date) - R(l.item.good[2]) * l.qty), 0);
    if (!onAccount) await keepAfloat(date, before + vatOnIt);
    const receiptId = await slip(date, supplier, lines.map((l) => `${l.qty} × ${l.item.good[0]}`).join(', ').slice(0, 300), before + vatOnIt, vatOnIt, true);
    const made = await io.send<{ costId: string }>('POST', '/api/stock/purchases', {
      date,
      supplier,
      receiptId,
      reference: `${opening ? 'OPEN' : 'PO'}-${date.replace(/-/g, '')}`,
      sourceId: onAccount ? bills : bank,
      dueDate: onAccount ? addDays(date, 30) : null,
      // A VAT vendor gives the price before VAT (the VAT is claimed); a business not registered for
      // VAT gives what it paid, VAT and all, which is its cost (IFRS for SMEs 13.6).
      lines: lines.map((l) => ({ itemId: l.item.id, qtyInvoiced: l.qty, unitCostCents: vat || l.item.good[4] ? R(l.item.good[2]) : withVat(R(l.item.good[2]), date), vatCode: l.item.good[4] ? 'zero' : 'standard' })),
    });
    summary.costs++;
    for (const l of lines) l.item.qty += l.qty;
    if (onAccount) on(fromDay(addDays(date, 30)), () => payBill(made.costId));
  };
  /** Goods for resale bought as a cost, when stock isn't kept in Shap: zero-rated goods on a cost of their own. */
  let soldStandard = 0;
  let soldZero = 0;
  const buyGoods = async (date: string, r: Rng) => {
    const supplier = r.pick(trade.suppliers);
    const billDays = has('bills') && r.chance(0.5) ? 30 : undefined;
    if (soldStandard > 0) await cost({ date, description: 'Goods for resale', totalCents: Math.round(soldStandard * 0.55), category: await category('Goods for resale', 'materials', 'cos_goods'), supplier, billDays });
    if (soldZero > 0) await cost({ date, description: 'Goods for resale (zero-rated foods)', totalCents: Math.round(soldZero * 0.6), category: await category('Goods for resale', 'materials', 'cos_goods'), supplier, code: 'zero', billDays });
    soldStandard = 0;
    soldZero = 0;
  };
  const sellNow = async (date: string, r: Rng, toClient = false) => {
    const howMany = toClient ? r.int(2, 4) : r.int(1, 3);
    const picked: { item: (typeof items)[number]; qty: number }[] = [];
    for (let i = 0; i < howMany; i++) {
      const item = r.pick(items);
      if (picked.some((p) => p.item === item)) continue;
      const qty = toClient ? r.int(20, 45) : r.int(1, 3);
      if (stocked && item.qty < qty) continue;
      picked.push({ item, qty });
    }
    // A zero-rated supply over R50 needs a full tax invoice (VAT Act s20(5) proviso, s20(6)), so a
    // walk-in buys zero-rated goods on their own, up to R50; more goes on an account customer's invoice.
    if (vat && !toClient && picked.some((p) => p.item.good[4])) {
      const z = picked.find((p) => p.item.good[4])!;
      const most = Math.floor(NO_TAX_INVOICE_CENTS / R(z.item.good[3]));
      if (most < 1) return;
      picked.splice(0, picked.length, { item: z.item, qty: Math.min(z.qty, most) });
    }
    if (!picked.length) return;
    const shelf = picked.reduce((t, p) => t + R(p.item.good[3]) * p.qty, 0);
    if (!roomFor(date, shelf)) return;
    trade$(date, shelf);
    const client = toClient ? clients.find((c) => c.vat) ?? null : null;
    const cash = !toClient && r.chance(0.45) && till != null;
    const sourceId = cash ? till! : bank;
    const method = cash ? 'cash' : toClient ? 'eft' : 'card';
    const sale = await io.send<{ id: string; doc: { totalCents: number }; lines: { id: string }[] }>('POST', '/api/sales', {
      date,
      sourceId,
      method,
      pricesIncludeVat: true,
      clientId: client?.id ?? null,
      lines: picked.map((p) => ({ itemId: p.item.id, description: p.item.good[0], qty: p.qty, unit: 'each', unitPriceCents: R(p.item.good[3]), vatCode: p.item.good[4] ? 'zero' : 'standard', category: 'goods' })),
    });
    summary.sales++;
    for (const p of picked) {
      p.item.qty -= p.qty;
      if (p.item.good[4]) soldZero += R(p.item.good[3]) * p.qty;
      else soldStandard += R(p.item.good[3]) * p.qty;
    }
    if (cash) tillCash += Number(sale.doc.totalCents);
    recentSales.push({ id: sale.id, date, sourceId, method, lineIds: sale.lines.map((l) => l.id) });
    if (recentSales.length > 40) recentSales.shift();
  };
  const refundNow = async (date: string, r: Rng) => {
    const candidates = recentSales.filter((x) => x.date >= addDays(date, -7) && x.date < date);
    if (!candidates.length) return;
    const sale = r.pick(candidates);
    recentSales.splice(recentSales.indexOf(sale), 1);
    const lineId = sale.lineIds[0]!;
    const before = await io.get<{ lines: { id: string; itemId: string | null; unitPriceCents: number }[] }>(`/api/documents/${sale.id}`);
    const line = before.lines.find((l) => l.id === lineId);
    // Cash back from the till only if the till has it; otherwise paid back from the bank.
    const fromTill = sale.method === 'cash' && tillCash >= Number(line?.unitPriceCents ?? 0);
    const done = await io.send<{ amountCents: number }>('POST', `/api/documents/${sale.id}/refund`, {
      date,
      money: 'paid_out',
      sourceId: fromTill ? sale.sourceId : bank,
      method: fromTill ? 'cash' : sale.method === 'cash' ? 'eft' : sale.method,
      reason: 'Returned by the customer: faulty (made up)',
      lines: [{ lineId, qty: 1, restock: true }],
    });
    const back = items.find((i) => i.id === line?.itemId);
    if (back) back.qty += 1;
    if (fromTill) tillCash -= Number(done.amountCents);
  };
  /** The till's cash takings, banked. */
  const bankTill = async (date: string) => {
    if (!till || tillCash < R(200)) return;
    const tillAccount = ref.sources.find((x) => x.id === till)!.accountId;
    await io.send('POST', '/api/journals', { date, description: 'Takings banked from the till', reference: 'DEPOSIT', lines: [{ accountId: acc('bank'), debitCents: tillCash }, { accountId: tillAccount, creditCents: tillCash }] });
    tillCash = 0;
  };
  const stockTake = async (date: string, r: Rng) => {
    if (!stocked || !items.length) return;
    const lines = items.map((i) => {
      const missing = i.qty > 5 && r.chance(0.3) ? r.int(1, 2) : 0;
      return { itemId: i.id, countedQty: i.qty - missing, reason: missing ? 'Missing at the count (made up)' : '' };
    });
    await io.send('POST', '/api/stock/takes', { date, note: 'Stock count (made up)', lines });
    for (const [k, i] of items.entries()) i.qty = lines[k]!.countedQty;
  };

  // ---------------------------------------------------------------- people on the payroll
  const payroll = has('payroll');
  // Without SDL, the payroll stays under R500 000 a year (SDL is due over it): about R35 700 a
  // month, leaving room for a December bonus and overtime.
  const monthlyRoom = s.sdl ? Infinity : R(35_700);
  const employees: { id: string; body: Record<string, unknown> }[] = [];
  const hire = async (date: string, title: string, salaryCents: number, director: boolean, r: Rng) => {
    const name = `${PEOPLE[r.int(0, PEOPLE.length - 1)]!.split(' ')[0]} ${['Jacobs', 'Mabuza', 'Naidoo', 'Smit', 'Khoza', 'Petersen', 'Mkhize', 'Venter'][r.int(0, 7)]}`;
    const born = `${r.int(1965, 2002)}-${String(r.int(1, 12)).padStart(2, '0')}-${String(r.int(1, 28)).padStart(2, '0')}`;
    const body = {
      name: director ? `${owners[0]} (director)` : `${name} (${title.toLowerCase()})`,
      idNumber: idNumber(r, born),
      taxNumber: luhnNumber(r, '0', 10),
      isDirector: director,
      salaryCents,
      ageBand: 'under65',
      // No medical aid through the payroll, so no medical tax credits on it.
      medicalMembers: 0,
      // A director on a salary contributes to UIF like any employee.
      uif: true,
      startDate: date,
      endDate: null,
      bankDetails: 'Example Bank, account 0000000000 (made up)',
      active: true,
    };
    const e = await io.send<{ id: string }>('POST', '/api/employees', body);
    employees.push({ id: e.id, body });
  };
  const payRun = async (period: string, r: Rng) => {
    const payDate = byDay(`${period}-25`);
    const run = await io.send<{ id: string }>('POST', '/api/pay-runs', { period, payDate, sourceId: bank });
    const full = await io.get<{ lines: { employeeId: string; salaryCents: number }[] }>(`/api/pay-runs/${run.id}`);
    for (const l of full.lines) {
      const e = employees.find((x) => x.id === l.employeeId);
      const december = period.endsWith('-12') && e && !e.body.isDirector;
      const overtime = !e?.body.isDirector && r.chance(0.2) ? Math.round(R(r.int(4, 25) * 100) * fixed) : 0;
      if (december || overtime) {
        await io.send('PUT', `/api/pay-runs/${run.id}/lines/${l.employeeId}`, { salaryCents: Number(l.salaryCents), overtimeCents: overtime, commissionCents: 0, extraCents: december ? Number(l.salaryCents) : 0, note: december ? 'Year-end bonus (made up)' : 'Overtime (made up)' });
      }
    }
    await keepAfloat(current, full.lines.reduce((t, l) => t + Number(l.salaryCents) * 2, 0));
    await io.send('POST', `/api/pay-runs/${run.id}/finalise`);
    summary.payRuns++;
  };
  const payEmp201 = async (period: string) => {
    const sars = await io.get<{ emp201: { period: string; payeCents: number; uifCents: number; sdlCents: number; paidCents: number }[] }>('/api/payroll/sars');
    const m = sars.emp201.find((x) => x.period === period);
    if (!m) return;
    const due = Number(m.payeCents) + Number(m.uifCents) + Number(m.sdlCents) - Number(m.paidCents);
    if (due <= 0) return;
    await keepAfloat(current, due);
    await io.send('POST', '/api/sars-payments', { kind: 'emp201', period, date: current, amountCents: due, sourceId: bank, reference: `EMP201 ${period}` });
  };

  // ---------------------------------------------------------------- casual workers
  // Helpers who come in on the days there's work: two or three days a week each.
  const workers: { id: string; rate: number; owed: number }[] = [];
  const general = ref.workTypes.find((w) => w.active)?.id ?? null;
  const labourDay = async (date: string, r: Rng) => {
    const here = workers.filter(() => r.chance(0.5));
    if (!here.length) return;
    const jobs = [...activeJobs.entries()].filter(([, j]) => j.until >= date).map(([id]) => id);
    const projectId = jobs.length ? r.pick(jobs) : null;
    const entries = here.map((w) => ({ workerId: w.id, days: 1, wageCents: w.rate, allowanceCents: r.chance(0.3) ? R(50) : 0 }));
    await io.send('POST', '/api/labour', { date, projectId, workTypeId: projectId ? null : general, note: '', entries });
    for (const e of entries) workers.find((w) => w.id === e.workerId)!.owed += e.wageCents + e.allowanceCents;
  };
  const payWorkers = async (date: string) => {
    const owed = workers.reduce((t, w) => t + w.owed, 0);
    if (owed > 0) await keepAfloat(date, owed);
    for (const w of workers) {
      if (w.owed <= 0) continue;
      await io.send('POST', '/api/wage-payments', { date, workerId: w.id, amountCents: w.owed, sourceId: bank, note: 'Week’s wages' });
      w.owed = 0;
    }
  };

  // ---------------------------------------------------------------- the travel logbook
  // SARS's logbook runs by the tax year (March to February), whatever the business's year end. Each
  // trip is there and back, and the odometer moves by what the trips add up to, private ones too.
  // Private use is kept small (under 5%: full input VAT on the vehicle, VAT Act s17(1)), and none
  // for a business with its own legal personality (it would be a fringe benefit on the payroll).
  const taxYear = (d: string) => financialYear(d, 2);
  let odometer = 48_000;
  let yearStartKm = odometer;
  const privateUse = kind.key === 'sole_prop' || kind.key === 'partnership';
  const vehicle = `${trade.asset === 'bakkie' ? 'Single-cab bakkie' : 'Panel van'} (made up), CA 000-000`;
  const trip = async (date: string, r: Rng) => {
    const business = !privateUse || !r.chance(0.03);
    const km = business ? 2 * r.int(8, 45) : 2 * r.int(3, 10);
    const client = business ? pickClient(r) : null;
    await io.send('POST', '/api/trips', { date, fromPlace: 'Workshop', toPlace: business ? `${client!.name}, ${r.pick(SUBURBS)}` : 'Shops', reason: business ? 'To the client and back (made up)' : 'Private', km, business, clientId: client?.id ?? null });
    odometer += km;
  };
  const logbookYear = async (yearEnd: string, ended: boolean) => {
    await io.send('PUT', `/api/logbook/${yearEnd}`, { vehicle, odometerStart: yearStartKm, odometerEnd: ended ? odometer : null });
  };

  // ---------------------------------------------------------------- the owners' money and tax
  const drawings = async (date: string) => {
    if (kind.payout !== 'drawings') return;
    const room = (await bankBalance(date)) - R(25_000);
    const want = R(Math.round(14_000 * fixed * (small ? 0.6 : 1)));
    const take = Math.min(want, room);
    if (take < R(1_000)) return;
    const shares = kind.key === 'partnership' ? await partnerList() : [{ name: owners[0]!, shareBp: 10_000 }];
    for (const p of shares) {
      const part = Math.round((take * p.shareBp) / 10_000 / 100) * 100;
      if (part <= 0) continue;
      await cost({ date, description: `Drawings: ${p.name}`, totalCents: part, category: await cat(personalOf(p.name)), supplier: p.name, code: 'no_vat', noSlip: true });
    }
  };
  const personalOf = (name: string) => (kind.key === 'partnership' ? `Personal (${name})` : 'Personal (owner)');
  const taxPaidByBusiness = (kind.taxedAs === 'company' || kind.taxedAs === 'trust' || (kind.taxedAs === 'npc' && !s.approvedPbo)) && !s.turnoverTax;
  const ownTaxPaid = new Map<string, number>();
  /**
   * Provisional tax, as Shap's own provisional tax screen works it out: the year so far projected
   * to twelve months, Shap's estimate of the year's tax (the partners each on their own share; a
   * trust on what it keeps), half of it at six months, the rest less what was paid at the year end.
   */
  const provisional = async (date: string, fy: { start: string; end: string }, second: boolean) => {
    if (s.turnoverTax || (kind.taxedAs === 'npc' && s.approvedPbo)) return;
    const asAt = monthEnd(addMonths(date, -1)) < fy.start ? date : monthEnd(addMonths(date, -1));
    const p = await io.get<{ fy: { end: string }; lines: { type: string; projectedCents: number }[]; assessedLossCents: number; kind: TaxEstimateFigures['kind']; approvedPbo: boolean; sbc: boolean | null; partners: { name: string; shareBp: number }[]; distributedCents: number; payments: { amountCents: number }[] }>(
      `/api/reports/provisional-tax?fyEnd=${fy.end}&asAt=${asAt}`,
    );
    const sum = (t: string) => p.lines.filter((l) => l.type === t).reduce((x, l) => x + Number(l.projectedCents), 0);
    const net = sum('income') - sum('cost_of_sales') - sum('expense');
    const est = estimateTax({ kind: p.kind, profitCents: net, assessedLossCents: Number(p.assessedLossCents), fyEnd: p.fy.end, sbc: p.sbc === true, distributedCents: Number(p.distributedCents), approvedPbo: p.approvedPbo, partners: p.partners });
    if (taxPaidByBusiness) {
      const paid = p.payments.reduce((t, x) => t + Number(x.amountCents), 0);
      const due = down(provisionalPayable({ taxCents: est.taxCents, period: second ? 2 : 1, paidCents: paid }).payableCents);
      if (due <= 0) return;
      await keepAfloat(date, due);
      await io.send('POST', '/api/sars-payments', { kind: 'irp6', period: fy.end.slice(0, 7), date, amountCents: due, sourceId: bank, reference: `IRP6 ${second ? 'second' : 'first'} payment` });
    } else if (kind.payout === 'drawings') {
      // A sole proprietor's or partner's provisional tax is their own: paid from the business, it's drawings.
      const each = est.partners?.map((x) => ({ name: x.name, tax: x.taxCents })) ?? [{ name: owners[0]!, tax: est.taxCents }];
      for (const x of each) {
        const key = `${fy.end}|${x.name}`;
        const due = down(second ? x.tax - (ownTaxPaid.get(key) ?? 0) : x.tax / 2);
        if (due <= 0) continue;
        await keepAfloat(date, due);
        await cost({ date, description: `Provisional tax (IRP6) for ${x.name}: their own tax`, totalCents: due, category: await cat(personalOf(x.name)), supplier: 'SARS', code: 'no_vat', noSlip: true });
        ownTaxPaid.set(key, (ownTaxPaid.get(key) ?? 0) + due);
      }
    }
  };
  /**
   * Turnover tax's two interim payments (TT02), for a sole proprietor or partners: their own tax,
   * so paid from the business it's drawings. (Shap has no payment of its own for a company's: none
   * is made for one.) Worked out from the year's turnover so far, projected to twelve months.
   */
  const turnoverInterim = async (date: string, fy: { start: string; end: string }, second: boolean) => {
    if (!s.turnoverTax || kind.payout !== 'drawings') return;
    const months = Math.max(1, Math.round((Date.parse(date) - Date.parse(fy.start)) / (30.44 * 86_400_000)));
    const [t] = await db<{ income: number }[]>`
      select coalesce(-sum(l.amount_cents), 0)::bigint as income from ledger l join accounts a on a.id = l.account_id
      where a.type = 'income' and coalesce(a.system_key, '') not in ('disposal_gain_loss', 'interest_income') and l.date between ${fy.start}::date and ${date}::date`;
    const projected = Math.round((Number(t!.income) / months) * 12);
    const shares = kind.key === 'partnership' ? await partnerList() : [{ name: owners[0]!, shareBp: 10_000 }];
    for (const p of shares) {
      const tax = turnoverTax(Math.round((projected * p.shareBp) / 10_000), fy.end);
      const key = `tt|${fy.end}|${p.name}`;
      const due = down(second ? tax - (ownTaxPaid.get(key) ?? 0) : tax / 2);
      if (due <= 0) continue;
      await keepAfloat(date, due);
      await cost({ date, description: `Turnover tax (TT02) interim payment for ${p.name}: their own tax`, totalCents: due, category: await cat(personalOf(p.name)), supplier: 'SARS', code: 'no_vat', noSlip: true });
      ownTaxPaid.set(key, (ownTaxPaid.get(key) ?? 0) + due);
    }
  };
  /**
   * A dividend (a CC's distribution, a co-op's to its members in equal shares) out of last year's
   * profit after tax, three months after the year end; a trust's distribution of the year's income
   * at its end. Never more than half the profit after tax, and never out of the bank's last R30 000:
   * a rule of thumb, not the solvency and liquidity test (Companies Act s4, s46; CC Act s51), which
   * is the owners' to do.
   */
  const payOut = async (date: string, fy: { start: string; end: string }, fromThisYear: boolean) => {
    if (!paysOutProfit(s.businessType) || !has('dividends')) return;
    const p = await profit(fy.start, fromThisYear ? date : fy.end);
    const after = p - estimateTax({ kind: kind.taxedAs === 'trust' ? 'trust' : 'company', profitCents: p, assessedLossCents: 0, fyEnd: fy.end }).taxCents;
    const room = (await bankBalance(date)) - R(30_000);
    const payees = kind.key === 'coop' ? owners : [owners[0]!];
    const each = down(Math.min(after * (fromThisYear ? 0.6 : 0.5), room) / payees.length, R(1_000));
    if (each * payees.length < R(5_000)) return;
    let dwt = 0;
    for (const who of payees) {
      const made = await io.send<{ id: string }>('POST', '/api/dividends', { declaredOn: date, paidOn: date, shareholder: who, grossCents: each, sourceId: bank, conduit: true, note: 'Made up' });
      const list = await io.get<{ dividends?: { id: string; dwtCents: number }[] } | { id: string; dwtCents: number }[]>('/api/dividends');
      const rows = Array.isArray(list) ? list : (list.dividends ?? []);
      dwt += Number(rows.find((x) => x.id === made.id)?.dwtCents ?? 0);
    }
    if (dwt > 0) {
      const [y, m] = addMonths(date, 1).split('-').map(Number) as [number, number];
      on(lastBusinessDay(y, m), async () => {
        await keepAfloat(current, dwt);
        await io.send('POST', '/api/sars-payments', { kind: 'dwt', period: date.slice(0, 7), date: current, amountCents: dwt, sourceId: bank, reference: 'Dividends tax' });
      });
    }
  };
  const payVat = async (period: { start: string; end: string }) => {
    const ret = await io.get<{ fields: { field20: number } }>(`/api/vat/return?on=${period.end}`);
    const f20 = Number(ret.fields.field20);
    if (f20 === 0) return;
    const pay = f20 > 0;
    const go = (d: string) =>
      io.send('POST', '/api/journals', {
        date: d,
        description: `VAT201 ${period.start} to ${period.end}: ${pay ? 'paid to' : 'refund from'} SARS`,
        reference: 'VAT201',
        lines: pay ? [{ accountId: acc('vat'), debitCents: f20 }, { accountId: acc('bank'), creditCents: f20 }] : [{ accountId: acc('bank'), debitCents: -f20 }, { accountId: acc('vat'), creditCents: -f20 }],
      });
    if (pay) {
      await keepAfloat(current, f20);
      await go(current);
    } else {
      // A refund comes in about three weeks after the return.
      const d = fromDay(addDays(current, 21));
      on(d, () => go(d));
    }
  };

  // ---------------------------------------------------------------- the overheads
  const overheads = async (month: string, r: Rng) => {
    const first = month === start.slice(0, 7) ? start : `${month}-01`;
    const last = monthEnd(`${month}-01`);
    // A day of the month: on a weekend or holiday, the business day before, unless that's last month.
    const at = (day: number) => {
      const d = byDay(`${month}-${String(Math.min(day, Number(last.slice(8)))).padStart(2, '0')}`);
      return d < first ? fromDay(first) : d;
    };
    const plan2: [string, string, number, string, string, string?][] = [];
    if (trade.rent) plan2.push([at(1), 'Rent for the premises', Math.round(withVat(R(trade.rent), first) * (small ? 0.5 : 1) * fixed), 'Rent', 'Harbourside Properties (made up)']);
    plan2.push([at(3), 'Cellphone contract', R(r.around(650, 0.05)), 'Cellphone', 'Example Mobile (made up)']);
    plan2.push([at(5), 'Business insurance', R(850), 'Insurance', 'Shieldwell Insurance (made up)']);
    plan2.push([at(15), 'Bookkeeping fee', Math.round(R(1_500) * fixed), 'Accounting', 'Ledger & Co Bookkeeping (made up)']);
    if (trade.asset === 'computer') plan2.push([at(10), 'Software subscriptions', R(r.around(420, 0.1)), 'Software & subscriptions', 'Cloudnine Hosting (made up)']);
    if (r.chance(0.4)) plan2.push([at(r.int(5, 25)), 'Advertising', R(r.around(900, 0.3)), 'Advertising', 'Coast Community Ads (made up)']);
    if (r.chance(0.3) && trade.asset !== 'computer') plan2.push([at(r.int(5, 25)), 'Small tools', R(r.around(600, 0.4)), 'Tool', trade.suppliers[0]!]);
    if (r.chance(0.3)) plan2.push([at(r.int(5, 25)), 'Stationery', R(r.around(250, 0.4)), 'Sundry', 'Paperclip Office Supplies (made up)']);
    // Entertainment: VAT charged, but SARS doesn't allow it back (s17(2)(a)).
    if (r.chance(0.3)) plan2.push([at(r.int(5, 25)), 'Client lunch', R(r.around(750, 0.4)), 'Entertainment', 'Harbour Grill (made up)', 'not_claimable']);
    for (const [date, description, total, catName, supplier, code] of plan2) {
      const personally = code === 'not_claimable' && r.chance(0.3);
      on(date, async () => {
        const catId = catName === 'Rent' ? await category('Rent', 'overhead', 'rent') : await cat(catName);
        await cost({ date, description, totalCents: total, category: catId, supplier, code, sourceId: personally ? ownerPaid : undefined });
      });
    }
    // Bank charges at the month end: VAT is included in a bank's fees.
    const charges = at(31);
    on(charges, () => cost({ date: charges, description: 'Bank charges', totalCents: R(r.around(260, 0.3)), category: ref.categories.find((c) => c.name === 'Bank')!.id, supplier: 'Example Bank (made up)' }));
    // Fuel: zero-rated. Now and then paid personally (the owner's card).
    if (trade.asset === 'bakkie' || has('logbook')) {
      for (const day of [3, 10, 17, 24]) {
        const d = at(day);
        const personally = r.chance(0.15);
        const amount = R(r.around(1_200, 0.25));
        on(d, async () => cost({ date: d, description: 'Fuel', totalCents: amount, category: await cat('Petrol'), supplier: 'FuelStop (made up)', code: 'zero', sourceId: personally ? ownerPaid : undefined }));
      }
      if (Number(month.slice(5)) % 3 === 0) {
        const d = at(20);
        on(d, async () => cost({ date: d, description: 'Vehicle service', totalCents: R(r.around(3_200, 0.3)), category: await cat('Vehicle Maintenance'), supplier: 'Bayside Motors (made up)' }));
      }
      // A car wash now and then, from a one-person business not registered for VAT.
      const wash = at(r.int(5, 25));
      if (r.chance(0.5)) on(wash, async () => cost({ date: wash, description: 'Vehicle wash', totalCents: R(150), category: await cat('Vehicle Maintenance'), supplier: 'Sipho’s Car Wash (made up)', code: 'no_vat' }));
    }
  };

  // ---------------------------------------------------------------- the first day
  const firstDay = async () => {
    const r = monthRng('start');
    // A tax invoice shows the business's address, the EMP501 its income tax number, and the time
    // tracker needs an hourly rate: made up here if setup left them out.
    const missing = {
      ...(!String(s.address ?? '').trim() ? { address: `1 Test Street\n${SUBURBS[0]}\n${TOWN}` } : {}),
      ...(!String(s.taxNumber ?? '').trim() ? { taxNumber: luhnNumber(r, kind.taxedAs === 'individual' || kind.taxedAs === 'partners' ? '0' : '9', 10) } : {}),
      ...(hourly && !Number(s.hourlyRateCents) ? { hourlyRateCents: R(hourPrice) } : {}),
    };
    if (Object.keys(missing).length) {
      const { termsAcceptedAt: _t, logoId: _l, installId: _i, ...rest } = s;
      await io.send('PUT', '/api/settings', { ...rest, ...missing });
    }
    if (kind.key === 'partnership') {
      const partners = await partnerList();
      if (!partners.length) {
        await io.send('POST', '/api/partners', { name: owners[0], shareBp: 6000 });
        await io.send('POST', '/api/partners', { name: owners[1], shareBp: 4000 });
      }
      ref = await io.get<Ref>('/api/reference');
      ownerPaid = ref.sources.find((x) => x.kind === 'owner' && x.name === `Paid personally (${owners[0]})`)?.id ?? ownerPaid;
    }
    await putInCapital(start);
    await addClients();
    if (payroll) {
      let room = monthlyRoom;
      if (kind.key === 'company' || kind.key === 'inc') {
        const pay = Math.round(R(s.sdl ? 28_000 : 18_000) * fixed);
        await hire(start, 'Director', pay, true, r);
        room -= pay;
      }
      const staff = trade.staff.slice(0, small ? 1 : trade.staff.length);
      for (const [title, rand] of staff) {
        const pay = Math.round(R(rand) * fixed);
        if (pay > room && employees.length) break;
        await hire(start, title, pay, false, r);
        room -= pay;
      }
    }
    if (has('workers')) {
      for (const name of WORKER_NAMES.slice(0, 2)) {
        const w = await io.send<{ id: string }>('POST', '/api/workers', { name: `${name} (made up)`, kind: 'casual', dayRateCents: R(trade.dayRate), allowanceCents: R(50), phone: '000 000 0000', notes: 'Made up' });
        workers.push({ id: w.id, rate: R(trade.dayRate), owed: 0 });
      }
    }
    if (sells) {
      await addItems();
      if (stocked) await buyStock(start, r, true);
    }
    if (has('logbook')) await logbookYear(taxYear(start).end, false);
  };
  const buyAsset = async (date: string) => {
    const bought: (readonly [string, string, number, number, number])[] = [
      trade.asset === 'bakkie' ? ['Single-cab bakkie (made up)', 'vehicles', 165_000, 60, 40_000] as const
      : trade.asset === 'computer' ? ['Laptop and screen (made up)', 'computers', 18_000, 36, 0] as const
      : ['Shop and workshop equipment (made up)', 'equipment', 45_000, 60, 0] as const,
    ];
    // The logbook needs a vehicle: a panel van (a commercial vehicle, not a "motor car", so its VAT is claimed).
    if (has('logbook') && trade.asset !== 'bakkie') bought.push(['Panel van (made up)', 'vehicles', 210_000, 60, 50_000]);
    for (const [name, category2, costRand, life, residual] of bought) {
      const before = R(costRand);
      const cost2 = vat ? before : withVat(before, date);
      await keepAfloat(date, withVat(before, date));
      await io.send('POST', '/api/assets', { name, category: category2, purchaseDate: date, costCents: cost2, vatCents: vat ? withVat(before, date) - before : 0, residualCents: R(residual), sourceId: bank, lifeMonths: life, notes: 'Made up' });
    }
  };

  // ---------------------------------------------------------------- each month
  const vatDone = new Set<string>();
  let monthNo = 0;
  const planMonth = async (month: string) => {
    const r = monthRng(month);
    monthNo++;
    const first = month === start.slice(0, 7) ? start : `${month}-01`;
    const last = monthEnd(`${month}-01`);
    const days = workdays(first, last);
    const fy = financialYear(first, fyEndMonth);

    // Quotes and invoices on the month's working days.
    const docs = n(trade.docs, r);
    for (let i = 0; i < docs && days.length; i++) {
      const d = r.pick(days);
      on(d, () => (workflow === 'invoices' ? invoiceNow(d, r) : quoteNow(d, r)));
    }
    if (monthNo % 6 === 5 && has('creditNotes') && days.length) on(r.pick(days.slice(-8)), () => creditNote(current));
    if (monthNo % 10 === 8 && days.length) on(days[0]!, () => writeOff(current));

    // Counter sales: every trading day (Saturdays too for a shop, salon or café).
    if (sells) {
      const saturdays = ['retail', 'hair', 'catering'].includes(s.industry);
      const range = trade.sales ?? [1, 4];
      for (const d of workdays(first, last, saturdays)) {
        const count = Math.max(1, Math.round(r.int(range[0], range[1]) * scale));
        on(d, async () => {
          for (let i = 0; i < count; i++) await sellNow(d, r);
          if (r.chance(0.05)) await refundNow(d, r);
          if (s.industry === 'retail' && r.chance(0.08)) await sellNow(d, r, true);
        });
        if (new Date(`${d}T00:00:00Z`).getUTCDay() === 1) {
          on(d, async () => {
            await bankTill(d);
            if (stocked) await buyStock(d, r);
            else await buyGoods(d, r);
          });
        }
      }
      // A stock count at each quarter's end (the year end among them).
      if (stocked && (Number(month.slice(5)) - fyEndMonth + 12) % 3 === 0) on(last, () => stockTake(last, r));
    }

    // Overheads, payroll, casual workers and the logbook.
    await overheads(month, r);
    if (payroll) {
      on(byDay(`${month}-25`), () => payRun(month, r));
      const prev = addMonths(`${month}-01`, -1).slice(0, 7);
      const emp = byDay(`${month}-07`);
      if (emp >= first) on(emp, () => payEmp201(prev));
      // Someone leaves at the end of the tenth month, and someone new starts the next.
      if (monthNo === 10 && employees.length > 1) {
        const leaving = employees[employees.length - 1]!;
        on(addDays(last, -10), () => io.send('PUT', `/api/employees/${leaving.id}`, { ...leaving.body, endDate: last }));
        // In the leaver's place: the same job, at the same pay.
        const title = /\(([^)]+)\)$/.exec(String(leaving.body.name))?.[1] ?? trade.staff[trade.staff.length - 1]![0];
        const startNext = fromDay(addDays(last, 1));
        on(startNext, () => hire(current, title, Number(leaving.body.salaryCents), false, r));
      }
    }
    if (workers.length) {
      for (const d of days) {
        on(d, () => labourDay(d, r));
        if (new Date(`${d}T00:00:00Z`).getUTCDay() === 5) on(d, () => payWorkers(d));
      }
    }
    // (Trips from the day after the vehicle is bought, on day four.)
    if (has('logbook')) for (const d of days) if (r.chance(0.5) && d > addDays(start, 3)) on(d, () => trip(d, r));

    // The owners' money: drawings each month; dividends and distributions after the year end.
    on(byDay(`${month}-28`), () => drawings(current));
    if (first === addMonths(fy.start, 3) && kind.key !== 'trust') {
      const prior = financialYear(addDays(fy.start, -1), fyEndMonth);
      if (prior.start >= start) on(byDay(`${month}-15`), () => payOut(current, prior, false));
    }
    // A trust distributes the year's income to its beneficiary by the year end (taxed in their hands, s25B).
    if (kind.key === 'trust' && last === fy.end) on(byDay(last), () => payOut(current, fy, true));

    // Provisional tax and turnover tax's interim payments: six months into the year, and at its end.
    const sixth = monthEnd(addMonths(fy.start, 5));
    const due = lastBusinessDay(Number(last.slice(0, 4)), Number(last.slice(5, 7)));
    if (last === sixth || last === fy.end) {
      on(due, () => provisional(current, fy, last === fy.end));
      on(due, () => turnoverInterim(current, fy, last === fy.end));
    }

    // The travel logbook's tax year: closed at the end of February, the next one opened.
    if (has('logbook') && last === taxYear(last).end) {
      on(last, async () => {
        await logbookYear(taxYear(last).end, true);
        yearStartKm = odometer;
        if (addDays(last, 1) <= today) await logbookYear(taxYear(addDays(last, 1)).end, false);
      });
    }

    // VAT: each period's VAT201 paid (or refunded) on its due date, from the first period the books reach.
    if (vat) {
      for (let back = 0; back < 3; back++) {
        const p = vatPeriod(monthEnd(addMonths(`${month}-01`, -back - 1)), s.vatCategory, fyEndMonth);
        if (p.end < start || vatDone.has(p.end)) continue;
        const dueOn = vat201Due(p.end);
        if (dueOn.slice(0, 7) === month && dueOn >= first) {
          vatDone.add(p.end);
          on(dueOn, () => payVat(p));
        }
      }
    }
  };

  // ---------------------------------------------------------------- run it, day by day
  const total = Math.round((Date.parse(today) - Date.parse(start)) / 86_400_000) + 1;
  let done = 0;
  await firstDay();
  on(addDays(start, 3), () => buyAsset(addDays(start, 3)));
  for (let d = start; d <= today; d = addDays(d, 1)) {
    current = d;
    if (d === start || d.endsWith('-01')) await planMonth(d.slice(0, 7));
    await keepAfloat(d);
    const list = plan.get(d) ?? [];
    // Things planned for today while today runs (a payment on the day) run today too.
    for (let i = 0; i < list.length; i++) await list[i]!();
    plan.delete(d);
    done++;
    if (opts.progress && (done % 7 === 0 || d === today)) opts.progress({ done, total, step: d });
  }

  // The statements name the made-up owners (directors, members, trustees, partners), not whoever is signed in.
  const details = await io.get<Record<string, unknown>>('/api/statements/details');
  const role = ({ cc: 'Member', trust: 'Trustee', partnership: 'Partner', sole_prop: 'Owner' } as Record<string, string>)[kind.key] ?? 'Director';
  await io.send('PUT', '/api/statements/details', { ...details, directors: owners.map((name) => ({ name, role })) });
  return summary;
}
