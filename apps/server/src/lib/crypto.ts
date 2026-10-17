import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Small, explicit crypto helpers built on SECRETS_KEY:
 *  - seal/open: AES-256-GCM for secrets stored in the database (two-factor seeds)
 *  - signToken/verifyToken: HMAC-SHA256 signed, expiring tokens that need no database
 *    (two-factor challenges, and sessions on the read-only standby)
 * Each purpose gets its own derived key, so a token can never be confused with ciphertext.
 */
export class Secrets {
  private readonly encKey: Buffer;
  private readonly signKey: Buffer;
  private readonly hashKey: Buffer;

  constructor(master: Buffer) {
    const derive = (info: string) => Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), info, 32));
    this.encKey = derive('shap/encrypt/v1');
    this.signKey = derive('shap/sign/v1');
    this.hashKey = derive('shap/hash/v1');
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), body.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
  }

  open(sealed: string): string {
    const [v, iv, body, tag] = sealed.split('.');
    if (v !== 'v1' || !iv || !body || !tag) throw new Error('Unreadable secret');
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  }

  /** Keyed hash for low-entropy-ish values we only compare (recovery codes). */
  hash(value: string): string {
    return createHmac('sha256', this.hashKey).update(value).digest('hex');
  }

  signToken(purpose: string, payload: Record<string, unknown>, ttlSeconds: number): string {
    const body = Buffer.from(JSON.stringify({ ...payload, p: purpose, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
    const mac = createHmac('sha256', this.signKey).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  verifyToken<T extends Record<string, unknown>>(purpose: string, token: string): T | null {
    const [body, mac] = token.split('.');
    if (!body || !mac) return null;
    const expected = createHmac('sha256', this.signKey).update(body).digest();
    const given = Buffer.from(mac, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let payload: T & { p?: string; exp?: number };
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (payload.p !== purpose || typeof payload.exp !== 'number' || payload.exp < Date.now() / 1000) return null;
    return payload;
  }
}
