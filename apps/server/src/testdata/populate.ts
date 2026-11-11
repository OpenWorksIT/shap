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
 * generator seeded with the setup and the month, so a month that has ended always looks the same.
 */
import {
  addDays,
  addMonths,
  businessDayOnOrBefore,
  companyTax,
  entity,
  featureOn,
  financialYear,
  individualTax,
  isBusinessDay,
  lastBusinessDay,
  monthEnd,
  paysOutProfit,
  TRUST_RATE,
  vat201Due,
  vatPeriod,
  type Feature,
} from '@shap/shared';
import type { Db } from '../db/index.js';
import { CLIENTS, GENERIC_GOODS, PEOPLE, STREETS, SUBURBS, tradeFor, WORKER_NAMES, type Good, type LineCat, type Service } from './catalogue.js';
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
const VAT_FRACTION = 15 / 115;

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

/** Fills the books. Refuses nothing itself: the route checks the books are new first. */
export async function populate(io: Io, db: Db, opts: PopulateOptions): Promise<PopulateSummary> {
  const scale = opts.scale ?? 1;
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
  const seed = ['shap-test', s.businessType, s.industry, vat ? `vat-${s.vatCategory}` : 'novat', s.turnoverTax ? 'tt' : '', `fy${fyEndMonth}`, SHAPES.filter(has).join(',')].join('|');
  const monthRng = (ym: string) => rng(`${seed}|${ym}`);
  const summary: PopulateSummary = { from: start, to: today, invoices: 0, quotes: 0, sales: 0, costs: 0, payRuns: 0 };
  const n = (range: readonly [number, number], r: Rng) => Math.max(1, Math.round(r.int(range[0], range[1]) * scale));

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
  const plan = new Map<string, (() => Promise<unknown>)[]>();
  const on = (date: string, fn: () => Promise<unknown>) => {
    if (date > today || date < start) return;
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
  const businessDay = (d: string) => businessDayOnOrBefore(d);

  // ---------------------------------------------------------------- the people
  const people = monthRng('people');
  const owners = kind.key === 'partnership' ? [PEOPLE[0], PEOPLE[1]] : [PEOPLE[people.int(0, PEOPLE.length - 1)]!];

  const partnerList = async () => (await io.get<{ partners: { id: string; name: string; shareBp: number; capitalAccountId: string }[] }>('/api/partners')).partners;

  // ---------------------------------------------------------------- clients
  const clients: { id: string; name: string; vat: boolean }[] = [];
  const addClients = async () => {
    const r = monthRng('clients');
    for (const [i, c] of CLIENTS.entries()) {
      const address = `${r.int(1, 120)} ${r.pick(STREETS)}\n${r.pick(SUBURBS)}\nGqeberha 6001`;
      const email = `${c.name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '')}@example.com`;
      const made = await io.send<{ id: string }>('POST', '/api/clients', {
        code: `TEST${String(i + 1).padStart(3, '0')}`,
        name: c.name,
        contactPerson: c.contact ?? '',
        email,
        phone: `000 ${String(r.int(100, 999))} ${String(r.int(1000, 9999))}`,
        address,
        vatNumber: c.vat ? luhnNumber(r, '4', 10) : '',
        notes: 'Made up, for testing.',
      });
      clients.push({ id: made.id, name: c.name, vat: Boolean(c.vat) });
    }
  };
  // A business's regulars come back more often than strangers.
  const pickClient = (r: Rng) => clients[r.chance(0.6) ? r.int(0, 7) : r.int(0, clients.length - 1)]!;

  // ---------------------------------------------------------------- money in from the owners
  const capitalCents = R(trade.asset === 'bakkie' || has('logbook') ? 300_000 : has('inventory') ? 220_000 : 140_000);
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
      lines.push({ accountId: acc('owner_loan'), creditCents: capitalCents, memo: kind.key === 'npc' ? 'Loan from a member' : 'Capital from the owner' });
    } else {
      const shares = R(kind.key === 'trust' ? 100 : kind.key === 'cc' ? 10_000 : kind.key === 'coop' ? 5_000 : 1_000);
      lines.push({ accountId: acc('share_capital'), creditCents: shares, memo: kind.key === 'trust' ? 'Trust capital (the settlement)' : 'Shares issued' });
      lines.push({ accountId: acc('owner_loan'), creditCents: capitalCents - shares, memo: `Loan from ${owners[0]}` });
    }
    await io.send('POST', '/api/journals', { date, description: 'Money put in to start the business (made up)', reference: 'START', lines });
  };

  // ---------------------------------------------------------------- costs
  const vatOn = (totalCents: number, code: string) => (vat && (code === 'standard' || code === 'not_claimable') ? Math.round(totalCents * VAT_FRACTION) : 0);
  /** The supplier's slip, made up, uploaded as the business would photograph it (most costs have one). */
  const slip = async (date: string, supplier: string, description: string, totalCents: number, vatCents: number, charged: boolean): Promise<string | null> => {
    const r = rng(`${seed}|slip|${date}|${supplier}|${totalCents}`);
    if (!r.chance(0.92)) return null;
    const number = `${supplier.replace(/[^A-Z]/g, '').slice(0, 3) || 'INV'}${r.int(10_000, 99_999)}`;
    const dataBase64 = await slipPdf({ supplier, vatNumber: charged ? luhnNumber(rng(`vat|${supplier}`), '4', 10) : '', date, number, description, totalCents, vatCents });
    const made = await io.send<{ id: string }>('POST', '/api/attachments', { filename: `slip-${date}-${number}.pdf`, mime: 'application/pdf', dataBase64 });
    return made.id;
  };
  const cost = async (c: { date: string; description: string; totalCents: number; category: string; supplier: string; code?: string; sourceId?: string; projectId?: string | null; billDays?: number }) => {
    const code = c.code ?? 'standard';
    const onAccount = c.billDays != null;
    // Drawings and the owner's own tax have no supplier's slip.
    const receiptId = code === 'no_vat' ? null : await slip(c.date, c.supplier, c.description, c.totalCents, code === 'standard' || code === 'not_claimable' ? Math.round(c.totalCents * VAT_FRACTION) : 0, true);
    const made = await io.send<{ id: string }>('POST', '/api/costs', {
      date: c.date,
      description: c.description,
      amountCents: c.totalCents,
      vatCents: vatOn(c.totalCents, code),
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
    if (onAccount) on(businessDay(addDays(c.date, c.billDays!)), () => payBill(made.id));
    return made.id;
  };
  /** A supplier's bill, paid in full when it's due. */
  const payBill = async (costId: string) => {
    const c = await io.get<{ amountCents: number }>(`/api/costs/${costId}`);
    await io.send('POST', `/api/costs/${costId}/bill-payments`, { date: current, amountCents: Number(c.amountCents), sourceId: bank, note: 'Paid when due' });
  };

  // ---------------------------------------------------------------- quotes, jobs and invoices
  const workflow = has('jobs') ? 'jobs' : has('quotes') ? 'quotes' : 'invoices';
  const open: OpenInvoice[] = [];
  const activeJobs = new Map<string, { until: string; hourly: boolean }>();
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
  /** Buys the materials on a job or invoice from a supplier: paid, or a bill to pay. */
  const buyMaterials = async (date: string, mats: ReturnType<typeof materialLines>, r: Rng, projectId: string | null) => {
    if (!mats.length) return;
    // The supplier's invoice, VAT included (a VAT vendor claims it back).
    const total = Math.round(mats.reduce((t, m) => t + m.costCents * m.qty, 0) * 1.15);
    await cost({
      date,
      description: mats.map((m) => `${m.qty} × ${m.description}`).join(', ').slice(0, 190),
      totalCents: total,
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
    if (mats.length) await buyMaterials(date, mats, r, null);
    const timed = hourly ? svc.filter((l) => l.unit === 'hour') : [];
    if (timed.length) await logTime(date, null, timed.reduce((t, l) => t + l.qty, 0), r);
    const lines = [...svc.filter((l) => !timed.includes(l)), ...strip(mats)];
    const inv = await io.send<{ id: string; number: string }>('POST', '/api/documents', { kind: 'invoice', clientId: client.id, issueDate: date, lines, pricesIncludeVat: false, title: lines[0] ? String((lines[0] as { description: string }).description) : 'Time' });
    if (timed.length) await billTime(inv.id, null);
    await issue(inv, date, client.id, r);
  };
  const issue = async (inv: { id: string; number: string }, date: string, clientId: string | null, r: Rng) => {
    const issued = await io.send<{ number?: string }>('POST', `/api/documents/${inv.id}/issue`);
    summary.invoices++;
    const o: OpenInvoice = { id: inv.id, number: issued?.number ?? inv.number, issued: date, clientId, neverPays: r.chance(0.025) };
    open.push(o);
    schedulePayment(o, r);
  };

  /** Hours worked, on the time tracker: whole hours from eight in the morning, on the days before. */
  const timeEntries: string[] = [];
  const logTime = async (lastDay: string, projectId: string | null, hours: number, r: Rng) => {
    let left = Math.max(1, Math.round(hours));
    let day = lastDay;
    while (left > 0) {
      const h = Math.min(left, r.int(2, 6));
      const end = 8 + h;
      const t = await io.send<{ id: string }>('POST', '/api/time', { projectId, startedAt: `${day}T08:00:00+02:00`, endedAt: `${day}T${String(end).padStart(2, '0')}:00:00+02:00`, note: 'Made up' });
      timeEntries.push(t.id);
      left -= h;
      day = addDays(day, -1);
      if (day < start) day = start;
    }
  };
  const billTime = async (documentId: string, _projectId: string | null) => {
    if (!timeEntries.length) return;
    await io.send('POST', '/api/time/bill', { documentId, ids: timeEntries.splice(0) });
  };

  /** A quote: accepted (then the work, then the invoice), declined, or still waiting. */
  const quoteNow = async (date: string, r: Rng) => {
    const client = pickClient(r);
    const svc = serviceLines(r);
    const mats = materialLines(r);
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
      const paid = addDays(date, r.int(1, 7));
      on(paid, async () => {
        if (projectId) activeJobs.set(projectId, { until: addDays(paid, r.int(2, 10)), hourly: false });
        const inv = await io.send<{ id: string; number: string }>('POST', `/api/documents/${q.id}/convert`);
        await io.send('PUT', `/api/documents/${inv.id}`, { clientId: client.id, projectId, issueDate: current, title, lines, pricesIncludeVat: false });
        const issued = await io.send<{ number?: string }>('POST', `/api/documents/${inv.id}/issue`);
        summary.invoices++;
        const o: OpenInvoice = { id: inv.id, number: issued?.number ?? inv.number, issued: current, clientId: client.id, neverPays: false };
        open.push(o);
        await receive(o, 1, 'eft');
        await buyMaterials(current, mats, r, projectId);
      });
    } else if (upfront) {
      on(addDays(date, r.int(5, 20)), () => io.send('POST', `/api/documents/${q.id}/status`, { status: 'declined' }));
    } else if (roll < 0.7) {
      const yes = addDays(date, r.int(2, 10));
      const days = r.int(1, Math.max(2, Math.ceil(trade.size * 1.5)));
      const done = addDays(yes, days);
      on(yes, async () => {
        await io.send('POST', `/api/documents/${q.id}/status`, { status: 'accepted' });
        if (projectId) activeJobs.set(projectId, { until: done, hourly });
        await buyMaterials(current, mats, r, projectId);
      });
      on(done, async () => {
        if (projectId) activeJobs.delete(projectId);
        const timed = hourly ? svc.filter((l) => l.unit === 'hour') : [];
        if (timed.length) await logTime(current, projectId, timed.reduce((t, l) => t + l.qty, 0), r);
        const inv = await io.send<{ id: string; number: string }>('POST', `/api/documents/${q.id}/convert`);
        const kept = [...svc.filter((l) => !timed.includes(l)), ...strip(mats)];
        await io.send('PUT', `/api/documents/${inv.id}`, { clientId: client.id, projectId, issueDate: current, title, lines: kept, pricesIncludeVat: false });
        if (timed.length) await billTime(inv.id, projectId);
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
    const lines = items
      .filter((i) => opening || i.qty < 15)
      .map((i) => ({ item: i, qty: r.int(60, 110) }));
    if (!lines.length) return;
    const onAccount = has('bills') && !opening;
    const supplier = r.pick(trade.suppliers);
    const before = lines.reduce((t, l) => t + R(l.item.good[2]) * l.qty, 0);
    const vatIn = lines.reduce((t, l) => t + (l.item.good[4] ? 0 : Math.round(R(l.item.good[2]) * l.qty * 0.15)), 0);
    const receiptId = await slip(date, supplier, lines.map((l) => `${l.qty} × ${l.item.good[0]}`).join(', ').slice(0, 300), before + vatIn, vatIn, true);
    const made = await io.send<{ costId: string }>('POST', '/api/stock/purchases', {
      date,
      supplier,
      receiptId,
      reference: `${opening ? 'OPEN' : 'PO'}-${date.replace(/-/g, '')}`,
      sourceId: onAccount ? bills : bank,
      dueDate: onAccount ? addDays(date, 30) : null,
      // Zero-rated or standard, as the supplier charged it: a business not registered for VAT pays it as part of the cost.
      lines: lines.map((l) => ({ itemId: l.item.id, qtyInvoiced: l.qty, unitCostCents: R(l.item.good[2]), vatCode: l.item.good[4] ? 'zero' : 'standard' })),
    });
    summary.costs++;
    for (const l of lines) l.item.qty += l.qty;
    if (onAccount) on(businessDay(addDays(date, 30)), () => payBill(made.costId));
  };
  /** Goods for resale bought as a cost, when stock isn't kept in Shap. */
  const buyGoods = async (date: string, r: Rng, salesCents: number) => {
    if (salesCents <= 0) return;
    await cost({ date, description: 'Goods for resale', totalCents: Math.round(salesCents * 0.55), category: await category('Goods for resale', 'materials', 'cos_goods'), supplier: r.pick(trade.suppliers), billDays: has('bills') && r.chance(0.5) ? 30 : undefined });
  };
  let soldSinceBuying = 0;
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
    // A zero-rated supply over R50 needs a full tax invoice (VAT Act s20(5) proviso), so a walk-in
    // buys zero-rated goods on their own, up to R50; more goes on an account customer's invoice.
    if (vat && !toClient && picked.some((p) => p.item.good[4])) {
      const z = picked.find((p) => p.item.good[4])!;
      const most = Math.floor(50 / z.item.good[3]);
      if (most < 1) return;
      picked.splice(0, picked.length, { item: z.item, qty: Math.min(z.qty, most) });
    }
    if (!picked.length) return;
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
    for (const p of picked) p.item.qty -= p.qty;
    const total = Number(sale.doc.totalCents);
    soldSinceBuying += total;
    if (cash) tillCash += total;
    recentSales.push({ id: sale.id, date, sourceId, method, lineIds: sale.lines.map((l) => l.id) });
    if (recentSales.length > 40) recentSales.shift();
  };
  const refundNow = async (date: string, r: Rng) => {
    const candidates = recentSales.filter((x) => x.date >= addDays(date, -7) && x.date < date);
    if (!candidates.length) return;
    const sale = r.pick(candidates);
    recentSales.splice(recentSales.indexOf(sale), 1);
    const lineId = sale.lineIds[0]!;
    const before = await io.get<{ lines: { id: string; itemId: string | null }[] }>(`/api/documents/${sale.id}`);
    const line = before.lines.find((l) => l.id === lineId);
    const done = await io.send<{ amountCents: number }>('POST', `/api/documents/${sale.id}/refund`, {
      date,
      money: 'paid_out',
      sourceId: sale.sourceId,
      method: sale.method,
      reason: 'Returned by the customer: faulty (made up)',
      lines: [{ lineId, qty: 1, restock: true }],
    });
    const back = items.find((i) => i.id === line?.itemId);
    if (back) back.qty += 1;
    if (sale.method === 'cash') tillCash -= Number(done.amountCents);
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
  const employees: { id: string; body: Record<string, unknown> }[] = [];
  const hire = async (date: string, title: string, salaryRand: number, director: boolean, r: Rng) => {
    const name = `${PEOPLE[r.int(0, PEOPLE.length - 1)]!.split(' ')[0]} ${['Jacobs', 'Mabuza', 'Naidoo', 'Smit', 'Khoza', 'Petersen', 'Mkhize', 'Venter'][r.int(0, 7)]}`;
    const born = `${r.int(1965, 2002)}-${String(r.int(1, 12)).padStart(2, '0')}-${String(r.int(1, 28)).padStart(2, '0')}`;
    const body = {
      name: director ? `${owners[0]} (director)` : `${name} (${title.toLowerCase()})`,
      idNumber: idNumber(r, born),
      taxNumber: luhnNumber(r, '0', 10),
      isDirector: director,
      salaryCents: R(salaryRand),
      ageBand: 'under65',
      medicalMembers: director ? 2 : 0,
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
    const payDate = businessDay(`${period}-25`);
    const run = await io.send<{ id: string; lines?: { employeeId: string; salaryCents: number }[] }>('POST', '/api/pay-runs', { period, payDate, sourceId: bank });
    const full = await io.get<{ lines: { employeeId: string; salaryCents: number }[] }>(`/api/pay-runs/${run.id}`);
    for (const l of full.lines) {
      const e = employees.find((x) => x.id === l.employeeId);
      const december = period.endsWith('-12') && e && !e.body.isDirector;
      const overtime = !e?.body.isDirector && r.chance(0.2) ? R(r.int(4, 25) * 100) : 0;
      if (december || overtime) {
        await io.send('PUT', `/api/pay-runs/${run.id}/lines/${l.employeeId}`, { salaryCents: Number(l.salaryCents), overtimeCents: overtime, commissionCents: 0, extraCents: december ? Number(l.salaryCents) : 0, note: december ? 'Year-end bonus (made up)' : 'Overtime (made up)' });
      }
    }
    await io.send('POST', `/api/pay-runs/${run.id}/finalise`);
    summary.payRuns++;
  };
  const payEmp201 = async (period: string) => {
    const sars = await io.get<{ emp201: { period: string; payeCents: number; uifCents: number; sdlCents: number; paidCents: number }[] }>('/api/payroll/sars');
    const m = sars.emp201.find((x) => x.period === period);
    if (!m) return;
    const due = Number(m.payeCents) + Number(m.uifCents) + Number(m.sdlCents) - Number(m.paidCents);
    if (due <= 0) return;
    await io.send('POST', '/api/sars-payments', { kind: 'emp201', period, date: current, amountCents: due, sourceId: bank, reference: `EMP201 ${period}` });
  };

  // ---------------------------------------------------------------- casual workers
  const workers: { id: string; rate: number; owed: number }[] = [];
  const general = ref.workTypes.find((w) => w.active)?.id ?? null;
  const labourDay = async (date: string, r: Rng) => {
    const today2 = workers.filter(() => r.chance(0.75));
    if (!today2.length) return;
    const jobs = [...activeJobs.entries()].filter(([, j]) => j.until >= date).map(([id]) => id);
    const projectId = jobs.length ? r.pick(jobs) : null;
    const entries = today2.map((w) => ({ workerId: w.id, days: 1, wageCents: w.rate, allowanceCents: r.chance(0.3) ? R(50) : 0 }));
    await io.send('POST', '/api/labour', { date, projectId, workTypeId: projectId ? null : general, note: '', entries });
    for (const e of entries) workers.find((w) => w.id === e.workerId)!.owed += e.wageCents + e.allowanceCents;
  };
  const payWorkers = async (date: string) => {
    for (const w of workers) {
      if (w.owed <= 0) continue;
      await io.send('POST', '/api/wage-payments', { date, workerId: w.id, amountCents: w.owed, sourceId: bank, note: 'Week’s wages' });
      w.owed = 0;
    }
  };

  // ---------------------------------------------------------------- the travel logbook
  let odometer = 48_000;
  let fyKmStart = odometer;
  const vehicle = `${trade.asset === 'bakkie' ? 'Single-cab bakkie' : 'Panel van'} (made up), CA 000-000`;
  const trip = async (date: string, r: Rng) => {
    const business = r.chance(0.85);
    const km = business ? r.int(8, 45) : r.int(5, 30);
    const client = business ? pickClient(r) : null;
    await io.send('POST', '/api/trips', { date, fromPlace: 'Workshop', toPlace: business ? `${client!.name}, ${r.pick(SUBURBS)}` : 'Shops', reason: business ? 'To the client (made up)' : 'Private', km, business, clientId: client?.id ?? null });
    odometer += km * 2;
  };
  const logbookYear = async (fyEnd: string, ended: boolean) => {
    await io.send('PUT', `/api/logbook/${fyEnd}`, { vehicle, odometerStart: fyKmStart, odometerEnd: ended ? odometer : null });
  };

  // ---------------------------------------------------------------- the owners' money and tax
  const drawings = async (date: string) => {
    if (kind.payout !== 'drawings') return;
    const room = (await bankBalance(date)) - R(25_000);
    const want = R(Math.round(14_000 * Math.max(scale, 0.3)));
    const take = Math.min(want, room);
    if (take < R(1_000)) return;
    const shares = kind.key === 'partnership' ? await partnerList() : [{ name: owners[0]!, shareBp: 10_000 }];
    for (const p of shares) {
      const part = Math.round((take * p.shareBp) / 10_000 / 100) * 100;
      if (part <= 0) continue;
      const personal = kind.key === 'partnership' ? `Personal (${p.name})` : 'Personal (owner)';
      await cost({ date, description: `Drawings: ${p.name}`, totalCents: part, category: await cat(personal), supplier: p.name, code: 'no_vat' });
    }
  };
  const taxPaidByCompany = (kind.taxedAs === 'company' || kind.taxedAs === 'trust' || (kind.taxedAs === 'npc' && !s.approvedPbo)) && !s.turnoverTax;
  const taxOn = (profitCents: number, fyEnd: string) =>
    profitCents <= 0 ? 0 : kind.taxedAs === 'trust' ? Math.round(profitCents * TRUST_RATE) : kind.taxedAs === 'individual' || kind.taxedAs === 'partners' ? individualTax(profitCents, fyEnd) : companyTax(profitCents, fyEnd, false);
  const provisional = async (date: string, fy: { start: string; end: string }, second: boolean) => {
    if (s.turnoverTax || (kind.taxedAs === 'npc' && s.approvedPbo)) return;
    const months = Math.max(1, Math.round((Date.parse(date) - Date.parse(fy.start)) / (30.44 * 86_400_000)));
    const sofar = await profit(fy.start, date);
    const year = Math.round((sofar / months) * 12);
    const tax = taxOn(year, fy.end);
    const due = Math.floor((second ? tax - Math.floor(tax / 2 / 10_000) * 10_000 : tax / 2) / 10_000) * 10_000;
    if (due <= 0) return;
    if (taxPaidByCompany) {
      await io.send('POST', '/api/sars-payments', { kind: 'irp6', period: fy.end.slice(0, 7), date, amountCents: due, sourceId: bank, reference: `IRP6 ${second ? 'second' : 'first'} payment` });
    } else if (kind.payout === 'drawings') {
      // A sole proprietor's or partner's provisional tax is their own: paid from the business, it's drawings.
      const shares = kind.key === 'partnership' ? await partnerList() : [{ name: owners[0]!, shareBp: 10_000 }];
      for (const p of shares) {
        const part = Math.floor((due * p.shareBp) / 10_000 / 100) * 100;
        if (part <= 0) continue;
        const personal = kind.key === 'partnership' ? `Personal (${p.name})` : 'Personal (owner)';
        await cost({ date, description: `Provisional tax (IRP6) for ${p.name}: their own tax`, totalCents: part, category: await cat(personal), supplier: 'SARS', code: 'no_vat' });
      }
    }
  };
  /** A dividend (a CC's or co-op's distribution) out of last year's profit, three months after the year end. */
  const payOut = async (date: string, fy: { start: string; end: string }, fromThisYear: boolean) => {
    if (!paysOutProfit(s.businessType) || !has('dividends')) return;
    const p = await profit(fy.start, fromThisYear ? date : fy.end);
    const after = p - taxOn(p, fy.end);
    const room = (await bankBalance(date)) - R(30_000);
    const gross = Math.floor(Math.min(after * (fromThisYear ? 0.6 : 0.5), room) / R(1_000)) * R(1_000);
    if (gross < R(5_000)) return;
    const made = await io.send<{ id: string }>('POST', '/api/dividends', { declaredOn: date, paidOn: date, shareholder: owners[0], grossCents: gross, sourceId: bank, conduit: true, note: 'Made up' });
    const list = await io.get<{ dividends?: { id: string; dwtCents: number }[] } | { id: string; dwtCents: number }[]>('/api/dividends');
    const rows = Array.isArray(list) ? list : (list.dividends ?? []);
    const dwt = Number(rows.find((x) => x.id === made.id)?.dwtCents ?? 0);
    if (dwt > 0) {
      const [y, m] = addMonths(date, 1).split('-').map(Number) as [number, number];
      on(lastBusinessDay(y, m), () => io.send('POST', '/api/sars-payments', { kind: 'dwt', period: date.slice(0, 7), date: current, amountCents: dwt, sourceId: bank, reference: 'Dividends tax' }));
    }
  };
  const payVat = async (period: { start: string; end: string }) => {
    const ret = await io.get<{ fields: { field20: number } }>(`/api/vat/return?on=${period.end}`);
    const f20 = Number(ret.fields.field20);
    if (f20 === 0) return;
    const pay = f20 > 0;
    const lines = pay
      ? [{ accountId: acc('vat'), debitCents: f20 }, { accountId: acc('bank'), creditCents: f20 }]
      : [{ accountId: acc('bank'), debitCents: -f20 }, { accountId: acc('vat'), creditCents: -f20 }];
    const go = () => io.send('POST', '/api/journals', { date: current, description: `VAT201 ${period.start} to ${period.end}: ${pay ? 'paid to' : 'refund from'} SARS`, reference: 'VAT201', lines });
    if (pay) await go();
    else on(addDays(current, 21), go);
  };

  // ---------------------------------------------------------------- the overheads
  const overheads = async (month: string, r: Rng) => {
    const first = `${month}-01`;
    const last = monthEnd(first);
    const at = (day: number) => businessDay(`${month}-${String(Math.min(day, Number(last.slice(8)))).padStart(2, '0')}`);
    const plan2: [string, string, number, string, string?][] = [];
    if (trade.rent) plan2.push([at(1), 'Rent for the premises', R(trade.rent * 1.15), 'Rent', 'Harbourside Properties']);
    plan2.push([at(3), 'Cellphone contract', R(r.around(650, 0.05)), 'Cellphone', 'Example Mobile']);
    plan2.push([at(5), 'Business insurance', R(850), 'Insurance', 'Shieldwell Insurance']);
    plan2.push([at(15), 'Bookkeeping fee', R(1_500), 'Accounting', 'Ledger & Co Bookkeeping']);
    if (trade.asset === 'computer') plan2.push([at(10), 'Software subscriptions', R(r.around(420, 0.1)), 'Software & subscriptions', 'Cloudnine Hosting']);
    if (r.chance(0.4)) plan2.push([at(r.int(5, 25)), 'Advertising', R(r.around(900, 0.3)), 'Advertising', 'Coast Community Ads']);
    if (r.chance(0.3) && trade.asset !== 'computer') plan2.push([at(r.int(5, 25)), 'Small tools', R(r.around(600, 0.4)), 'Tool', trade.suppliers[0]!]);
    if (r.chance(0.3)) plan2.push([at(r.int(5, 25)), 'Stationery', R(r.around(250, 0.4)), 'Sundry', 'Paperclip Office Supplies']);
    for (const [date, description, total, catName, supplier] of plan2) {
      on(date, async () => {
        const catId = catName === 'Rent' ? await category('Rent', 'overhead', 'rent') : await cat(catName);
        await cost({ date, description, totalCents: total, category: catId, supplier: supplier ?? 'Supplier' });
      });
    }
    // Bank charges at the month end: VAT is included in a bank's fees.
    on(at(31), () => cost({ date: at(31), description: 'Bank charges', totalCents: R(r.around(260, 0.3)), category: ref.categories.find((c) => c.name === 'Bank')!.id, supplier: 'Example Bank' }));
    // Entertainment: VAT charged, but SARS doesn't allow it back.
    const lunch = at(r.int(5, 25));
    if (r.chance(0.3)) on(lunch, async () => cost({ date: lunch, description: 'Client lunch', totalCents: R(r.around(750, 0.4)), category: await cat('Entertainment'), supplier: 'Harbour Grill (made up)', code: 'not_claimable', sourceId: r.chance(0.3) ? ownerPaid : undefined }));
    // Fuel: zero-rated. Now and then paid personally (the owner's card).
    if (trade.asset === 'bakkie' || has('logbook')) {
      for (const day of [3, 10, 17, 24]) {
        const d = at(day);
        on(d, async () => cost({ date: d, description: 'Fuel', totalCents: R(r.around(1_200, 0.25)), category: await cat('Petrol'), supplier: 'FuelStop Walmer (made up)', code: 'zero', sourceId: r.chance(0.15) ? ownerPaid : undefined }));
      }
      if (Number(month.slice(5)) % 3 === 0) on(at(20), async () => cost({ date: at(20), description: 'Vehicle service', totalCents: R(r.around(3_200, 0.3)), category: await cat('Vehicle Maintenance'), supplier: 'Bayside Motors (made up)' }));
    }
  };

  // ---------------------------------------------------------------- the first day
  let current = start;
  const firstDay = async () => {
    const r = monthRng('start');
    // A tax invoice shows the business's address, and the time tracker needs an hourly rate: made
    // up here if setup left them out.
    const missing = { ...(!String(s.address ?? '').trim() ? { address: '1 Test Street\nMade-up Park\nGqeberha 6001' } : {}), ...(hourly && !Number(s.hourlyRateCents) ? { hourlyRateCents: R(hourPrice) } : {}) };
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
      const staff = trade.staff.slice(0, Math.max(1, Math.round(trade.staff.length * Math.min(1, scale * 2))));
      if (kind.key === 'company' || kind.key === 'inc') await hire(start, 'Director', 28_000, true, r);
      for (const [title, pay] of staff) await hire(start, title, pay, false, r);
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
    if (has('logbook')) await logbookYear(financialYear(start, fyEndMonth).end, false);
  };
  const buyAsset = async (date: string) => {
    const bought: (readonly [string, string, number, number])[] = [
      trade.asset === 'bakkie' ? ['Single-cab bakkie (made up)', 'vehicles', 165_000, 60] as const
      : trade.asset === 'computer' ? ['Laptop and screen (made up)', 'computers', 18_000, 36] as const
      : ['Shop and workshop equipment (made up)', 'equipment', 45_000, 60] as const,
    ];
    // The logbook needs a vehicle: a panel van (a commercial vehicle, not a "motor car", so its VAT is claimed).
    if (has('logbook') && trade.asset !== 'bakkie') bought.push(['Panel van (made up)', 'vehicles', 210_000, 60]);
    for (const [name, category2, costRand, life] of bought) {
      const before = R(costRand);
      await io.send('POST', '/api/assets', { name, category: category2, purchaseDate: date, costCents: vat ? before : Math.round(before * 1.15), vatCents: vat ? Math.round(before * 0.15) : 0, sourceId: bank, lifeMonths: life, notes: 'Made up' });
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
    for (let i = 0; i < docs; i++) {
      const d = r.pick(days);
      on(d, () => (workflow === 'invoices' ? invoiceNow(d, r) : quoteNow(d, r)));
    }
    if (monthNo % 6 === 5 && has('creditNotes')) on(r.pick(days.slice(-8)), () => creditNote(current));
    if (monthNo % 10 === 8) on(days[0]!, () => writeOff(current));

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
            else {
              await buyGoods(d, r, soldSinceBuying);
              soldSinceBuying = 0;
            }
          });
        }
      }
      // A stock count at each quarter's end.
      if (stocked && (Number(month.slice(5)) - fyEndMonth + 12) % 3 === 0) on(last, () => stockTake(last, r));
    }

    // Overheads, payroll, casual workers and the logbook.
    await overheads(month, r);
    if (payroll) {
      on(businessDay(`${month}-25`), () => payRun(month, r));
      const prev = addMonths(`${month}-01`, -1).slice(0, 7);
      on(businessDay(`${month}-07`), () => payEmp201(prev));
      if (monthNo === 10 && employees.length > 1) {
        const leaving = employees[employees.length - 1]!;
        on(addDays(last, -10), () => io.send('PUT', `/api/employees/${leaving.id}`, { ...leaving.body, endDate: last }));
        const [title, pay] = trade.staff[trade.staff.length - 1]!;
        on(businessDay(`${addMonths(`${month}-01`, 1).slice(0, 7)}-01`), () => hire(current, title, pay, false, r));
      }
    }
    if (workers.length) {
      for (const d of days) {
        on(d, () => labourDay(d, r));
        if (new Date(`${d}T00:00:00Z`).getUTCDay() === 5) on(d, () => payWorkers(d));
      }
    }
    if (has('logbook')) for (const d of days) if (r.chance(0.5)) on(d, () => trip(d, r));

    // The owners' money: drawings each month; dividends and distributions after the year end.
    on(businessDay(`${month}-28`), () => drawings(current));
    if (first === addMonths(fy.start, 3)) {
      const prior = financialYear(addDays(fy.start, -1), fyEndMonth);
      if (prior.start >= start) on(businessDay(`${month}-15`), () => payOut(current, prior, false));
    }
    // A trust distributes the year's income to its beneficiaries by the year end (taxed in their hands).
    if (kind.key === 'trust' && last === fy.end) on(businessDay(last), () => payOut(current, fy, true));

    // Provisional tax: the first payment six months into the year, the second at its end.
    const sixth = monthEnd(addMonths(fy.start, 5));
    if (last === sixth) on(lastBusinessDay(Number(last.slice(0, 4)), Number(last.slice(5, 7))), () => provisional(current, fy, false));
    if (last === fy.end) on(lastBusinessDay(Number(last.slice(0, 4)), Number(last.slice(5, 7))), () => provisional(current, fy, true));

    // The travel logbook's year: closed at the year end, the next one opened.
    if (has('logbook') && last === fy.end) {
      on(last, async () => {
        await logbookYear(fy.end, true);
        fyKmStart = odometer;
        if (addDays(last, 1) <= today) await logbookYear(financialYear(addDays(last, 1), fyEndMonth).end, false);
      });
    }

    // VAT: each period's VAT201 paid (or refunded) on its due date.
    if (vat) {
      for (let back = 0; back < 3; back++) {
        const p = vatPeriod(monthEnd(addMonths(`${month}-01`, -back - 1)), s.vatCategory, fyEndMonth);
        if (p.start < start || vatDone.has(p.end)) continue;
        const due = vat201Due(p.end);
        if (due.slice(0, 7) === month) {
          vatDone.add(p.end);
          on(due, () => payVat(p));
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
    const list = plan.get(d) ?? [];
    // Things planned for today while today runs (a payment on the day) run today too.
    for (let i = 0; i < list.length; i++) await list[i]!();
    plan.delete(d);
    done++;
    if (opts.progress && (done % 7 === 0 || d === today)) opts.progress({ done, total, step: d });
  }
  return summary;
}
