/**
 * The per-account limits and the single-use of two-factor codes must hold when many requests
 * arrive at once — not just one after another. Each guard counts/claims under a per-account lock,
 * so a burst can't all slip past the window check or redeem one code more than once.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { appVersion } from '../src/modules/system.js';
import { base32Decode, hotp, timeStep } from '../src/lib/totp.js';
import { login, setup, type TestEnv } from './helpers.js';

const V = { 'x-shap-version': appVersion() };

describe('auth limits hold under concurrency', () => {
  let env: TestEnv;
  let app: FastifyInstance;
  let owner: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    env = await setup();
    ({ app } = await buildApp({ config: loadConfig({ ...process.env, TRUST_PROXY: 'true' }), sql: env.sql, mailer: { send: async () => {} } }));
    await app.ready();
    owner = await login(env.app, 'owner@example.co.za');
  });
  afterAll(async () => {
    await app.close();
    await env.close();
  });

  // Each request from its own address, so the per-IP @fastify/rate-limit (which the tests would
  // otherwise exhaust) stays out of the way and these tests exercise only the per-account guards.
  const ipHeaders = (ip: string) => ({ ...V, 'x-forwarded-for': ip });
  const enrol = async (email: string, password: string, ip: string) => {
    await owner.post('/api/users', { name: email.split('@')[0], email, role: 'capture', password });
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, headers: ipHeaders(ip) });
    const cookie = r.cookies.find((c) => c.name === 'shap_session')!.value;
    const as = (url: string, payload: unknown = {}) => app.inject({ method: 'POST', url, payload: payload as never, headers: ipHeaders(ip), cookies: { shap_session: cookie } });
    const s = (await as('/api/auth/mfa/setup', { password })).json();
    const e = (await as('/api/auth/mfa/enrol', { challenge: s.challenge, code: hotp(base32Decode(s.secret), timeStep()) })).json();
    return { secret: s.secret as string, recoveryCodes: e.recoveryCodes as string[] };
  };
  const verifyChallenge = async (email: string, password: string, ip: string) => {
    const r = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, headers: ipHeaders(ip) })).json();
    expect(r.mfa).toBe('verify');
    return r.challenge as string;
  };

  it('a burst of wrong passwords for one account can’t all slip past the limit', async () => {
    const email = 'race-pw@example.co.za';
    const password = 'harbor-candle-ferry-6';
    await owner.post('/api/users', { name: 'Race PW', email, role: 'capture', password });
    const tries = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: `wrong-guess-${i}` }, headers: { ...V, 'x-forwarded-for': `100.64.0.${i}` } }),
      ),
    );
    const n401 = tries.filter((r) => r.statusCode === 401).length;
    const n429 = tries.filter((r) => r.statusCode === 429).length;
    // At most the per-account limit (8) are actually checked; the rest are turned away.
    expect(n401).toBeLessThanOrEqual(8);
    expect(n429).toBeGreaterThanOrEqual(1);
    expect(n401 + n429).toBe(24);
    // Even the correct password is refused now.
    const right = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, headers: { ...V, 'x-forwarded-for': '100.64.1.1' } });
    expect(right.statusCode).toBe(429);
  });

  it('one recovery code can’t be redeemed twice by racing requests', async () => {
    const { recoveryCodes } = await enrol('race-rec@example.co.za', 'granite-willow-socket-8', '100.65.0.1');
    const challenge = await verifyChallenge('race-rec@example.co.za', 'granite-willow-socket-8', '100.65.0.2');
    const code = recoveryCodes[0]!;
    const tries = await Promise.all(
      Array.from({ length: 8 }, (_, i) => app.inject({ method: 'POST', url: '/api/auth/mfa/verify', payload: { challenge, code }, headers: ipHeaders(`100.65.1.${i}`) })),
    );
    expect(tries.filter((r) => r.statusCode === 200).length).toBe(1);
  });

  it('one authenticator code can’t be redeemed twice — racing or replayed', async () => {
    // Racing: a burst with one fresh code yields exactly one sign-in.
    const { secret } = await enrol('race-totp@example.co.za', 'copper-meadow-anchor-3', '100.68.0.1');
    // A code for the next step is accepted once (current+1 is inside the window and past the enrol
    // step), then spent.
    const fresh = hotp(base32Decode(secret), timeStep() + 1);
    const challenge = await verifyChallenge('race-totp@example.co.za', 'copper-meadow-anchor-3', '100.68.0.2');
    const racing = await Promise.all(
      Array.from({ length: 8 }, (_, i) => app.inject({ method: 'POST', url: '/api/auth/mfa/verify', payload: { challenge, code: fresh }, headers: ipHeaders(`100.68.1.${i}`) })),
    );
    expect(racing.filter((r) => r.statusCode === 200).length).toBe(1);

    // Replayed: on a fresh account (so the burst's failures don't rate-limit it), a code works
    // once and the same code on a new challenge is then refused as already used.
    const u2 = await enrol('race-totp2@example.co.za', 'copper-meadow-anchor-3', '100.69.0.1');
    const fresh2 = hotp(base32Decode(u2.secret), timeStep() + 1);
    const c1 = await verifyChallenge('race-totp2@example.co.za', 'copper-meadow-anchor-3', '100.69.0.2');
    expect((await app.inject({ method: 'POST', url: '/api/auth/mfa/verify', payload: { challenge: c1, code: fresh2 }, headers: ipHeaders('100.69.0.3') })).statusCode).toBe(200);
    const c2 = await verifyChallenge('race-totp2@example.co.za', 'copper-meadow-anchor-3', '100.69.0.4');
    expect((await app.inject({ method: 'POST', url: '/api/auth/mfa/verify', payload: { challenge: c2, code: fresh2 }, headers: ipHeaders('100.69.0.5') })).statusCode).toBe(401);
  });
});
