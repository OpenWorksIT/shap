/** Plain calendar dates as YYYY-MM-DD strings, no time zones involved. */

export function todayIso(timeZone = 'Africa/Johannesburg'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export function monthEnd(iso: string): string {
  const [y, m] = iso.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

export function addMonths(iso: string, months: number): string {
  const [y, m, day] = iso.split('-').map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(day, last));
  return first.toISOString().slice(0, 10);
}

/**
 * Financial year containing a date, for a year ending on the last day of `fyEndMonth` (1–12).
 * South African companies often end in February: FY2026 runs 1 Mar 2025 – 28 Feb 2026.
 */
export function financialYear(iso: string, fyEndMonth: number): { start: string; end: string; label: string } {
  const [y, m] = iso.split('-').map(Number) as [number, number];
  const endYear = m > fyEndMonth ? y + 1 : y;
  const end = monthEnd(`${endYear}-${String(fyEndMonth).padStart(2, '0')}-01`);
  const start = addDays(monthEnd(`${endYear - 1}-${String(fyEndMonth).padStart(2, '0')}-01`), 1);
  return { start, end, label: fyEndMonth === 12 ? `${endYear}` : `FY${endYear}` };
}

/** Months (YYYY-MM) from start to end inclusive. */
export function monthsBetween(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  let cur = monthStart(startIso);
  const last = monthStart(endIso);
  while (cur <= last && out.length < 240) {
    out.push(cur.slice(0, 7));
    cur = addMonths(cur, 1);
  }
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function monthLabel(ym: string, withYear = true): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return withYear ? `${MONTHS[m - 1]} ${String(y).slice(2)}` : MONTHS[m - 1]!;
}

export function formatDate(iso: string | null | undefined, style: 'short' | 'long' = 'short'): string {
  if (!iso) return '–';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number) as [number, number, number];
  if (style === 'long') return `${d} ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${y}`;
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/**
 * South Africa's public holidays in a year (Public Holidays Act 36 of 1994): a holiday on a
 * Sunday is also kept on the Monday after. One-off days the President declares (an election day,
 * say) aren't known in advance and aren't here.
 */
export function publicHolidays(year: number): Set<string> {
  // Easter Sunday (the anonymous Gregorian computus).
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  const easter = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const fixed = ['01-01', '03-21', '04-27', '05-01', '06-16', '08-09', '09-24', '12-16', '12-25', '12-26'].map((md) => `${year}-${md}`);
  const out = new Set([...fixed, addDays(easter, -2), addDays(easter, 1)]);
  for (const x of fixed) if (new Date(`${x}T00:00:00Z`).getUTCDay() === 0) out.add(addDays(x, 1));
  return out;
}

/** A weekday that isn't a public holiday. */
export function isBusinessDay(iso: string): boolean {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6 && !publicHolidays(Number(iso.slice(0, 4))).has(iso);
}

/** The date itself if it's a business day, else the last business day before it (SARS's rule for due dates). */
export function businessDayOnOrBefore(iso: string): string {
  let d = iso;
  while (!isBusinessDay(d)) d = addDays(d, -1);
  return d;
}
