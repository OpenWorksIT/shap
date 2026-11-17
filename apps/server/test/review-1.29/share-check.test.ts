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

  it('a share with an account Pocket keeps itself that this Shap doesn’t know is refused', async () => {
    const id = await t.client('Made-up Tools again');
    const odd = await makeShare(t.phone.sql, { number: 1, madeAt: '2026-11-10T08:00:00.000Z', through: '2026-11-10', books: OTHER });
    odd.records.accounts!.push({ ...odd.records.accounts!.find((a) => a.system_key === 'suspense')!, id: '4f6b8c0e-3d5a-4e7f-8a9b-1c2d3e4f5a6b', code: '9998', system_key: 'made_up_new' });
    const res = await t.bringIn(id, odd);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/an account Shap Pocket keeps itself that this Shap doesn’t know\. If they’ve updated Shap Pocket, this Shap may need updating too/);
  });
});
