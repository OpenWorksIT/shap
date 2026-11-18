/**
 * Shap Accountant (docs/ACCOUNTANT.md): some of the returns coming up for a practice's client, worked
 * out from its own settings, the dates the law fixes (in code here) and the filing season's dates SARS
 * sets each year (tax.ts FILING_SEASON_DATES). Aids for the practice to check against SARS: Shap files
 * nothing, SARS can move a date, and this isn't every return (docs/SARS.md lists what is here).
 *
 * What's here:
 * - the VAT201 (vat201Due: eFiling's date; the 25th for those who don't file on eFiling), Category E on
 *   the year of assessment (VAT Act s27(1));
 * - the EMP201 (emp201Due), nil ones included, for an employer registered for PAYE;
 * - provisional tax (IRP6): the first payment six months into the year of assessment, the second on
 *   its last business day, and the voluntary third (top-up) seven months after a February year end,
 *   six after any other; each partner's own for a partnership; none for an approved PBO;
 * - turnover tax's two interim payments (TT02) on the same days, and a company's TT03 at 12 months;
 * - a company's ITR14 at 12 months after its year end (GN 7422 para 4(a)), an approved PBO's IT12EI
 *   on the same day;
 * - dividends tax (DTR01) by the end of the month after a dividend is paid (dwtDue);
 * - the filing season's own dates (ITR12, ITR12T, IT3(t), the EMP501 interim) from the table.
 *
 * Not here: the CIPC annual return (Shap doesn't keep the date of incorporation), the Compensation
 * Fund's return of earnings, an individual's TT03 (SARS's two pages give different dates), and a
 * filing season SARS hasn't announced yet.
 */
import { addDays, addMonths, businessDayOnOrBefore, financialYear } from './dates.js';
import { ENTITIES, type BusinessType } from './entities.js';
import { dwtDue, emp201Due } from './payroll.js';
import { FILING_SEASON_DATES, lastBusinessDay, vat201Due, vat201Label, vatPeriod, type VatCategory } from './tax.js';

/** The practice's people's two ways into a client: writing the books up, or reading them and compiling the statements. */
export const LEVELS = ['books', 'compile'] as const;
export type Level = (typeof LEVELS)[number];
/** What each way in is, as the practice's screens say it. */
export const LEVEL_WORDS: Record<Level, string> = {
  books: 'Writes up the books, as their owner in Shap',
  compile: 'Reads them and compiles the statements, as their accountant in Shap (read only)',
};
/** Who opens it, beside the choice: compiling is signing, in that person's own name. */
export const COMPILE_SIGNS =
  'Given a client either way, someone can open it to compile. Whoever compiles a client’s statements in Shap does it signed in as themselves, and signs the compilation report (for a close corporation, the accounting officer’s report) in their own name. Who in your practice may sign one is your practice’s to decide, under its professional body’s rules.';

export interface DeadlineInputs {
  businessType: BusinessType;
  vatRegistered: boolean;
  vatCategory: VatCategory;
  fyEndMonth: number;
  turnoverTax: boolean;
  /** Registered for PAYE (a PAYE number), or paying people on Shap's payroll: an EMP201 each month, a nil one included. */
  employer: boolean;
  /** An approved public benefit organisation (s30): an IT12EI, and no provisional tax. */
  approvedPbo?: boolean;
  /** The days dividends were paid, lately (a DTR01 each month one was). */
  dividendsPaid?: string[];
}

export interface Deadline {
  key: string;
  label: string;
  /** YYYY-MM-DD */
  due: string;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const lastDayOf = (ym: string) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return lastBusinessDay(y, m);
};

/**
 * The returns due from `now` to `days` ahead, and those due in the last `days` back, with `past`
 * (Shap can't tell whether they were filed). Worked out again whenever they're shown, so a date
 * moves from coming up to past by itself.
 */
