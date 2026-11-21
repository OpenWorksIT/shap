import type { FastifyRequest } from 'fastify';
import { assessedLossCarried, closesBy, entity, featureOn, financialYear, periodLockDue, safeText, standardNames, todayIso, type BusinessType, type TaxEstimateFigures, type VatCategory } from '@shap/shared';
import type { Db } from '../db/index.js';
import { audit } from './audit.js';
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
  vatCategory: VatCategory;
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
  /** A company's or CC's date of incorporation (CIPC's annual return dates), when the owner gave it. */
  incorporatedOn: string | null;
  /** Registered with the Compensation Fund (a return of earnings each year), when the owner said. */
  coidaRegistered: boolean | null;
  uifRegistered: boolean | null;
  uifRef: string;
  /** The terms of use accepted (terms.ts TERMS_VERSION), and when. */
  termsVersion: string;
  termsAcceptedAt: string | null;
  /** A practice's: the Shap Accountant terms accepted (terms.ts ACCOUNTANT_TERMS_VERSION), and when. */
  accountantTermsVersion: string;
  accountantTermsAcceptedAt: string | null;
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
  /** The lock date before the books were reopened (to lock them again at); null: not reopened. */
  relockDate: string | null;
  /** Month end (a business that sells): closed by hand, or locks itself on monthEndDay of the next month. */
  monthEndMode: 'manual' | 'auto';
  monthEndDay: number;
  monthLockedThrough: string | null;
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

/**
 * Whether the company qualifies as a small business corporation (s12E) for the year ending
 * `fyEnd`: the answer given for that year, or the latest one given for a year before it (a
 * company usually goes on qualifying), or null: not said. `said`: answered for this year itself.
 * Only for a kind of business that can be one (entities.ts sbcPossible); else false.
 */
export async function sbcAnswer(db: Db, fyEnd: string, businessType: string): Promise<{ sbc: boolean | null; said: boolean; from: string | null }> {
  if (!entity(businessType).sbcPossible) return { sbc: false, said: false, from: null };
  const [r] = await db<{ fyEnd: string; sbc: boolean }[]>`select fy_end::text as fy_end, sbc from sbc_years where fy_end <= ${fyEnd}::date order by fy_end desc limit 1`;
  return r ? { sbc: r.sbc, said: r.fyEnd === fyEnd, from: r.fyEnd } : { sbc: null, said: false, from: null };
}

/**
 * How far books brought in from another package reach (books-import.ts), or null: a projection to a
 * full year counts from there, not from today (the months after it aren't in the books yet).
 */
export async function broughtInThrough(db: Db): Promise<string | null> {
  const [r] = await db<{ d: string | null }[]>`select max(date_to)::text as d from ledger_imports`;
  return r?.d ?? null;
}

/**
 * VAT that came in with books brought in from another package in a VAT period: how many lines on
 * the VAT account, and what they moved it by (credit positive: output VAT). Any line at all makes
 * the period's return the package's (or the business's), not Shap's to work out or check, even
 * when the lines net to nothing (VAT charged and paid in the same period).
 */
export async function importedVat(db: Db, start: string, end: string): Promise<{ lines: number; cents: number }> {
  const [r] = await db<{ n: number; t: string }[]>`
    select count(*)::int as n, coalesce(sum(jl.credit_cents - jl.debit_cents), 0)::bigint as t
    from journal_lines jl join journals j on j.id = jl.journal_id join accounts a on a.id = jl.account_id
    where a.system_key = 'vat' and j.ledger_import_id is not null and j.date between ${start}::date and ${end}::date`;
  return { lines: r?.n ?? 0, cents: Number(r?.t ?? 0) };
}

/**
 * VAT on journals by hand (typed in, or an adjustment) in a period, other than what Shap can tell
 * is a payment to or refund from SARS: VAT against money (the bank, cash, a card or any account you
 * pay from, or your own money), with at most expense or income smaller than it beside it (SARS's
 * interest, or interest on a refund). Shap's VAT201 boxes are worked out from documents, so these aren't in them; where
 * they go on the return (a cash sale journalled, a correction) is the business's or their
 * accountant's to say. What was added to the VAT owed (credits) and taken off it (debits), apart.
 */
