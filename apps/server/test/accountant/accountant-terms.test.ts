/**
 * The Shap Accountant terms of use (terms.ts, docs/ACCOUNTANT.md "The Shap Accountant terms"):
 * Shap's terms, with what a practice takes on, accepted by its owner for the practice before Shap
 * Accountant goes on and again whenever they change; until then no client's books open. Shap's own
 * terms don't change with them, so nobody else is asked again. All data made up.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTANT_TERMS_MEANS, ACCOUNTANT_TERMS_TICK, ACCOUNTANT_TERMS_URL, ACCOUNTANT_TERMS_VERSION, accountantTermsPoints, PRACTICE_TERMS_TICK, TERMS_VERSION } from '@shap/shared';
import { runClientsMonthly } from '../../src/modules/monthly.js';
import { ACCOUNTANT_TERMS_NEEDED } from '../../src/modules/practice.js';
import { expectCleanAudit, login, setup, type TestEnv } from '../helpers.js';

type Cookies = Record<string, string>;

describe('the Shap Accountant terms of use', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  let site: Awaited<ReturnType<typeof login>>;
  let client: string;
  let backups: string;
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
    backups = mkdtempSync(join(tmpdir(), 'shap-accountant-terms-'));
    env = await setup({ env: { BACKUP_DIR: backups } });
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
    // Staff who see only names and pickers still see whether the practice has accepted them (Practice asks until then).
    expect((await site.get('/api/reference')).settings.accountantTermsVersion).toBe(ACCOUNTANT_TERMS_VERSION);
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
    // A monthly invoice set up in the client's books, and a backup of them on the server.
    const send = (method: 'POST' | 'PUT', url: string, payload: unknown) => owner.call({ method, url, payload: payload as never, cookies });
    const customer = (await send('POST', '/api/clients', { name: 'Made-up Clinic' })).json();
    const inv = (await send('POST', '/api/documents', { kind: 'invoice', clientId: customer.id, issueDate: '2026-10-01', title: 'Hosting', lines: [{ category: 'other', description: 'Hosting (made up)', qty: 1, unitPriceCents: 50_000 }] })).json();
    expect((await send('POST', `/api/documents/${inv.id}/issue`, {})).statusCode).toBe(200);
    expect((await send('POST', `/api/documents/${inv.id}/monthly`, { dayOfMonth: 1, startsOn: '2026-12-01', mode: 'draft', emailTo: '' })).statusCode).toBe(200);
    const [c] = await env.sql<{ dbName: string }[]>`select db_name from practice_clients where id = ${client}`;
    const backup = `${c!.dbName}-daily-2026-11-16_0200.dump`;
    writeFileSync(join(backups, backup), 'made-up backup');
    const shaps = async () => (await env.sql<{ termsVersion: string; termsAcceptedAt: Date | null }[]>`select terms_version, terms_accepted_at from settings where id`)[0];
    const before = await shaps();
    // The published terms move on (as a new version of Shap would).
    await env.sql`update settings set accountant_terms_version = '2026-01-01' where id`;
    const list = await owner.call({ method: 'GET', url: '/api/practice' });
    expect(list.statusCode).toBe(400);
    expect(list.json().details).toMatchObject({ needsAccountantTerms: true });
    expect(list.json().error).toBe(ACCOUNTANT_TERMS_NEEDED);
    expect(ACCOUNTANT_TERMS_NEEDED).toMatch(/Nothing in the clients’ books changes meanwhile, except monthly invoices set up there, which are still made on their day; their backups can still be downloaded from the Practice page\./);
    expect((await open(client)).status).toBe(400);
    // Monthly invoices are still made on their day, as the words say (a catch-up later could land in a closed month).
    expect(await runClientsMonthly(env.ctx, '2026-12-01')).toBe(1);
    // The owner can still hand the client its books: the list, the backups, the link and the download.
    expect((await owner.get('/api/practice/records')).clients.map((x: { name: string }) => x.name)).toEqual(['Made-up Terms Client']);
    expect((await owner.get(`/api/practice/clients/${client}/backups`)).backups.map((b: { name: string }) => b.name)).toEqual([backup]);
    const { url } = await owner.post(`/api/practice/clients/${client}/backups/${backup}/link`, { password: 'test-password-1' });
    const got = await owner.call({ method: 'GET', url });
    expect([got.statusCode, got.body]).toEqual([200, 'made-up backup']);
    // Only the owner.
    expect((await site.call({ method: 'GET', url: '/api/practice/records' })).statusCode).toBe(403);
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
    // The indemnity as clause 13 has it: its whole scope, its people, ordinary negligence, and the carve-out for theirs too.
    expect(points[3]!.body).toMatch(
      /over your practice’s work for its clients, its use of Shap on their books, the personal information it keeps or opens there, or a breach of these terms by your practice or anyone it lets in, your practice covers them for that claim and its costs, even where the claim says Shap or OpenWorks’ negligence caused it, but not where the fraud, gross negligence or wilful misconduct of OpenWorks or its people did/,
    );
    expect(ACCOUNTANT_TERMS_MEANS).toMatch(/indemnifies OpenWorks against claims by its clients or anyone else over that work, its use of Shap on their books, the personal information it keeps or opens there, or a breach of the terms/);
    expect(all).toMatch(/personal information \(POPIA\)/);
    expect(all).toMatch(/not complete, and not advice/);
    // Estimates, as the owner's rule says, and what Shap doesn't do.
    expect(all).toMatch(/Its tax figures \(income tax, provisional tax, turnover tax, the tax pack\) and the public interest score, with the audit or independent review it points to, are estimates only/);
    expect(all).toMatch(/Shap files nothing with SARS, the Department of Employment and Labour or CIPC/);
    expect(all).toMatch(/OpenWorks IT are not accountants, tax practitioners or auditors/);
    // Who approves a client's statements, as the law has it.
    expect(points[1]!.body).toMatch(/for a company, its board; for a close corporation, members holding at least half of the members’ interest; for a trust, its trustees; for a partnership, its partners; for a sole proprietor, its owner/);
    expect(ACCOUNTANT_TERMS_TICK).toBe('I accept the Shap Accountant terms of use for my practice, and I’m authorised to agree to them on its behalf.');
    expect(PRACTICE_TERMS_TICK).toBe('I accept the Shap Accountant terms of use, which my practice’s owner has accepted for the practice, for my practice’s use of Shap on these books.');
    // Part A follows Shap's terms: never an older version than them.
    expect(ACCOUNTANT_TERMS_VERSION >= TERMS_VERSION).toBe(true);
    const web = (p: string) => readFileSync(join(import.meta.dirname, '../../../web/src', p), 'utf8');
    // Switching it on shows them, with what the practice answers for; Practice asks again when they change.
    expect(web('pages/Settings.tsx')).toMatch(/<AccountantTermsAccept\s+cautions=\{\[PRACTICE_CAUTION\]\}/);
    expect(web('pages/Practice.tsx')).toMatch(/settings\.accountantTermsVersion !== ACCOUNTANT_TERMS_VERSION/);
    expect(web('components/Terms.tsx')).toMatch(/\{tick && <AccountantPoints \/>\}/);
    expect(web('components/Terms.tsx')).toMatch(/\{tick \? ACCOUNTANT_TERMS_MEANS :/);
    expect(web('components/AccountantTerms.tsx')).toMatch(/\{ACCOUNTANT_TERMS_MEANS\}/);
    expect(web('pages/Practice.tsx')).toMatch(/\$\{PRACTICE_TERMS_TICK\}\\n\\n\$\{ACCOUNTANT_TERMS_MEANS\}\\n\\nThe Shap Accountant terms of use: \$\{ACCOUNTANT_TERMS_URL\}/);
    // The owner sees the clients' backups beside the terms, while they wait.
    expect(web('pages/Practice.tsx')).toMatch(/\{isOwner && <ClientRecords \/>\}/);
    expect(web('pages/Practice.tsx')).not.toMatch(/books are untouched/);
    // The penetration test accepts them before it switches Shap Accountant on.
    const pentest = readFileSync(join(import.meta.dirname, '../../../../deploy/test/pentest.mjs'), 'utf8');
    expect(pentest.indexOf("'/api/practice/terms'")).toBeGreaterThan(-1);
    expect(pentest.indexOf("'/api/practice/terms'")).toBeLessThan(pentest.indexOf('practice: true'));
  });
});
