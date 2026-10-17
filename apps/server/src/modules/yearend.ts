import type { FastifyInstance } from 'fastify';
import { addMonths, companyTax, financialYear, isoDate, monthEnd, monthsBetween, taxEstimateInput, yearEndInput, type AccountType } from '@shap/shared';
import { z } from 'zod';
import { requireRole, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import { audit } from '../lib/audit.js';
import { getSettings, isIsoDate, q, today } from '../lib/books.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

const PL: AccountType[] = ['income', 'cost_of_sales', 'expense'];
/** Debit-positive ledger figures ↔ the way a statement shows them (income, liabilities and equity positive). */
export const natural = (type: AccountType) => (type === 'asset' || type === 'expense' || type === 'cost_of_sales' ? 1 : -1);

export function registerYearEndRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;
  const readers = { preHandler: requireRole('owner', 'accountant') };
  const owner = { preHandler: requireRole('owner') };

  // ---------------------------------------------------------------- agreed year ends
  app.get('/api/year-ends', readers, async () => {
    return sql`
      select y.fy_end, y.note, y.created_at, count(f.account_id)::int as figures,
        coalesce((select sum(l.amount_cents) from ledger l where l.source = 'year_end' and l.date = y.fy_end and l.account_id = sys_account('suspense')), 0)::bigint as suspense_cents
      from year_ends y left join year_end_figures f on f.fy_end = y.fy_end group by y.fy_end order by y.fy_end desc`;
  });

  /**
   * One row per account for a year end: what Shap's detail says (before this year's adjustment),
   * and the accountant's figure if one has been entered. Amounts in natural signs.
   */
  app.get('/api/year-ends/form', readers, async (req) => {
    const fyEnd = q(req).fyEnd;
    if (!isIsoDate(fyEnd)) throw badRequest('Choose a year end');
    const settings = await getSettings(sql);
    const fy = financialYear(fyEnd, settings.fyEndMonth);
    if (fy.end !== fyEnd) throw badRequest(`Your financial year ends in month ${settings.fyEndMonth}; ${fyEnd} isn’t a year end`);
    const rows = await sql<{ id: string; code: string; name: string; type: AccountType; systemKey: string | null; shapCents: number; targetCents: number | null }[]>`
      select a.id, a.code, a.name, a.type, a.system_key,
        coalesce((select sum(l.amount_cents) from ledger l
          where l.account_id = a.id and not (l.source = 'year_end' and l.date = ${fyEnd}::date)
            and l.date <= ${fyEnd}::date
            and (a.type not in ('income', 'cost_of_sales', 'expense') or l.date >= ${fy.start}::date)), 0)::bigint as shap_cents,
        (select f.amount_cents from year_end_figures f where f.fy_end = ${fyEnd} and f.account_id = a.id) as target_cents
      from accounts a
      where coalesce(a.system_key, '') not in ('retained_earnings', 'suspense')
      order by a.code`;
    const [ye] = await sql`select * from year_ends where fy_end = ${fyEnd}`;
    // Retained earnings at the start of the year (earlier years' profit, adjustments included).
    const [re] = await sql<{ t: number }[]>`
      select coalesce(sum(l.amount_cents), 0)::bigint as t from ledger l join accounts a on a.id = l.account_id
      where a.type in ('income', 'cost_of_sales', 'expense') and l.date < ${fy.start}::date`;
    return {
      fyEnd,
      fyStart: fy.start,
      label: fy.label,
      agreed: Boolean(ye),
      note: ye?.note ?? '',
      openingRetainedCents: -re!.t,
      rows: rows
        .filter((r) => r.shapCents !== 0 || r.targetCents != null)
        .map((r) => ({ ...r, shapCents: r.shapCents * natural(r.type), targetCents: r.targetCents == null ? null : r.targetCents * natural(r.type) })),
      allAccounts: rows.map((r) => ({ id: r.id, code: r.code, name: r.name, type: r.type })),
    };
  });

  app.put('/api/year-ends', owner, async (req) => {
    const user = userOrThrow(req);
    const input = parse(yearEndInput, req.body);
    const settings = await getSettings(sql);
    if (financialYear(input.fyEnd, settings.fyEndMonth).end !== input.fyEnd) throw badRequest('That date isn’t the end of a financial year');
    const types = new Map((await sql<{ id: string; type: AccountType }[]>`select id, type from accounts`).map((a) => [a.id, a.type]));
    await sql.begin(async (tx) => {
      await tx`insert into year_ends (fy_end, note) values (${input.fyEnd}, ${input.note}) on conflict (fy_end) do update set note = excluded.note`;
      await tx`delete from year_end_figures where fy_end = ${input.fyEnd}`;
      // The tracker's own trial-balance journal is superseded by the accountant's figures.
      await tx`delete from journals where kind = 'import' and date <= ${input.fyEnd}::date`;
      for (const f of input.figures) {
        const t = types.get(f.accountId);
        if (!t) throw badRequest('Unknown account');
        await tx`insert into year_end_figures (fy_end, account_id, amount_cents) values (${input.fyEnd}, ${f.accountId}, ${f.amountCents * natural(t)})`;
      }
      if (input.lock) await tx`update settings set lock_date = greatest(coalesce(lock_date, ${input.fyEnd}::date), ${input.fyEnd}::date) where id`;
      await audit(tx, { userId: user.id, action: 'agree_year_end', entity: 'year_end', entityId: input.fyEnd, ip: req.ip, details: { figures: input.figures.length } });
    });
    return { ok: true };
  });

  app.delete('/api/year-ends/:fyEnd', owner, async (req) => {
    const user = userOrThrow(req);
    const { fyEnd } = parse(z.object({ fyEnd: isoDate }), req.params);
    const r = await sql`delete from year_ends where fy_end = ${fyEnd}`;
    if (!r.count) throw notFound('Year end');
    await audit(sql, { userId: user.id, action: 'remove_year_end', entity: 'year_end', entityId: fyEnd, ip: req.ip });
    return { ok: true };
  });

  // ---------------------------------------------------------------- provisional tax
  /**
   * The figures for a provisional tax estimate (IRP6): this year's income statement to date,
   * projected to a full year at the same monthly rate, next to last year's actual figures.
   */
  app.get('/api/reports/provisional-tax', readers, async (req) => {
    const settings = await getSettings(sql);
    const { fyEnd: fyParam, asAt: asAtParam } = q(req);
    const fy = financialYear(isIsoDate(fyParam) ? fyParam : today(), settings.fyEndMonth);
    // Complete months only, unless told otherwise: the month in progress would drag the average down.
    const lastFull = monthEnd(addMonths(today(), -1));
    let asAt = isIsoDate(asAtParam) ? asAtParam : lastFull < fy.start ? today() : lastFull > fy.end ? fy.end : lastFull;
    if (asAt > fy.end) asAt = fy.end;
    if (asAt < fy.start) throw badRequest('That date is before the financial year starts');
    const months = monthsBetween(fy.start, asAt).filter((m) => monthEnd(`${m}-01`) <= asAt).length || 1;
    const prev = financialYear(addMonths(fy.start, -1), settings.fyEndMonth);
    const rows = await sql<{ id: string; code: string; name: string; type: AccountType; systemKey: string | null; actual: number; prior: number }[]>`
      select a.id, a.code, a.name, a.type, a.system_key,
        coalesce((select sum(l.amount_cents) from ledger l where l.account_id = a.id and l.date between ${fy.start}::date and ${asAt}::date), 0)::bigint as actual,
        coalesce((select sum(l.amount_cents) from ledger l where l.account_id = a.id and l.date between ${prev.start}::date and ${prev.end}::date), 0)::bigint as prior
      from accounts a where a.type in ('income', 'cost_of_sales', 'expense') and coalesce(a.system_key, '') <> 'income_tax'
      order by a.code`;
    const always = new Set(['director_salary', 'depreciation']);
    const lines = rows
      .filter((r) => r.actual !== 0 || r.prior !== 0 || always.has(r.systemKey ?? ''))
      .map((r) => {
        const sign = natural(r.type);
        const actual = r.actual * sign;
        return {
          accountId: r.id,
          code: r.code,
          name: r.name,
          type: r.type as 'income' | 'cost_of_sales' | 'expense',
          actualCents: actual,
          projectedCents: Math.round((actual / months) * 12),
          priorCents: r.prior * sign,
        };
      });
    // Assessed loss brought forward: earlier years' losses not yet used up by profits (from the books).
    const [prior] = await sql<{ t: number }[]>`
      select coalesce(sum(l.amount_cents), 0)::bigint as t from ledger l join accounts a on a.id = l.account_id
      where a.type in ('income', 'cost_of_sales', 'expense') and coalesce(a.system_key, '') <> 'income_tax' and l.date < ${fy.start}::date`;
    const assessedLoss = Math.max(0, prior!.t); // debit-positive: a net loss is positive
    const saved = await sql`select id, period, as_at, taxable_income_cents, tax_cents, payable_cents, note, created_at from tax_estimates where fy_end = ${fy.end} order by created_at desc`;
    return { fy, asAt, months, prev, lines, assessedLossCents: assessedLoss, saved, exampleTaxOn100k: companyTax(10_000_000, fy.end, true) };
  });

  app.post('/api/tax-estimates', owner, async (req) => {
    const user = userOrThrow(req);
    const input = parse(taxEstimateInput, req.body);
    const income = input.lines.reduce((s, l) => s + (l.type === 'income' ? l.projectedCents : -l.projectedCents), 0);
    const taxable = Math.max(0, income - input.assessedLossCents);
    const tax = companyTax(taxable, input.fyEnd, input.sbc);
    const payable = Math.max(0, (input.period === 1 ? Math.round(tax / 2) : tax) - input.paidCents);
    const [row] = await sql`
      insert into tax_estimates (fy_end, period, as_at, lines, taxable_income_cents, tax_cents, payable_cents, note, created_by)
      values (${input.fyEnd}, ${input.period}, ${input.asAt}, ${sql.json({ lines: input.lines, assessedLossCents: input.assessedLossCents, paidCents: input.paidCents, sbc: input.sbc } as never)},
              ${taxable}, ${tax}, ${payable}, ${input.note}, ${user.id})
      returning id`;
    await audit(sql, { userId: user.id, action: 'create', entity: 'tax_estimate', entityId: row!.id, ip: req.ip });
    return { id: row!.id, taxableCents: taxable, taxCents: tax, payableCents: payable };
  });

  app.get('/api/tax-estimates/:id', readers, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const [row] = await sql`select * from tax_estimates where id = ${id}`;
    if (!row) throw notFound('Estimate');
    return row;
  });

  app.delete('/api/tax-estimates/:id', owner, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    await sql`delete from tax_estimates where id = ${id}`;
    return { ok: true };
  });
}