export function deadlinesFor(c: DeadlineInputs, now: string, days = 45): (Deadline & { past: boolean })[] {
  const until = addDays(now, days);
  const from = addDays(now, -days);
  const out: (Deadline & { past: boolean })[] = [];
  const add = (d: Deadline) => {
    if (d.due >= from && d.due <= until && !out.some((o) => o.key === d.key)) out.push({ ...d, past: d.due < now });
  };
  const rules = ENTITIES[c.businessType];
  // A trust's and an individual's year of assessment ends in February, whatever the books' year end.
  const taxYearEndMonth = rules.febYearEnd ? 2 : c.fyEndMonth;
  const partners = rules.taxedAs === 'partners';
  const pbo = rules.taxedAs === 'npc' && Boolean(c.approvedPbo);
  // An NPC that isn't an approved PBO is taxed as a company.
  const company = rules.taxedAs === 'company' || (rules.taxedAs === 'npc' && !pbo);

  if (c.vatRegistered) {
    // Every period whose return falls in the window: from the one ending after it, back.
    let p = vatPeriod(addMonths(until.slice(0, 8) + '01', 1), c.vatCategory, taxYearEndMonth);
    for (let i = 0; i < 40 && vat201Due(p.end) >= from; i++) {
      add({ key: `vat201-${p.end}`, label: `${vat201Label(p)} (on eFiling; by the 25th otherwise)`, due: vat201Due(p.end) });
      p = vatPeriod(addMonths(p.start, -1), c.vatCategory, taxYearEndMonth);
    }
  }
  if (c.employer) {
    for (let month = addMonths(from.slice(0, 8) + '01', -1).slice(0, 7); month <= until.slice(0, 7); month = addMonths(`${month}-01`, 1).slice(0, 7))
      add({ key: `emp201-${month}`, label: `EMP201 for ${monthName(month)}`, due: emp201Due(month) });
  }
  for (const k of [-24, -12, 0, 12]) {
    const fy = financialYear(addMonths(now, k), taxYearEndMonth);
    const year = `year to ${monthName(fy.end)}`;
    const sixth = lastDayOf(addMonths(fy.start, 5));
    const last = lastDayOf(fy.end);
    const twelve = businessDayOnOrBefore(addDays(addMonths(addDays(fy.end, 1), 12), -1));
    const whose = partners ? 'Each partner’s ' : '';
    const first = partners ? 'first' : 'First';
    const second = partners ? 'second' : 'Second';
    if (c.turnoverTax) {
      add({ key: `tt1-${fy.end}`, label: `${whose}${first} turnover tax payment (TT02, ${year})`, due: sixth });
      add({ key: `tt2-${fy.end}`, label: `${whose}${second} turnover tax payment (TT02, ${year})`, due: last });
      if (company) add({ key: `tt03-${fy.end}`, label: `Turnover tax return (TT03, ${year})`, due: twelve });
    } else if (!pbo) {
      add({ key: `irp6a-${fy.end}`, label: `${whose}${first} provisional tax payment (IRP6, ${year})`, due: sixth });
      add({ key: `irp6b-${fy.end}`, label: `${whose}${second} provisional tax payment (IRP6, ${year})`, due: last });
      const third = lastDayOf(addMonths(fy.end, taxYearEndMonth === 2 ? 7 : 6));
      add({ key: `irp6c-${fy.end}`, label: `${whose}${partners ? 'third' : 'Third'} provisional tax payment, only if a top-up is needed (IRP6, ${year})`, due: third });
      if (company) add({ key: `itr14-${fy.end}`, label: `ITR14 for the ${year}`, due: twelve });
    }
    if (pbo) add({ key: `it12ei-${fy.end}`, label: `IT12EI for the ${year}`, due: twelve });
  }
  if (company || pbo) {
    for (const paid of c.dividendsPaid ?? []) add({ key: `dtr01-${paid.slice(0, 7)}`, label: `Dividends tax return (DTR01) for dividends paid in ${monthName(paid.slice(0, 7))}`, due: dwtDue(paid) });
  }
  for (const d of FILING_SEASON_DATES) {
    const theirs =
      (d.who === 'individual' && rules.taxedAs === 'individual' && !c.turnoverTax) ||
      (d.who === 'partners' && partners && !c.turnoverTax) ||
      (d.who === 'trust' && rules.taxedAs === 'trust') ||
      (d.who === 'employer' && c.employer);
    if (theirs) add({ key: d.key, label: d.label, due: d.due });
  }
  return out.sort((a, b) => a.due.localeCompare(b.due) || a.label.localeCompare(b.label));
}
