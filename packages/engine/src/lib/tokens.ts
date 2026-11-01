import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** 256-bit random token, URL safe. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// No 0/O, 1/I/L — easy to read out over the phone.
const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newReference(length = 6): string {
  let out = '';
  for (let i = 0; i < length; i++) out += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return out;
}
