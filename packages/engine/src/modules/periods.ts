/**
 * Locked periods (Shap's docs/LOCKS.md). Everything dated on or before the lock date is closed.
 * The owner locks a month or a year, and reopens the books with a reason (in the audit log) to put
 * something right, then locks them again. A business that sells closes each month (month end): by hand, or
 * the month locks itself on a day of the next month (lib/books.ts applyMonthLock). One that doesn't
 * closes its years.
 */
import type { App as FastifyInstance } from '../http.js';
import { addMonths, featureOn, financialYear, lockInput, monthEnd, monthEndInput, monthLockDue, nextMonthLock, reopenInput, vatPeriod, type VatCategory } from '@shap/shared';
import { requireRole, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { applyMonthLock, effectiveLock, getSettings, today } from '../lib/books.js';
import { badRequest } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

/** A year whose financial statements were approved and signed stays closed until they're reopened. */
async function signedAfter(db: Db, date: string | null): Promise<string | null> {
  const [signed] = await db<{ fyEnd: string }[]>`
    select fy_end::text as fy_end from financial_statements where status = 'approved' and fy_end > coalesce(${date}::date, '0001-01-01'::date) order by fy_end desc limit 1`;
  return signed?.fyEnd ?? null;
}

/**
 * The lock as it stands, with what month end needs. `who`: whether to say who reopened the books
 * and why (it's the audit log's: for whoever may lock, the owner and the accountant).
 */
export async function lockState(db: Db, who = true) {
  const lockDate = await effectiveLock(db);
  const s = await getSettings(db);
  const sells = featureOn(s.features, 'sales');
  // Reopened: the lock it was at, while that's still later than the lock now.
  const relock = s.relockDate && (!lockDate || String(s.relockDate) > lockDate) ? String(s.relockDate) : null;
  const [reopened] = relock
    ? await db<{ at: string; byName: string | null; reason: string; to: string | null }[]>`
        select a.at, u.name as by_name, a.details->>'reason' as reason, a.details->>'to' as to from audit_log a left join users u on u.id = a.user_id
        where a.entity = 'period' and a.action = 'reopen' order by a.at desc limit 1`
    : [];
  const t = today();
  const lastMonthEnd = monthEnd(addMonths(`${t.slice(0, 8)}01`, -1));
  return {
    lockDate,
    reopened: relock ? { relockDate: relock, at: reopened?.at ?? null, byName: who ? (reopened?.byName ?? null) : null, reason: who ? (reopened?.reason ?? '') : '' } : null,
    sells,
    monthEnd: { mode: s.monthEndMode, day: s.monthEndDay, next: s.monthEndMode === 'auto' && sells ? nextMonthLock(t, s.monthEndDay) : null },
    // Month end due: a business that sells, last month still open, from the month end day.
    monthDue: sells && (!lockDate || lockDate < lastMonthEnd) && Number(t.slice(8, 10)) >= s.monthEndDay ? lastMonthEnd : null,
    fyEndMonth: s.fyEndMonth,
    // A VAT vendor's VAT periods that have ended and are closed: reopening one may mean a VAT201
    // already filed (docs/LOCKS.md).
    vatPeriods: s.vatRegistered && lockDate ? closedVatPeriods(lockDate, s.vatCategory, s.fyEndMonth) : [],
  };
}

/** The VAT periods ended on or before the lock date, the last two years of them, newest first. */
export function closedVatPeriods(lockDate: string, category: VatCategory, fyEndMonth: number): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  for (let m = 0; m < 24; m++) {
    const p = vatPeriod(monthEnd(addMonths(`${lockDate.slice(0, 8)}01`, -m)), category, fyEndMonth);
    if (p.end <= lockDate && !out.some((x) => x.end === p.end)) out.push(p);
  }
  return out;
}

/** The VAT periods a reopen to `to` opens again (ended after `to`, closed up to `was`). */
export const vatPeriodsReopened = (periods: { start: string; end: string }[], to: string | null) => periods.filter((p) => !to || p.end > to);

