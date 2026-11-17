/**
 * The check of the fixes of the 1.29 reviews (CPDAUDIT.md, "The fixes, checked"): a partnership on
 * turnover tax shared from its phone (its partners, and half of an asset's proceeds in turnover,
 * from the records themselves: SARS 3 and 5), and Shap's own accounts in the copy, which keep their
 * ids whatever a share has (check 3). A second database plays the phone (../accountant/phone.ts).
 * All data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { financialYear } from '@shap/shared';
import { taxFigures } from '../../src/modules/yearend.js';
import { buildStatements } from '../../src/statements/build.js';
import { expectCleanAudit } from '../helpers.js';
import { makeShare, practiceAndPhone, tbOf } from '../accountant/phone.js';

const BOOKS = '2d4f6a8c-1b3e-4c5d-8e7f-9a0b1c2d3e4f';
const OTHER = '3e5a7b9d-2c4f-4d6e-9f8a-0b1c2d3e4f5a';

describe('a partnership on turnover tax, shared from its phone', () => {
  let t: Awaited<ReturnType<typeof practiceAndPhone>>;
  let id: string;
  beforeAll(async () => {
    t = await practiceAndPhone(`${new URL(process.env.DATABASE_URL!).pathname.slice(1)}_tt_phone`);
    const { me, r } = t;
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, companyName: 'Made-up Brothers Plumbing', businessType: 'partnership', fyEndMonth: 2, turnoverTax: true, vatRegistered: false, features: { ...settings.features, statements: true } }, 'PUT');
    await me.post('/api/partners', { name: 'Made-up Sipho', shareBp: 6_000, active: true });
    await me.post('/api/partners', { name: 'Made-up Andile', shareBp: 4_000, active: true });
    const client = await me.post('/api/clients', { name: 'Made-up Body Corporate' });
    const inv = await me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: '2026-05-05', lines: [{ category: 'labour', description: 'Geyser (made up)', qty: 1, unitPriceCents: 800_000 }] });
    await me.post(`/api/documents/${inv.id}/issue`);
    await me.post(`/api/documents/${inv.id}/receipts`, { date: '2026-05-20', amountCents: 800_000, sourceId: await r.src('Business bank') });
    // A bakkie bought last year and sold this one: half of what it brought in is turnover.
    await me.post('/api/assets', { name: 'Made-up bakkie', category: 'vehicles', purchaseDate: '2025-04-01', costCents: 10_000_000, sourceId: await r.src('Business bank'), lifeMonths: 60, disposedOn: '2026-06-30', disposalProceedsCents: 6_000_000, disposalSourceId: await r.src('Business bank') });
    id = await t.client('Made-up Brothers Plumbing');
  });
  afterAll(async () => {
    await expectCleanAudit(t.phone.sql, '2026-11-17');
    await t.close();
  });

  it('the copy’s turnover tax is the phone’s: its partners, and half the bakkie’s proceeds (SARS 3, 5)', async () => {
    const one = await t.bringIn(id, await makeShare(t.phone.sql, { number: 1, madeAt: '2026-11-10T08:00:00.000Z', through: '2026-11-10', books: BOOKS }));
    expect(one.statusCode, one.body).toBe(200);
    const db = await t.copyOf(id);
    const fy = financialYear('2026-11-10', 2);
    const theirs = await taxFigures(t.phone.sql, 'partnership', fy);
    expect(theirs.partners).toEqual([{ name: 'Made-up Sipho', shareBp: 6_000 }, { name: 'Made-up Andile', shareBp: 4_000 }]);
    expect(await taxFigures(db, 'partnership', fy)).toEqual(theirs);
    const url = '/api/reports/turnover-tax?fyEnd=2027-02-28&asAt=2026-10-31';
    const phoneTt = await t.me.get(url);
    const copyTt = (await (await t.open(id, 'compile')).get(url)).json();
    expect(copyTt).toEqual(phoneTt);
    // R8 000 of work and half the R60 000 the bakkie brought in.
    expect(JSON.stringify(phoneTt)).toContain(String(800_000 + 3_000_000));
    expect(await tbOf(db, '2026-11-10')).toEqual(await tbOf(t.phone.sql, '2026-11-10'));
    await expectCleanAudit(db, '2026-11-17');
  });
});

describe('Shap’s own accounts in a Pocket client’s copy (check 3)', () => {
  let t: Awaited<ReturnType<typeof practiceAndPhone>>;
  beforeAll(async () => {
    t = await practiceAndPhone(`${new URL(process.env.DATABASE_URL!).pathname.slice(1)}_sys_phone`);
    const { settings } = await t.me.get('/api/reference');
    await t.me.post('/api/settings', { ...settings, companyName: 'Made-up Tools (Pty) Ltd', businessType: 'company', fyEndMonth: 2 }, 'PUT');
  });
  afterAll(async () => {
    await expectCleanAudit(t.phone.sql, '2026-11-17');
    await t.close();
  });

  it('keep their ids whatever a share has: one left out stays, and the copy’s figures are the phone’s', async () => {
    const id = await t.client('Made-up Tools (Pty) Ltd');
    const db = await t.copyOf(id);
    const receivables = async () => (await db<{ id: string; code: string }[]>`select id, code from accounts where system_key = 'receivables'`)[0];
    const before = await receivables();
    // A share without the receivables account (doctored, or from a Pocket without it).
    const doctored = await makeShare(t.phone.sql, { number: 1, madeAt: '2026-11-10T08:00:00.000Z', through: '2026-11-10', books: BOOKS });
    doctored.records.accounts = doctored.records.accounts!.filter((a) => a.system_key !== 'receivables');
    const one = await t.bringIn(id, doctored);
    expect(one.statusCode, one.body).toBe(200);
    expect(await receivables()).toEqual(before);
    // The phone invoices; the genuine shares after it come in, and the copy, through the app's own
    // connections, has what the phone has (a receivables account that changed its id wouldn't).
    const client = await t.me.post('/api/clients', { name: 'Made-up Customer' });
    const inv = await t.me.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: '2026-11-11', lines: [{ category: 'labour', description: 'Made-up job', qty: 1, unitPriceCents: 50_000 }] });
    await t.me.post(`/api/documents/${inv.id}/issue`);
    for (let n = 2; n <= 4; n++) {
      const res = await t.bringIn(id, await makeShare(t.phone.sql, { number: n, madeAt: `2026-11-1${n}T08:00:00.000Z`, through: '2026-11-16', books: BOOKS }));
      expect(res.statusCode, res.body).toBe(200);
    }
    expect(await receivables()).toEqual(before);
    expect(await tbOf(db, '2026-11-16')).toEqual(await tbOf(t.phone.sql, '2026-11-16'));
    expect(new Map(await tbOf(db, '2026-11-16')).get(before!.code)).toBe(50_000);
    await expectCleanAudit(db, '2026-11-17');
  });

  it('a share that gives one of Shap’s own accounts’ codes to another account, leaving Shap’s out, is refused', async () => {
    const id = await t.client('Made-up Tools clash');
    const clash = await makeShare(t.phone.sql, { number: 1, madeAt: '2026-11-10T08:00:00.000Z', through: '2026-11-10', books: '5a7c9e1b-4d6f-4a8b-9c0d-2e3f4a5b6c7d' });
    const code = clash.records.accounts!.find((a) => a.system_key === 'receivables')!.code;
    clash.records.accounts = clash.records.accounts!.filter((a) => a.system_key !== 'receivables');
    clash.records.accounts.find((a) => !a.system_key)!.code = code;
    const res = await t.bringIn(id, clash);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(new RegExp(`account ${code} is one Shap keeps itself`));
  });

  it('a share with an account Pocket keeps itself that this Shap doesn’t know is refused', async () => {
    const id = await t.client('Made-up Tools again');
    const odd = await makeShare(t.phone.sql, { number: 1, madeAt: '2026-11-10T08:00:00.000Z', through: '2026-11-10', books: OTHER });
    odd.records.accounts!.push({ ...odd.records.accounts!.find((a) => a.system_key === 'suspense')!, id: '4f6b8c0e-3d5a-4e7f-8a9b-1c2d3e4f5a6b', code: '9998', system_key: 'made_up_new' });
    const res = await t.bringIn(id, odd);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/an account Shap Pocket keeps itself that this Shap doesn’t know\. If they’ve updated Shap Pocket, this Shap may need updating too/);
  });
});

describe('a compiled year, and an account renamed on the phone (second check 2)', () => {
  let t: Awaited<ReturnType<typeof practiceAndPhone>>;
  beforeAll(async () => {
    t = await practiceAndPhone(`${new URL(process.env.DATABASE_URL!).pathname.slice(1)}_name_phone`);
  });
  afterAll(async () => {
    await expectCleanAudit(t.phone.sql, '2026-11-17');
    await t.close();
  });

  it('is refused when the statements place the account by its name, and its cash flow would move', async () => {
    const { me, r } = t;
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, companyName: 'Made-up Signed (Pty) Ltd', businessType: 'company', fyEndMonth: 2, features: { ...settings.features, statements: true } }, 'PUT');
    // An account of the plant's, named for its depreciation (the statements add that back by name).
    const dep = await me.post('/api/accounts', { code: '6977', name: 'Made-up depreciation', type: 'expense' });
    const acc = await me.post('/api/accounts', { code: '1577', name: 'Made-up accumulated depreciation', type: 'asset' });
    const loan = await me.post('/api/accounts', { code: '2477', name: 'Made-up loan', type: 'liability' });
    await t.phone.sql`update accounts set statement_line = 'ppe' where id = ${acc.id}`;
    const bank = await r.acc('bank');
    await me.post('/api/journals', { date: '2025-04-01', description: 'Loan in (made up)', lines: [{ accountId: bank, debitCents: 50_000 }, { accountId: loan.id, creditCents: 50_000 }] });
    await me.post('/api/journals', { date: '2025-08-01', description: 'Year-end adjustments (made up)', lines: [{ accountId: dep.id, debitCents: 10_000 }, { accountId: bank, debitCents: 5_000 }, { accountId: acc.id, creditCents: 10_000 }, { accountId: loan.id, creditCents: 5_000 }] });
    const id = await t.client('Made-up Signed (Pty) Ltd');
    const books = '6d4f2b3c-8e5a-4f7b-8c9d-2e3f4a5b6c7d';
    expect((await t.bringIn(id, await makeShare(t.phone.sql, { number: 1, madeAt: '2026-11-10T08:00:00.000Z', through: '2026-11-10', books }))).statusCode).toBe(200);
    const inside = await t.open(id, 'compile');
    const details = (await inside.get('/api/statements/2026-02-28')).json().details;
    expect((await inside.send('PUT', '/api/statements/details', { ...details, directors: [{ name: 'Made-up Director', role: 'Director' }] })).statusCode).toBe(200);
    const compiled = await inside.send('POST', '/api/statements/2026-02-28/compile', { date: '2026-11-15', compiler: { name: 'Made-up Compiler', qualification: 'Professional Accountant (SA)', body: 'SAIPA', number: '00000', practice: 'Made-up Practice' } });
    expect(compiled.statusCode, compiled.body).toBe(200);
    const db = await t.copyOf(id);
    const scf = async () => JSON.stringify((await buildStatements(db, '2026-02-28')).scf);
    const signed = await scf();
    // Renamed on the phone, nothing else: the depreciation would no longer be added back.
    await t.phone.sql`update accounts set name = 'Made-up trailer' where id = ${acc.id}`;
    const two = await t.bringIn(id, await makeShare(t.phone.sql, { number: 2, madeAt: '2026-11-16T08:00:00.000Z', through: '2026-11-16', books, previous: 1 }));
    expect(two.statusCode).toBe(400);
    expect(two.json().error).toMatch(/Share 2 changes what the statements to 28 Feb 2026 show, where they were compiled here: an account’s kind, name or the line it’s shown on/);
    expect(await scf()).toBe(signed);
    // A rename the statements don't place by: it comes in.
    await t.phone.sql`update accounts set name = 'Made-up accumulated depreciation' where id = ${acc.id}`;
    await t.phone.sql`update accounts set name = 'Made-up bank loan' where id = ${loan.id}`;
    const three = await t.bringIn(id, await makeShare(t.phone.sql, { number: 3, madeAt: '2026-11-17T08:00:00.000Z', through: '2026-11-17', books, previous: 1 }));
    expect(three.statusCode, three.body).toBe(200);
    await expectCleanAudit(db, '2026-11-17');
  });
});
