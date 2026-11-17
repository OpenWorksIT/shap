/**
 * The five reviews of 1.30.0 (CPDAUDIT.md): what would have lost or blocked a linked client's data.
 * A practice's server starting again (each update) deleted its linked clients; a business's own
 * Shap couldn't be wiped once its practice had opened it; one long finding kept the practice from
 * reading its checks at all, the returns with them. Also: a dividend journalled by hand lists its
 * dividends tax return. Each test fails on the code the reviews were of. All data made up.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACCOUNTANT_TERMS_VERSION, deadlinesFor } from '@shap/shared';
import { auditBooks } from '../../src/audit/books.js';
import { today } from '../../src/lib/books.js';
import { healthForLink, healthOf, migrateClients } from '../../src/lib/practice.js';
import { expectCleanAudit, ledgerTotal, login, ref, setup, type TestEnv } from '../helpers.js';
import { linkPair, type LinkPair } from '../accountant/link-pair.js';

const quiet = { info: () => {}, warn: () => {} };
const read = (p: string) => readFileSync(join(import.meta.dirname, '../../../..', p), 'utf8');

describe('a linked client, through a restart and a wipe, and with long findings', () => {
  let p: LinkPair;
  let linked: string;
  let siteId: string;

  beforeAll(async () => {
    p = await linkPair('rev130_data');
    linked = await p.link('books');
    siteId = (await p.practice.sql<{ id: string }[]>`select id from users where email = 'site@example.co.za'`)[0]!.id;
    await p.practice.sql`update users set access_add = '{practice.clients}' where id = ${siteId}`;
    await p.owner.post(`/api/practice/clients/${linked}/access`, { access: [{ userId: siteId, level: 'compile' }] }, 'PUT');
  });
  afterAll(async () => {
    await expectCleanAudit(p.own.sql);
    await expectCleanAudit(p.practice.sql);
    await p.close();
  });

  it('keeps a linked client, its credential and who opens it when the practice’s server starts again (accounting 1, security 1)', async () => {
    // Linked yesterday: no database here, ever, and that's no unfinished client.
    await p.practice.sql`update practice_clients set created_at = now() - interval '1 day' where id = ${linked}`;
    await migrateClients(p.practice.sql, p.practice.ctx.clients, quiet);
    const [c] = await p.practice.sql<{ linkCredential: string | null }[]>`select link_credential from practice_clients where id = ${linked}`;
    expect(c?.linkCredential).toBeTruthy();
    expect(await p.practice.sql`select 1 from practice_access where client_id = ${linked}`).toHaveLength(1);
    expect((await p.owner.post<{ level: string }>(`/api/practice/clients/${linked}/open`, {})).level).toBe('books');
  });

  it('the long finding: the practice reads it, cut to what its list shows, and the returns with it (IFRS 1, SARS 1, accounting 3)', async () => {
    const { settings } = await p.theirs.get('/api/reference');
    await p.theirs.post('/api/settings', { ...settings, features: { ...settings.features, inventory: true } }, 'PUT');
    // Six stocked items with long made-up names, each with opening stock and never counted.
    for (let i = 1; i <= 6; i++) {
      const item = await p.theirs.post<{ id: string }>('/api/items', { description: `Made-up item ${i} ${'with a long descriptive name '.repeat(7)}`.slice(0, 200), stocked: true, unitPriceCents: 10_000 });
      await p.theirs.post(`/api/items/${item.id}/opening`, { date: '2026-10-01', qty: 1, unitCostCents: 5_000, from: 'costs' });
    }
    const long = (await auditBooks(p.own.sql)).find((i) => i.text.length > 500);
    expect(long, 'a finding over 500 characters').toBeDefined();
    const direct = await healthOf(p.own.sql);
    const r = await p.owner.call({ method: 'POST', url: `/api/practice/clients/${linked}/checks`, payload: {} });
    expect(r.statusCode, r.body).toBe(200);
    const h = r.json().health;
    expect(h.audit.items.every((i: { text: string }) => i.text.length <= 500)).toBe(true);
    expect(h.audit.items.find((i: { text: string }) => i.text.startsWith(long!.text.slice(0, 40))).text).toMatch(/…$/);
    expect(h.deadlines).toEqual(deadlinesFor(direct.deadlineInputs!, today()));
    expect(h.deadlineInputs).toEqual(direct.deadlineInputs);
    expect(h.stale).toBeUndefined();
    // What the client's Shap sends is cut there too, and only what's named.
    expect(Object.keys(healthForLink(direct)).sort()).toEqual(['at', 'audit', 'company', 'deadlineInputs', 'lockedThrough', 'setupDone', 'statements', 'vatRegistered']);
    expect(healthForLink(direct).audit.items.every((i) => i.text.length <= 500)).toBe(true);
  });

  it('a dividend journalled by hand lists its dividends tax return, as one recorded under Dividends does (SARS 3)', async () => {
    const r = await ref(p.own.sql);
    const day = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
    await p.theirs.post('/api/journals', { date: day, description: 'Made-up dividend paid', lines: [{ accountId: await r.acc('dividends'), debitCents: 50_000 }, { accountId: await r.acc('bank'), creditCents: 50_000 }] });
    const h = (await p.owner.post<{ health: { deadlineInputs: { dividendsPaid: string[] }; deadlines: { label: string }[] } }>(`/api/practice/clients/${linked}/checks`, {})).health;
    expect(h.deadlineInputs.dividendsPaid).toContain(day);
    expect(h.deadlines.some((d) => /DTR01|Dividends tax/i.test(d.label))).toBe(true);
    await p.theirs.post('/api/journals', { date: day, description: 'Made-up dividend paid, undone', lines: [{ accountId: await r.acc('bank'), debitCents: 50_000 }, { accountId: await r.acc('dividends'), creditCents: 50_000 }] });
    // Undone in the same month: no dividend paid, no return (the fixes' check).
    expect((await healthOf(p.own.sql)).deadlineInputs!.dividendsPaid).not.toContain(day);
  });

  it('looks back far enough for a dividends tax return still on the list (the fixes’ check)', async () => {
    const r = await ref(p.own.sql);
    await p.theirs.post('/api/journals', { date: '2026-10-02', description: 'Made-up dividend paid in October', lines: [{ accountId: await r.acc('dividends'), debitCents: 40_000 }, { accountId: await r.acc('bank'), creditCents: 40_000 }] });
    // On 14 January 2027 its DTR01 (due 30 November) is 45 days back: still listed.
    const h = await healthOf(p.own.sql, '2027-01-14');
    expect(h.deadlineInputs!.dividendsPaid).toContain('2026-10-02');
    expect(deadlinesFor(h.deadlineInputs!, '2027-01-14').some((d) => d.key === 'dtr01-2026-10')).toBe(true);
    await p.theirs.post('/api/journals', { date: '2026-10-02', description: 'Made-up dividend undone', lines: [{ accountId: await r.acc('bank'), debitCents: 40_000 }, { accountId: await r.acc('dividends'), creditCents: 40_000 }] });
  });

  it('the owner wipes their books once the practice has opened them, and the link stays (accounting 2, security 3)', async () => {
    const opened = await p.enter((await p.owner.post<{ url: string }>(`/api/practice/clients/${linked}/open`, {})).url);
    expect(opened.cookie).toBeTruthy();
    const { names } = await p.theirs.get('/api/wipe');
    const r = await p.theirs.call({ method: 'POST', url: '/api/wipe', payload: { password: 'test-password-1', name: names[0] } });
    expect(r.statusCode, r.body).toBe(200);
    expect(await ledgerTotal(p.own.sql)).toBe(0);
    // Who signs in stays, the practice's people and their link with them: a wipe doesn't unlink.
    expect(await p.own.sql`select 1 from users where link_id is not null`).toHaveLength(1);
    expect((await p.theirs.get<{ status: string }[]>('/api/accountant-links')).map((l) => l.status)).toEqual(['linked']);
    expect((await p.owner.post<{ level: string }>(`/api/practice/clients/${linked}/open`, {})).level).toBe('books');
    // Set up again, for the books audit at the end.
    const { settings } = await p.theirs.get('/api/reference');
    await p.theirs.post('/api/settings', { ...settings, companyName: 'Made-up Own Books (Pty) Ltd', businessType: 'company', fyEndMonth: 2, setupDone: true }, 'PUT');
  });
});

describe('a client’s Shap whose checks the practice can’t read', () => {
  let practice: TestEnv;
  let fake: Server;
  let base: string;
  let owner: Awaited<ReturnType<typeof login>>;
  let health: unknown;
  const good = () => ({
    at: '2026-11-17T08:00:00.000Z',
    company: 'Made-up Odd Books',
    setupDone: true,
    vatRegistered: true,
    audit: { fail: 0, warn: 1, items: [{ level: 'warn', section: 'Made-up', text: 'x'.repeat(600) }] },
    statements: null,
    lockedThrough: null,
    deadlineInputs: { businessType: 'company', vatRegistered: true, vatCategory: 'B', fyEndMonth: 2, turnoverTax: false, employer: false },
  });

  beforeAll(async () => {
    practice = await setup({ env: { LINK_PRIVATE: 'true' } });
    owner = await login(practice.app, 'owner@example.co.za');
    const s = (await owner.get('/api/reference')).settings;
    await owner.post('/api/practice/terms', { version: ACCOUNTANT_TERMS_VERSION });
    await owner.post('/api/settings', { ...s, features: { ...s.features, practice: true } }, 'PUT');
    fake = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/link/redeem') return res.end(JSON.stringify({ credential: 'c'.repeat(43), company: 'Made-up Odd Books', level: 'books', api: 1 }));
        if (req.url === '/api/link/health') return res.end(JSON.stringify({ health }));
        res.statusCode = 404;
        res.end('{}');
      });
    });
    await new Promise<void>((done) => fake.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await expectCleanAudit(practice.sql);
    fake.close();
    await practice.ctx.clients.end();
    await practice.close();
  });

  it('cuts a 600-character finding, marks what it can’t read as from before, and keeps the returns (IFRS 1, SARS 1 and 5, accounting 3)', async () => {
    health = good();
    const { id } = await owner.post<{ id: string }>('/api/practice/clients/link', { link: `${base}/link#${'a'.repeat(43)}` });
    const first = await owner.post<{ health: { audit: { items: { text: string }[] }; deadlines: unknown[] } }>(`/api/practice/clients/${id}/checks`, {});
    expect(first.health.audit.items[0]!.text).toHaveLength(500);
    expect(first.health.deadlines.length).toBeGreaterThan(0);
    // Now a day that isn't one, and a VAT category changed: the rest can't be read, the returns can.
    health = { ...good(), lockedThrough: '2025-23-01', deadlineInputs: { ...good().deadlineInputs, vatCategory: 'A' } };
    const bad = await owner.call({ method: 'POST', url: `/api/practice/clients/${id}/checks`, payload: {} });
    expect(bad.statusCode, bad.body).toBe(502);
    expect(bad.json().error).toMatch(/so what’s shown is from before/);
    const shown = (await owner.get('/api/practice')).clients.find((c: { id: string }) => c.id === id);
    expect(shown.health).toMatchObject({ stale: true, company: 'Made-up Odd Books', deadlineInputs: { vatCategory: 'A' } });
    // And when it reads again, it's no longer from before.
    health = good();
    await owner.post(`/api/practice/clients/${id}/checks`, {});
    expect((await owner.get('/api/practice')).clients.find((c: { id: string }) => c.id === id).health.stale).toBeUndefined();
    // A dividend "paid" on no day at all, or a time that isn't one, isn't read either.
    for (const odd of [{ deadlineInputs: { ...good().deadlineInputs, dividendsPaid: ['2025-02-30'] } }, { at: 'yesterday' }]) {
      health = { ...good(), ...odd };
      expect((await owner.call({ method: 'POST', url: `/api/practice/clients/${id}/checks`, payload: {} })).statusCode).toBe(502);
    }
  });

  it('a client’s Shap that can’t be reached leaves what was shown marked as from before (the fixes’ check)', async () => {
    health = good();
    const { id } = await owner.post<{ id: string }>('/api/practice/clients/link', { link: `${base}/link#${'k'.repeat(43)}` });
    expect((await owner.get('/api/practice')).clients.find((c: { id: string }) => c.id === id).health.stale).toBeUndefined();
    // Nothing listening there now.
    await practice.sql`update practice_clients set link_url = 'http://127.0.0.1:1' where id = ${id}`;
    const r = await owner.call({ method: 'POST', url: `/api/practice/clients/${id}/checks`, payload: {} });
    expect(r.statusCode).toBe(502);
    expect((await owner.get('/api/practice')).clients.find((c: { id: string }) => c.id === id).health).toMatchObject({ stale: true, company: 'Made-up Odd Books' });
    // A summary saved since these checks began (another run at the same time) isn't marked.
    await practice.sql`update practice_clients set link_url = ${base} where id = ${id}`;
    health = good();
    await owner.post(`/api/practice/clients/${id}/checks`, {});
    await practice.sql`update practice_clients set health_at = now() + interval '1 hour' where id = ${id}`;
    await practice.sql`update practice_clients set link_url = 'http://127.0.0.1:1' where id = ${id}`;
    expect((await owner.call({ method: 'POST', url: `/api/practice/clients/${id}/checks`, payload: {} })).statusCode).toBe(502);
    expect((await owner.get('/api/practice')).clients.find((c: { id: string }) => c.id === id).health.stale).toBeUndefined();
    await practice.sql`update practice_clients set link_url = ${base}, health_at = now() where id = ${id}`;
  });

  it('a first answer it can’t read keeps the returns, said to be all that was read (the fixes’ check)', async () => {
    health = { ...good(), lockedThrough: 'never' };
    const { id } = await owner.post<{ id: string }>('/api/practice/clients/link', { link: `${base}/link#${'b'.repeat(43)}` });
    const shown = (await owner.get('/api/practice')).clients.find((c: { id: string }) => c.id === id);
    expect(shown.health).toMatchObject({ stale: true, unread: true, deadlineInputs: { vatCategory: 'B' } });
    expect(shown.health.deadlines.length).toBeGreaterThan(0);
    expect(read('apps/web/src/pages/Practice.tsx')).toMatch(/Their Shap’s checks couldn’t be read: only the returns coming up are shown, from what it sent\./);
  });
});