export function registerPeriodRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;

  app.get('/api/periods', { preHandler: requireRole('owner', 'accountant') }, async (req) => {
    userOrThrow(req);
    const state = await lockState(sql);
    const t = today();
    // The last twelve month ends (a business that sells) or financial years, newest first, with
    // what each holds: a month end looks over these before locking.
    const ends = state.sells
      ? Array.from({ length: 12 }, (_, i) => monthEnd(addMonths(`${t.slice(0, 8)}01`, -i)))
      : Array.from({ length: 6 }, (_, i) => financialYear(addMonths(t, -12 * i), state.fyEndMonth).end);
    const periods = [];
    for (const end of ends) {
      const start = state.sells ? `${end.slice(0, 8)}01` : financialYear(end, state.fyEndMonth).start;
      const [f] = await sql<{ salesCount: number; salesCents: string; refundsCents: string; invoicedCents: string; costsCents: string; bankOpen: number }[]>`
        select
          (select count(*)::int from documents where counter and status = 'issued' and issue_date between ${start}::date and ${end}::date) as sales_count,
          (select coalesce(sum(total_cents), 0) from documents where counter and status = 'issued' and issue_date between ${start}::date and ${end}::date) as sales_cents,
          (select coalesce(sum(rf.amount_cents), 0) from refunds rf join documents cn on cn.id = rf.credit_note_id join documents s on s.id = cn.credited_invoice_id
             where s.counter and rf.date between ${start}::date and ${end}::date) as refunds_cents,
          (select coalesce(sum(total_cents), 0) from documents where kind = 'invoice' and not counter and status = 'issued' and issue_date between ${start}::date and ${end}::date) as invoiced_cents,
          (select coalesce(sum(amount_cents), 0) from costs where date between ${start}::date and ${end}::date) as costs_cents,
          (select count(*)::int from bank_lines l where l.date between ${start}::date and ${end}::date and not l.ignored
             and not exists (select 1 from bank_matches m where m.bank_line_id = l.id)) as bank_open`;
      periods.push({
        start,
        end,
        ended: end < t,
        locked: Boolean(state.lockDate && state.lockDate >= end),
        salesCount: f!.salesCount,
        salesCents: Number(f!.salesCents),
        refundsCents: Number(f!.refundsCents),
        invoicedCents: Number(f!.invoicedCents),
        costsCents: Number(f!.costsCents),
        bankOpen: f!.bankOpen,
      });
    }
    return { ...state, periods };
  });

  /** Lock the books up to a month end (closing every month before it too). */
  app.post('/api/periods/lock', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { through } = parse(lockInput, req.body);
    if (through >= today()) throw badRequest('A month is locked once it has ended');
    return sql.begin(async (tx) => {
      // One at a time: two locks sent together can't leave it at the earlier one.
      await tx`select 1 from settings where id for update`;
      const was = await applyMonthLock(tx);
      if (was && was >= through) throw badRequest(`The books are already closed up to ${was}`);
      await tx`update settings set lock_date = greatest(coalesce(lock_date, ${through}::date), ${through}::date), relock_date = case when relock_date <= ${through}::date then null else relock_date end where id`;
      await audit(tx, { userId: user.id, action: 'lock', entity: 'period', ip: req.ip, details: { through, was } });
      return lockState(tx);
    });
  });

  /**
   * Reopen the books from a month end (they stay closed up to `to`; null opens them all), with the
   * reason, to put something right; lock them again after.
   */
  app.post('/api/periods/reopen', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { to, reason } = parse(reopenInput, req.body);
    return sql.begin(async (tx) => {
      await tx`select 1 from settings where id for update`;
      const was = await applyMonthLock(tx);
      if (!was) throw badRequest('Nothing is locked');
      if (to && to >= was) throw badRequest(`The books are closed up to ${was}: reopen them from an earlier month end`);
      const signed = await signedAfter(tx, to);
      if (signed) throw badRequest(`The financial statements for the year ended ${signed} were approved and signed. Reopen them first (Accounts → Financial statements, with the reason), then the books.`);
      const [s] = await tx<{ relockDate: string | null }[]>`select relock_date::text as relock_date from settings where id for update`;
      const before = await lockState(tx);
      await tx`update settings set lock_date = ${to}::date, relock_date = greatest(coalesce(${s!.relockDate}::date, ${was}::date), ${was}::date) where id`;
      const vat = vatPeriodsReopened(before.vatPeriods, to);
      await audit(tx, { userId: user.id, action: 'reopen', entity: 'period', ip: req.ip, details: { was, to, reason, vatPeriods: vat.map((p) => p.end) } });
      return { ...(await lockState(tx)), vatReopened: vat };
    });
  });

  /** Month end: closed by hand, or each month locks itself on a day of the next. */
  app.put('/api/periods/month-end', { preHandler: requireRole('owner') }, async (req) => {
    const user = userOrThrow(req);
    const { mode, day } = parse(monthEndInput, req.body);
    const before = await getSettings(sql);
    if (!featureOn(before.features, 'sales')) throw badRequest('Month end is for a business that sells: switch Sales on first (Settings → What you use)');
    // Switched to locking by itself: the months due lock now, unless the books are reopened (then
    // from the next month's day, so what's being put right isn't closed under someone).
    const due = monthLockDue(today(), day);
    await sql`update settings set month_end_mode = ${mode}, month_end_day = ${day}, updated_at = now(),
      month_locked_through = case when ${mode} = 'auto' and relock_date is not null and (lock_date is null or relock_date > lock_date)
        then greatest(coalesce(month_locked_through, ${due}::date), ${due}::date) else month_locked_through end
      where id`;
    await audit(sql, { userId: user.id, action: 'update', entity: 'period', ip: req.ip, details: { monthEnd: mode, day, was: { mode: before.monthEndMode, day: before.monthEndDay } } });
    return lockState(sql);
  });
}
