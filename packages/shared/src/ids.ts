/**
 * South African reference numbers: what each one looks like, so a typo is caught where it's
 * typed instead of on a tax invoice or at SARS. A number that passes is well formed, not proof
 * that SARS or CIPC issued it.
 *
 * Formats and the modulus-10 check: SARS's tax numbers (income tax, VAT, PAYE/SDL/UIF), see
 * https://lookuptax.com/docs/tax-identification-number/south-africa-tax-id-guide
 * CIPC registration numbers (YYYY/NNNNNN/NN, the last two digits the kind of entity):
 * https://tradeshield-help.freshdesk.com/support/solutions/articles/153000256853-cipc-company-codes-types-status-the-complete-guide
 */

/** Spaces and dashes people type between groups of digits. */
export const compact = (v: string) => String(v ?? '').replace(/[\s-]+/g, '').toUpperCase();

/** The modulus-10 (Luhn) check SARS uses on its 10-digit numbers. */
export function luhnOk(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** A VAT registration number: 10 digits starting with 4. */
export function vatNumberProblem(v: string): string | null {
  const s = compact(v);
  if (!s) return null;
  if (!/^\d{10}$/.test(s)) return 'A VAT number is 10 digits (it starts with 4)';
  if (s[0] !== '4') return 'A VAT number starts with 4';
  if (!luhnOk(s)) return 'That VAT number doesn’t add up: check the digits against your VAT registration letter';
  return null;
}

/**
 * A client's VAT number: a South African one (checked as above), or a client abroad's, which
 * starts with their country code (GB123456789, DE123456789) and isn't checked further.
 */
export function clientVatNumberProblem(v: string): string | null {
  const s = compact(v);
  if (!s) return null;
  if (/^[A-Z]{2}[A-Z0-9]{2,13}$/.test(s)) return null;
  if (/^\d{10}$/.test(s)) return vatNumberProblem(s);
  return 'A South African VAT number is 10 digits starting with 4. For a client abroad, start with their country code (for example GB123456789)';
}

/** An income tax reference number: 10 digits starting with 0, 1, 2, 3 or 9. */
export function taxNumberProblem(v: string): string | null {
  const s = compact(v);
  if (!s) return null;
  if (!/^\d{10}$/.test(s)) return 'An income tax number is 10 digits';
  if (!/^[01239]/.test(s)) return 'An income tax number starts with 0, 1, 2, 3 or 9';
  if (!luhnOk(s)) return 'That income tax number doesn’t add up: check the digits';
  return null;
}

/** The employer's PAYE reference: 10 digits starting with 7 (SDL is the same with L, UIF at SARS with U). */
export function payeRefProblem(v: string): string | null {
  const s = compact(v);
  if (!s) return null;
  if (!/^7\d{9}$/.test(s)) return 'A PAYE reference is 10 digits starting with 7';
  // SARS checks it like a tax number with the leading 7 read as 4.
  if (!luhnOk(`4${s.slice(1)}`)) return 'That PAYE reference doesn’t add up: check the digits on your EMP201';
  return null;
}

/** SDL and UIF (at SARS) references are the PAYE reference with L or U in front of the same nine digits. */
export const sdlRefFor = (paye: string) => (compact(paye) ? `L${compact(paye).slice(1)}` : '');
export const uifSarsRefFor = (paye: string) => (compact(paye) ? `U${compact(paye).slice(1)}` : '');

/** The UIF employer reference from the Department of Employment and Labour: 1234567/8 (older ones 123456/7). */
export function uifRefProblem(v: string): string | null {
  const s = String(v ?? '').replace(/\s+/g, '');
  if (!s) return null;
  if (/^U\d{9}$/i.test(s)) return null; // the SARS U-number, also accepted
  if (!/^\d{6,7}\/\d$/.test(s)) return 'A UIF reference looks like 1234567/8 (from the Department of Employment and Labour), or U and nine digits';
  if (/^0+\/0$/.test(s)) return 'That UIF reference is all zeros';
  return null;
}

/**
 * The entity codes a registration number may end in, for each kind of business (CIPC):
 * 06 public, 07 private, 08 non-profit, 21 Inc., 23 CC, 24–26 co-operatives.
 */
const REG_CODES: Partial<Record<string, string[]>> = {
  company: ['07', '06'],
  inc: ['21'],
  cc: ['23'],
  npc: ['08'],
  coop: ['24', '25', '26'],
};
const REG_WHAT: Record<string, string> = { '06': 'a public company', '07': 'a (Pty) Ltd', '08': 'a non-profit company', '21': 'an Inc. company', '23': 'a close corporation', '24': 'a primary co-operative', '25': 'a secondary co-operative', '26': 'a tertiary co-operative' };

/** Tidies a registration number as typed (2024 733128 07 → 2024/733128/07). */
export function tidyRegNumber(v: string): string {
  // Spaces around each slash dropped by splitting (a regex like /\s*\/\s*/ backtracks on a long run of spaces).
  const s = String(v ?? '').trim().toUpperCase().split('/').map((part) => part.trim()).join('/');
  const bare = s.replace(/^CK\s*/, '');
  const m = /^(\d{4})[\s/-]?(\d{6})[\s/-]?(\d{2})$/.exec(bare);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : s;
}

/**
 * A company registration number (YYYY/NNNNNN/NN), ending in the code for this kind of business.
 * A trust's Master's reference (IT 1234/2015) for trusts. Others (sole proprietor, partnership)
 * have none.
 */
export function regNumberProblem(v: string, businessType: string, thisYear = new Date().getFullYear()): string | null {
  const raw = String(v ?? '').trim();
  if (!raw) return null;
  if (businessType === 'trust') {
    return /^IT\s?\d{1,6}\/\d{4}(\s?\(?[A-Z]{1,3}\)?)?$/i.test(raw) ? null : 'A trust’s Master’s reference looks like IT 1234/2015';
  }
  const codes = REG_CODES[businessType];
  if (!codes) return null;
  const s = tidyRegNumber(raw);
  const m = /^(\d{4})\/(\d{6})\/(\d{2})$/.exec(s);
  if (!m) return 'A company registration number looks like 2024/123456/07 (year / six digits / type)';
  const year = Number(m[1]);
  if (year < 1900 || year > thisYear) return `The first part is the year it was registered (1900 to ${thisYear})`;
  if (!codes.includes(m[3]!)) return `A registration number for ${REG_WHAT[codes[0]!]} ends in /${codes.join(' or /')} (this one ends in /${m[3]}${REG_WHAT[m[3]!] ? `, ${REG_WHAT[m[3]!]}` : ''})`;
  return null;
}

/** A South African ID number: 13 digits, a real date of birth, and the check digit. */
export function idNumberProblem(v: string): string | null {
  const s = compact(v);
  if (!s) return null;
  if (!/^\d+$/.test(s)) return /^[A-Z0-9]{6,20}$/.test(s) ? null : 'Use the 13-digit ID number, or a passport number (letters and digits)';
  // A passport number can be digits only (SARS takes any of 6 or more characters); one of 11 to
  // 14 digits is far more likely an ID number with a digit missing or extra.
  if (s.length >= 6 && s.length <= 10) return null;
  if (s.length !== 13) return s.length < 6 ? 'Use the 13-digit ID number, or a passport number (6 or more characters)' : 'A South African ID number is 13 digits';
  const mm = Number(s.slice(2, 4));
  const dd = Number(s.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return 'The first six digits of an ID number are the date of birth (YYMMDD)';
  if (!luhnOk(s)) return 'That ID number doesn’t add up: check the digits';
  return null;
}

/** For storing: digits only where the number is all digits; registration numbers tidied. */
export const tidyTaxNumber = (v: string) => compact(v);

type NumberFields = { vatRegistered: boolean; vatNumber: string; regNumber: string; businessType: string; taxNumber?: string; payeRef?: string; uifRef?: string };

/** The business's own numbers, tidied for storing. */
export function tidyNumbers<T extends NumberFields>(s: T): T {
  return { ...s, vatNumber: compact(s.vatNumber), regNumber: tidyRegNumber(s.regNumber), taxNumber: compact(s.taxNumber ?? ''), payeRef: compact(s.payeRef ?? ''), uifRef: String(s.uifRef ?? '').replace(/\s+/g, '').toUpperCase() };
}

/**
 * What's wrong with the business's own numbers, if anything. Only what changed is checked
 * (numbers saved before these checks existed don't block other changes), and switching VAT on
 * needs a VAT number.
 */
export function settingsNumberProblem(s: NumberFields, before?: Partial<NumberFields> | null): { field: keyof NumberFields; message: string } | null {
  const t = tidyNumbers(s);
  const b = before ? tidyNumbers({ vatRegistered: false, vatNumber: '', regNumber: '', businessType: s.businessType, ...before } as NumberFields) : null;
  const changed = (k: keyof NumberFields) => !b || t[k] !== b[k] || (k === 'regNumber' && s.businessType !== b.businessType);
  // (Books registered for VAT before this check, with no number, aren't stopped from saving anything else.)
  if (t.vatRegistered && !t.vatNumber && (!b || !b.vatRegistered || b.vatNumber)) return { field: 'vatNumber', message: 'Add your VAT number: it’s on every tax invoice, so Shap can’t charge VAT without it' };
  if (t.vatNumber && (changed('vatNumber') || (t.vatRegistered && !b?.vatRegistered))) {
    const p = vatNumberProblem(t.vatNumber);
    if (p) return { field: 'vatNumber', message: p };
  }
  if (t.regNumber && changed('regNumber')) {
    const p = regNumberProblem(t.regNumber, s.businessType);
    if (p) return { field: 'regNumber', message: p };
  }
  if (t.taxNumber && changed('taxNumber')) {
    const p = taxNumberProblem(t.taxNumber);
    if (p) return { field: 'taxNumber', message: `Income tax number: ${p.charAt(0).toLowerCase()}${p.slice(1)}` };
  }
  if (t.payeRef && changed('payeRef')) {
    const p = payeRefProblem(t.payeRef);
    if (p) return { field: 'payeRef', message: p };
  }
  if (t.uifRef && changed('uifRef')) {
    const p = uifRefProblem(t.uifRef);
    if (p) return { field: 'uifRef', message: p };
  }
  return null;
}
