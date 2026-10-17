/** All money is stored and transported as integer cents (ZAR). */
export function formatZar(cents: number, opts: { cents?: boolean } = {}): string {
  const showCents = opts.cents ?? true;
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(showCents ? cents : Math.round(cents / 100) * 100));
  const rands = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return showCents ? `${sign}R ${rands}.${String(abs % 100).padStart(2, '0')}` : `${sign}R ${rands}`;
}

/** Accounting style: negatives in brackets, no currency symbol. */
export function formatAmount(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  const s = `${Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${String(abs % 100).padStart(2, '0')}`;
  return cents < 0 ? `(${s})` : s;
}

/** Parse "450", "450.5", "R 1 200,00", "-30" into cents. Returns null when unparseable. */
export function parseZarToCents(input: string): number | null {
  const cleaned = input.trim().replace(/[Rr\s]/g, '').replace(/,(\d{1,2})$/, '.$1').replace(/,/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

/** Cents → "1200.50" for an input box. */
export function centsToInput(cents: number | null | undefined): string {
  if (cents == null) return '';
  const neg = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const part = abs % 100;
  return part ? `${neg}${whole}.${String(part).padStart(2, '0')}` : `${neg}${whole}`;
}

/** Line total for a quantity and unit price, rounded to the cent. */
export function lineTotal(qty: number, unitPriceCents: number): number {
  return Math.round(qty * unitPriceCents);
}

/** VAT on an amount, rate in basis points (1500 = 15%). */
export function vatOn(cents: number, rateBp: number): number {
  return Math.round((cents * rateBp) / 10000);
}

/** VAT contained in a VAT-inclusive amount. */
export function vatIncluded(inclusiveCents: number, rateBp: number): number {
  return Math.round((inclusiveCents * rateBp) / (10000 + rateBp));
}

export function percent(part: number, whole: number): number | null {
  if (!whole) return null;
  return part / whole;
}

export function formatPercent(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return '–';
  return `${(v * 100).toFixed(digits)}%`;
}
