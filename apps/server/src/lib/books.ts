import type { FastifyRequest } from 'fastify';
import { assessedLossCarried, entity, financialYear, safeText, standardNames, todayIso, type BusinessType, type TaxEstimateFigures } from '@shap/shared';
import type { Db } from '../db/index.js';
import { badRequest } from './errors.js';

export interface SettingsRow {
  companyName: string;
  tradingName: string;
  regNumber: string;
  vatNumber: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  bankDetails: string;
  logoId: string | null;
  defaultBrandId: string | null;
  businessType: BusinessType;
  /** A non-profit company approved by SARS as a public benefit organisation. */
  approvedPbo: boolean;
  features: Record<string, boolean>;
  setupDone: boolean;
  logoLayout: { zoom?: number; x?: number; y?: number };
  accent: string;
  creditPrefix: string;
  creditNext: number;
  creditPad: number;
  proformaPrefix: string;
  proformaNext: number;
  payshapId: string;
  vatCategory: 'A' | 'B' | 'C';
  turnoverTax: boolean;
  hourlyRateCents: number;
  tone: 'casual' | 'formal';
  watermark: boolean;
  industry: string;
  usageConsent: boolean;
  /** Share anonymous market rates (modules/market.ts), and the last month shared. */
  marketConsent: boolean;
  /** Has the owner been told about it (setup, or the note on Home)? Nothing goes before. */
  marketNoticeSeen: boolean;
  marketSentMonth: string;
  installId: string;
  sdl: boolean;
  taxNumber: string;
  payeRegistered: boolean | null;
  payeRef: string;
  uifRegistered: boolean | null;
  uifRef: string;
  /** The terms of use accepted (terms.ts TERMS_VERSION), and when. */
  termsVersion: string;
  termsAcceptedAt: string | null;
  payLink: string;
  vatRegistered: boolean;
  vatRateBp: number;
  fyEndMonth: number;
  invoicePrefix: string;
  invoiceNext: number;
  invoicePad: number;
  quotePrefix: string;
  quoteNext: number;
  quotePad: number;
  paymentDays: number;
  quoteValidDays: number;
  invoiceTerms: string;
  quoteTerms: string;
  markupBp: number;
  defaultReceiptSourceId: string | null;
  defaultWageSourceId: string | null;
  defaultCostSourceId: string | null;
  lockDate: string | null;
  timezone: string;
}

/**
 * Brings the per-account, per-day totals (ledger_totals) up to date. Cheap when nothing changed;
 * after a change it works the ledger out once. Call before a query that reads ledger_totals.
 */
export async function freshTotals(db: Db): Promise<void> {
  await db`select fresh_ledger_totals()`;
}

/**
 * The assessed loss carried into the year starting `fyStart`, from the books: each earlier
 * financial year's result before income tax (a trust's less what it gave its beneficiaries),
 * walked in order (assessedLossCarried: no carry-back, a company's set-off limited). Call
 * freshTotals first. An estimate: SARS's assessments are what count.
 */
export async function assessedLossBefore(db: Db, fyStart: string, fyEndMonth: number, kind: TaxEstimateFigures['kind']): Promise<number> {
  if (kind === 'partners') return 0;
  const months = await db<{ m: string; cents: string }[]>`
    select to_char(l.date, 'YYYY-MM') as m, sum(l.amount_cents)::bigint as cents from ledger_totals l join accounts a on a.id = l.account_id
    where a.type in ('income', 'cost_of_sales', 'expense') and coalesce(a.system_key, '') <> 'income_tax' and coalesce(a.statement_line, '') <> 'income_tax'
      and l.date < ${fyStart}::date group by 1`;
  const years = new Map<string, { profit: number; given: number }>();
  const add = (month: string, k: 'profit' | 'given', cents: number) => {
    const end = financialYear(`${month}-01`, fyEndMonth).end;
    const y = years.get(end) ?? { profit: 0, given: 0 };
    y[k] += cents;
    years.set(end, y);
  };
  for (const r of months) add(r.m, 'profit', -Number(r.cents));
  if (kind === 'trust') {
    // Only the year's income can be the beneficiaries' (s25B): giving out more doesn't make a loss.
    const given = await db<{ m: string; cents: string }[]>`
      select to_char(declared_on, 'YYYY-MM') as m, sum(gross_cents)::bigint as cents from dividends where conduit and declared_on < ${fyStart}::date group by 1`;
    for (const r of given) add(r.m, 'given', Number(r.cents));
  }
  return assessedLossCarried(kind, [...years].map(([fyEnd, y]) => ({ fyEnd, profitCents: y.profit - Math.min(y.given, Math.max(0, y.profit)) })));
}

