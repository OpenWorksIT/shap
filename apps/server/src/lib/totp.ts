import { createHmac, randomBytes, randomInt } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238 / RFC 4226): SHA-1, 6 digits, 30-second steps.
 * Works with any authenticator app (Aegis, FreeOTP, Google/Microsoft Authenticator, 1Password…).
 */
const STEP = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(code).padStart(DIGITS, '0');
}

export const timeStep = (ms = Date.now()) => Math.floor(ms / 1000 / STEP);

/**
 * Check a code against the current step ±1 (clock drift). Returns the matching step so the
 * caller can refuse re-use of the same code, or null if it doesn't match.
 */
export function verifyTotp(secretB32: string, code: string, opts: { now?: number; afterStep?: number | null } = {}): number | null {
  const digits = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const secret = base32Decode(secretB32);
  const current = timeStep(opts.now);
  for (const step of [current - 1, current, current + 1]) {
    if (opts.afterStep != null && step <= opts.afterStep) continue; // already used: replay
    if (hotp(secret, step) === digits) return step;
  }
  return null;
}

export function otpauthUrl(secretB32: string, account: string, issuer = 'Shap'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const q = new URLSearchParams({ secret: secretB32, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP) });
  return `otpauth://totp/${label}?${q.toString()}`;
}

const RC_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** Ten single-use recovery codes like 7KQ2-M9XD, for a lost phone. */
export function newRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => {
    let s = '';
    for (let i = 0; i < 8; i++) s += RC_ALPHABET[randomInt(RC_ALPHABET.length)];
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}

export const normaliseRecoveryCode = (c: string) => c.replace(/[\s-]/g, '').toUpperCase();
