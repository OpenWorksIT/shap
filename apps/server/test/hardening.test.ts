/** November 2026 security review: request floods, sign-in checks, files, consent. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appVersion } from '../src/modules/system.js';
import { base32Decode, hotp, timeStep } from '../src/lib/totp.js';
import { oversized } from '../src/lib/validate.js';
import { login, setup, type TestEnv } from './helpers.js';

const V = { 'x-shap-version': appVersion() };

describe('hardening', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  let site: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
    site = await login(env.app, 'site@example.co.za');
  });
  afterAll(() => env.close());

  it('refuses a huge list at once instead of checking every item', async () => {
    const trail = new Array(500_000).fill(0);
    const t = Date.now();
    const r = await site.call({ method: 'POST', url: '/api/feedback', payload: { kind: 'idea', message: 'x', trail } });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('too_many_items');
    expect(Date.now() - t).toBeLessThan(2000);
    expect(r.body.length).toBeLessThan(1000);
    // A list a bit too long for its own limit: a handful of problems, not one per item.
    const r2 = await site.call({ method: 'POST', url: '/api/feedback', payload: { kind: 'idea', message: 'x', trail: new Array(15_000).fill(0) } });
    expect(r2.statusCode).toBe(400);
    expect(Object.keys(r2.json().details?.fields ?? {}).length).toBeLessThanOrEqual(20);
    expect(oversized({ a: [[[1]]] })).toBe(false);
    let deep: unknown = 1;
    for (let i = 0; i < 60; i++) deep = [deep];
    expect(oversized(deep)).toBe(true);
  });

  it('turns away a change from someone not signed in before reading its body', async () => {
    const r = await env.app.inject({ method: 'POST', url: '/api/costs', payload: { description: 'x'.repeat(2_000_000) }, headers: V });
    expect(r.statusCode).toBe(401);
    // A made-up session is no better.
    const r2 = await env.app.inject({ method: 'POST', url: '/api/costs', payload: {}, headers: V, cookies: { shap_session: 'not-a-session' } });
    expect(r2.statusCode).toBe(401);
    // Signing in still works.
    expect((await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.co.za', password: 'test-password-1' }, headers: V })).statusCode).toBe(200);
  });

  it('only lets a Bearer token skip the version check', async () => {
    const [{ cookie }] = [{ cookie: (await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.co.za', password: 'test-password-1' }, headers: V })).cookies.find((c) => c.name === 'shap_session')!.value }];
    const r = await env.app.inject({ method: 'POST', url: '/api/clients', payload: { name: 'Via Basic' }, headers: { authorization: 'Basic dXNlcjpwYXNz' }, cookies: { shap_session: cookie } });
    expect(r.statusCode).toBe(409);
  });

  it('leaves sharing market rates as it was when a save doesn’t mention it', async () => {
    const { settings } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...settings, marketConsent: false }, 'PUT');
    const { marketConsent: _m, ...without } = (await owner.get('/api/reference')).settings;
    await owner.post('/api/settings', without, 'PUT');
    expect((await owner.get('/api/reference')).settings.marketConsent).toBe(false);
  });

  it('never serves a stored file of another kind as a page', async () => {
    const att = await owner.post('/api/attachments', { filename: 'slip.png', mime: 'image/png', dataBase64: Buffer.from('89504e470d0a1a0a0000', 'hex').toString('base64') });
    await env.sql`update attachments set mime = 'text/html', bytes = ${Buffer.from('<script>alert(1)</script>')} where id = ${att.id}`;
    const r = await owner.call({ method: 'GET', url: `/api/attachments/${att.id}` });
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['content-disposition']).toMatch(/^attachment;/);
  });

  it('takes the password and a fresh code to make new recovery codes', async () => {
    const pw = 'stone-orchid-kettle-4';
    await owner.post('/api/users', { name: 'Lerato', email: 'lerato@example.co.za', password: pw, role: 'accountant' });
    const r = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'lerato@example.co.za', password: pw }, headers: V });
    const cookie = r.cookies.find((c) => c.name === 'shap_session')!.value;
    const as = (url: string, payload: unknown = {}) => env.app.inject({ method: 'POST', url, payload: payload as never, headers: V, cookies: { shap_session: cookie } });
    const s = (await as('/api/auth/mfa/setup', { password: pw })).json();
    const code = (now = Date.now()) => hotp(base32Decode(s.secret), timeStep(now));
    expect((await as('/api/auth/mfa/enrol', { challenge: s.challenge, code: code() })).statusCode).toBe(200);
    // The code used to switch it on can't be used again, and no password means no codes.
    expect((await as('/api/auth/mfa/recovery-codes', { code: code(Date.now() + 30_000) })).statusCode).toBe(400);
    expect((await as('/api/auth/mfa/recovery-codes', { code: code(), password: pw })).statusCode).toBe(400);
    const ok = await as('/api/auth/mfa/recovery-codes', { code: code(Date.now() + 30_000), password: pw });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().recoveryCodes).toHaveLength(10);
    // And the same code again is refused.
    expect((await as('/api/auth/mfa/recovery-codes', { code: code(Date.now() + 30_000), password: pw })).statusCode).toBe(400);
    // Wrong codes count: after six, even a right one waits.
    for (let i = 0; i < 6; i++) await as('/api/auth/mfa/recovery-codes', { code: String(100000 + i), password: pw });
    expect((await as('/api/auth/mfa/recovery-codes', { code: code(Date.now() + 60_000), password: pw })).statusCode).toBe(429);
  });
});