export async function getSettings(db: Db): Promise<SettingsRow> {
  const [s] = await db<SettingsRow[]>`select * from settings where id`;
  return s!;
}

/** Refuse changes dated on or before the lock date (a closed financial year). */
export async function assertOpen(db: Db, ...dates: (string | null | undefined)[]): Promise<void> {
  const [row] = await db<{ lockDate: string | null }[]>`select lock_date from settings where id`;
  const lock = row?.lockDate;
  if (!lock) return;
  for (const d of dates) {
    if (d && d <= lock) throw badRequest(`The books are closed up to ${lock}. Change the lock date in Settings to edit earlier entries.`);
  }
}

export function today(): string {
  return todayIso('Africa/Johannesburg');
}

export function currentFy(fyEndMonth: number, at = today()) {
  return financialYear(at, fyEndMonth);
}

export function formatNumber(prefix: string, n: number, pad: number): string {
  return `${prefix}${String(n).padStart(pad, '0')}`;
}

/** Query-string helpers. */
export function q(req: FastifyRequest): Record<string, string | undefined> {
  return (req.query ?? {}) as Record<string, string | undefined>;
}
export const isIsoDate = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** RFC 4180 CSV, with a BOM so Excel opens it as UTF-8. */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    if (v == null) return '';
    // Text that a spreadsheet would run as a formula (= + - @ at the start, or straight after a
    // separator a differently set-up Excel would split on) is neutralised: a description typed as
    // "=HYPERLINK(...)" can't run when the accountant opens the export. Numbers stay numbers.
    const s = typeof v === 'number' ? String(v) : safeText(String(v));
    return /[",;\t\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '\uFEFF' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export const centsToCsv = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2));

/**
 * The owners' accounts, named the way this kind of business names them (entities.ts): a CC's
 * share capital is "Members' contributions", a trust's retained earnings "Accumulated funds".
 * Only a standard name is replaced; a name someone chose stays. The owner's account is equity
 * for a sole proprietor (capital less drawings) and a loan (a liability) for everyone else.
 */
export async function applyBusinessType(db: Db, type: BusinessType) {
  const names = entity(type).accounts;
  for (const key of ['share_capital', 'retained_earnings', 'owner_loan', 'dividends', 'dividends_payable', 'director_salary'] as const) {
    const a = names[key];
    const to = typeof a === 'string' ? a : a.name;
    const standard = [...standardNames(key)];
    await db`update accounts set name = case when name = any(${standard}) then ${to} else name end where system_key = ${key}`;
  }
  await db`update accounts set type = ${names.owner_loan.type} where system_key = 'owner_loan'`;
  // A partnership's personal spending is each partner's own (their "Personal (name)" cost type,
  // against their current account), not one shared owner's: the shared one is put away.
  if (type === 'partnership') await db`update cost_categories set active = false where name = 'Personal (owner)' and kind = 'personal'`;
}

/**
 * Notes Shap's own figures for each account of an agreed year as it's agreed (the books audit,
 * audit/books.ts): what was posted to it within the year, without any year-end adjustment. Shap
 * keeps the agreed figures by adjusting each account to them at the year end, so something dated
 * in the year that's added or changed later shows as this moving. Agreeing or removing another
 * year changes only adjustments, so it doesn't.
 */
export async function noteShapFigures(db: Db, fyEnd: string) {
  await freshTotals(db);
  await db`
    update year_end_figures f set shap_cents = coalesce((
      select sum(l.amount_cents) from ledger_totals l
      where l.account_id = f.account_id and l.source <> 'year_end'
        and l.date between (date_trunc('month', f.fy_end) - interval '11 months')::date and f.fy_end), 0)
    where f.fy_end = ${fyEnd}::date`;
}

/**
 * The same for every agreed year: after bringing history in (a tracker import, moving in from
 * another package), which is where the books start from, not a change made after agreeing.
 */
export async function noteAllShapFigures(db: Db) {
  for (const y of await db<{ fyEnd: string }[]>`select fy_end::text as fy_end from year_ends`) await noteShapFigures(db, y.fyEnd);
}
