/**
 * Shap Accountant, phase 5 (docs/ACCOUNTANT.md, "Engagement letters and working papers"): a practice
 * agrees its terms with each client in an engagement letter it drafts, sends and records as accepted,
 * looks at again each later year; and keeps working papers for each client's ended year: review notes,
 * each account ticked as prepared and reviewed, the year signed off. All in the practice's own
 * database; checks on its list and the compile form, never locks. All data made up.
 */
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTANT_TERMS_VERSION, LETTER_NOTE } from '@shap/shared';
import type { Sql } from '../../src/db/index.js';
import { expectCleanAudit, login, ref } from '../helpers.js';
import { linkPair, type LinkPair, type Session } from './link-pair.js';

const FY = '2026-02-28';
const PRIOR = '2025-02-28';
const PDF = Buffer.from('%PDF-1.4\n% a made-up signed letter\n').toString('base64');

interface Api {
  get: <T = any>(url: string) => Promise<T>;
  post: <T = any>(url: string, body?: unknown, method?: 'POST' | 'PUT' | 'DELETE') => Promise<T>;
  call: (o: InjectOptions) => ReturnType<Session['call']>;
}

describe('engagement letters and working papers', () => {
  let p: LinkPair;
  let kept: string;
  let keptDb: Sql;
  let books: Api;
  let linked: string;
  let site: Session;
  let siteId: string;
  let accountantId: string;
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

  beforeAll(async () => {
    p = await linkPair('wp');
    await dropClients();
    // A client kept in the practice: a company with a February year end, a year and a bit of books.
    kept = (await p.owner.post<{ id: string }>('/api/practice/clients', { name: 'Made-up Kept Books (Pty) Ltd' })).id;
    const [c] = await p.practice.sql<{ dbName: string }[]>`select db_name from practice_clients where id = ${kept}`;
    keptDb = p.practice.ctx.clients.get(c!.dbName);
    await keptDb`update settings set setup_done = true, features = ${keptDb.json({ brands: true, workers: true, statements: true })}, address = '1 Test Street, Fictional Town, 0001'`;
    await keptDb`insert into brands (name, sort) select company_name, 1 from settings`;
    await keptDb`update settings set default_brand_id = (select id from brands limit 1)`;
    const k = await p.owner.call({ method: 'POST', url: `/api/practice/clients/${kept}/open`, payload: {} });
    const cookies = Object.fromEntries(k.cookies.filter((x) => x.value).map((x) => [x.name, x.value]));
    const call = (o: InjectOptions) => p.owner.call({ ...o, cookies });
    books = {
      call,
      get: async (url) => (await call({ method: 'GET', url })).json(),
      post: async (url, body = {}, method = 'POST') => {
        const r = await call({ method, url, payload: body as never });
        if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
        return r.json();
      },
    };
    const { settings } = await books.get('/api/reference');
    await books.post('/api/settings', { ...settings, companyName: 'Made-up Kept Books (Pty) Ltd', regNumber: '2020/000001/07', businessType: 'company', fyEndMonth: 2 }, 'PUT');
    const r = await ref(keptDb);
    await books.post('/api/journals', { date: '2025-06-01', description: 'Made-up capital', lines: [{ accountId: await r.acc('bank'), debitCents: 500_000 }, { accountId: await r.acc('owner_loan'), creditCents: 500_000 }] });
    await books.post('/api/journals', { date: '2025-07-01', description: 'Made-up rent', lines: [{ accountId: await r.acc('rent'), debitCents: 120_000 }, { accountId: await r.acc('bank'), creditCents: 120_000 }] });
    await p.owner.post(`/api/practice/clients/${kept}/checks`, {});
    // The practice's site staff writes up the kept client; its accountant (read-only) can't be given one.
    siteId = (await p.practice.sql<{ id: string }[]>`select id from users where email = 'site@example.co.za'`)[0]!.id;
    accountantId = (await p.practice.sql<{ id: string }[]>`select id from users where email = 'accountant@example.co.za'`)[0]!.id;
    await p.practice.sql`update users set access_add = '{practice.clients}' where id = ${siteId}`;
    await p.owner.post(`/api/practice/clients/${kept}/access`, { access: [{ userId: siteId, level: 'books' }] }, 'PUT');
    site = await login(p.practice.app, 'site@example.co.za');
    // And one on its own Shap, linked.
    linked = await p.link('books');
  });
  afterAll(async () => {
    await expectCleanAudit(keptDb);
    await expectCleanAudit(p.own.sql);
    await expectCleanAudit(p.practice.sql);
    await p.practice.ctx.clients.end();
    await dropClients();
    await p.close();
  });

  it('drafts a letter from the client’s details, covering what ISRS 4410 asks the terms to say, for whoever manages the clients', async () => {
    // Someone given the client, without managing the practice's clients, reads the letters but doesn't make them.
    expect((await site.call({ method: 'POST', url: `/api/practice/clients/${kept}/letters`, payload: { services: ['compile'], fromYearEnd: FY } })).statusCode).toBe(403);
    expect((await p.owner.call({ method: 'POST', url: `/api/practice/clients/${kept}/letters`, payload: { services: ['compile'], fromYearEnd: '2026-03-31' } })).statusCode).toBe(400);
    expect((await p.owner.call({ method: 'POST', url: `/api/practice/clients/${kept}/letters`, payload: { services: [], fromYearEnd: FY } })).statusCode).toBe(400);
    const { id } = await p.owner.post<{ id: string }>(`/api/practice/clients/${kept}/letters`, { services: ['books', 'vat', 'compile', 'accounting_officer'], fromYearEnd: PRIOR, fees: 'R1 500 a month, made up.', body: 'SAIPA' });
    const { letters, note } = await site.get(`/api/practice/clients/${kept}/letters`);
    expect(note).toBe(LETTER_NOTE);
    const l = letters.find((x: { id: string }) => x.id === id);
    // An accounting officer is a close corporation's: not offered to a company.
    expect(l.services).toEqual(['books', 'vat', 'compile']);
    const text = l.body.map((s: { heading: string; paragraphs: string[] }) => [s.heading, ...s.paragraphs].join(' ')).join(' ');
    // ISRS 4410 (Revised) para 24 (a) to (f).
    for (const said of [
      /Their use\. The annual financial statements are for the directors to approve/,
      /prepared in accordance with the IFRS for SMEs Accounting Standard and the requirements of the Companies Act 71 of 2008/,
      /in accordance with the International Standard on Related Services 4410 \(Revised\), Compilation Engagements/,
      /A compilation is not an assurance engagement: we won’t audit or review them/,
      /comply with the relevant ethical requirements \(SAIPA’s code of professional conduct\)/,
      /The directors are responsible for the financial statements/,
      /approving them \(its board of directors \(Companies Act, section 30\(3\)\(c\)\), signed by a director it authorises\)/,
      /As you approve them, you acknowledge that you’ve taken responsibility for the final version/,
      /Our practitioner’s compilation report goes with them/,
      /We keep your books in Shap, on our practice’s server/,
      /as the Protection of Personal Information Act asks \(sections 19 to 22\)/,
      /R1 500 a month, made up\./,
      /for the year ending 28 February 2025 and every year after it/,
    ])
      expect(text).toMatch(said);
  });

  it('the draft changes as the practice likes; sent, it’s kept as it was, and accepted only after', async () => {
    const { letters } = await p.owner.get(`/api/practice/clients/${kept}/letters`);
    const l = letters[0];
    const body = [...l.body, { heading: 'Made-up extra', paragraphs: ['A paragraph of the practice’s own.'] }];
    await p.owner.post(`/api/practice/clients/${kept}/letters/${l.id}`, { body }, 'PUT');
    const draft = await p.owner.call({ method: 'GET', url: `/api/practice/clients/${kept}/letters/${l.id}/pdf` });
    expect(draft.statusCode).toBe(200);
    const draftText = await pdfText(draft.rawPayload);
    expect(draftText).toMatch(/Draft: not sent yet/);
    expect(draftText).toMatch(/A paragraph of the practice’s own\./);
    expect((await p.owner.call({ method: 'POST', url: `/api/practice/clients/${kept}/letters/${l.id}/accept`, payload: { on: '2026-03-01', name: 'Made-up Director', how: 'recorded' } })).statusCode).toBe(400);
    await p.owner.post(`/api/practice/clients/${kept}/letters/${l.id}/sent`, {});
    expect((await p.owner.call({ method: 'PUT', url: `/api/practice/clients/${kept}/letters/${l.id}`, payload: { body } })).statusCode).toBe(400);
    expect((await p.owner.call({ method: 'DELETE', url: `/api/practice/clients/${kept}/letters/${l.id}` })).statusCode).toBe(400);
    // Accepted on a day before it was sent, or after today, isn't.
    for (const on of ['2020-01-01', '2999-01-01']) expect((await p.owner.call({ method: 'POST', url: `/api/practice/clients/${kept}/letters/${l.id}/accept`, payload: { on, name: 'Made-up Director', how: 'recorded' } })).statusCode).toBe(400);
    // A signed copy: the file is checked, and kept with the letter.
    expect((await p.owner.call({ method: 'POST', url: `/api/practice/clients/${kept}/letters/${l.id}/accept`, payload: { on: new Date().toISOString().slice(0, 10), name: 'Made-up Director', how: 'signed' } })).statusCode).toBe(400);
    expect((await p.owner.call({ method: 'POST', url: `/api/practice/clients/${kept}/letters/${l.id}/accept`, payload: { on: new Date().toISOString().slice(0, 10), name: 'Made-up Director', how: 'signed', signed: { filename: 'x.pdf', mime: 'application/pdf', dataBase64: Buffer.from('not a pdf at all').toString('base64') } } })).statusCode).toBe(400);
    await p.owner.post(`/api/practice/clients/${kept}/letters/${l.id}/accept`, { on: new Date().toISOString().slice(0, 10), name: 'Made-up Director', capacity: 'Director', how: 'signed', signed: { filename: 'signed letter.pdf', mime: 'application/pdf', dataBase64: PDF } });
    const signed = await site.call({ method: 'GET', url: `/api/practice/clients/${kept}/letters/${l.id}/signed` });
    expect([signed.statusCode, signed.headers['content-type']]).toEqual([200, 'application/pdf']);
    expect(signed.rawPayload.toString('base64')).toBe(PDF);
    const final = await pdfText((await p.owner.call({ method: 'GET', url: `/api/practice/clients/${kept}/letters/${l.id}/pdf` })).rawPayload);
    expect(final).toMatch(/Signed by Made-up Director, Director, on/);
    // Ended letters stay; a draft goes.
    const extra = await p.owner.post<{ id: string }>(`/api/practice/clients/${kept}/letters`, { services: ['payroll'], fromYearEnd: FY });
    await p.owner.post(`/api/practice/clients/${kept}/letters/${extra.id}`, {}, 'DELETE');
    expect((await p.owner.get(`/api/practice/clients/${kept}/letters`)).letters).toHaveLength(1);
  });

  it('a recurring engagement: each later year its terms are looked at again (ISRS 4410 para 26), said on the list until they are', async () => {
    const clientOf = async () => (await p.owner.get('/api/practice')).clients.find((x: { id: string }) => x.id === kept);
    // The letter is from the year to February 2025: the year to February 2026 is the latest ended.
    expect((await clientOf()).papers).toMatchObject({ fyEnd: FY, letter: 'accepted', compiling: true, termsLooked: false, openNotes: 0 });
    const { letters } = await p.owner.get(`/api/practice/clients/${kept}/letters`);
    expect((await p.owner.call({ method: 'POST', url: `/api/practice/clients/${kept}/letters/${letters[0].id}/years`, payload: { fyEnd: PRIOR } })).statusCode).toBe(400);
    await p.owner.post(`/api/practice/clients/${kept}/letters/${letters[0].id}/years`, { fyEnd: FY });
    expect((await clientOf()).papers).toMatchObject({ termsLooked: true });
    // In the client's books, the compile form is told what the practice has recorded for that year.
    expect((await books.get(`/api/statements/${FY}`)).practice).toMatchObject({ compiling: true, termsLooked: true, signed: { partner: false } });
  });

  it('ticks each account at the year end as prepared and reviewed, and says when its balance has changed since', async () => {
    const file = await site.get(`/api/practice/clients/${kept}/file`);
    expect(file.years[0]).toBe(FY);
    expect(file.ticksHere).toBe(true);
    const [bankAcc] = await keptDb<{ code: string }[]>`select code from accounts where system_key = 'bank'`;
    const bank = file.lines.find((l: { code: string }) => l.code === bankAcc!.code);
    expect(bank.balanceCents).toBe(380_000);
    await site.post(`/api/practice/clients/${kept}/file/ticks`, { fyEnd: FY, code: bank.code, which: 'prepared', on: true });
    // Reviewing by the same person is said, not refused (a sole practitioner reviews their own).
    await site.post(`/api/practice/clients/${kept}/file/ticks`, { fyEnd: FY, code: bank.code, which: 'reviewed', on: true });
    let now = await site.get(`/api/practice/clients/${kept}/file`);
    expect(now.lines.find((l: { code: string }) => l.code === bank.code).reviewed).toMatchObject({ by: 'Site', samePerson: true, changed: false });
    await p.owner.post(`/api/practice/clients/${kept}/file/ticks`, { fyEnd: FY, code: bank.code, which: 'reviewed', on: true });
    // Someone given the client to compile reviews, but doesn't tick as prepared.
    await p.owner.post(`/api/practice/clients/${kept}/access`, { access: [{ userId: siteId, level: 'compile' }] }, 'PUT');
    expect((await site.call({ method: 'POST', url: `/api/practice/clients/${kept}/file/ticks`, payload: { fyEnd: FY, code: bank.code, which: 'prepared', on: true } })).statusCode).toBe(403);
    // A tick is taken off by whoever made it, or an owner.
    expect((await site.call({ method: 'POST', url: `/api/practice/clients/${kept}/file/ticks`, payload: { fyEnd: FY, code: bank.code, which: 'reviewed', on: false } })).statusCode).toBe(403);
    await p.owner.post(`/api/practice/clients/${kept}/access`, { access: [{ userId: siteId, level: 'books' }] }, 'PUT');
    // The books move after the ticks: the ticks say so.
    const r = await ref(keptDb);
    await books.post('/api/journals', { date: '2026-02-01', description: 'Made-up late rent', lines: [{ accountId: await r.acc('rent'), debitCents: 5_000 }, { accountId: await r.acc('bank'), creditCents: 5_000 }] });
    now = await site.get(`/api/practice/clients/${kept}/file`);
    expect(now.lines.find((l: { code: string }) => l.code === bank.code)).toMatchObject({ balanceCents: 375_000, prepared: { changed: true }, reviewed: { by: 'Owner', changed: true } });
    expect((await p.owner.call({ method: 'POST', url: `/api/practice/clients/${kept}/file/ticks`, payload: { fyEnd: FY, code: '9999', which: 'prepared', on: true } })).statusCode).toBe(400);
    expect((await p.owner.call({ method: 'POST', url: `/api/practice/clients/${kept}/file/ticks`, payload: { fyEnd: '2027-02-28', code: bank.code, which: 'prepared', on: true } })).statusCode).toBe(400);
  });

  it('review notes: raised, answered, cleared by whoever raised them; the year isn’t signed off as reviewed over one still open', async () => {
    const { id } = await p.owner.post<{ id: string }>(`/api/practice/clients/${kept}/file/notes`, { fyEnd: FY, account: { code: '1000', name: 'Bank' }, text: 'Made-up: where’s the February bank statement?' });
    await site.post(`/api/practice/clients/${kept}/file/notes/${id}/replies`, { text: 'Made-up: on file now, matched.' });
    await site.post(`/api/practice/clients/${kept}/file/signoffs`, { fyEnd: FY, role: 'prepared', on: true }, 'PUT');
    const open = await p.owner.call({ method: 'PUT', url: `/api/practice/clients/${kept}/file/signoffs`, payload: { fyEnd: FY, role: 'reviewed', on: true } });
    expect([open.statusCode, open.json().error]).toEqual([400, expect.stringMatching(/review notes still open/)]);
    // Not cleared by whoever answered it, unless they raised it (or are an owner).
    expect((await site.call({ method: 'POST', url: `/api/practice/clients/${kept}/file/notes/${id}/clear`, payload: { cleared: true } })).statusCode).toBe(403);
    await p.owner.post(`/api/practice/clients/${kept}/file/notes/${id}/clear`, { cleared: true });
    expect((await site.call({ method: 'POST', url: `/api/practice/clients/${kept}/file/notes/${id}/replies`, payload: { text: 'late' } })).statusCode).toBe(400);
    await p.owner.post(`/api/practice/clients/${kept}/file/signoffs`, { fyEnd: FY, role: 'reviewed', on: true }, 'PUT');
    // The engagement partner is an owner.
    expect((await site.call({ method: 'PUT', url: `/api/practice/clients/${kept}/file/signoffs`, payload: { fyEnd: FY, role: 'partner', on: true } })).statusCode).toBe(403);
    await p.owner.post(`/api/practice/clients/${kept}/file/signoffs`, { fyEnd: FY, role: 'partner', on: true }, 'PUT');
    let file = await site.get(`/api/practice/clients/${kept}/file`);
    expect(file.signoffs).toMatchObject({ prepared: { by: 'Site', changed: false }, reviewed: { by: 'Owner' }, partner: { by: 'Owner' } });
    expect(file.notes[0]).toMatchObject({ account: { code: '1000' }, cleared: { by: 'Owner' }, replies: [{ by: 'Site', text: 'Made-up: on file now, matched.' }] });
    expect((await p.owner.get('/api/practice')).clients.find((x: { id: string }) => x.id === kept).papers).toMatchObject({ openNotes: 0, signed: { prepared: true, reviewed: true, partner: true } });
    // The books move: the sign-offs say so. A note opened again takes back the review and the partner's.
    const r = await ref(keptDb);
    await books.post('/api/journals', { date: '2026-02-02', description: 'Made-up correction', lines: [{ accountId: await r.acc('rent'), debitCents: 1_000 }, { accountId: await r.acc('bank'), creditCents: 1_000 }] });
    file = await site.get(`/api/practice/clients/${kept}/file`);
    expect(file.signoffs.partner.changed).toBe(true);
    await p.owner.post(`/api/practice/clients/${kept}/file/notes/${id}/clear`, { cleared: false });
    file = await site.get(`/api/practice/clients/${kept}/file`);
    expect([file.signoffs.prepared?.by, file.signoffs.reviewed, file.signoffs.partner]).toEqual(['Site', null, null]);
    // The year's file, as the practice keeps it.
    const pdf = await site.call({ method: 'GET', url: `/api/practice/clients/${kept}/file/pdf?fy=${FY}` });
    expect(pdf.statusCode).toBe(200);
    const text = await pdfText(pdf.rawPayload);
    for (const said of [/Working papers: Made-up Kept Books \(Pty\) Ltd/, /Prepared: Site/, /Reviewed: not yet/, /where’s the February bank statement\?/, /Made-up: on file now, matched\./, /An accepted letter covers compiling the statements for this year\./]) expect(text).toMatch(said);
    await p.owner.post(`/api/practice/clients/${kept}/file/notes/${id}/clear`, { cleared: true });
  });

  it('a client on its own Shap: letters, notes and sign-offs, but its trial balance stays there', async () => {
    const file = await p.owner.get(`/api/practice/clients/${linked}/file`);
    expect([file.ticksHere, file.lines]).toEqual([false, null]);
    expect(file.years).toHaveLength(4);
    expect((await p.owner.call({ method: 'POST', url: `/api/practice/clients/${linked}/file/ticks`, payload: { fyEnd: file.fyEnd, code: '1000', which: 'prepared', on: true } })).statusCode).toBe(400);
    await p.owner.post(`/api/practice/clients/${linked}/file/notes`, { fyEnd: file.fyEnd, text: 'Made-up: ask them for the loan agreement.' });
    const { id } = await p.owner.post<{ id: string }>(`/api/practice/clients/${linked}/letters`, { services: ['compile'], fromYearEnd: file.fyEnd });
    const l = (await p.owner.get(`/api/practice/clients/${linked}/letters`)).letters.find((x: { id: string }) => x.id === id);
    expect(l.body.map((s: { paragraphs: string[] }) => s.paragraphs.join(' ')).join(' ')).toMatch(/You keep your books in your own Shap and have linked our practice to it/);
    // Nothing of it went to their Shap.
    expect(await p.own.sql`select 1 from audit_log where action like 'letter%' or action like 'file%'`).toHaveLength(0);
  });

  it('only for who may open the client; an archived client’s papers are read, not changed', async () => {
    const [nobody] = await p.practice.sql<{ id: string }[]>`select id from users where email = 'accountant@example.co.za'`;
    expect(nobody!.id).toBe(accountantId);
    const acc = await login(p.practice.app, 'accountant@example.co.za');
    for (const url of [`/api/practice/clients/${kept}/file`, `/api/practice/clients/${kept}/letters`]) expect((await acc.call({ method: 'GET', url })).statusCode).toBe(403);
    await p.owner.post(`/api/practice/clients/${kept}/access`, { access: [] }, 'PUT');
    expect((await site.call({ method: 'GET', url: `/api/practice/clients/${kept}/file` })).statusCode).toBe(403);
    // Inside a client's books, the practice's own records aren't reached.
    const inside = await books.call({ method: 'GET', url: `/api/practice/clients/${kept}/file` });
    expect(inside.statusCode, inside.body).toBe(403);
    await p.owner.post(`/api/practice/clients/${kept}/archive`, { archived: true });
    expect((await p.owner.call({ method: 'GET', url: `/api/practice/clients/${kept}/file` })).statusCode).toBe(200);
    expect((await p.owner.call({ method: 'POST', url: `/api/practice/clients/${kept}/file/notes`, payload: { fyEnd: FY, text: 'x' } })).statusCode).toBe(400);
    await p.owner.post(`/api/practice/clients/${kept}/archive`, { archived: false });

  });

  it('a wipe of the practice’s own books keeps its letters and working papers about its clients', async () => {
    const before = await p.practice.sql`select count(*)::int as n from practice_letters`;
    const notes = await p.practice.sql`select count(*)::int as n from practice_notes`;
    const { names } = await p.owner.get('/api/wipe');
    const r = await p.owner.call({ method: 'POST', url: '/api/wipe', payload: { password: 'test-password-1', name: names[0] } });
    expect(r.statusCode, r.body).toBe(200);
    expect(await p.practice.sql`select count(*)::int as n from practice_letters`).toEqual(before);
    expect(await p.practice.sql`select count(*)::int as n from practice_notes`).toEqual(notes);
    const [signed] = await p.practice.sql<{ n: number }[]>`select count(*)::int as n from practice_letters where signed_bytes is not null`;
    expect(signed!.n).toBe(1);
    // Set up again, as it was, for what follows.
    await p.owner.post('/api/practice/terms', { version: ACCOUNTANT_TERMS_VERSION });
    const s = (await p.owner.get('/api/reference')).settings;
    await p.owner.post('/api/settings', { ...s, companyName: 'Made-up Practice Inc', setupDone: true, features: { ...s.features, practice: true } }, 'PUT');
  });
});
