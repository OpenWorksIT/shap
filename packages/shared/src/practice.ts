/**
 * Shap Accountant (docs/ACCOUNTANT.md): the returns coming up for a practice's client, worked out
 * from its own settings and Shap's SARS tables, the same way the client's Home works them out.
 * Estimates, for the practice to check against SARS: Shap files nothing, and SARS can move a date.
 *
 * What's here: the VAT201 (vat201Due), the EMP201 (emp201Due), provisional tax (IRP6: the first
 * payment six months into the year, the second on its last business day), turnover tax's two
 * payments on the same days, and the ITR14 (12 months after a company's year end). The CIPC
 * annual return isn't: Shap doesn't keep the date of incorporation.
 */
import { addDays, addMonths, businessDayOnOrBefore, financialYear } from './dates.js';
import { ENTITIES, type BusinessType } from './entities.js';
import { emp201Due } from './payroll.js';
import { lastBusinessDay, vat201Due, vatPeriod, type VatCategory } from './tax.js';

export interface DeadlineInputs {
  businessType: BusinessType;
  vatRegistered: boolean;
  vatCategory: VatCategory;
  fyEndMonth: number;
  turnoverTax: boolean;
  /** Has employees on payroll (an EMP201 each month). */
  employer: boolean;
}

export interface Deadline {
  key: string;
  label: string;
  /** YYYY-MM-DD */
  due: string;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

/** The returns due from `now` to `days` ahead (and those due in the last `days` back, with `past` (Shap can't tell whether they were filed)). */
export function deadlinesFor(c: DeadlineInputs, now: string, days = 45): (Deadline & { past: boolean })[] {
  const until = addDays(now, days);
  const from = addDays(now, -days);
  const out: (Deadline & { past: boolean })[] = [];
  const add = (d: Deadline) => {
    if (d.due >= from && d.due <= until && !out.some((o) => o.key === d.key)) out.push({ ...d, past: d.due < now });
  };
  if (c.vatRegistered) {
    // The period ending this month or next, and the two before it.
    let p = vatPeriod(addMonths(now.slice(0, 8) + '01', 1), c.vatCategory, c.fyEndMonth);
    for (let i = 0; i < 4; i++) {
      const label = p.start.slice(0, 7) === p.end.slice(0, 7) ? monthName(p.end) : `${monthName(p.start)} to ${monthName(p.end)}`;
      add({ key: `vat201-${p.end}`, label: `VAT201 for ${label}`, due: vat201Due(p.end) });
      p = vatPeriod(addMonths(p.start, -1), c.vatCategory, c.fyEndMonth);
    }
  }
  if (c.employer) {
    for (const k of [-2, -1, 0]) {
      const month = addMonths(now.slice(0, 8) + '01', k).slice(0, 7);
      add({ key: `emp201-${month}`, label: `EMP201 for ${monthName(month)}`, due: emp201Due(month) });
    }
  }
  const rules = ENTITIES[c.businessType];
  // A trust's and an individual's year of assessment ends in February, whatever the books' year end.
  const taxYearEndMonth = rules.febYearEnd ? 2 : c.fyEndMonth;
  for (const k of [-12, 0, 12]) {
    const fy = financialYear(addMonths(now, k), taxYearEndMonth);
    const [y1, m1] = addMonths(fy.start, 5).split('-').map(Number) as [number, number];
    const [y2, m2] = fy.end.split('-').map(Number) as [number, number];
    const year = fy.end.slice(0, 4);
    if (c.turnoverTax) {
      add({ key: `tt1-${fy.end}`, label: `First turnover tax payment (year to ${monthName(fy.end)})`, due: lastBusinessDay(y1, m1) });
      add({ key: `tt2-${fy.end}`, label: `Second turnover tax payment (year to ${monthName(fy.end)})`, due: lastBusinessDay(y2, m2) });
    } else if (rules.taxedAs !== 'npc') {
      add({ key: `irp6a-${fy.end}`, label: `First provisional tax payment (IRP6, ${year})`, due: lastBusinessDay(y1, m1) });
      add({ key: `irp6b-${fy.end}`, label: `Second provisional tax payment (IRP6, ${year})`, due: lastBusinessDay(y2, m2) });
    }
    if (rules.taxedAs === 'company') {
      const due = businessDayOnOrBefore(addDays(addMonths(addDays(fy.end, 1), 12), -1));
      add({ key: `itr14-${fy.end}`, label: `ITR14 for the year to ${monthName(fy.end)}`, due });
    }
  }
  return out.sort((a, b) => a.due.localeCompare(b.due) || a.label.localeCompare(b.label));
}