export async function handVat(db: Db, start: string, end: string): Promise<{ lines: number; addedCents: number; offCents: number }> {
  const [r] = await db<{ n: number; added: string; off: string }[]>`
    with money as (
      select id from accounts where statement_line in ('cash', 'bank_overdraft') or system_key in ('owner_loan', 'paye_payable', 'uif_payable', 'sdl_payable', 'income_tax_payable', 'dwt_payable')
      union select account_id from payment_sources where kind in ('bank', 'cash', 'card', 'owner')
    ), per as (
      -- Each journal's lines read once (not once for each of its VAT lines): whether money is on it,
      -- anything other than expense, income, VAT or money, and how much expense or income.
      select jl.journal_id, bool_or(m.id is not null) as money,
        bool_or(a.type not in ('expense', 'income') and coalesce(a.system_key, '') <> 'vat' and m.id is null) as other,
        coalesce(sum(jl.debit_cents + jl.credit_cents) filter (where a.type in ('expense', 'income') and m.id is null), 0) as expense
      from journal_lines jl join journals j on j.id = jl.journal_id join accounts a on a.id = jl.account_id
      left join money m on m.id = jl.account_id
      where j.kind in ('manual', 'adjustment') and j.date between ${start}::date and ${end}::date
      group by jl.journal_id
    )
    select count(*)::int as n, coalesce(sum(jl.credit_cents), 0)::bigint as added, coalesce(sum(jl.debit_cents), 0)::bigint as off
    from journal_lines jl join per p on p.journal_id = jl.journal_id join accounts a on a.id = jl.account_id
    where a.system_key = 'vat' and not (p.money and not p.other and p.expense < abs(jl.credit_cents - jl.debit_cents))`;
  return { lines: r?.n ?? 0, addedCents: Number(r?.added ?? 0), offCents: Number(r?.off ?? 0) };
}

/** An account as the audit log names it: its code, name and statement line. */
async function accountWords(db: Db, id: string) {
  const [a] = await db<{ code: string; name: string; statementLine: string | null }[]>`select code, name, statement_line from accounts where id = ${id}`;
  return { id, code: a?.code ?? null, name: a?.name ?? null, line: a?.statementLine ?? null };
}

/**
 * Moving a payment account or a cost type onto another account in the books, within a
 * transaction (the list PUT, a company file brought in): everything already captured with it moves
 * too. Refused when that reaches into a closed year, or (a payment account) carries entries on or
 * off the statements' cash line; otherwise done by `update`, and in the audit log with both
 * accounts' names and lines (IFRS for SMEs 3.12). `prefix` starts a refusal (whose file it is).
 */
