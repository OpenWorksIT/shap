/**
 * Privacy, checked on every change: books full of made-up but personal-looking details (the
 * "canaries": a client's name, email, phone and address, a worker's name and ID number, the
 * company's own details, an item typed by hand), then everything that can leave the server, and
 * everything it writes to its log, is searched for them.
 *
 * What may leave, and only with the owner's yes (docs/AUDIT.md, the privacy policy):
 * - the anonymous usage note: the app, version, a random install number, the kind of business,
 *   which parts are switched on;
 * - anonymous market rates: average prices of the trade's standard items, nothing typed;
 * - feedback, which is what the person chose to send;
 * and the notices file is fetched with nothing about the server in the request.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { serverLogger, withoutAddresses } from '../src/lib/logging.js';
import { createMailer } from '../src/lib/mailer.js';
import { reportUsage } from '../src/modules/feedback.js';
import { shareMarketRates } from '../src/modules/market.js';
import { appVersion } from '../src/modules/system.js';
import { login, ref, setup, type TestEnv } from './helpers.js';

const CANARY = {
  company: 'Canarybird Construction (Pty) Ltd',
  client: 'Zandile Canarybird',
  email: 'zandile.canary@client.example',
  phone: '082 555 0199',
  address: '7 Canary Close, Kariega',
  worker: 'Bongani Canaryman',
  idNumber: '8001015009087',
  item: 'Canary bespoke gate',
  password: 'canary-secret-pass-77',
};
const leaks = (text: string) => Object.entries(CANARY).filter(([, v]) => text.toLowerCase().includes(v.toLowerCase())).map(([k]) => k);

describe('what leaves the server', () => {
  let env: TestEnv;
  const sent: { url: string; method: string; body: string; headers: string }[] = [];
  const realFetch = globalThis.fetch;
  const quiet = { warn: () => undefined };

  beforeAll(async () => {
    // Feedback is written to a folder too: a scratch one, not the repository.
    env = await setup({ env: { FEEDBACK_DIR: mkdtempSync(join(tmpdir(), 'shap-feedback-')) } });
    const me = await login(env.app, 'owner@example.co.za');
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, companyName: CANARY.company, industry: 'electrician', address: CANARY.address, phone: CANARY.phone }, 'PUT');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    const client = await me.post('/api/clients', { name: CANARY.client, email: CANARY.email, phone: CANARY.phone, address: CANARY.address });
    await me.post('/api/employees', { name: CANARY.worker, idNumber: CANARY.idNumber, salaryCents: 1_500_000, startDate: '2026-01-01' });
    // Last month's invoice: a standard item of the trade, and one typed by hand.
    const lastMonth = new Date();
    lastMonth.setUTCDate(1);
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
    const inv = await me.post('/api/documents', {
      kind: 'invoice',
      clientId: client.id,
      issueDate: `${lastMonth.toISOString().slice(0, 7)}-10`,
      lines: [
        { category: 'labour', description: 'Install plug point', unit: 'point', qty: 2, unitPriceCents: 45_000 },
        { category: 'materials', description: CANARY.item, qty: 1, unitPriceCents: 900_000 },
      ],
    });
    await me.post(`/api/documents/${inv.id}/issue`);
    await me.post(`/api/documents/${inv.id}/receipts`, { date: `${lastMonth.toISOString().slice(0, 7)}-20`, amountCents: 100_000, sourceId: bank }).catch(() => undefined);
    await env.sql`update settings set market_consent = true, market_notice_seen = true, usage_consent = true`;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : '', headers: JSON.stringify(init?.headers ?? {}) });
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await env.close();
  });

  it('sends the usage note with nothing about the business but its kind and what it uses', async () => {
    const s = (await env.sql<{ installId: string; businessType: string; industry: string; features: Record<string, boolean>; vatRegistered: boolean }[]>`select * from settings`)[0]!;
    expect(await reportUsage(env.ctx, { usageConsent: true, installId: s.installId, businessType: s.businessType as never, industry: s.industry, features: Object.keys(s.features ?? {}), vatRegistered: s.vatRegistered, tone: 'casual' }, quiet)).toBe(true);
    const note = sent.find((x) => x.url.endsWith('/usage'))!;
    expect(note).toBeTruthy();
    expect(Object.keys(JSON.parse(note.body)).sort()).toEqual(['app', 'businessType', 'features', 'industry', 'installId', 'platform', 'tone', 'vatRegistered', 'version']);
    expect(leaks(note.body)).toEqual([]);
  });

  it('shares only the trade’s standard items’ average prices: nothing typed by a person', async () => {
    expect(await shareMarketRates(env.ctx, env.sql, quiet)).toBe('sent');
    const market = sent.find((x) => x.url.endsWith('/market'))!;
    const body = JSON.parse(market.body) as { rates: { item: string }[] };
    expect(Object.keys(body).sort()).toEqual(['app', 'industry', 'installId', 'month', 'rates', 'version']);
    expect(body.rates.map((x) => x.item)).toEqual(['Install plug point']);
    expect(leaks(market.body)).toEqual([]);
  });

  it('sends feedback as the person wrote it, with their role but not who they are', async () => {
    const me = await login(env.app, 'owner@example.co.za');
    // A trail as an older (or altered) app might send it: a client's address, number and search
    // in it. The server blanks them whatever sent it.
    await me.post('/api/feedback', {
      kind: 'idea',
      message: 'A wish of my own',
      page: '/clients',
      at: new Date().toISOString(),
      trail: [
        { t: Date.now(), kind: 'nav', detail: `/clients?q=${encodeURIComponent(CANARY.client)}` },
        { t: Date.now(), kind: 'api', detail: 'GET /api/clients/0b9d2d9e-6a51-4e0e-9f5e-1d2c3b4a5f60 200' },
        { t: Date.now(), kind: 'error', detail: `Couldn't send to ${CANARY.email}, phone ${CANARY.phone}, ID ${CANARY.idNumber}` },
      ],
    });
    await new Promise((r) => setTimeout(r, 50));
    const fb = sent.find((x) => x.url.endsWith('/feedback'))!;
    expect(fb).toBeTruthy();
    expect(fb.body).toContain('A wish of my own');
    expect(fb.body).not.toContain('owner@example.co.za');
    expect(fb.body).not.toContain('0b9d2d9e-6a51');
    expect(fb.body).toContain('/clients?q=…');
    expect(leaks(fb.body)).toEqual([]);
  });

  it('goes only to OpenWorks’ collector, and never with a cookie or a sign-in', () => {
    const allowed = new Set([new URL(env.ctx.config.COLLECTOR_URL).host, new URL(env.ctx.config.NOTICE_URL).host]);
    for (const x of sent) {
      expect(allowed.has(new URL(x.url).host)).toBe(true);
      expect(x.headers.toLowerCase()).not.toMatch(/cookie|authorization/);
      expect(leaks(x.url)).toEqual([]);
    }
  });
});

describe('what the server writes to its log', () => {
  let env: TestEnv;
  let log = '';
  let sentStatus = 0;
  let refusedStatus = 0;

  beforeAll(async () => {
    env = await setup();
    const stream = new PassThrough();
    stream.on('data', (c: Buffer) => (log += c.toString()));
    // The real mailer, pointed at a mail server that isn't there: its failure is logged too.
    const { app } = await buildApp({ config: loadConfig({ ...process.env, TRUST_PROXY: 'true', SMTP_URL: 'smtp://127.0.0.1:1', MAIL_FROM: 'Fictional Books <books@example.co.za>' }), sql: env.sql, logger: serverLogger({ dev: false, stream }) });
    await app.ready();
    const V = { 'x-shap-version': appVersion(), 'content-type': 'application/json' };
    const owner = await login(app, 'owner@example.co.za');
    await owner.post('/api/users', { name: CANARY.worker, email: 'canary.user@example.co.za', role: 'owner', password: CANARY.password, currentPassword: 'test-password-1' });
    // A wrong password, the right one, a search for a client, a client with all their details.
    await app.inject({ method: 'POST', url: '/api/auth/login', headers: V, payload: { email: 'canary.user@example.co.za', password: `${CANARY.password}-wrong` } });
    await app.inject({ method: 'POST', url: '/api/auth/login', headers: V, payload: { email: 'canary.user@example.co.za', password: CANARY.password } });
    const c = await owner.post('/api/clients', { name: CANARY.client, email: CANARY.email, phone: CANARY.phone, address: CANARY.address });
    await owner.get(`/api/clients?q=${encodeURIComponent(CANARY.client)}`);
    await owner.get(`/api/clients/${c.id}`);
    const inv = await owner.post('/api/documents', { kind: 'invoice', clientId: c.id, issueDate: '2026-11-03', lines: [{ category: 'labour', description: CANARY.item, qty: 1, unitPriceCents: 10_000 }] });
    await owner.post(`/api/documents/${inv.id}/issue`);
    sentStatus = (await owner.call({ method: 'POST', url: `/api/documents/${inv.id}/email`, payload: { to: CANARY.email, message: 'Hi' } })).statusCode;
    // A value the database refuses: noted by its code and route, without the value.
    refusedStatus = (await owner.call({ method: 'GET', url: '/api/costs?from=2026-99-99' })).statusCode;
    await app.inject({ method: 'GET', url: `/api/clients?q=${encodeURIComponent(CANARY.email)}`, headers: { cookie: 'shap_session=canary-session-token' } });
    await app.close();
  });
  afterAll(() => env.close());

  it('logs requests, without anyone’s details, passwords, searches or sessions', () => {
    expect(log).toMatch(/"url":"\/api\/clients"/);
    // The email really was tried, and failed: the mailer's own line is in the log, without whom or what.
    expect(sentStatus).toBe(502);
    expect(log).toMatch(/email send failed/);
    expect(log).not.toContain('Fictional Books');
    expect(refusedStatus).toBe(400);
    expect(log).toMatch(/"pgCode":"22008","route":"GET \/api\/costs","msg":"a value the database refused"/);
    expect(log).not.toContain('2026-99-99');
    expect(leaks(log)).toEqual([]);
    expect(log).not.toContain('canary-session-token');
    expect(log).not.toContain('canary.user@example.co.za');
  });
});

describe('the mailer, on its own', () => {
  it('logs that an email failed or wasn’t sent, never to whom or what about', async () => {
    const lines: string[] = [];
    const log = { info: (...a: unknown[]) => void lines.push(JSON.stringify(a)), error: (...a: unknown[]) => void lines.push(JSON.stringify(a)), warn: () => undefined } as never;
    const mail = { to: CANARY.email, subject: `Invoice INV-0001 from ${CANARY.company}`, text: `Dear ${CANARY.client}`, fromName: CANARY.company };
    await createMailer('', 'books@example.co.za', log).send(mail as never);
    await expect(createMailer('smtp://127.0.0.1:1', 'books@example.co.za', log).send(mail as never)).rejects.toThrow(/Not sent/);
    expect(lines.join('\n')).toMatch(/not sent/);
    expect(lines.join('\n')).toMatch(/email send failed/);
    expect(leaks(lines.join('\n'))).toEqual([]);
  });

  it('blanks addresses in what a mail server says back', () => {
    expect(withoutAddresses('550 5.1.1 <zandile.canary@client.example>: Recipient address rejected')).toBe('550 5.1.1 <…@…>: Recipient address rejected');
  });
});
