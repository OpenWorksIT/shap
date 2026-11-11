/**
 * A small seeded random number generator for the test server's made-up books (docs/TEST_SERVER.md):
 * the same seed gives the same numbers every time, so the same setup gives the same books.
 */

/** A 32-bit hash of a string (FNV-1a). */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface Rng {
  /** 0 ≤ n < 1. */
  next(): number;
  /** A whole number from min to max, both included. */
  int(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  pick<T>(list: readonly T[]): T;
  /** Spread around n by up to ±pct (0.1 = 10%), rounded to `to` (cents: 100 for whole rands). */
  around(n: number, pct: number, to?: number): number;
}

/** mulberry32: small, fast and good enough for made-up books. */
export function rng(seed: string): Rng {
  let a = hash(seed);
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    chance: (p) => next() < p,
    pick: <T,>(list: readonly T[]) => list[Math.floor(next() * list.length)]!,
    around: (n, pct, to = 1) => Math.max(to, Math.round((n * (1 + (next() * 2 - 1) * pct)) / to) * to),
  };
}

/** The Luhn check digit for a string of digits (SA ID, income tax and VAT numbers use it). */
export function luhnDigit(digits: string): string {
  let sum = 0;
  // Doubling every second digit from the right, counting the check digit still to come.
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
}

/** A made-up number of `length` digits starting with `prefix`, with a Luhn check digit. */
export function luhnNumber(r: Rng, prefix: string, length: number): string {
  let s = prefix;
  while (s.length < length - 1) s += String(r.int(0, 9));
  return s + luhnDigit(s);
}

/** A made-up South African ID number: a date of birth, a sequence, citizen, and the check digit. */
export function idNumber(r: Rng, born: string): string {
  const base = `${born.slice(2, 4)}${born.slice(5, 7)}${born.slice(8, 10)}${String(r.int(0, 9999)).padStart(4, '0')}08`;
  return base + luhnDigit(base);
}
