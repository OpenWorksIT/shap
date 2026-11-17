/**
 * The Shap Accountant terms of use (terms.ts, docs/ACCOUNTANT.md "The Shap Accountant terms"):
 * Shap's terms, with what a practice takes on, accepted by its owner for the practice before Shap
 * Accountant goes on and again whenever they change; until then no client's books open. Shap's own
 * terms don't change with them, so nobody else is asked again. All data made up.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTANT_TERMS_TICK, ACCOUNTANT_TERMS_URL, ACCOUNTANT_TERMS_VERSION, accountantTermsPoints, PRACTICE_TERMS_TICK, TERMS_VERSION } from '@shap/shared';
import { expectCleanAudit, login, setup, type TestEnv } from '../helpers.js';

type Cookies = Record<string, string>;

describe('the Shap Accountant terms of use', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  let site: Awaited<ReturnType<typeof login>>;
  let client: string;
  const dropClients = async () => {
    const pattern = `${env.ctx.clients.practiceDb.replace(/_/g, '\\_')}\\_\\_c\\_%`;
    for (const { datname } of await env.sql<{ datname: string }[]>`select datname from pg_database where datname like ${pattern}`) await env.sql.unsafe(`drop database if exists "${datname}" with (force)`);
  };
  const switchOn = async () => {
    const { settings } = await owner.get('/api/reference');
    return owner.call({ method: 'PUT', url: '/api/settings', payload: { ...settings, features: { ...settings.features, practice: true } } });
  };
  const open = async (id: string): Promise<{ status: number; cookies: Cookies }> => {
    const r = await owner.call({ method: 'POST', url: `/api/practice/clients/${id}/open`, payload: {} });
    return { status: r.statusCode, cookies: Object.fromEntries(r.cookies.filter((c) => c.value).map((c) => [c.name, c.value])) };
  };

  beforeAll(async () => {
    env = await setup();
    await dropClients();
    owner = await login(env.app, 'owner@example.co.za');
    site = await login(env.app, 'site@example.co.za');
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.ctx.clients.end();
    await dropClients();
    await env.close();
  });

  it('Shap Accountant goes on only once the owner has accepted them for the practice', async () => {
    const off = await switchOn();
    expect(off.statusCode).toBe(400);
    expect(off.json().error).toMatch(/Accept the Shap Accountant terms of use for your practice first/);
    expect(off.json().details).toMatchObject({ needsAccountantTerms: true });
    // Only the owner, the terms as they are now, and in the practice's own books.
    expect((await site.call({ method: 'POST', url: '/api/practice/terms', payload: { version: ACCOUNTANT_TERMS_VERSION } })).statusCode).toBe(403);
    const stale = await owner.call({ method: 'POST', url: '/api/practice/terms', payload: { version: '2020-01-01' } });
    expect(stale.statusCode).toBe(400);
    expect(stale.json().error).toMatch(/aren’t the Shap Accountant terms as they are now/);
    await owner.post('/api/practice/terms', { version: ACCOUNTANT_TERMS_VERSION });
    const [s] = await env.sql<{ accountantTermsVersion: string; accountantTermsAcceptedAt: Date | null }[]>`select accountant_terms_version, accountant_terms_accepted_at from settings where id`;
    expect(s!.accountantTermsVersion).toBe(ACCOUNTANT_TERMS_VERSION);
    expect(s!.accountantTermsAcceptedAt).toBeInstanceOf(Date);
    const [log] = await env.sql<{ details: Record<string, unknown> }[]>`select details from audit_log where action = 'accept_accountant_terms'`;
    expect(log!.details).toEqual({ version: ACCOUNTANT_TERMS_VERSION, url: ACCOUNTANT_TERMS_URL });
    // Accepting the same again records nothing more.
    await owner.post('/api/practice/terms', { version: ACCOUNTANT_TERMS_VERSION });
    expect(await env.sql`select 1 from audit_log where action = 'accept_accountant_terms'`).toHaveLength(1);
    expect((await switchOn()).statusCode).toBe(200);
    client = (await owner.post<{ id: string }>('/api/practice/clients', { name: 'Made-up Terms Client' })).id;
  });

  it('in a client’s books, the practice accepts them for its use of Shap on those books', async () => {
    const { status, cookies } = await open(client);
    expect(status).toBe(200);
    // Accepting in the client's own books is the practice's own, so not done there.
    expect((await owner.call({ method: 'POST', url: '/api/practice/terms', payload: { version: ACCOUNTANT_TERMS_VERSION }, cookies })).statusCode).toBe(403);
    const ref = (await owner.call({ method: 'GET', url: '/api/reference', cookies })).json();
    const saved = await owner.call({ method: 'PUT', url: '/api/settings', cookies, payload: { ...ref.settings, companyName: 'Made-up Terms Client', setupDone: true, termsVersion: TERMS_VERSION } });
    expect(saved.statusCode, saved.body).toBe(200);
    const [c] = await env.sql<{ dbName: string }[]>`select db_name from practice_clients where id = ${client}`;
    const db = env.ctx.clients.get(c!.dbName);
    const [log] = await db<{ details: Record<string, unknown> }[]>`select details from audit_log where action = 'accept_terms'`;
    expect(log!.details).toMatchObject({ version: TERMS_VERSION, accountantVersion: ACCOUNTANT_TERMS_VERSION, accountantUrl: ACCOUNTANT_TERMS_URL, for: 'the practice’s use of Shap on these books' });
    await owner.call({ method: 'POST', url: '/api/practice/leave', payload: {}, cookies });
    await expectCleanAudit(db);
  });

  it('when they change, no client’s books open until the owner accepts them again; Shap’s own terms don’t change', async () => {
    const { cookies } = await open(client);
    const shaps = async () => (await env.sql<{ termsVersion: string; termsAcceptedAt: Date | null }[]>`select terms_version, terms_accepted_at from settings where id`)[0];
    const before = await shaps();
    // The published terms move on (as a new version of Shap would).
    await env.sql`update settings set accountant_terms_version = '2026-01-01' where id`;
    const list = await owner.call({ method: 'GET', url: '/api/practice' });
    expect(list.statusCode).toBe(400);
    expect(list.json().details).toMatchObject({ needsAccountantTerms: true });
    expect(list.json().error).toMatch(/its owner accepts them on the Practice page before any client’s books are opened\. The books are untouched\./);
    expect((await open(client)).status).toBe(400);
    // Someone already in a client's books is taken back to the practice.
    const there = await owner.call({ method: 'GET', url: '/api/reference', cookies, headers: { 'x-shap-books': client } });
    expect(there.statusCode).toBe(409);
    // Shap's own terms are as they were (the version everyone accepted): nobody else is asked.
    expect(TERMS_VERSION).toBe('2026-11-09');
    await owner.post('/api/practice/terms', { version: ACCOUNTANT_TERMS_VERSION });
    expect(await shaps()).toEqual(before);
    expect((await owner.get('/api/practice')).clients.map((x: { name: string }) => x.name)).toContain('Made-up Terms Client');
    expect((await open(client)).status).toBe(200);
  });

  it('say what a practice takes on: its own work, aids not advice, its clients’ books and information, the indemnity', () => {
    const points = accountantTermsPoints();
    expect(points.map((p) => p.title)).toEqual(['Your work for your clients is your own', 'Shap’s checks and returns are aids', 'Your clients’ books and information are in your care', 'Your practice indemnifies OpenWorks', 'Shap’s terms of use apply too']);
    const all = points.map((p) => p.body).join(' ');
    expect(all).toMatch(/your practice covers OpenWorks for that claim and its costs, except where OpenWorks’ own fraud, gross negligence or wilful misconduct caused it/);
    expect(all).toMatch(/personal information \(POPIA\)/);
    expect(all).toMatch(/not complete, and not advice/);
    expect(ACCOUNTANT_TERMS_TICK).toMatch(/I accept the Shap Accountant terms of use for my practice, and I may agree to them on its behalf/);
    expect(PRACTICE_TERMS_TICK).toBe('I accept the Shap Accountant terms of use for my practice’s use of Shap on these books.');
    const web = (p: string) => readFileSync(join(import.meta.dirname, '../../../web/src', p), 'utf8');
    // Switching it on shows them, with what the practice answers for; Practice asks again when they change.
    expect(web('pages/Settings.tsx')).toMatch(/<AccountantTermsAccept\s+cautions=\{\[PRACTICE_CAUTION\]\}/);
    expect(web('pages/Practice.tsx')).toMatch(/settings\.accountantTermsVersion !== ACCOUNTANT_TERMS_VERSION/);
    expect(web('components/Terms.tsx')).toMatch(/\{tick && <AccountantPoints \/>\}/);
    expect(web('pages/Practice.tsx')).toMatch(/The Shap Accountant terms of use: \$\{ACCOUNTANT_TERMS_URL\}/);
  });
});
