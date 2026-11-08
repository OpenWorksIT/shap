/**
 * The books audit: what an accountant would check before trusting the figures, run against the
 * books as they are. It changes nothing in the books (it brings the report totals up to date
 * first, as any report does). Each finding is OK, WARN (worth a look) or FAIL (the figures can't
 * be trusted until it's put right), in the same shape as Steady's and Shap's server audits, so
 * one screen shows them all.
 *
 * It checks that:
 * - every posting balances, document by document, and the quick totals agree with the ledger;
 * - the trial balance and the balance sheet balance (today and at each recent year end);
 * - the debtors, creditors and payroll accounts agree to the cent with the records behind them
 *   (open invoices, unpaid bills, final pay runs less EMP201 payments), and the VAT account moved
 *   by what Shap's VAT201 for each period says (both come from the same documents: this catches
 *   postings gone astray, not a return filed with other figures, which Shap doesn't keep);
 * - agreed years still show the figures they were agreed at, and nothing dated in them has been
 *   added or changed since (which would show as more in suspense for that year);
 * - documents add up, tax invoices carry what SARS requires, numbers don't go missing unexplained;
 * - the safeguards in the database itself are in place (the audit log can't be changed, journals
 *   must balance).
 *
 * Used by the app (Settings → Updates & backups, the accountant's Accounts screen), by the server
 * audit (deploy/vps/audit-server.sh) and by the tests, which also break the books on purpose to
 * see each check catch it (test/books-audit.test.ts).
 */
import { financialYear, formatZar, vatIncluded, vatPeriod, vatRateOn } from '@shap/shared';
import type { Ctx } from '../context.js';

type Db = Ctx['sql'];
/** Journals typed in, not made by the app from a pay run, a SARS payment, a dividend or a profit share. */
const BY_HAND = ['manual', 'opening', 'import', 'adjustment'];
import { freshTotals, getSettings, today } from '../lib/books.js';
import { FULL_TAX_INVOICE_CENTS } from '../modules/documents.js';
import { balanceSheet, trialBalance } from '../modules/reports.js';
import { vat201 } from '../modules/taxforms.js';

export type AuditLevel = 'ok' | 'warn' | 'fail';
export interface AuditItem {
  level: AuditLevel;
  section: string;
  text: string;
}

const rand = (cents: number) => formatZar(Math.abs(cents));
const n = (v: unknown) => Number(v ?? 0);
const few = (xs: string[], max = 5) => (xs.length > max ? `${xs.slice(0, max).join(', ')} and ${xs.length - max} more` : xs.join(', '));