export async function moveToAccount<T>(
  tx: Db,
  o: { table: 'payment_sources' | 'cost_categories'; id: string; to: string; userId?: string | null; ip?: string; prefix?: string },
  update: () => Promise<T>,
): Promise<T> {
  // No key update: a capture against it (its foreign key) isn't held up, nor deadlocked.
  const [was] = await tx<{ accountId: string; name: string }[]>`select account_id, name from ${tx(o.table)} where id = ${o.id} for no key update`;
  if (!was || was.accountId === o.to) return update();
  const refuse = (words: string) => badRequest(`${o.prefix ?? ''}${words}`);
  const [s] = await tx<{ lockDate: string | null; fyEndMonth: number }[]>`select lock_date::text as lock_date, fy_end_month from settings where id`;
  if (s?.lockDate) {
    const [closed] =
      o.table === 'cost_categories'
        ? await tx`select 1 from costs where category_id = ${o.id} and date <= ${s.lockDate}::date limit 1`
        : await tx`select 1 from ledger l where l.account_id = ${was.accountId} and l.date <= ${s.lockDate}::date limit 1`;
    if (closed) throw refuse('What’s already captured with this goes to its account in a closed year, so the account can’t change. Make a new one for what’s coming instead.');
  }
  // Its history goes with it to its new account: not on or off the statements' cash lines by the
  // way (that's a judgement, made on the account's line). Only when one account is on them and the
  // other isn't can anything cross: then all of it is counted, and what's from before this
  // financial year (last year's figures).
  const sides = await tx<{ cash: boolean }[]>`select coalesce(statement_line in ('cash', 'bank_overdraft'), false) as cash from accounts where id in ${tx([was.accountId, o.to])}`;
  const crossing = sides.length === 2 && sides[0]!.cash !== sides[1]!.cash;
  const yearStart = financialYear(today(), s?.fyEndMonth ?? 2).start;
  const onCash = async () => {
    const [n] = await tx<{ total: string; lastYear: string }[]>`
      select count(*)::bigint as total, count(*) filter (where l.date < ${yearStart}::date)::bigint as last_year
      from ledger l join accounts a on a.id = l.account_id where l.account_id in ${tx([was.accountId, o.to])} and a.statement_line in ('cash', 'bank_overdraft')`;
    return { all: Number(n!.total), before: Number(n!.lastYear) };
  };
  const before = crossing ? await onCash() : null;
  const row = await update();
  if (before) {
    const after = await onCash();
    if (after.all !== before.all)
      throw refuse(
        `What’s already captured with this would move on or off the statements’ cash line with it${after.before !== before.before ? ', last year’s figures too' : ''}. If the account it’s on now is on the wrong line, change that account’s line instead (Settings → Lists → Chart of accounts), after checking with your accountant; if the new account has nothing in it yet, put it on the same line first; otherwise make a new ${o.table === 'payment_sources' ? 'payment account' : 'cost type'} for what’s coming.`,
      );
  }
  await audit(tx, {
    userId: o.userId ?? null,
    actor: o.userId ? 'user' : 'system',
    action: 'moved_to_account',
    entity: o.table === 'payment_sources' ? 'payment_source' : 'cost_category',
    entityId: o.id,
    ip: o.ip,
    details: { name: was.name, from: await accountWords(tx, was.accountId), to: await accountWords(tx, o.to), ...(o.userId ? {} : { by: 'the company file' }) },
  });
  return row;
}

export async function getSettings(db: Db): Promise<SettingsRow> {
  const [s] = await db<SettingsRow[]>`select * from settings where id`;
  return s!;
}

export interface LockSettings {
  lockDate: string | null;
  monthEndMode: string;
  monthEndDay: number;
  monthLockedThrough: string | null;
  features: Record<string, boolean> | null;
  vatRegistered: boolean;
  vatCategory: VatCategory;
  fyEndMonth: number;
}
async function lockSettings(db: Db): Promise<LockSettings | undefined> {
  const [s] = await db<LockSettings[]>`
    select lock_date::text as lock_date, month_end_mode, month_end_day, month_locked_through::text as month_locked_through, features, vat_registered, vat_category, fy_end_month from settings where id`;
  return s;
}
/** What this business closes as it goes: months (it sells), VAT periods (a VAT vendor), or years. */
export const closesOf = (s: { features: Record<string, boolean> | null; vatRegistered: boolean }) => closesBy({ sells: featureOn(s.features, 'sales'), vatRegistered: s.vatRegistered });
/** The period end due to have locked itself by today, when it's set to lock by itself and that's not done yet. */
function lockDueBySelf(s: LockSettings): string | null {
  const closes = closesOf(s);
  if (s.monthEndMode !== 'auto' || closes === 'year') return null;
  const due = periodLockDue(today(), s.monthEndDay, closes, s.vatCategory, s.fyEndMonth);
  return s.monthLockedThrough && s.monthLockedThrough >= due ? null : due;
}

