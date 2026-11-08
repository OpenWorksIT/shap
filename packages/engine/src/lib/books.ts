import type { Req as FastifyRequest } from '../http.js';
import { entity, financialYear, safeText, standardNames, todayIso, type BusinessType } from '@shap/shared';
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
  tone: 'casual' | 'formal';
  creditPrefix: string;
  creditNext: number;
  creditPad: number;
  proformaPrefix: string;
  proformaNext: number;
  payshapId: string;
  vatCategory: 'A' | 'B' | 'C';
  turnoverTax: boolean;
  hourlyRateCents: number;
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
  setupDone: boolean;
  logoLayout: { zoom?: number; x?: number; y?: number };
  accent: string;
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
