import type { App as FastifyInstance } from '../http.js';
import { addMonths, companyTax, estimateTax, provisionalPayable, financialYear, isoDate, monthEnd, monthsBetween, taxEstimateInput, yearEndInput, type AccountType, entity, sbcApplies } from '@shap/shared';
import { z } from 'zod';
import { requireRole, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { assessedLossBefore, assertOpen, sbcAnswer, getSettings, isIsoDate, q, today, freshTotals, noteShapFigures } from '../lib/books.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

const PL: AccountType[] = ['income', 'cost_of_sales', 'expense'];
/** Debit-positive ledger figures ↔ the way a statement shows them (income, liabilities and equity positive). */
export const natural = (type: AccountType) => (type === 'asset' || type === 'expense' || type === 'cost_of_sales' ? 1 : -1);

/** The tax estimate's kind for a kind of business (entities.ts). */
export const taxKind = (businessType: string) => ({ individual: 'individual', partners: 'partners', company: 'company', trust: 'trust', npc: 'npc' } as const)[entity(businessType).taxedAs];

/**
 * What else a tax estimate needs: a partnership's partners and their shares, and for a trust,
 * what it has given its beneficiaries this year that's taxed in their hands rather than the
 * trust's: this year's income, to beneficiaries who are South African residents (section 25B).
 */
export async function taxFigures(db: Db, businessType: string, fy: { start: string; end: string }) {
  const kind = entity(businessType).taxedAs;
  const partners = kind === 'partners' ? await db<{ name: string; shareBp: number }[]>`select name, share_bp from partners where active order by created_at` : [];
  const [d] = kind === 'trust' ? await db<{ t: number }[]>`select coalesce(sum(gross_cents), 0)::bigint as t from dividends where conduit and declared_on between ${fy.start}::date and ${fy.end}::date` : [{ t: 0 }];
  return { partners: partners.map((p) => ({ name: p.name, shareBp: p.shareBp })), distributedCents: Number(d!.t) };
}

/**
 * Agrees a year: the figures given (debit-positive), every other account pinned at what the books
 * say now, Shap's own figures noted (the books audit), and closed if asked. Call inside a transaction.
 */
export async function agreeYear(
  tx: Db,
  input: { fyEnd: string; fyStart: string; note: string; lock: boolean; figures: { accountId: string; amountCents: number }[]; keepImport?: boolean },
): Promise<void> {
  await tx`insert into year_ends (fy_end, note) values (${input.fyEnd}, ${input.note}) on conflict (fy_end) do update set note = excluded.note`;
  await tx`delete from year_end_figures where fy_end = ${input.fyEnd}`;
  // The tracker's own trial-balance journal is superseded by the accountant's figures (not when
  // the year is agreed at the books as they are: approved statements, which include it).
  if (!input.keepImport) await tx`delete from journals where kind = 'import' and date <= ${input.fyEnd}::date`;
  for (const f of input.figures) {
    await tx`insert into year_end_figures (fy_end, account_id, amount_cents) values (${input.fyEnd}, ${f.accountId}, ${f.amountCents})`;
  }
  // Agreed in full: every other account is pinned at what the books say now, so a later change
  // that reaches back into this year can't move its figures (the books audit notices it instead).
  await freshTotals(tx);
  await tx`
    insert into year_end_figures (fy_end, account_id, amount_cents)
    select ${input.fyEnd}, a.id,
      coalesce((select sum(l.amount_cents) from ledger_totals l
        where l.account_id = a.id and not (l.source = 'year_end' and l.date = ${input.fyEnd}::date) and l.date <= ${input.fyEnd}::date
          and (a.type not in ('income', 'cost_of_sales', 'expense') and coalesce(a.system_key, '') <> 'dividends' or l.date >= ${input.fyStart}::date)), 0)::bigint
    from accounts a
    where coalesce(a.system_key, '') not in ('retained_earnings', 'suspense')
      and not exists (select 1 from year_end_figures f where f.fy_end = ${input.fyEnd} and f.account_id = a.id)`;
  await noteShapFigures(tx, input.fyEnd);
  if (input.lock) await tx`update settings set lock_date = greatest(coalesce(lock_date, ${input.fyEnd}::date), ${input.fyEnd}::date) where id`;
}

export function registerYearEndRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;
  const readers = { preHandler: requireRole('owner', 'accountant') };
  const owner = { preHandler: requireRole('owner') };

  // ---------------------------------------------------------------- agreed year ends
  app.get('/api/year-ends', readers, async () => {
    await freshTotals(sql);
    return sql`
      select y.fy_end, y.note, y.created_at, count(f.account_id) filter (where f.amount_cents <> 0)::int as figures,
        coalesce((select sum(l.amount_cents) from ledger_totals l where l.source = 'year_end' and l.date = y.fy_end and l.account_id = sys_account('suspense')), 0)::bigint as suspense_cents
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
    await freshTotals(sql);
    const rows = await sql<{ id: string; code: string; name: string; type: AccountType; systemKey: string | null; shapCents: number; targetCents: number | null }[]>`
      select a.id, a.code, a.name, a.type, a.system_key,
        coalesce((select sum(l.amount_cents) from ledger_totals l
          where l.account_id = a.id and not (l.source = 'year_end' and l.date = ${fyEnd}::date)
            and l.date <= ${fyEnd}::date
            and (a.type not in ('income', 'cost_of_sales', 'expense') and coalesce(a.system_key, '') <> 'dividends' or l.date >= ${fy.start}::date)), 0)::bigint as shap_cents,
        (select f.amount_cents from year_end_figures f where f.fy_end = ${fyEnd} and f.account_id = a.id) as target_cents
      from accounts a
      where coalesce(a.system_key, '') not in ('retained_earnings', 'suspense')
      order by a.code`;
    const [ye] = await sql`select * from year_ends where fy_end = ${fyEnd}`;
    // Retained earnings at the start of the year (earlier years' profit less their dividends, the
    // opening balance and adjustments included).
    const [re] = await sql<{ t: number }[]>`
      select coalesce(sum(l.amount_cents), 0)::bigint as t from ledger_totals l join accounts a on a.id = l.account_id
      where (a.type in ('income', 'cost_of_sales', 'expense') or a.system_key in ('dividends', 'retained_earnings')) and l.date < ${fy.start}::date`;
    return {
      fyEnd,
      fyStart: fy.start,
      label: fy.label,
      agreed: Boolean(ye),
      note: ye?.note ?? '',
      openingRetainedCents: -re!.t,
      rows: rows
        // (Accounts pinned at nothing when the year was agreed stay out of the way.)
        .filter((r) => r.shapCents !== 0 || (r.targetCents != null && r.targetCents !== 0))
        .map((r) => ({ ...r, shapCents: r.shapCents * natural(r.type), targetCents: r.targetCents == null ? null : r.targetCents * natural(r.type) })),
      allAccounts: rows.map((r) => ({ id: r.id, code: r.code, name: r.name, type: r.type })),
    };
  });

  app.put('/api/year-ends', owner, async (req) => {
    const user = userOrThrow(req);
    const input = parse(yearEndInput, req.body);
    const settings = await getSettings(sql);
    if (financialYear(input.fyEnd, settings.fyEndMonth).end !== input.fyEnd) throw badRequest('That date isn’t the end of a financial year');
    // A closed year's agreed figures are what its books are: move the lock date back to change them.
    // (Agreeing a year for the first time is how a closed year gets the accountant's figures.)
    const [already] = await sql`select 1 from year_ends where fy_end = ${input.fyEnd}`;
    if (already) await assertOpen(sql, input.fyEnd);
    const types = new Map((await sql<{ id: string; type: AccountType }[]>`select id, type from accounts`).map((a) => [a.id, a.type]));
    const fy = financialYear(input.fyEnd, settings.fyEndMonth);
    await sql.begin(async (tx) => {
      await agreeYear(tx, { fyEnd: input.fyEnd, fyStart: fy.start, note: input.note, lock: input.lock, figures: input.figures.map((f) => {
        const t = types.get(f.accountId);
        if (!t) throw badRequest('Unknown account');
        return { accountId: f.accountId, amountCents: f.amountCents * natural(t) };
      }) });
      await audit(tx, { userId: user.id, action: 'agree_year_end', entity: 'year_end', entityId: input.fyEnd, ip: req.ip, details: { figures: input.figures.length } });
    });
    return { ok: true };
  });

  app.delete('/api/year-ends/:fyEnd', owner, async (req) => {
    const user = userOrThrow(req);
    const { fyEnd } = parse(z.object({ fyEnd: isoDate }), req.params);
    await assertOpen(sql, fyEnd);
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
    await freshTotals(sql);
    const rows = await sql<{ id: string; code: string; name: string; type: AccountType; systemKey: string | null; actual: number; prior: number }[]>`
      select a.id, a.code, a.name, a.type, a.system_key,
        coalesce((select sum(l.amount_cents) from ledger_totals l where l.account_id = a.id and l.date between ${fy.start}::date and ${asAt}::date), 0)::bigint as actual,
        coalesce((select sum(l.amount_cents) from ledger_totals l where l.account_id = a.id and l.date between ${prev.start}::date and ${prev.end}::date), 0)::bigint as prior
      from accounts a where a.type in ('income', 'cost_of_sales', 'expense') and coalesce(a.system_key, '') <> 'income_tax' and coalesce(a.statement_line, '') <> 'income_tax'
      order by a.code`;
    // A sole proprietor or partner doesn't pay themselves a salary: what they take out is drawings, not a cost.
    const always = new Set(entity(settings.businessType).payout === 'drawings' ? ['depreciation'] : ['director_salary', 'depreciation']);
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
    const assessedLoss = await assessedLossBefore(sql, fy.start, settings.fyEndMonth, taxKind(settings.businessType));
    const saved = await sql`select id, period, as_at, taxable_income_cents, tax_cents, payable_cents, note, created_at from tax_estimates where fy_end = ${fy.end} order by created_at desc`;
    return {
      fy,
      asAt,
      months,
      prev,
      lines,
      // A partnership has no assessed loss of its own (each year's loss went to the partners).
      assessedLossCents: taxKind(settings.businessType) === 'partners' ? 0 : assessedLoss,
      saved,
      businessType: settings.businessType,
      kind: taxKind(settings.businessType),
      approvedPbo: settings.approvedPbo,
      // Qualifies as a small business corporation (s12E) this year: what was said (null: not yet).
      sbc: (await sbcAnswer(sql, fy.end, settings.businessType)).sbc,
      // Provisional tax already paid for the year (recorded in Shap): what "paid" starts at.
      payments: await sql<{ id: string; date: string; amountCents: number; sourceName: string; reference: string }[]>`
        select p.id, p.date::text as date, p.amount_cents, s.name as source_name, p.reference from sars_payments p join payment_sources s on s.id = p.source_id
        where p.kind = 'irp6' and p.period = ${fy.end.slice(0, 7)} order by p.date`,
      ...(await taxFigures(sql, settings.businessType, fy)),
      exampleTaxOn100k: companyTax(10_000_000, fy.end, true),
    };
  });

  /**
   * Whether the company qualifies as a small business corporation (s12E) for a year: yes, no, or
   * not said (null). The owner's or the accountant's to say; SARS tests it each year.
   */
  app.put('/api/tax/sbc', { preHandler: requireRole('owner', 'accountant') }, async (req) => {
    const user = userOrThrow(req);
    const input = parse(z.object({ fyEnd: isoDate, sbc: z.boolean().nullable() }), req.body);
    const settings = await getSettings(sql);
    if (!entity(settings.businessType).sbcPossible) throw badRequest(`${entity(settings.businessType).label} can’t be a small business corporation`);
    if (financialYear(input.fyEnd, settings.fyEndMonth).end !== input.fyEnd) throw badRequest('That isn’t one of the business’s year ends');
    if (input.sbc === null) await sql`delete from sbc_years where fy_end = ${input.fyEnd}::date`;
    else
      await sql`insert into sbc_years (fy_end, sbc, updated_by) values (${input.fyEnd}::date, ${input.sbc}, ${user.id})
        on conflict (fy_end) do update set sbc = excluded.sbc, updated_at = now(), updated_by = excluded.updated_by`;
    await audit(sql, { userId: user.id, action: 'update', entity: 'sbc_year', entityId: input.fyEnd, ip: req.ip, details: { sbc: input.sbc } });
    return { fyEnd: input.fyEnd, sbc: input.sbc };
  });

  app.post('/api/tax-estimates', owner, async (req) => {
    const user = userOrThrow(req);
    const input = parse(taxEstimateInput, req.body);
    // Who pays, and on what, comes from the kind of business, not from the screen.
    const settings = await getSettings(sql);
    input.kind = taxKind(settings.businessType);
    const fy = financialYear(input.fyEnd, settings.fyEndMonth);
    const extra = await taxFigures(sql, settings.businessType, fy);
    const income = input.lines.reduce((s, l) => s + (l.type === 'income' ? l.projectedCents : -l.projectedCents), 0);
    // The small business corporation table only if the company qualifies, and never over R20 million of gross income.
    const gross = input.lines.reduce((s, l) => s + (l.type === 'income' ? l.projectedCents : 0), 0);
    // The estimate is on the table it was worked out on (the screen shows what was said for the
    // year); saving it doesn't answer the question for the year: only choosing does (/api/tax/sbc).
    const said = (await sbcAnswer(sql, fy.end, settings.businessType)).sbc;
    input.sbc = input.kind === 'company' && entity(settings.businessType).sbcPossible ? sbcApplies(input.sbc ?? said, gross) === true : false;
    const { taxableCents: taxable, taxCents: tax } = estimateTax({ ...input, profitCents: income, approvedPbo: settings.approvedPbo, distributedCents: extra.distributedCents, partners: extra.partners });
    const { payableCents: payable } = provisionalPayable({ taxCents: tax, payeCents: input.kind === 'individual' ? input.payeCents : 0, period: input.period, paidCents: input.paidCents });
    const [row] = await sql`
      insert into tax_estimates (fy_end, period, as_at, lines, taxable_income_cents, tax_cents, payable_cents, note, created_by)
      values (${input.fyEnd}, ${input.period}, ${input.asAt}, ${sql.json({ lines: input.lines, assessedLossCents: input.assessedLossCents, paidCents: input.paidCents, sbc: input.sbc, kind: input.kind, approvedPbo: settings.approvedPbo, distributedCents: extra.distributedCents, partners: extra.partners, ageBand: input.ageBand, otherIncomeCents: input.otherIncomeCents, retirementCents: input.retirementCents, payeCents: input.payeCents } as never)},
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
