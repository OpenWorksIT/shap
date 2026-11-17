/**
 * The 1.31.0 reviews of engagement letters and working papers, on a practice with clients kept on
 * its server (modules/working-papers.ts, lib/papers.ts, migration 052): what a sent letter keeps,
 * what runs alongside, which letter covers a year, a change of year-end month, ticks by the account
 * itself, the compile form noticing the books moved, the trial balance's totals, sign-offs taken
 * back, the caps, and what the audit log keeps. Each check failed on 1.31.0 as the reviews found it.
 * The clock is fixed, as the reviews asked (17 November 2026). All data made up.
 */
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LETTER_MAX_CHARS, NOTES_PER_YEAR, REPLIES_PER_NOTE, YEAR_NOTES_MAX_CHARS } from '@shap/shared';
import type { Sql } from '../../src/db/index.js';
import { expectCleanAudit, login, ref } from '../helpers.js';
import { linkPair, type LinkPair } from '../accountant/link-pair.js';

const FY = '2026-02-28';
const PRIOR = '2025-02-28';
const PDF = Buffer.from('%PDF-1.4\n% a made-up signed letter\n').toString('base64');

interface Books {
  sql: Sql;
  get: <T = any>(url: string) => Promise<T>;
  post: <T = any>(url: string, body?: unknown, method?: 'POST' | 'PUT' | 'DELETE') => Promise<T>;
  call: (o: InjectOptions) => Promise<{ statusCode: number; body: string; json: () => any }>;
}

