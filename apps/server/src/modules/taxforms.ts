/**
 * Figures laid out the way SARS's forms ask for them: the VAT201 return box by box, and turnover
 * tax for micro businesses. Shap fills in what the books know; the person (or their accountant)
 * checks them and files on eFiling. Shap doesn't file, and isn't a tax practitioner.
 */
import type { FastifyInstance } from 'fastify';
import { addMonths, financialYear, lastBusinessDay, monthEnd, monthsBetween, turnoverTax, turnoverTaxLimit, turnoverTaxTable, vat201Due, vatPeriod, entity, splitByShares } from '@shap/shared';
import { z } from 'zod';
import { requireAccess } from '../auth.js';
import type { Ctx } from '../context.js';
import { freshTotals, getSettings, today } from '../lib/books.js';
import { badRequest } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

type Db = Ctx['sql'];

/** The VAT201 boxes for a period (invoice basis: invoices and costs by their dates). */
export async function vat201(db: Db, start: string, end: string) {
  // Each line by its kind of supply: standard-rated (field 1, with its VAT: field 4), zero-rated
  // (2), exported (2A), exempt or not a supply (3). Credit notes count against them. A document
  // without a VAT rate was issued before the business registered (or is a credit note on one):
  // not a supply by a vendor, so not on the return.
  const [out] = await db<{ std: number; stdVat: number; zero: number; exported: number; exempt: number }[]>`
    select
      coalesce(sum(sign * (l.std + d.vat_cents)), 0)::bigint as std,
      coalesce(sum(sign * d.vat_cents), 0)::bigint as std_vat,
      coalesce(sum(sign * l.zero), 0)::bigint as zero,
      coalesce(sum(sign * l.exported), 0)::bigint as exported,
      coalesce(sum(sign * l.exempt), 0)::bigint as exempt
    from documents d
    cross join lateral (select case d.kind when 'credit_note' then -1 else 1 end as sign) k
    cross join lateral (
      select coalesce(sum(x.line_total_cents) filter (where x.vat_code = 'standard'), 0) as std,
             coalesce(sum(x.line_total_cents) filter (where x.vat_code = 'zero'), 0) as zero,
             coalesce(sum(x.line_total_cents) filter (where x.vat_code = 'export'), 0) as exported,
             coalesce(sum(x.line_total_cents) filter (where x.vat_code = 'exempt'), 0) as exempt
      from document_lines x where x.document_id = d.id) l
    where d.kind in ('invoice', 'credit_note', 'sale') and d.status = 'issued' and d.vat_rate_bp > 0 and d.issue_date between ${start}::date and ${end}::date`;
  // Input VAT: capital goods (field 14) are the costs of the asset type or on the asset register,
  // and assets bought straight from an account; everything else is field 15.
  const [inp] = await db<{ capital: number; other: number }[]>`
    select coalesce(sum(c.vat_cents) filter (where k.kind = 'asset' or exists (select 1 from assets a where a.cost_id = c.id)), 0)::bigint
             + (select coalesce(sum(a.vat_cents), 0) from assets a where a.cost_id is null and a.vat_cents <> 0 and a.purchase_date between ${start}::date and ${end}::date)::bigint as capital,
           coalesce(sum(c.vat_cents) filter (where k.kind <> 'asset' and not exists (select 1 from assets a where a.cost_id = c.id)), 0)::bigint as other
    from costs c join cost_categories k on k.id = c.category_id
    where c.vat_cents <> 0 and c.date between ${start}::date and ${end}::date`;
  // Output VAT on selling the business's own assets (capital goods supplied): fields 1A and 4A.
  const [sold] = await db<{ incl: number; vat: number }[]>`
    select coalesce(sum(disposal_proceeds_cents), 0)::bigint as incl, coalesce(sum(disposal_vat_cents), 0)::bigint as vat
    from assets where disposal_vat_cents <> 0 and disposed_on between ${start}::date and ${end}::date`;
  // Bad debts written off: the VAT in what was written off can be claimed back (the same as the
  // books post: ledger_detail in 036_vat_per_line.sql).
  const [bad] = await db<{ vat: number }[]>`
    select coalesce(sum(bad_debt_vat(d.id, d.written_off_cents, d.vat_rate_bp, d.vat_cents, d.total_cents)), 0)::bigint as vat
    from documents d where d.kind = 'invoice' and d.status = 'issued' and d.written_off_vat_relief and d.vat_rate_bp > 0
      and d.written_off_on between ${start}::date and ${end}::date`;
  const f = {
    field1: Number(out!.std),
    field1A: Number(sold!.incl),
    field2: Number(out!.zero),
    field2A: Number(out!.exported),
    field3: Number(out!.exempt),
    field4: Number(out!.stdVat),
    field4A: Number(sold!.vat),
    field14: Number(inp!.capital),
    field15: Number(inp!.other),
    field17: Number(bad!.vat),
  };
  const field13 = f.field4 + f.field4A;
  const field19 = f.field14 + f.field15 + f.field17;
  return { ...f, field13, field19, field20: field13 - field19 };
}

