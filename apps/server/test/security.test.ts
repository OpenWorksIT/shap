/**
 * Break-in attempts, kept as tests so they're tried again on every change:
 * guessing passwords and codes, using a stolen session, cross-site requests, files that aren't
 * what they say, spreadsheet formulas, what site staff can see, and every route's door.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { appVersion } from '../src/modules/system.js';
import { base32Decode, hotp, timeStep } from '../src/lib/totp.js';
import { login, ref, setup, type TestEnv } from './helpers.js';

const V = { 'x-shap-version': appVersion() };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('breaking in', () => {
  let env: TestEnv;
  let app: FastifyInstance;
  let owner: Awaited<ReturnType<typeof login>>;
  const signIn = (email: string, password: string, ip: string) =>
    app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, headers: { ...V, 'x-forwarded-for': ip } });

  beforeAll(async () => {
    env = await setup();
    // As on the server: behind Caddy, trusting the forwarded address.
    ({ app } = await buildApp({ config: loadConfig({ ...process.env, TRUST_PROXY: 'true' }), sql: env.sql, mailer: { send: async () => {} } }));
    await app.ready();
    owner = await login(env.app, 'owner@example.co.za');
    await owner.post('/api/users', { name: 'Thandi Mokoena', email: 'thandi@example.co.za', role: 'owner', password: 'river-canvas-lamp-9' });
    await owner.post('/api/users', { name: 'Pieter Botha', email: 'pieter@example.co.za', role: 'owner', password: 'stone-orchid-kettle-4' });
  });
  afterAll(async () => {
    await app.close();
    await env.close();
  });

  it('stops password guessing at an account, even from many addresses', async () => {
    for (let i = 0; i < 8; i++) expect((await signIn('thandi@example.co.za', `guess-${i}-xx`, `198.51.100.${i}`)).statusCode).toBe(401);
    // The ninth try is refused, even with the right password, from a new address.
    const r = await signIn('thandi@example.co.za', 'river-canvas-lamp-9', '203.0.113.77');
    expect(r.statusCode).toBe(429);
    // An email that doesn't exist behaves exactly the same (no telling who has an account).
    for (let i = 0; i < 8; i++) expect((await signIn('nobody@example.co.za', `guess-${i}-xx`, `192.0.2.${i}`)).statusCode).toBe(401);
    expect((await signIn('nobody@example.co.za', 'anything-at-all', '192.0.2.200')).statusCode).toBe(429);
    // Other accounts are unaffected.
    expect((await signIn('pieter@example.co.za', 'stone-orchid-kettle-4', '203.0.113.78')).statusCode).toBe(200);
  });

  it('stops guessing two-factor codes, and a stolen session can’t move them to another phone', async () => {
    const pieter = await login(env.app, 'pieter@example.co.za').catch(() => null);
    // (login() uses the test password; sign Pieter in by hand.)
    void pieter;
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'pieter@example.co.za', password: 'stone-orchid-kettle-4' }, headers: { ...V, 'x-forwarded-for': '203.0.113.79' } });
    const cookie = r.cookies.find((c) => c.name === 'shap_session')!.value;
    const as = (url: string, payload: unknown = {}) => app.inject({ method: 'POST', url, payload: payload as never, headers: V, cookies: { shap_session: cookie } });
    const setupRes = (await as('/api/auth/mfa/setup')).json();
    const code = (now = Date.now()) => hotp(base32Decode(setupRes.secret), timeStep(now));
    expect((await as('/api/auth/mfa/enrol', { challenge: setupRes.challenge, code: code() })).statusCode).toBe(200);
    // Moving two-factor to a new phone needs the password: a stolen session alone can't.
    expect((await as('/api/auth/mfa/setup')).statusCode).toBe(400);
    expect((await as('/api/auth/mfa/setup', { password: 'stone-orchid-kettle-4' })).statusCode).toBe(200);
    // Signing in again: six wrong codes, then even the right one is refused for a while.
    const start = (await signIn('pieter@example.co.za', 'stone-orchid-kettle-4', '203.0.113.80')).json();
    expect(start.mfa).toBe('verify');
    for (let i = 0; i < 6; i++) {
      const bad = await app.inject({ method: 'POST', url: '/api/auth/mfa/verify', payload: { challenge: start.challenge, code: String(100000 + i) }, headers: { ...V, 'x-forwarded-for': `198.18.0.${i}` } });
      expect(bad.statusCode).toBe(401);
    }
    const right = await app.inject({ method: 'POST', url: '/api/auth/mfa/verify', payload: { challenge: start.challenge, code: code(Date.now() + 30_000) }, headers: { ...V, 'x-forwarded-for': '198.18.0.99' } });
    expect(right.statusCode).toBe(429);
  });

  it('a stolen session can’t lock the owner out by changing their email or password', async () => {
    const [me] = await env.sql<{ id: string }[]>`select id from users where email = 'owner@example.co.za'`;
    const takeover = await owner.call({ method: 'PUT', url: `/api/users/${me!.id}`, payload: { name: 'Owner', email: 'attacker@evil.example', role: 'owner', password: 'attacker-pass-123' } });
    expect(takeover.statusCode).toBe(400);
    expect(takeover.json().error).toMatch(/password/i);
    const [still] = await env.sql<{ email: string }[]>`select email from users where id = ${me!.id}`;
    expect(still!.email).toBe('owner@example.co.za');
    // Changing your own password: current one first, a decent new one; you stay signed in, other devices don't.
    const other = await login(env.app, 'owner@example.co.za');
    expect((await owner.call({ method: 'POST', url: '/api/auth/password', payload: { currentPassword: 'wrong-password-1', newPassword: 'meadow-violin-tractor-2' } })).statusCode).toBe(400);
    expect((await owner.call({ method: 'POST', url: '/api/auth/password', payload: { currentPassword: 'test-password-1', newPassword: 'password123' } })).json().error).toMatch(/first passwords anyone would guess/);
    expect((await owner.call({ method: 'POST', url: '/api/auth/password', payload: { currentPassword: 'test-password-1', newPassword: 'meadow-violin-tractor-2' } })).statusCode).toBe(200);
    expect((await owner.call({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(200);
    expect((await other.call({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
    // Put it back for the other tests.
    await owner.post('/api/auth/password', { currentPassword: 'meadow-violin-tractor-2', newPassword: 'test-password-1' });
  });

  it('won’t take an obvious password for anyone', async () => {
    for (const pw of ['password1234', 'qwertyuiop', 'aaaaaaaaaaaa', 'thandi12345', 'springboks']) {
      const r = await owner.call({ method: 'POST', url: '/api/users', payload: { name: 'Thandi Two', email: 'thandi2@example.co.za', role: 'capture', password: pw } });
      expect(r.statusCode, pw).toBe(400);
    }
  });

  it('refuses changes another website tries to make with your session', async () => {
    const [session] = (await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'site@example.co.za', password: 'test-password-1' }, headers: V })).cookies.filter((c) => c.name === 'shap_session');
    // A form or script elsewhere can't add Shap's header: refused.
    const forged = await env.app.inject({ method: 'POST', url: '/api/costs', payload: { description: 'x' }, cookies: { shap_session: session!.value } });
    expect(forged.statusCode).toBe(409);
    const login = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'x@y.z', password: 'p' } });
    expect(login.statusCode).toBe(409);
    // A plain-text "form" body isn't read at all.
    const text = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: '{"email":"x@y.z","password":"p"}', headers: { ...V, 'content-type': 'text/plain' } });
    expect(text.statusCode).toBe(415);
  });

  it('takes only real photos and PDFs', async () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
    const r = await owner.call({ method: 'POST', url: '/api/attachments', payload: { filename: 'slip.png', mime: 'image/png', dataBase64: html } });
    expect(r.statusCode).toBe(400);
    expect((await owner.call({ method: 'POST', url: '/api/attachments', payload: { filename: 'slip.png', mime: 'image/png', dataBase64: PNG } })).statusCode).toBe(200);
  });

  it('keeps formulas out of spreadsheet exports', async () => {
    const parts = await ref(env.sql).then((r) => r.cat('Parts'));
    await owner.post('/api/costs', { date: '2026-10-01', description: '=HYPERLINK("http://evil.example","Click")', amountCents: -500, supplier: '@SUM(A1)', categoryId: parts, sourceId: null });
    const csv = (await owner.call({ method: 'GET', url: '/api/export/costs?from=2026-10-01&to=2026-10-31' })).body;
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"",""Click"")"`);
    expect(csv).toContain(`'@SUM(A1)`);
    expect(csv).toMatch(/,-5\.00/);
  });

  it('shows site staff the job and their own slips, not the money', async () => {
    const site = await login(env.app, 'site@example.co.za');
    const client = await owner.post('/api/clients', { name: 'Quoted Client' });
    const job = await owner.post('/api/projects', { name: 'Big roof', clientId: client.id, estLabourCents: 9_000_000 });
    const seen = await site.get(`/api/projects/${job.id}`);
    expect(seen.project.name).toBe('Big roof');
    expect(seen.project.estLabourCents).toBeUndefined();
    await owner.post('/api/brands', { name: 'Beta', bankDetails: 'Acc 123 456' });
    const refData = await site.get('/api/reference');
    expect(JSON.stringify(refData)).not.toContain('Acc 123 456');
    const slip = await owner.post('/api/attachments', { filename: 's.png', mime: 'image/png', dataBase64: PNG });
    const parts = await ref(env.sql).then((r) => r.cat('Parts'));
    const ownerCost = await owner.post('/api/costs', { date: '2026-10-02', description: 'Owner slip', amountCents: 1000, supplier: 'X', categoryId: parts, sourceId: null, receiptId: slip.id });
    expect((await site.call({ method: 'GET', url: `/api/costs/${ownerCost.id}` })).statusCode).toBe(404);
    expect((await site.call({ method: 'GET', url: `/api/attachments/${slip.id}` })).statusCode).toBe(404);
    const mySlip = await site.post('/api/attachments', { filename: 'm.png', mime: 'image/png', dataBase64: PNG });
    const mine = await site.post('/api/costs', { date: '2026-10-02', description: 'Site slip', amountCents: 1000, supplier: 'X', categoryId: parts, sourceId: null, receiptId: mySlip.id });
    expect((await site.call({ method: 'GET', url: `/api/costs/${mine.id}` })).statusCode).toBe(200);
    expect((await site.call({ method: 'GET', url: `/api/attachments/${mySlip.id}` })).statusCode).toBe(200);
  });

  it('every route: signed out gets nowhere; the accountant changes nothing; site staff only log', async () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith('.ts') ? [join(dir, f)] : []));
    const routes = new Set<string>();
    for (const f of files(join(__dirname, '../src'))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/app\.(get|post|put|delete|patch)\('(\/api\/[^']+)'/g)) routes.add(`${m[1]!.toUpperCase()} ${m[2]}`);
    }
    const open = new Set(['GET /api/health', 'GET /api/demo/status', 'POST /api/auth/login', 'POST /api/auth/mfa/verify', 'POST /api/auth/mfa/enrol', 'POST /api/auth/logout', 'POST /api/demo/leave']);
    // What site staff may do besides read their pickers: log days and costs, attach slips, look after their own sign-in.
    const siteMay = new Set(['POST /api/costs', 'PUT /api/costs/:id', 'POST /api/labour', 'PUT /api/labour/:id', 'POST /api/attachments', 'POST /api/auth/mfa/setup', 'POST /api/auth/mfa/disable', 'POST /api/auth/mfa/recovery-codes', 'POST /api/auth/password']);
    const accountantMay = new Set(['POST /api/auth/mfa/setup', 'POST /api/auth/mfa/disable', 'POST /api/auth/mfa/recovery-codes', 'POST /api/auth/password']);
    const site = await login(env.app, 'site@example.co.za');
    const acc = await login(env.app, 'accountant@example.co.za');
    const id = '00000000-0000-4000-8000-000000000000';
    const problems: string[] = [];
    expect(routes.size).toBeGreaterThan(100);
    for (const r of routes) {
      // Signing out would end the sessions the scan is using.
      if (r === 'POST /api/auth/logout') continue;
      const [method, path] = r.split(' ') as [string, string];
      const url = path.replace(/:[a-zA-Z]+/g, id);
      const opts = { method: method as never, url, payload: method === 'GET' || method === 'DELETE' ? undefined : ({} as never), headers: V };
      if (!open.has(r) && (await env.app.inject(opts)).statusCode !== 401) problems.push(`${r} open when signed out`);
      if (method !== 'GET') {
        const a = (await acc.call(opts)).statusCode;
        if (a !== 403 && !accountantMay.has(r) && !open.has(r)) problems.push(`${r} accountant got ${a}`);
        const s = (await site.call(opts)).statusCode;
        if (s !== 403 && !siteMay.has(r) && !open.has(r)) problems.push(`${r} site got ${s}`);
      }
    }
    expect(problems).toEqual([]);
  }, 120_000);
});