/** How the books close as they stand: for comparing before and after a settings change. */
export async function lockSettingsNow(db: Db): Promise<LockSettings | undefined> {
  return lockSettings(db);
}

/**
 * After a change to what decides how the books close (Sales, VAT registration, the VAT category,
 * the year end), within the same transaction: a new way of closing starts by hand, for the owner to
 * choose again under Accounts → Locks (a month end that locked by itself was never a choice about
 * VAT periods); the same VAT periods, differently cut, carry on by themselves from the next one's
 * day. Either way nothing locks at once, and a reopen stays open. Returns what changed, for the log.
 */
export async function lockAfterSettings(db: Db, before: LockSettings): Promise<Record<string, unknown> | null> {
  const after = await lockSettings(db);
  if (!after) return null;
  const was = closesOf(before);
  const now = closesOf(after);
  if (was !== now) {
    if (after.monthEndMode === 'auto') await db`update settings set month_end_mode = 'manual' where id`;
    return { closes: { was, now }, ...(after.monthEndMode === 'auto' ? { monthEnd: 'by hand from now: choose again under Accounts → Locks' } : {}) };
  }
  if (now === 'vat' && after.monthEndMode === 'auto' && (before.vatCategory !== after.vatCategory || before.fyEndMonth !== after.fyEndMonth)) {
    const due = periodLockDue(today(), after.monthEndDay, 'vat', after.vatCategory, after.fyEndMonth);
    await db`update settings set month_locked_through = greatest(coalesce(month_locked_through, ${due}::date), ${due}::date) where id`;
    return { vatPeriods: { was: before.vatCategory, now: after.vatCategory, fyEndMonth: after.fyEndMonth } };
  }
  return null;
}

/**
 * Month end (or VAT period end) set to lock itself: the periods due by today locked, once each (a
 * period reopened isn't locked again until the next one's day). Returns the lock date.
 */
export async function applyMonthLock(db: Db): Promise<string | null> {
  const s = await lockSettings(db);
  if (!s) return null;
  const due = lockDueBySelf(s);
  if (!due) return s.lockDate;
  const [u] = await db<{ lockDate: string }[]>`
    update settings set lock_date = greatest(coalesce(lock_date, ${due}::date), ${due}::date),
      relock_date = case when relock_date <= greatest(coalesce(lock_date, ${due}::date), ${due}::date) then null else relock_date end,
      month_locked_through = ${due}::date
    where id and (month_locked_through is null or month_locked_through < ${due}::date)
    returning lock_date::text as lock_date`;
  if (u && u.lockDate !== s.lockDate) {
    await audit(db, { actor: 'system', action: 'lock', entity: 'period', details: { through: u.lockDate, was: s.lockDate, by: closesOf(s) === 'vat' ? 'VAT period end, by itself' : 'month end, by itself' } });
  }
  if (u) return u.lockDate;
  // Another request locked it first (this one waited on the row): the lock as it is now.
  const [now] = await db<{ lockDate: string | null }[]>`select lock_date::text as lock_date from settings where id`;
  return now?.lockDate ?? null;
}

/**
 * The lock as it stands, month end's own lock included, without writing it: for what a screen
 * shows (a look changes nothing; the next change made locks it: applyMonthLock).
 */
export async function effectiveLock(db: Db): Promise<string | null> {
  const s = await lockSettings(db);
  if (!s) return null;
  const due = lockDueBySelf(s);
  if (!due) return s.lockDate;
  return !s.lockDate || s.lockDate < due ? due : s.lockDate;
}

/** Refuse changes dated on or before the lock date (a closed month, VAT period or year). */
export async function assertOpen(db: Db, ...dates: (string | null | undefined)[]): Promise<void> {
  const lock = await applyMonthLock(db);
  if (!lock) return;
  for (const d of dates) {
    if (d && d <= lock) throw badRequest(`The books are closed up to ${lock}. Someone who may close and reopen months and years can reopen them (Accounts → Locks), with the reason, to put this right.`);
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
