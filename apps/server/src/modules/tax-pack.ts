/**
 * The tax pack: a year's tax figures in one PDF, to send to the accountant or tax practitioner who
 * files the returns (Accounts → Export → Tax pack). What the books give for the year (the income
 * statement, account by account), Shap's estimate of the year's income tax and the provisional tax
 * estimates (IRP6) kept for it, what was paid to SARS, each VAT201 period, turnover tax, the
 * payroll declarations (EMP201 by month, EMP501 by tax year), dividends and dividends tax, and the
 * assets bought and sold (for the wear-and-tear allowances).
 *
 * Every figure in it is an estimate worked out from the books, as an aid: the business and its
 * accountant check them before anything is filed (ESTIMATE_NOTE, on every page).
 */
import type { FastifyInstance } from 'fastify';
import PDFDocument from 'pdfkit';
import { entity, ESTIMATE_NOTE, ESTIMATE_SHORT, estimateTax, sbcApplies, featureOn, financialYear, formatAmount, formatDate, vat201Due, vatPeriod, addMonths, monthsBetween } from '@shap/shared';
import { z } from 'zod';
import { requireAccess, can, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import { assessedLossBefore, freshTotals, getSettings, today } from '../lib/books.js';
import { parse } from '../lib/validate.js';
import { usePdfFonts } from './pdf.js';
import { vat201 } from './taxforms.js';
import { emp501 } from './payroll.js';
import { taxFigures, taxKind } from './yearend.js';

type Db = Ctx['sql'];

const INK = '#1d262c';
const MUTED = '#66737b';
const amt = (c: number | null | undefined) => (c == null ? '' : c === 0 ? '–' : formatAmount(c));

/**
 * The figures for a year's tax pack. `people`: each employee's pay and certificate (EMP501), for
 * someone who may see payroll; without it the pack keeps the monthly totals (EMP201) only.
 */
export async function taxPack(db: Db, fyEnd: string, o: { people?: boolean } = {}) {
  const people = o.people ?? true;
  const s = await getSettings(db);
  const fy = financialYear(fyEnd, s.fyEndMonth);
  const kind = taxKind(s.businessType);
  await freshTotals(db);
  const accounts = await db<{ code: string; name: string; type: string; systemKey: string | null; statementLine: string | null; cents: string }[]>`
    select a.code, a.name, a.type, a.system_key, a.statement_line, coalesce(sum(l.amount_cents), 0)::bigint as cents
    from accounts a join ledger_totals l on l.account_id = a.id and l.date between ${fy.start}::date and ${fy.end}::date
    where a.type in ('income', 'cost_of_sales', 'expense') group by a.id having sum(l.amount_cents) <> 0 order by a.code`;
  const shown = accounts.map((a) => ({ code: a.code, name: a.name, type: a.type, isTax: a.systemKey === 'income_tax' || a.statementLine === 'income_tax', cents: a.type === 'income' ? -Number(a.cents) : Number(a.cents) }));
  const income = shown.filter((a) => a.type === 'income').reduce((t, a) => t + a.cents, 0);
  const costs = shown.filter((a) => a.type !== 'income' && !a.isTax).reduce((t, a) => t + a.cents, 0);
  const profitBeforeTax = income - costs;
  const assessedLossCents = await assessedLossBefore(db, fy.start, s.fyEndMonth, kind);
  const extra = await taxFigures(db, s.businessType, fy);
  const estimates = await db<{ period: number; asAt: string; taxableIncomeCents: string; taxCents: string; payableCents: string; note: string; createdAt: Date; lines: { sbc?: boolean } }[]>`
    select period, as_at::text as as_at, taxable_income_cents, tax_cents, payable_cents, note, created_at, lines from tax_estimates where fy_end = ${fy.end}::date order by period, created_at`;
  // The small business corporation table if the company says it qualifies (Settings) and its gross
  // income is within the limit; not said, both figures (the company rate's as the estimate).
  const sbc = kind === 'company' && entity(s.businessType).sbcPossible ? sbcApplies(s.sbc, income) : false;
  const est = (onSbc: boolean) => estimateTax({ kind, profitCents: profitBeforeTax, assessedLossCents, fyEnd: fy.end, sbc: onSbc, approvedPbo: s.approvedPbo, distributedCents: extra.distributedCents, partners: extra.partners } as Parameters<typeof estimateTax>[0]);
  const estimate = est(sbc === true);
  const sbcTaxCents = sbc === null ? est(true).taxCents : null;
  const [paidTax] = await db<{ paid: string; booked: string }[]>`
    select coalesce(sum(l.amount_cents) filter (where l.amount_cents > 0), 0)::bigint as paid,
           coalesce(-sum(l.amount_cents) filter (where l.amount_cents < 0), 0)::bigint as booked
    from ledger_totals l join accounts a on a.id = l.account_id where a.system_key = 'income_tax_payable' and l.date between ${fy.start}::date and ${fy.end}::date`;
  // VAT201s: each period that ends in the year.
  const vat: { start: string; end: string; due: string; fields: Awaited<ReturnType<typeof vat201>> }[] = [];
  if (s.vatRegistered) {
    let p = vatPeriod(fy.end, s.vatCategory, s.fyEndMonth);
    while (p.end >= fy.start) {
      if (p.end <= fy.end) vat.unshift({ ...p, due: vat201Due(p.end), fields: await vat201(db, p.start, p.end) });
      p = vatPeriod(addMonths(p.start, -1), s.vatCategory, s.fyEndMonth);
    }
  }
  // Payroll: the months in the year, and each tax year (March to February) it touches.
  const runs = await db<{ n: number }[]>`select count(*)::int as n from pay_runs where status = 'final' and pay_date between ${fy.start}::date and ${fy.end}::date`;
  const taxYears = runs[0]!.n ? [...new Set(monthsBetween(fy.start, fy.end).map((m) => (Number(m.slice(5, 7)) >= 3 ? Number(m.slice(0, 4)) + 1 : Number(m.slice(0, 4)))))] : [];
  const payroll = [];
  for (const y of taxYears) {
    const r = await emp501(db, y, `${y}-02-28` <= today() ? 'annual' : 'interim');
    payroll.push(people ? { ...r, peopleLeftOut: false } : { ...r, employees: [], peopleLeftOut: true });
  }
  const dividends = await db<{ declaredOn: string; shareholder: string; grossCents: string; dwtCents: string; exempt: boolean }[]>`
    select declared_on::text as declared_on, shareholder, gross_cents, dwt_cents, exempt from dividends where declared_on between ${fy.start}::date and ${fy.end}::date order by declared_on`;
  const assets = await db<{ name: string; category: string; purchaseDate: string; costCents: string; disposedOn: string | null; proceedsCents: string | null }[]>`
    select name, category, purchase_date::text as purchase_date, cost_cents, disposed_on::text as disposed_on, (disposal_proceeds_cents - disposal_vat_cents) as proceeds_cents from assets
    where purchase_date between ${fy.start}::date and ${fy.end}::date or disposed_on between ${fy.start}::date and ${fy.end}::date order by purchase_date`;
  return {
    settings: s,
    fy,
    kind,
    accounts: shown,
    incomeCents: income,
    costsCents: costs,
    profitBeforeTax,
    assessedLossCents,
    estimate: { ...estimate, sbc, sbcTaxCents },
    estimates,
    paidToSarsCents: Number(paidTax!.paid),
    taxBookedCents: Number(paidTax!.booked),
    vat,
    turnoverTax: s.turnoverTax,
    payroll,
    dividends,
    assets,
  };
}

export function renderTaxPack(t: Awaited<ReturnType<typeof taxPack>>): Promise<Buffer> {
  const s = t.settings;
  const pdf = new PDFDocument({ size: 'A4', margins: { top: 60, bottom: 70, left: 56, right: 56 }, bufferPages: true, info: { Title: `${s.companyName}: tax pack for the year ended ${formatDate(t.fy.end, 'long')}`, Author: s.companyName } });
  const { regular, bold } = usePdfFonts(pdf);
  const chunks: Buffer[] = [];
  pdf.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => pdf.on('end', () => resolve(Buffer.concat(chunks))));
  const L = 56;
  const R = pdf.page.width - 56;
  const W = R - L;
  const ensure = (h: number) => {
    if (pdf.y + h > pdf.page.height - 80) pdf.addPage();
  };
  const heading = (title: string, sub?: string) => {
    ensure(60);
    pdf.moveDown(0.6);
    pdf.font(bold).fontSize(13).fillColor(INK).text(title, L, pdf.y);
    if (sub) pdf.font(regular).fontSize(9).fillColor(MUTED).text(sub, L, pdf.y, { width: W });
    pdf.moveDown(0.5);
  };
  const para = (text: string, size = 9.5) => {
    pdf.font(regular).fontSize(size).fillColor(INK).text(text, L, pdf.y, { width: W, lineGap: 1.5 });
    pdf.moveDown(0.5);
  };
  /** A table: the first column words, the rest amounts in rand (or text). */
  const table = (head: string[], rows: (string | number | null)[][], widths?: number[]) => {
    const n = head.length;
    const w = widths ?? [W - (n - 1) * 80, ...Array(n - 1).fill(80)];
    const xs = w.reduce<number[]>((acc, _, i) => [...acc, i === 0 ? L : acc[i - 1]! + w[i - 1]!], []);
    // A column of amounts is right-aligned, its heading too.
    const numeric = head.map((_, i) => i > 0 && rows.some((r) => typeof r[i] === 'number' || (typeof r[i] === 'string' && /^[\d\s,.\-–()\n]+$/.test(String(r[i])))));
    const line = (cells: (string | number | null)[], font: string, color = INK) => {
      ensure(16);
      const y = pdf.y;
      let h = 12;
      cells.forEach((c, i) => {
        const txt = typeof c === 'number' ? amt(c) : (c ?? '');
        pdf.font(font).fontSize(8.5).fillColor(color).text(txt, xs[i]!, y, { width: w[i]! - 4, align: numeric[i] ? 'right' : 'left' });
        h = Math.max(h, pdf.y - y);
      });
      pdf.y = y + h + 3;
    };
    line(head, bold, MUTED);
    for (const r of rows) line(r, regular);
    pdf.moveDown(0.4);
  };

  // ---------------------------------------------------------------- cover
  pdf.font(bold).fontSize(20).fillColor(INK).text(s.companyName, L, 120, { width: W });
  pdf.font(regular).fontSize(12).text(`Tax pack for the year ended ${formatDate(t.fy.end, 'long')}`, { width: W });
  pdf.moveDown(1);
  const ids: [string, string][] = [
    ['Kind of business', entity(s.businessType).label],
    ['Registration number', s.regNumber],
    ['Income tax number', s.taxNumber ?? ''],
    ['VAT number', s.vatRegistered ? s.vatNumber : ''],
    ['PAYE reference', s.payeRef ?? ''],
    ['Year', `${formatDate(t.fy.start, 'long')} to ${formatDate(t.fy.end, 'long')}`],
    ['Prepared', formatDate(today(), 'long')],
  ];
  for (const [k, v] of ids) {
    if (!v) continue;
    const y = pdf.y;
    pdf.font(bold).fontSize(9.5).fillColor(INK).text(k, L, y, { width: 150 });
    pdf.font(regular).text(v, L + 160, y, { width: W - 160 });
    pdf.moveDown(0.3);
  }
  pdf.moveDown(1);
  para(`For the accountant or tax practitioner who files the returns: the year’s figures from the books kept in Shap. ${ESTIMATE_NOTE}`, 9);
  para('Contents: the year in the books; income tax; ' + [t.vat.length ? 'VAT201s' : '', t.turnoverTax ? 'turnover tax' : '', t.payroll.length ? 'payroll (EMP201 and EMP501)' : '', t.dividends.length ? 'dividends' : '', t.assets.length ? 'assets bought and sold' : ''].filter(Boolean).join('; ') + '.', 9);

  // ---------------------------------------------------------------- the year in the books
  pdf.addPage();
  heading('The year in the books', 'The income statement, account by account, as the books stand (year-end adjustments included).');
  table(
    ['Account', 'R'],
    [
      ...t.accounts.filter((a) => a.type === 'income').map((a) => [`${a.code} ${a.name}`, a.cents]),
      ['Income', t.incomeCents],
      ...t.accounts.filter((a) => a.type !== 'income' && !a.isTax).map((a) => [`${a.code} ${a.name}`, -a.cents]),
      ['Costs and expenses', -t.costsCents],
      ['Profit (loss) before tax', t.profitBeforeTax],
    ],
    [W - 100, 100],
  );

  // ---------------------------------------------------------------- income tax
  heading('Income tax', 'Shap’s estimate from the year’s profit: what’s deductible and taxable differs from the books in ways only your tax practitioner settles (wear-and-tear, non-deductible costs, exempt income).');
  table(
    ['', 'R'],
    [
      ['Profit (loss) before tax, from the books', t.profitBeforeTax],
      ...(t.assessedLossCents ? [['Assessed loss brought forward (earlier years’ losses in the books)', -t.assessedLossCents] as [string, number]] : []),
      ['Taxable income (estimate)', t.estimate.taxableCents],
      [`Tax (estimate${t.kind === 'company' ? (t.estimate.sbc ? ', small business corporation rates' : ', company rate') : ''})`, t.estimate.taxCents],
      ...(t.estimate.sbcTaxCents != null ? [['Tax on the small business corporation table, if the company qualifies (s12E: not said in Shap)', t.estimate.sbcTaxCents] as [string, number]] : []),
      ['Income tax booked for the year', t.taxBookedCents],
      ['Paid to SARS for income tax in the year (provisional tax and any balance)', t.paidToSarsCents],
    ],
    [W - 100, 100],
  );
  if (t.estimates.length) {
    para('Provisional tax estimates (IRP6) kept in Shap for this year:', 9);
    table(
      ['Period', 'As at', 'Saved', 'Taxable income', 'Tax', 'Payable'],
      t.estimates.map((e) => [e.period === 3 ? 'Top-up (3rd)' : `${e.period === 1 ? '1st' : '2nd'} period`, formatDate(e.asAt), formatDate(e.createdAt.toISOString().slice(0, 10)), Number(e.taxableIncomeCents), Number(e.taxCents), Number(e.payableCents)]),
      [90, 70, 70, (W - 230) / 3, (W - 230) / 3, (W - 230) / 3],
    );
  } else para('No provisional tax estimates were saved in Shap for this year.', 9);

  // ---------------------------------------------------------------- VAT
  if (t.vat.length) {
    heading('VAT201s', `Category ${s.vatCategory}, on the invoice basis: each period that ended in the year, field by field (as the VAT201 numbers them).`);
    table(
      ['Period', '1 / 4', '2 / 2A', '3', '14', '15', '20'],
      t.vat.map((v) => [`${formatDate(v.start)} – ${formatDate(v.end)}\ndue ${formatDate(v.due)}`, `${amt(v.fields.field1)}\n${amt(v.fields.field4)}`, `${amt(v.fields.field2)}\n${amt(v.fields.field2A)}`, v.fields.field3, v.fields.field14, v.fields.field15, v.fields.field20]),
      [120, (W - 120) / 6, (W - 120) / 6, (W - 120) / 6, (W - 120) / 6, (W - 120) / 6, (W - 120) / 6],
    );
    para('Field 1: standard-rated supplies (VAT included); 4: their output VAT; 2: zero-rated; 2A: exported; 3: exempt and non-supplies; 14: input VAT on capital goods; 15: other input VAT; 20: payable (refundable if negative). Fields 1A, 4A (assets sold) and 17 (bad debts) are on the VAT201 screen when they apply.', 8.5);
  }

  // ---------------------------------------------------------------- turnover tax
  if (t.turnoverTax) {
    heading('Turnover tax', 'Registered for turnover tax: the Turnover tax screen (Accounts) has the year’s turnover, the projection and the two interim payments (TT01, TT03).');
    para(`Income in the books for the year: R${amt(t.incomeCents)} (gains on selling assets aside, half of what selling the business’s assets brought in counts as turnover).`, 9);
  }

  // ---------------------------------------------------------------- payroll
  for (const p of t.payroll) {
    heading(`Payroll: tax year ending February ${p.taxYear}`, `${p.kind === 'annual' ? 'The annual' : 'The interim'} reconciliation (EMP501), ${formatDate(p.from)} to ${formatDate(p.to)}.`);
    table(
      ['Month (EMP201)', 'PAYE', 'UIF', 'SDL', 'Total', 'Paid'],
      p.months.map((m) => [m.period, Number(m.payeCents), Number(m.uifCents), Number(m.sdlCents), m.totalCents, Number(m.paidCents)]),
      [90, (W - 90) / 5, (W - 90) / 5, (W - 90) / 5, (W - 90) / 5, (W - 90) / 5],
    );
    if (p.peopleLeftOut) para('Each employee’s certificate (IRP5) is left out of this copy: it takes “See payroll” to see people’s pay. The owner’s copy has them.', 9);
    else
      table(
        ['Employee (certificate)', 'Gross (3699)', 'PAYE (4102)', 'UIF (4141)', 'SDL (4142)'],
        p.employees.map((e) => [`${e.name} (${e.certificate})${e.problems.length ? `\n${e.problems.join('; ')}` : ''}`, e.codes[3699], e.codes[4102], e.codes[4141], e.codes[4142]]),
        [W - 4 * 80, 80, 80, 80, 80],
      );
    if (p.differences.unpaidCents || p.differences.payeCents || p.differences.uifCents || p.differences.sdlCents)
      para(`Doesn’t reconcile yet: declared but unpaid R${amt(p.differences.unpaidCents)}; declared less certified PAYE R${amt(p.differences.payeCents)}, UIF R${amt(p.differences.uifCents)}, SDL R${amt(p.differences.sdlCents)}.`, 9);
  }

  // ---------------------------------------------------------------- dividends
  if (t.dividends.length) {
    heading('Dividends and dividends tax', 'Declared in the year: dividends tax is declared (DTR01, with a DTR02 for each shareholder), withheld and paid by the end of the month after the dividend is paid.');
    table(
      ['Declared', 'To', 'Gross', 'Dividends tax'],
      t.dividends.map((d) => [formatDate(d.declaredOn), `${d.shareholder}${d.exempt ? ' (exempt)' : ''}`, Number(d.grossCents), Number(d.dwtCents)]),
      [80, W - 280, 100, 100],
    );
  }

  // ---------------------------------------------------------------- assets
  if (t.assets.length) {
    heading('Assets bought and sold', 'For the wear-and-tear (s11(e)) and other allowances: the cost before VAT, as the books carry it.');
    table(
      ['Asset', 'Kind', 'Bought', 'Cost', 'Sold', 'Proceeds'],
      t.assets.map((a) => [a.name, a.category, formatDate(a.purchaseDate), Number(a.costCents), a.disposedOn ? formatDate(a.disposedOn) : '', a.proceedsCents == null ? null : Number(a.proceedsCents)]),
      [W - 400, 70, 70, 90, 70, 100],
    );
  }

  // ---------------------------------------------------------------- footers
  const range = pdf.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.switchToPage(i);
    const y = pdf.page.height - 50;
    pdf.font(regular).fontSize(7.5).fillColor(MUTED).text(`${s.companyName} · tax pack ${formatDate(t.fy.end, 'long')} · page ${i + 1} of ${range.count}. ${ESTIMATE_SHORT} Prepared with Shap (OpenWorks IT).`, L, y, { width: W, align: 'center', lineBreak: true, height: 30 });
  }
  pdf.end();
  return done;
}

export function registerTaxPackRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/tax-pack', { preHandler: requireAccess('reports.view') }, async (req, reply) => {
    const s = await getSettings(ctx.sql);
    const { fyEnd } = parse(z.object({ fyEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.query);
    // The last year that has ended, unless asked for another.
    const fy = financialYear(fyEnd ?? addMonths(financialYear(today(), s.fyEndMonth).start, -1), s.fyEndMonth);
    const pack = await taxPack(ctx.sql, fy.end, { people: can(userOrThrow(req), 'payroll.view') });
    const pdf = await renderTaxPack(pack);
    reply.header('content-type', 'application/pdf');
    reply.header('content-disposition', `attachment; filename="Tax pack ${fy.end}.pdf"`);
    return reply.send(pdf);
  });
  void featureOn;
}