/** The whole audit, in order. `on`: the day it's run for (today by default). */
export async function auditBooks(db: Db, on = today()): Promise<AuditItem[]> {
  const items: AuditItem[] = [];
  let section = '';
  const ok = (text: string) => items.push({ level: 'ok', section, text });
  const warn = (text: string) => items.push({ level: 'warn', section, text });
  const fail = (text: string) => items.push({ level: 'fail', section, text });
  const settings = await getSettings(db);
  await freshTotals(db);

  // ---------------------------------------------------------------- the ledger
  section = 'The ledger';
  const [all] = await db<{ total: number; rows: number }[]>`select coalesce(sum(amount_cents), 0)::bigint as total, count(*)::int as rows from ledger_detail`;
  if (n(all!.total) === 0) ok(`every posting balances (${n(all!.rows)} postings)`);
  else fail(`the postings don't balance: debits and credits differ by ${rand(n(all!.total))}`);

  const lopsided = await db<{ source: string; sourceId: string; total: number }[]>`
    select source, source_id, sum(amount_cents)::bigint as total from ledger_detail
    group by source, source_id having sum(amount_cents) <> 0 limit 20`;
  if (!lopsided.length) ok('each document, cost, payment and journal balances on its own');
  else fail(`${lopsided.length === 20 ? '20 or more' : lopsided.length} entries don't balance on their own: ${few(lopsided.map((l) => `${l.source} ${String(l.sourceId).slice(0, 8)} (${rand(n(l.total))})`))}`);

  // The quick totals are the ledger (year-end adjustments included) added up by account, day and
  // kind of posting: compared both ways, so a total missing from either side shows.
  const [cache] = await db<{ off: number }[]>`
    with l as (select account_id, date, source, sum(amount_cents)::bigint as t from ledger group by 1, 2, 3 having sum(amount_cents) <> 0),
         c as (select account_id, date, source, sum(amount_cents)::bigint as t from ledger_totals group by 1, 2, 3 having sum(amount_cents) <> 0)
    select count(distinct account_id)::int as off from ((select * from l except select * from c) union all (select * from c except select * from l)) x`;
  if (n(cache!.off) === 0) ok('the quick totals agree with the ledger');
  else fail(`the quick totals behind the reports disagree with the ledger on ${n(cache!.off)} accounts`);

  const tb = await trialBalance(db, on);
  if (tb.totals.differenceCents === 0) ok(`the trial balance balances (${rand(tb.totals.debitCents)} each side)`);
  else fail(`the trial balance is out by ${rand(tb.totals.differenceCents)}`);

  const fyNow = financialYear(on, settings.fyEndMonth);
  const ends = [on];
  for (let back = 1; back <= 3; back++) ends.push(financialYear(`${Number(fyNow.end.slice(0, 4)) - back}${fyNow.end.slice(4)}`, settings.fyEndMonth).end);
  const unbalanced: string[] = [];
  for (const d of ends) {
    const bs = await balanceSheet(db, d);
    if (bs.differenceCents !== 0) unbalanced.push(`${d} (out by ${rand(bs.differenceCents)})`);
  }
  if (!unbalanced.length) ok('the balance sheet balances, today and at the last three year ends');
  else fail(`the balance sheet doesn't balance at ${few(unbalanced)}`);

  const balance = async (key: string, to = '9999-12-31') => {
    const [r] = await db<{ t: number }[]>`select coalesce(sum(l.amount_cents), 0)::bigint as t from ledger_totals l join accounts a on a.id = l.account_id where a.system_key = ${key} and l.date <= ${to}::date`;
    return n(r!.t);
  };
  // What the app's own records posted to these accounts: the ledger without the accountant's
  // year-end adjustments, and without journals made by hand (an opening balance, a correction),
  // which have no document behind them. What's left has to agree with the documents to the cent.
  const posted = async (keys: string[]) => {
    const [r] = await db<{ t: number }[]>`select coalesce(sum(l.amount_cents), 0)::bigint as t from ledger_totals l join accounts a on a.id = l.account_id where a.system_key = any(${keys}) and l.source <> 'year_end'`;
    const [j] = await db<{ t: number }[]>`
      select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint as t from journal_lines jl join journals j on j.id = jl.journal_id join accounts a on a.id = jl.account_id
      where a.system_key = any(${keys}) and j.kind = any(${BY_HAND})`;
    return { app: n(r!.t) - n(j!.t), byHand: n(j!.t) };
  };
  const besides = (byHand: number) => (byHand ? `; journals by hand add ${byHand < 0 ? '−' : ''}${rand(byHand)} to the account` : '');
  const suspense = await balance('suspense');
  if (suspense === 0) ok('nothing is waiting in suspense');
  else warn(`${rand(suspense)} is in suspense: money not yet put where it belongs (or a change to an agreed year)`);

  // ---------------------------------------------------------------- control accounts
  section = 'Debtors, creditors, VAT and payroll';
  const [deb] = await db<{ expected: number }[]>`
    select (coalesce(sum(d.total_cents), 0) - coalesce(sum(d.written_off_cents), 0)
            - coalesce((select sum(r.amount_cents) from receipts r join documents i on i.id = r.invoice_id where i.kind = 'invoice' and i.status = 'issued'), 0))::bigint as expected
    from documents d where d.kind = 'invoice' and d.status = 'issued'`;
  const debtors = await posted(['receivables']);
  if (debtors.app === n(deb!.expected)) ok(`the debtors account agrees with the open invoices (${rand(debtors.app)}${besides(debtors.byHand)})`);
  else fail(`the debtors account (${rand(debtors.app)}, not counting journals by hand or year-end adjustments) and the open invoices (${rand(n(deb!.expected))}) differ by ${rand(debtors.app - n(deb!.expected))}`);

  const [cred] = await db<{ owing: number }[]>`
    select coalesce(sum(c.amount_cents - coalesce((select sum(p.amount_cents) from bill_payments p where p.cost_id = c.id), 0)), 0)::bigint as owing
    from costs c join payment_sources s on s.id = c.source_id and s.role = 'bills'`;
  const payables = await posted(['payables']);
  const creditors = -payables.app;
  if (creditors === n(cred!.owing)) ok(`the creditors account agrees with the unpaid bills (${rand(creditors)}${besides(-payables.byHand)})`);
  else fail(`the creditors account (${rand(creditors)}, not counting journals by hand or year-end adjustments) and the unpaid bills (${rand(n(cred!.owing))}) differ by ${rand(creditors - n(cred!.owing))}`);

  // Each VAT period of the last year: the VAT account's movement from documents, costs and assets
  // is exactly what Shap's VAT201 for the period says is payable (or refundable). Both are worked
  // out from the same documents, by different code: a posting that went astray shows here; a
  // return filed with other figures doesn't (Shap doesn't keep what was filed).
  const [anyVat] = await db<{ n: number }[]>`select count(*)::int as n from ledger_totals l join accounts a on a.id = l.account_id where a.system_key = 'vat'`;
  if (settings.vatRegistered || n(anyVat!.n) > 0) {
    const periods = new Map<string, { start: string; end: string }>();
    for (let m = 0; m < 12; m++) {
      const d = new Date(`${on}T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() - m, 1);
      const p = vatPeriod(d.toISOString().slice(0, 10), settings.vatCategory);
      periods.set(p.start, p);
    }
    const off: string[] = [];
    for (const p of periods.values()) {
      const f = await vat201(db, p.start, p.end);
      const [mv] = await db<{ t: number }[]>`
        select coalesce(sum(l.amount_cents), 0)::bigint as t from ledger_totals l join accounts a on a.id = l.account_id
        where a.system_key = 'vat' and l.source in ('invoice', 'credit_note', 'cost', 'asset', 'disposal', 'write_off')
          and l.date between ${p.start}::date and ${p.end}::date`;
      // The VAT account is a liability (credit negative): output VAT less input VAT is its movement, negated.
      if (-n(mv!.t) !== f.field20) off.push(`${p.start} to ${p.end} (VAT201 ${rand(f.field20)}, books ${rand(-n(mv!.t))})`);
    }
    if (!off.length) ok(`the VAT account moved by what Shap's VAT201 shows for each period of the last year (${periods.size} periods)`);
    else fail(`the VAT201 and the VAT account disagree for ${few(off, 3)}`);
  } else ok('not registered for VAT: no VAT201s to check');

  const sars = await db<{ owed: number }[]>`
    select coalesce(sum(l.paye_cents + l.uif_employee_cents + l.uif_employer_cents + l.sdl_cents), 0)::bigint
           - coalesce((select sum(amount_cents) from sars_payments where kind = 'emp201'), 0)::bigint as owed
    from pay_runs r join pay_lines l on l.run_id = r.id where r.status = 'final'`;
  // Pay runs and EMP201 payments post as the app's own journals (payroll, sars): counted.
  const payroll = await posted(['paye_payable', 'uif_payable', 'sdl_payable']);
  const owedSars = -payroll.app;
  if (owedSars === n(sars[0]!.owed)) ok(`PAYE, UIF and SDL owed agree with the pay runs less the EMP201 payments (${rand(owedSars)}${besides(-payroll.byHand)})`);
  else fail(`PAYE, UIF and SDL owed in the books (${rand(owedSars)}, not counting journals by hand or year-end adjustments) and by the pay runs less the EMP201 payments (${rand(n(sars[0]!.owed))}) differ by ${rand(owedSars - n(sars[0]!.owed))}`);

  // ---------------------------------------------------------------- agreed years
  section = 'Agreed years';
  // Shap keeps an agreed year's figures by adjusting each account to them at the year end, so
  // something dated in the year that's added or changed afterwards doesn't move them: it shows as
  // Shap's own figure (without that adjustment) differing from what it was when the year was agreed.
  const years = await db<{ fyEnd: string; agreedAt: string }[]>`select fy_end::text as fy_end, created_at::text as agreed_at from year_ends order by fy_end`;
  if (!years.length) ok('no year agreed with the accountant yet');
  for (const y of years) {
    // The year it was agreed for: the twelve months to its end (as the ledger takes it), even if
    // the year end in Settings has changed since. Each agreed account, and any account opened
    // after the year was agreed (so not among its figures) with something in that year.
    const figures = await db<{ name: string; target: number | null; shap: number | null; now: number; own: number }[]>`
      select a.name, f.amount_cents as target, f.shap_cents as shap,
        coalesce(sum(l.amount_cents), 0)::bigint as now,
        coalesce(sum(l.amount_cents) filter (where not (l.source = 'year_end' and l.date = ${y.fyEnd}::date)), 0)::bigint as own
      from accounts a
      left join year_end_figures f on f.account_id = a.id and f.fy_end = ${y.fyEnd}::date
      left join ledger_totals l on l.account_id = a.id and l.date <= ${y.fyEnd}::date
        and (not (a.type in ('income', 'cost_of_sales', 'expense') or coalesce(a.system_key, '') = 'dividends')
             or l.date >= (date_trunc('month', ${y.fyEnd}::date) - interval '11 months')::date)
      where coalesce(a.system_key, '') not in ('retained_earnings', 'suspense')
        and (f.account_id is not null or a.created_at > ${y.agreedAt}::timestamptz)
      group by a.id, a.code, a.name, f.amount_cents, f.shap_cents
      order by a.code`;
    const moved = figures.filter((m) => m.target != null && n(m.now) !== n(m.target));
    const late = figures.filter((m) => (m.target == null ? n(m.own) !== 0 : m.shap != null && n(m.own) !== n(m.shap)));
    const closed = !!settings.lockDate && String(settings.lockDate).slice(0, 10) >= y.fyEnd;
    if (moved.length) fail(`the year to ${y.fyEnd} no longer shows the figures it was agreed at: ${few(moved.map((c) => `${c.name} (${rand(n(c.now) - n(c.target))})`), 4)}`);
    else if (late.length)
      (closed ? fail : warn)(
        `something dated in the year to ${y.fyEnd} was added or changed after it was agreed${closed ? ', though the year is closed' : ''}: ${few(late.map((c) => `${c.name} (${rand(n(c.own) - n(c.shap))}${c.target == null ? ', an account opened since' : ''})`), 4)}. Shap still shows the agreed figures (it adjusts each agreed account back to them at the year end)${closed ? '' : ': tell your accountant, or date it in the next year'}`,
      );
    else ok(`the year to ${y.fyEnd} still shows the figures it was agreed at, with nothing added or changed in it since`);
  }
  const lastEnd = financialYear(`${Number(fyNow.end.slice(0, 4)) - 1}${fyNow.end.slice(4)}`, settings.fyEndMonth).end;
  const monthsSince = (Date.parse(on) - Date.parse(lastEnd)) / (30.4 * 86_400_000);
  const [lastPosting] = await db<{ d: string | null }[]>`select min(date)::text as d from ledger_totals`;
  if (lastPosting!.d && lastPosting!.d <= lastEnd && monthsSince > 6 && !years.some((y) => y.fyEnd >= lastEnd))
    warn(`the year to ${lastEnd} ended ${Math.floor(monthsSince)} months ago and isn't agreed with your accountant yet (Accounts → Year end)`);
  if (settings.lockDate) ok(`the books are closed up to ${String(settings.lockDate).slice(0, 10)}`);

  // ---------------------------------------------------------------- documents
  section = 'Quotes, invoices and credit notes';
  const wrong = await db<{ kind: string; number: string }[]>`
    select d.kind, d.number from documents d
    left join lateral (select coalesce(sum(line_total_cents), 0)::bigint as lines from document_lines where document_id = d.id) l on true
    where d.subtotal_cents <> l.lines or d.total_cents <> d.subtotal_cents + d.vat_cents
    limit 20`;
  if (!wrong.length) ok('every document adds up: its items to its subtotal, the subtotal and VAT to its total');
  else fail(`${wrong.length === 20 ? '20 or more' : wrong.length} documents don't add up: ${few(wrong.map((w) => `${w.kind.replace('_', ' ')} ${w.number}`))}`);

  const tax = await db<{ number: string; total: number; clientName: string | null; clientAddress: string | null; zero: boolean }[]>`
    select d.number, d.total_cents as total, c.name as client_name, c.address as client_address,
      exists (select 1 from document_lines l where l.document_id = d.id and l.vat_code in ('zero', 'export')) as zero
    from documents d left join clients c on c.id = d.client_id
    where d.kind = 'invoice' and d.status = 'issued' and d.vat_rate_bp > 0`;
  if (tax.length) {
    // (Once deregistered, the VAT number and address shown on new documents no longer matter here.)
    if (settings.vatRegistered && !settings.vatNumber.trim()) fail('tax invoices have been issued, but there is no VAT number in Settings → Company to show on them');
    if (settings.vatRegistered && !settings.address.trim()) warn('tax invoices have been issued, but there is no business address in Settings → Company');
    const short = tax.filter((t) => (Math.abs(n(t.total)) > FULL_TAX_INVOICE_CENTS || t.zero) && (!t.clientName?.trim() || !t.clientAddress?.trim()));
    if (!short.length) ok(`every full tax invoice names the client and their address (${tax.length} tax invoices)`);
    else warn(`${short.length} tax invoices over R5 000 (or with zero-rated items) don't show the client's name and address now: ${few(short.map((s) => s.number))}`);
  }
  const reasonless = await db<{ number: string }[]>`select number from documents where kind = 'credit_note' and status = 'issued' and trim(credit_reason) = ''`;
  if (reasonless.length) warn(`${reasonless.length} issued credit notes don't say why: ${few(reasonless.map((r) => r.number))}`);
  else ok('every issued credit note says why');

  // Numbers that went missing: SARS expects invoices numbered in sequence. Deleting one leaves a
  // gap, which the audit log should explain.
  const numbers = await db<{ number: string }[]>`select number from documents where kind = 'invoice'`;
  const deleted = new Set(
    (await db<{ number: string | null }[]>`select details->>'number' as number from audit_log where action = 'delete' and entity = 'invoice'`).map((d) => d.number).filter(Boolean) as string[],
  );
  const series = new Map<string, { width: number; nums: Set<number> }>();
  for (const { number } of numbers) {
    const m = /^(.*?)(\d+)$/.exec(number);
    if (!m) continue;
    const s = series.get(m[1]!) ?? { width: m[2]!.length, nums: new Set<number>() };
    s.nums.add(Number(m[2]));
    series.set(m[1]!, s);
  }
  const gaps: string[] = [];
  for (const [prefix, s] of series) {
    const sorted = [...s.nums].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++)
      for (let k = sorted[i - 1]! + 1; k < sorted[i]! && gaps.length < 50; k++) {
        const num = `${prefix}${String(k).padStart(s.width, '0')}`;
        if (!deleted.has(num)) gaps.push(num);
      }
  }
  if (!gaps.length) ok('no invoice numbers missing without a deletion in the audit log');
  else warn(`invoice numbers missing, with no deletion in the audit log: ${few(gaps, 8)} (SARS expects invoices numbered in sequence; a deletion before version 1.17 wasn't recorded)`);

  // ---------------------------------------------------------------- costs and payroll
  section = 'Costs and payroll';
  const [slips] = await db<{ n: number; vat: number }[]>`
    select count(*)::int as n, coalesce(sum(vat_cents), 0)::bigint as vat from costs where vat_cents > 0 and receipt_id is null and date >= ${`${Number(on.slice(0, 4)) - 5}${on.slice(4)}`}::date`;
  if (!n(slips!.n)) ok('every cost that claims VAT has its slip attached');
  else warn(`${n(slips!.n)} costs claim ${rand(n(slips!.vat))} VAT without a slip attached: SARS can ask for the supplier's tax invoice for each (keep them five years)`);

  // The rule a cost is saved by (modules/costs.ts): at most the VAT the amount includes at the
  // rate on its date, rounded, and a cent more for a supplier's rounding. (Over 12% of the amount
  // is checked closely: no rate Shap knows puts more than 13.05% in a VAT-inclusive amount.)
  const heavy = await db<{ description: string; date: string; amount: number; vat: number }[]>`
    select description, date::text as date, amount_cents as amount, vat_cents as vat from costs where vat_cents <> 0 and abs(vat_cents) * 100 > abs(amount_cents) * 12`;
  const tooMuch = heavy.filter((c) => Math.abs(n(c.vat)) > vatIncluded(Math.abs(n(c.amount)), vatRateOn(c.date)) + 1);
  if (!tooMuch.length) ok('no cost claims more VAT than its amount can hold');
  else fail(`${tooMuch.length} costs claim more VAT than what was paid includes: ${few(tooMuch.map((t) => t.description))}`);

  const taxYearStart = Number(on.slice(5, 7)) >= 3 ? `${on.slice(0, 4)}-03-01` : `${Number(on.slice(0, 4)) - 1}-03-01`;
  const unnumbered = await db<{ name: string }[]>`
    select distinct e.name from employees e join pay_lines l on l.employee_id = e.id join pay_runs r on r.id = l.run_id
    where r.status = 'final' and r.pay_date >= ${taxYearStart}::date and (trim(e.tax_number) = '' or trim(e.id_number) = '')`;
  if (!unnumbered.length) ok('everyone paid this tax year has an ID (or passport) and tax number for their IRP5');
  else warn(`paid this tax year without an ID or tax number (SARS rejects the EMP501 without them): ${few(unnumbered.map((u) => u.name))}`);

  // ---------------------------------------------------------------- safeguards
  section = 'Safeguards in the database';
  const triggers = new Set((await db<{ name: string }[]>`select tgname as name from pg_trigger where not tgisinternal`).map((t) => t.name));
  if (triggers.has('audit_log_no_update')) ok('the audit log can only be added to, never changed or deleted');
  else fail('the audit log can be changed: its safeguard (audit_log_no_update) is missing');
  if (triggers.has('journal_balanced')) ok('a journal that doesn’t balance is refused');
  else fail('journals that don’t balance can be saved: their safeguard (journal_balanced) is missing');

  return items;
}

/** Counts, for a summary line. */
export const tally = (items: AuditItem[]) => ({
  fails: items.filter((i) => i.level === 'fail').length,
  warns: items.filter((i) => i.level === 'warn').length,
  oks: items.filter((i) => i.level === 'ok').length,
});
