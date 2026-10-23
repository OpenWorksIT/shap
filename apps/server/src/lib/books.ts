import type { FastifyRequest } from 'fastify';
import { financialYear, todayIso } from '@shap/shared';
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
    let s = String(v);
    // A cell starting with = + - @ is a formula to Excel and LibreOffice: a description typed as
    // "=HYPERLINK(...)" could run when the accountant opens the export. Numbers stay numbers.
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '\uFEFF' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export const centsToCsv = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2));