describe('engagement letters and working papers, as the 1.31 reviews found them', () => {
  let p: LinkPair;
  const made: Sql[] = [];
  const pdfText = async (buf: Buffer) => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
    let out = '';
    for (let n = 1; n <= doc.numPages; n++) out += (await (await doc.getPage(n)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ') + '\n';
    return out.replace(/\s+/g, ' ');
  };
  const dropClients = async () => {
    const pattern = `${p.practice.ctx.clients.practiceDb.replace(/_/g, '\\_')}\\_\\_c\\_%`;
    for (const { datname } of await p.practice.sql<{ datname: string }[]>`select datname from pg_database where datname like ${pattern}`) await p.practice.sql.unsafe(`drop database if exists "${datname}" with (force)`);
  };
  /** A client kept in the practice, a company with a February year end, and its books as the practice's owner opens them. */
  const client = async (name: string): Promise<{ id: string; books: Books }> => {
    const { id } = await p.owner.post<{ id: string }>('/api/practice/clients', { name });
    const [c] = await p.practice.sql<{ dbName: string }[]>`select db_name from practice_clients where id = ${id}`;
    const sql = p.practice.ctx.clients.get(c!.dbName);
    made.push(sql);
    await sql`update settings set setup_done = true, features = ${sql.json({ brands: true, workers: true, statements: true })}, address = '1 Test Street, Fictional Town, 0001'`;
    await sql`insert into brands (name, sort) select company_name, 1 from settings`;
    await sql`update settings set default_brand_id = (select id from brands limit 1)`;
    const k = await p.owner.call({ method: 'POST', url: `/api/practice/clients/${id}/open`, payload: {} });
    const cookies = Object.fromEntries(k.cookies.filter((x) => x.value).map((x) => [x.name, x.value]));
    const call = (o: InjectOptions) => p.owner.call({ ...o, cookies });
    const books: Books = {
      sql,
      call,
      get: async (url) => (await call({ method: 'GET', url })).json(),
      post: async (url, body = {}, method = 'POST') => {
        const r = await call({ method, url, payload: body as never });
        if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
        return r.json();
      },
    };
    const { settings } = await books.get('/api/reference');
    await books.post('/api/settings', { ...settings, companyName: name, businessType: 'company', fyEndMonth: 2 }, 'PUT');
    return { id, books };
  };
  const journal = async (b: Books, date: string, debit: string, credit: string, cents: number) => {
    const r = await ref(b.sql);
    await b.post('/api/journals', { date, description: `Made-up ${debit}`, lines: [{ accountId: await r.acc(debit), debitCents: cents }, { accountId: await r.acc(credit), creditCents: cents }] });
  };
  const fileOf = (id: string, fy?: string) => p.owner.get(`/api/practice/clients/${id}/file${fy ? `?fy=${fy}` : ''}`);
  const letter = async (id: string, services: string[], from: string) => (await p.owner.post<{ id: string }>(`/api/practice/clients/${id}/letters`, { services, fromYearEnd: from })).id;
  const letterRow = async (id: string, lid: string) => (await p.owner.get(`/api/practice/clients/${id}/letters`)).letters.find((x: { id: string }) => x.id === lid);
  const accept = (id: string, lid: string) => p.owner.post(`/api/practice/clients/${id}/letters/${lid}/accept`, { on: '2026-11-17', name: 'Made-up Director', how: 'recorded' });
  const sign = (id: string, role: string, fy = FY, on = true) => p.owner.post(`/api/practice/clients/${id}/file/signoffs`, { fyEnd: fy, role, on }, 'PUT');

  let a: { id: string; books: Books };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-17T08:00:00Z'), shouldAdvanceTime: true });
    p = await linkPair('wp31');
    await dropClients();
    a = await client('Made-up Client A (Pty) Ltd');
    // Books from the year to February 2025, so both it and the year after have ended.
    await journal(a.books, '2024-06-01', 'bank', 'owner_loan', 500_000);
    await journal(a.books, '2025-07-01', 'rent', 'bank', 120_000);
  });
  afterAll(async () => {
    for (const sql of made) await expectCleanAudit(sql);
    await expectCleanAudit(p.practice.sql);
    await p.practice.ctx.clients.end();
    await dropClients();
    await p.close();
    vi.useRealTimers();
  });

  describe('a letter', () => {
    it('keeps its parties as they were when it was sent: renaming the practice or the client changes nothing, and the PDF heads it with them', async () => {
      const lid = await letter(a.id, ['compile'], PRIOR);
      const l = await letterRow(a.id, lid);
      expect([l.practiceName, l.clientName]).toEqual(['Made-up Practice Inc', 'Made-up Client A (Pty) Ltd']);
      await p.owner.post(`/api/practice/clients/${a.id}/letters/${lid}`, { body: l.body, parties: { practiceName: 'Made-up Practice Inc', practiceReg: '2019/000002/07', practiceTrading: 'Made-up Accountants', practiceAddress: '2 Test Road, Fictional Town', clientName: 'Made-up Client A (Pty) Ltd' } }, 'PUT');
      // The draft: not for sending, with the note on it.
      const draft = await pdfText((await p.owner.call({ method: 'GET', url: `/api/practice/clients/${a.id}/letters/${lid}/pdf` })).rawPayload);
      expect(draft).toMatch(/Draft, to read: not for sending/);
      expect(draft).toMatch(/not complete, and not checked against the law or your professional body’s rules/);
      await p.owner.post(`/api/practice/clients/${a.id}/letters/${lid}/sent`, {});
      // Renamed afterwards: the practice in Settings, the client in its books and on the list.
      const s = (await p.owner.get('/api/reference')).settings;
      await p.owner.post('/api/settings', { ...s, companyName: 'Renamed Practice Inc', tradingName: 'Renamed Trading' }, 'PUT');
      const cs = (await a.books.get('/api/reference')).settings;
      await a.books.post('/api/settings', { ...cs, companyName: 'Renamed Client (Pty) Ltd' }, 'PUT');
      const sent = await pdfText((await p.owner.call({ method: 'GET', url: `/api/practice/clients/${a.id}/letters/${lid}/pdf` })).rawPayload);
      for (const said of [/Made-up Practice Inc/, /Registration number 2019\/000002\/07/, /Trading as Made-up Accountants/, /2 Test Road, Fictional Town/, /To Made-up Client A \(Pty\) Ltd/, /Accepted for Made-up Client A \(Pty\) Ltd/, /17 November 2026/]) expect(sent).toMatch(said);
      // Nothing of the rename, of the draft, or of OpenWorks on the letter the practice sends.
      expect(sent).not.toMatch(/Renamed|Draft|OpenWorks/);
      await p.owner.post('/api/settings', { ...s, companyName: 'Made-up Practice Inc' }, 'PUT');
      await a.books.post('/api/settings', { ...cs, companyName: 'Made-up Client A (Pty) Ltd' }, 'PUT');
      await accept(a.id, lid);
    });

    it('once sent, the database itself refuses a change to its words or parties, a step back, or deleting it', async () => {
      const [l] = await p.practice.sql<{ id: string }[]>`select id from practice_letters where client_id = ${a.id} and status = 'accepted'`;
      for (const change of [
        p.practice.sql`update practice_letters set body = '[]' where id = ${l!.id}`,
        p.practice.sql`update practice_letters set client_name = 'Someone else' where id = ${l!.id}`,
        p.practice.sql`update practice_letters set accepted_name = 'Someone else' where id = ${l!.id}`,
        p.practice.sql`update practice_letters set status = 'draft' where id = ${l!.id}`,
        p.practice.sql`delete from practice_letters where id = ${l!.id}`,
      ])
        await expect(change).rejects.toThrow(/kept|only moves on/);
      // A draft is changed and deleted as the practice likes.
      const d = await letter(a.id, ['vat'], FY);
      await p.practice.sql`update practice_letters set other = 'Made-up' where id = ${d}`;
      await p.practice.sql`delete from practice_letters where id = ${d}`;
    });

    it('two people at once: a letter sent while it’s changed or deleted is either changed first or not at all', async () => {
      for (let n = 0; n < 4; n++) {
        const lid = await letter(a.id, ['vat'], FY);
        const l = await letterRow(a.id, lid);
        const edited = [...l.body, { heading: 'Made-up extra', paragraphs: [`Edit ${n}`] }];
        const parties = { practiceName: l.practiceName, practiceReg: l.practiceReg, practiceTrading: l.practiceTrading, practiceAddress: l.practiceAddress, clientName: l.clientName };
        const [put, sent] = await Promise.all([
          p.owner.call({ method: 'PUT', url: `/api/practice/clients/${a.id}/letters/${lid}`, payload: { body: edited, parties } }),
          p.owner.call({ method: 'POST', url: `/api/practice/clients/${a.id}/letters/${lid}/sent`, payload: {} }),
        ]);
        expect(sent.statusCode).toBe(200);
        const after = await letterRow(a.id, lid);
        expect(after.status).toBe('sent');
        expect(put.statusCode === 200).toBe(JSON.stringify(after.body).includes(`Edit ${n}`));
        await p.owner.post(`/api/practice/clients/${a.id}/letters/${lid}/end`, {});
        // Deleted while it's sent: one or the other, never both.
        const lid2 = await letter(a.id, ['vat'], FY);
        const [del, sent2] = await Promise.all([
          p.owner.call({ method: 'DELETE', url: `/api/practice/clients/${a.id}/letters/${lid2}` }),
          p.owner.call({ method: 'POST', url: `/api/practice/clients/${a.id}/letters/${lid2}/sent`, payload: {} }),
        ]);
        expect([del.statusCode, sent2.statusCode].filter((c) => c === 200)).toHaveLength(1);
        const left = await p.practice.sql`select status from practice_letters where id = ${lid2}`;
        if (left.length) {
          expect(left[0]!.status).toBe('sent');
          await p.owner.post(`/api/practice/clients/${a.id}/letters/${lid2}/end`, {});
        }
      }
      // A sent letter's log says it was sent once; a letter deleted isn't "sent" afterwards.
      const ghosts = await p.practice.sql`select a.entity_id from audit_log a where a.action = 'letter_sent' and not exists (select 1 from practice_letters l where l.id::text = a.entity_id)`;
      expect(ghosts).toHaveLength(0);
    });

    it(`runs to ${LETTER_MAX_CHARS} characters at most (its PDF is made on the server)`, async () => {
      const lid = await letter(a.id, ['vat'], FY);
      const l = await letterRow(a.id, lid);
      const parties = { practiceName: l.practiceName, practiceReg: '', practiceTrading: '', practiceAddress: '', clientName: l.clientName };
      const long = Array.from({ length: 16 }, (_, i) => ({ heading: `Part ${i}`, paragraphs: ['x'.repeat(4000)] }));
      const r = await p.owner.call({ method: 'PUT', url: `/api/practice/clients/${a.id}/letters/${lid}`, payload: { body: long, parties } });
      expect([r.statusCode, r.json().error]).toEqual([400, expect.stringMatching(/characters at most, all its parts together/)]);
      await p.owner.post(`/api/practice/clients/${a.id}/letters/${lid}`, {}, 'DELETE');
    });

    it('says rightly why an acceptance or a letter is refused, and logs each download', async () => {
      const lid = await letter(a.id, ['payroll'], FY);
      await p.owner.post(`/api/practice/clients/${a.id}/letters/${lid}/sent`, {});
      const early = await p.owner.call({ method: 'POST', url: `/api/practice/clients/${a.id}/letters/${lid}/accept`, payload: { on: '2026-11-01', name: 'Made-up Director', how: 'recorded' } });
      expect(early.json().error).toBe('The day they accepted it can’t be before the day it was sent (17 November 2026).');
      await p.owner.post(`/api/practice/clients/${a.id}/letters/${lid}/accept`, { on: '2026-11-17', name: 'Made-up Director', how: 'signed', signed: { filename: 'signed.pdf', mime: 'application/pdf', dataBase64: PDF } });
      // A company's accounting officer isn't one: said so, not "tick what your practice will do".
      const ao = await p.owner.call({ method: 'POST', url: `/api/practice/clients/${a.id}/letters`, payload: { services: ['accounting_officer'], fromYearEnd: FY } });
      expect(ao.json().error).toMatch(/An accounting officer is only a close corporation’s/);
      for (const url of [`/api/practice/clients/${a.id}/letters/${lid}/pdf`, `/api/practice/clients/${a.id}/letters/${lid}/signed`]) expect((await p.owner.call({ method: 'GET', url })).statusCode).toBe(200);
      const logged = await p.practice.sql<{ action: string }[]>`select action from audit_log where entity_id = ${lid} and action in ('letter_pdf', 'letter_signed_copy')`;
      expect(logged.map((x) => x.action).sort()).toEqual(['letter_pdf', 'letter_signed_copy']);
      await p.owner.post(`/api/practice/clients/${a.id}/letters/${lid}/end`, { lastYearEnd: FY });
    });
  });

  describe('which letter covers a year', () => {
    it('a later letter governs its years, its first one needing no second look; an ended letter still covers the years it did', async () => {
      // The letter from the year to February 2025 is accepted (above). A new one from the year after takes over.
      const first = (await p.practice.sql<{ id: string }[]>`select id from practice_letters where client_id = ${a.id} and status = 'accepted' and 'compile' = any(services)`)[0]!.id;
      const second = await letter(a.id, ['compile'], FY);
      await p.owner.post(`/api/practice/clients/${a.id}/letters/${second}/sent`, {});
      await accept(a.id, second);
      expect((await fileOf(a.id, FY)).letter).toEqual({ accepted: true, compiling: true, termsLooked: true });
      // Ending the first at its last year: that year still has its letter.
      const bad = await p.owner.call({ method: 'POST', url: `/api/practice/clients/${a.id}/letters/${first}/end`, payload: { lastYearEnd: '2024-02-29' } });
      expect(bad.statusCode).toBe(400);
      await p.owner.post(`/api/practice/clients/${a.id}/letters/${first}/end`, { lastYearEnd: PRIOR });
      expect((await letterRow(a.id, first)).lastYearEnd).toBe(PRIOR);
      expect((await fileOf(a.id, PRIOR)).letter).toEqual({ accepted: true, compiling: true, termsLooked: true });
      expect((await fileOf(a.id, FY)).letter).toEqual({ accepted: true, compiling: true, termsLooked: true });
      // The list, once the client's checks have run (they give it the year end).
      expect((await p.owner.get('/api/practice')).clients.find((x: { id: string }) => x.id === a.id).papers).toMatchObject({ fyEnd: null, letter: 'accepted' });
      await p.owner.post(`/api/practice/clients/${a.id}/checks`, {});
      const list = (await p.owner.get('/api/practice')).clients.find((x: { id: string }) => x.id === a.id).papers;
      expect(list).toMatchObject({ fyEnd: FY, letter: 'accepted', compiling: true, termsLooked: true });
    });

    it('a letter that isn’t for compiling covers its years, for compiling none', async () => {
      const b = await client('Made-up Client B (Pty) Ltd');
      await journal(b.books, '2025-06-01', 'bank', 'owner_loan', 100_000);
      const lid = await letter(b.id, ['books', 'vat'], FY);
      await p.owner.post(`/api/practice/clients/${b.id}/letters/${lid}/sent`, {});
      await accept(b.id, lid);
      await p.owner.post(`/api/practice/clients/${b.id}/checks`, {});
      const list = (await p.owner.get('/api/practice')).clients.find((x: { id: string }) => x.id === b.id).papers;
      expect(list).toMatchObject({ letter: 'accepted', compiling: false, termsLooked: true });
    });
  });

  describe('the working papers', () => {
    it('ticks go by the account, not its code: a new code moves nothing; a new type is a change', async () => {
      const file = await fileOf(a.id, FY);
      const rent = file.lines.find((l: { name: string }) => /rent/i.test(l.name));
      await p.owner.post(`/api/practice/clients/${a.id}/file/ticks`, { fyEnd: FY, accountId: rent.accountId, which: 'prepared', on: true });
      await sign(a.id, 'prepared');
      const acc = (await a.books.sql<{ id: string; code: string; name: string; type: string; active: boolean }[]>`select id, code, name, type, active from accounts where id = ${rent.accountId}`)[0]!;
      await a.books.post(`/api/accounts/${acc.id}`, { code: '6991', name: acc.name, type: acc.type, active: acc.active }, 'PUT');
      let now = await fileOf(a.id, FY);
      expect(now.lines.find((l: { accountId: string }) => l.accountId === rent.accountId)).toMatchObject({ code: '6991', prepared: { changed: false } });
      expect(now.gone).toEqual([]);
      expect(now.signoffs.prepared.changed).toBe(false);
      await a.books.post(`/api/accounts/${acc.id}`, { code: acc.code, name: acc.name, type: acc.type, active: acc.active }, 'PUT');
      // An account of the year's moved from expenses to assets: the balance and code are the same, the books aren't.
      const sundry = await a.books.post<{ id: string }>('/api/accounts', { code: '6995', name: 'Made-up sundry', type: 'expense', active: true });
      const r = await ref(a.books.sql);
      await a.books.post('/api/journals', { date: '2025-08-01', description: 'Made-up sundry', lines: [{ accountId: sundry.id, debitCents: 50_000 }, { accountId: await r.acc('bank'), creditCents: 50_000 }] });
      await sign(a.id, 'prepared', FY, false);
      await sign(a.id, 'prepared');
      await p.owner.post(`/api/practice/clients/${a.id}/file/ticks`, { fyEnd: FY, accountId: sundry.id, which: 'prepared', on: true });
      await a.books.post(`/api/accounts/${sundry.id}`, { code: '6995', name: 'Made-up sundry', type: 'asset', active: true }, 'PUT');
      now = await fileOf(a.id, FY);
      expect(now.signoffs.prepared.changed).toBe(true);
      // The account's own tick says so too (its balance is the same; what it is isn't).
      expect(now.lines.find((l: { accountId: string }) => l.accountId === sundry.id).prepared.changed).toBe(true);
      await a.books.post(`/api/accounts/${sundry.id}`, { code: '6995', name: 'Made-up sundry', type: 'expense', active: true }, 'PUT');
      // Each sign-off keeps the trial balance it was given against.
      const [kept] = await p.practice.sql<{ tb: { id: string; balanceCents: number }[] }[]>`select tb from practice_signoffs where client_id = ${a.id} and fy_end = ${FY} and role = 'prepared'`;
      expect(kept!.tb.some((x) => x.id === sundry.id && x.balanceCents === 50_000)).toBe(true);
    });

    it('the trial balance’s totals, on screen and in the year’s file, which says to keep the final set with it (para 38(c))', async () => {
      const file = await fileOf(a.id, FY);
      expect(file.totals.differenceCents).toBe(0);
      expect(file.totals.debitCents).toBe(file.totals.creditCents);
      expect(file.totals.debitCents).toBeGreaterThan(0);
      expect(file.statements).toEqual({ status: 'draft', compiledOn: null, approvedOn: null });
      const text = await pdfText((await p.owner.call({ method: 'GET', url: `/api/practice/clients/${a.id}/file/pdf?fy=${FY}` })).rawPayload);
      expect(text).toMatch(/Debit Credit/);
      expect(text).toMatch(/Total/);
      expect(text).toMatch(/not compiled yet, not approved yet/);
      expect(text).toMatch(/Keep a copy of the final set and the compilation report with this file \(ISRS 4410 \(Revised\) para 38\(c\)\)/);
      expect(text).toMatch(/an aid towards the practice’s record of the engagement/);
    });

    it('the compile form says when the books have moved since the engagement partner signed off', async () => {
      await sign(a.id, 'partner');
      expect((await a.books.get(`/api/statements/${FY}`)).practice).toMatchObject({ signed: { partner: true, reviewed: false }, changed: { partner: false } });
      await a.books.post('/api/journals', { date: '2026-01-15', description: 'Made-up late rent', lines: [{ accountId: await (await ref(a.books.sql)).acc('rent'), debitCents: 2_000 }, { accountId: await (await ref(a.books.sql)).acc('bank'), creditCents: 2_000 }] });
      expect((await a.books.get(`/api/statements/${FY}`)).practice).toMatchObject({ changed: { partner: true } });
      // The practice's list says it from the client's last checks: checks from before the sign-off say nothing of it.
      const listed = async () => (await p.owner.get('/api/practice')).clients.find((x: { id: string }) => x.id === a.id).papers;
      expect((await listed()).changed.partner).toBe(false);
      await p.owner.post(`/api/practice/clients/${a.id}/checks`, {});
      expect(await listed()).toMatchObject({ signed: { partner: true }, changed: { partner: true } });
      // Signed off again, as the books are now: unchanged until they move again.
      await sign(a.id, 'partner');
      await p.owner.post(`/api/practice/clients/${a.id}/checks`, {});
      expect((await listed()).changed.partner).toBe(false);
    });

    it('a note raised after the sign-offs takes back the review and the partner’s, each logged', async () => {
      await sign(a.id, 'reviewed');
      await sign(a.id, 'partner');
      const raised = await p.owner.post<{ id: string; removed: string[] }>(`/api/practice/clients/${a.id}/file/notes`, { fyEnd: FY, text: 'Made-up: the late rent?' });
      expect(raised.removed.sort()).toEqual(['partner', 'reviewed']);
      const file = await fileOf(a.id, FY);
      expect([file.signoffs.reviewed, file.signoffs.partner]).toEqual([null, null]);
      const logged = await p.practice.sql<{ role: string }[]>`select details->>'role' as role from audit_log where action = 'file_signoff_removed' and details->>'note' = ${raised.id}`;
      expect(logged.map((x) => x.role).sort()).toEqual(['partner', 'reviewed']);
      await p.owner.post(`/api/practice/clients/${a.id}/file/notes/${raised.id}/clear`, { cleared: true });
    });

    it(`a year takes ${NOTES_PER_YEAR} notes, a note ${REPLIES_PER_NOTE} replies`, async () => {
      const [owner] = await p.practice.sql<{ id: string }[]>`select id from users where email = 'owner@example.co.za'`;
      await p.practice.sql`insert into practice_notes (client_id, fy_end, text, raised_by, cleared_by, cleared_at) select ${a.id}, ${PRIOR}, 'Made-up ' || n, ${owner!.id}, ${owner!.id}, now() from generate_series(1, ${NOTES_PER_YEAR}) n`;
      const more = await p.owner.call({ method: 'POST', url: `/api/practice/clients/${a.id}/file/notes`, payload: { fyEnd: PRIOR, text: 'One too many' } });
      expect([more.statusCode, more.json().error]).toEqual([400, expect.stringMatching(/review notes at most/)]);
      const { id } = await p.owner.post<{ id: string }>(`/api/practice/clients/${a.id}/file/notes`, { fyEnd: FY, text: 'Made-up: many answers' });
      await p.practice.sql`insert into practice_note_replies (note_id, text, by_user) select ${id}, 'Made-up ' || n, ${owner!.id} from generate_series(1, ${REPLIES_PER_NOTE}) n`;
      const reply = await p.owner.call({ method: 'POST', url: `/api/practice/clients/${a.id}/file/notes/${id}/replies`, payload: { text: 'One too many' } });
      expect([reply.statusCode, reply.json().error]).toEqual([400, expect.stringMatching(/replies at most/)]);
      await p.owner.post(`/api/practice/clients/${a.id}/file/notes/${id}/clear`, { cleared: true });
    });

    it(`a year’s notes and replies run to ${YEAR_NOTES_MAX_CHARS} characters at most, so its file’s PDF stays quick`, async () => {
      const c = await client('Made-up Client E (Pty) Ltd');
      await journal(c.books, '2025-06-01', 'bank', 'owner_loan', 100_000);
      const [owner] = await p.practice.sql<{ id: string }[]>`select id from users where email = 'owner@example.co.za'`;
      // Filled to the cap with unbroken words, the slowest kind to lay out: 49 notes of 4,000 characters, and replies.
      await p.practice.sql`insert into practice_notes (client_id, fy_end, text, raised_by) select ${c.id}, ${FY}, repeat('x', 4000), ${owner!.id} from generate_series(1, 49)`;
      const [n] = await p.practice.sql<{ id: string }[]>`select id from practice_notes where client_id = ${c.id} limit 1`;
      await p.practice.sql`insert into practice_note_replies (note_id, text, by_user) select ${n!.id}, repeat('y', 999), ${owner!.id} from generate_series(1, 3)`;
      const full = await p.owner.call({ method: 'POST', url: `/api/practice/clients/${c.id}/file/notes`, payload: { fyEnd: FY, text: 'x'.repeat(1004) } });
      expect([full.statusCode, full.json().error]).toEqual([400, expect.stringMatching(/characters at most, all together: this year has 1[\s ]?003 left/)]);
      const reply = await p.owner.call({ method: 'POST', url: `/api/practice/clients/${c.id}/file/notes/${n!.id}/replies`, payload: { text: 'z'.repeat(1004) } });
      expect(reply.statusCode).toBe(400);
      await p.owner.post(`/api/practice/clients/${c.id}/file/notes/${n!.id}/replies`, { text: 'z'.repeat(1003) });
      const started = performance.now();
      const pdf = await p.owner.call({ method: 'GET', url: `/api/practice/clients/${c.id}/file/pdf?fy=${FY}` });
      const took = performance.now() - started;
      expect(pdf.statusCode).toBe(200);
      expect(took).toBeLessThan(3_000);
      await p.practice.sql`update practice_notes set cleared_by = ${owner!.id}, cleared_at = now() where client_id = ${c.id}`;
    });

    it('notes and replies sent at once don’t pass the year’s cap together, and the refusal never says a negative number', async () => {
      const c = await client('Made-up Client F (Pty) Ltd');
      await journal(c.books, '2025-06-01', 'bank', 'owner_loan', 100_000);
      const [owner] = await p.practice.sql<{ id: string }[]>`select id from users where email = 'owner@example.co.za'`;
      // 196,000 characters: room for one more of 4,000.
      await p.practice.sql`insert into practice_notes (client_id, fy_end, text, raised_by) select ${c.id}, ${FY}, repeat('x', 4000), ${owner!.id} from generate_series(1, 49)`;
      const [n] = await p.practice.sql<{ id: string }[]>`select id from practice_notes where client_id = ${c.id} limit 1`;
      const sent = await Promise.all([
        ...Array.from({ length: 12 }, () => p.owner.call({ method: 'POST', url: `/api/practice/clients/${c.id}/file/notes`, payload: { fyEnd: FY, text: 'n'.repeat(4000) } })),
        ...Array.from({ length: 12 }, () => p.owner.call({ method: 'POST', url: `/api/practice/clients/${c.id}/file/notes/${n!.id}/replies`, payload: { text: 'r'.repeat(4000) } })),
      ]);
      expect(sent.filter((r) => r.statusCode === 200)).toHaveLength(1);
      for (const r of sent.filter((x) => x.statusCode !== 200)) expect(r.json().error).toMatch(/this year has none left\.$/);
      const [total] = await p.practice.sql<{ used: number }[]>`
        select (select sum(length(text)) from practice_notes where client_id = ${c.id})::int + coalesce((select sum(length(r.text)) from practice_note_replies r join practice_notes x on x.id = r.note_id where x.client_id = ${c.id}), 0)::int as used`;
      expect(total!.used).toBe(YEAR_NOTES_MAX_CHARS);
      await p.practice.sql`update practice_notes set cleared_by = ${owner!.id}, cleared_at = now() where client_id = ${c.id}`;
    });

    it('a letter isn’t sent with no practice named', async () => {
      const [s] = await p.practice.sql<{ companyName: string; tradingName: string }[]>`select company_name, trading_name from settings`;
      await p.practice.sql`update settings set company_name = '', trading_name = ''`;
      const lid = await letter(a.id, ['vat'], FY);
      await p.practice.sql`update settings set company_name = ${s!.companyName}, trading_name = ${s!.tradingName}`;
      const r = await p.owner.call({ method: 'POST', url: `/api/practice/clients/${a.id}/letters/${lid}/sent`, payload: {} });
      expect([r.statusCode, r.json().error]).toEqual([400, expect.stringMatching(/^Name your practice in the letter first/)]);
      await p.owner.post(`/api/practice/clients/${a.id}/letters/${lid}`, {}, 'DELETE');
    });

    it('the practice’s audit log keeps no account or balance of a tick (people not given the client read it)', async () => {
      const rows = await p.practice.sql<{ details: Record<string, unknown> }[]>`select details from audit_log where action in ('file_tick', 'file_untick')`;
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(Object.keys(r.details).sort()).toEqual(['fyEnd', 'which']);
      const acc = await login(p.practice.app, 'accountant@example.co.za');
      for (const url of ['/api/audit', '/api/audit.csv']) {
        const r = await acc.call({ method: 'GET', url });
        expect(r.statusCode).toBe(200);
        expect(r.body).not.toMatch(/balanceCents/);
      }
    });

    it('the year-end month changes: the years before stay open, at their own twelve months, and the page opens', async () => {
      const c = await client('Made-up Client C (Pty) Ltd');
      await journal(c.books, '2025-06-01', 'bank', 'owner_loan', 300_000);
      await journal(c.books, '2025-10-01', 'rent', 'bank', 40_000);
      await sign(c.id, 'prepared');
      await sign(c.id, 'partner');
      const s = (await c.books.get('/api/reference')).settings;
      await c.books.post('/api/settings', { ...s, fyEndMonth: 6 }, 'PUT');
      const feb = await p.owner.call({ method: 'GET', url: `/api/practice/clients/${c.id}/file?fy=${FY}` });
      expect(feb.statusCode, feb.body).toBe(200);
      expect(feb.json().signoffs.partner.changed).toBe(false);
      expect((await p.owner.call({ method: 'GET', url: `/api/practice/clients/${c.id}/file/pdf?fy=${FY}` })).statusCode).toBe(200);
      const now = await fileOf(c.id);
      expect(now.years).toEqual(['2026-06-30', FY, '2025-06-30']);
      // Papers on a June year, then back to February: the page still opens, on the latest year with papers.
      await p.owner.post(`/api/practice/clients/${c.id}/file/notes`, { fyEnd: '2026-06-30', text: 'Made-up: June year' });
      await c.books.post('/api/settings', { ...s, fyEndMonth: 2 }, 'PUT');
      const back = await p.owner.call({ method: 'GET', url: `/api/practice/clients/${c.id}/file` });
      expect(back.statusCode, back.body).toBe(200);
      expect(back.json().fyEnd).toBe('2026-06-30');
      const n = back.json().notes[0];
      await p.owner.post(`/api/practice/clients/${c.id}/file/notes/${n.id}/clear`, { cleared: true });
    });

    it('books not yet at a year end: no years to open, and nothing signed off for a year before them', async () => {
      const d = await client('Made-up Client D (Pty) Ltd');
      await journal(d.books, '2026-04-01', 'bank', 'owner_loan', 10_000);
      const file = await fileOf(d.id);
      expect([file.years, file.empty]).toEqual([[], true]);
      // A letter usually comes before the work: it can start from this year's end, or the next.
      expect(file.coming).toEqual(['2028-02-29', '2027-02-28']);
      await letter(d.id, ['books', 'compile'], '2027-02-28');
      const r = await p.owner.call({ method: 'PUT', url: `/api/practice/clients/${d.id}/file/signoffs`, payload: { fyEnd: '2023-02-28', role: 'partner', on: true } });
      expect([r.statusCode, r.json().error]).toEqual([400, 'Choose a year of theirs that has ended.']);
    });
  });
});