export function registerTaxFormRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;

  /** The VAT201 for the period ending in (or the period containing) `on`; recent periods to pick from. */
  app.get('/api/vat/return', { preHandler: requireAccess('reports.view') }, async (req) => {
    const settings = await getSettings(sql);
    // A real date, within the years a VAT201 can be for.
    const { on } = parse(z.object({ on: z.string().regex(/^(19|20)\d{2}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v, 'A real date').optional() }), req.query);
    const cat = settings.vatCategory;
    // The default: the last period that has ended.
    const current = vatPeriod(today(), cat, settings.fyEndMonth);
    const lastEnded = vatPeriod(addMonths(current.start, -1), cat, settings.fyEndMonth);
    const period = on ? vatPeriod(on, cat, settings.fyEndMonth) : lastEnded;
    const periods: { start: string; end: string }[] = [];
    let p = current;
    for (let i = 0; i < 8; i++) {
      periods.push(p);
      p = vatPeriod(addMonths(p.start, -1), cat, settings.fyEndMonth);
    }
    return { category: cat, registered: settings.vatRegistered, vatNumber: settings.vatNumber, period, due: vat201Due(period.end), periods, fields: await vat201(sql, period.start, period.end) };
  });

  /** Turnover tax for a year of assessment: turnover so far, the year projected, the two interim payments. */
  app.get('/api/reports/turnover-tax', { preHandler: requireAccess('reports.view') }, async (req) => {
    const settings = await getSettings(sql);
    const { fyEnd } = parse(z.object({ fyEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.query);
    const fy = financialYear(fyEnd ?? today(), settings.fyEndMonth);
    const t = today();
    const lastFull = monthEnd(addMonths(t, -1));
    const asAt = lastFull < fy.start ? t : lastFull > fy.end ? fy.end : lastFull;
    if (asAt < fy.start) throw badRequest('That year hasn’t started');
    const months = monthsBetween(fy.start, asAt).filter((m) => monthEnd(`${m}-01`) <= asAt).length || 1;
    await freshTotals(sql);
    // Taxable turnover (Sixth Schedule; SARS's TT01 FAQ): business income, not profit. Gains on
    // selling assets are left out, but half of what selling the business's assets brought in counts.
    // An individual's (or partner's) investment income (interest) isn't turnover; a company's is.
    const individual = entity(settings.businessType).taxedAs !== 'company';
    const [r] = await sql<{ income: number }[]>`
      select coalesce(-sum(l.amount_cents), 0)::bigint as income from ledger_totals l join accounts a on a.id = l.account_id
      where a.type = 'income' and coalesce(a.system_key, '') <> 'disposal_gain_loss'
        and not (${individual} and coalesce(a.system_key, '') = 'interest_income')
        and l.date between ${fy.start}::date and ${asAt}::date`;
    const [sold] = await sql<{ proceeds: number }[]>`
      select coalesce(sum(disposal_proceeds_cents - disposal_vat_cents), 0)::bigint as proceeds from assets
      where disposed_on between ${fy.start}::date and ${asAt}::date`;
    const actual = Number(r!.income) + Math.round(Number(sold!.proceeds) / 2);
    const projected = Math.round((actual / months) * 12);
    // A partnership's partners each pay turnover tax on their own share of the turnover.
    const partners = entity(settings.businessType).taxedAs === 'partners' ? await sql<{ id: string; name: string; shareBp: number }[]>`select id, name, share_bp from partners where active order by created_at` : [];
    const perPartner = splitByShares(projected, partners).map((p) => ({ name: p.partner.name, shareBp: p.partner.shareBp, turnoverCents: p.cents, taxCents: turnoverTax(p.cents, fy.end) }));
    const tax = partners.length ? perPartner.reduce((t, p) => t + p.taxCents, 0) : turnoverTax(projected, fy.end);
    const [y1, m1] = addMonths(fy.start, 5).split('-').map(Number) as [number, number];
    const [y2, m2] = fy.end.split('-').map(Number) as [number, number];
    return {
      on: settings.turnoverTax,
      fy,
      asAt,
      months,
      turnoverCents: actual,
      projectedCents: projected,
      taxCents: tax,
      overLimit: projected > turnoverTaxLimit(fy.end),
      partners: perPartner,
      limitCents: turnoverTaxLimit(fy.end),
      halfOfAssetSalesCents: Math.round(Number(sold!.proceeds) / 2),
      bands: turnoverTaxTable(fy.end),
      // Two interim payments (TT02): half by the end of the sixth month, the rest by year end.
      interim: [
        { label: 'First interim payment', due: lastBusinessDay(y1, m1), cents: Math.round(tax / 2) },
        { label: 'Second interim payment', due: lastBusinessDay(y2, m2), cents: tax - Math.round(tax / 2) },
      ],
    };
  });
}
