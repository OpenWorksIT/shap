import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, financialYear } from '@shap/shared';
import { today } from '../../src/lib/books.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

// The eighth round of 1.33's reviews (words): what the seventh round's words say that the code
// doesn't do, or say unplainly. Made-up business, names and figures. Each fails on 0c02c9e.

const root = join(__dirname, '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const now = today();

describe('the move refusals (words)', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await env.sql`update settings set lock_date = null where id`;
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('don’t call a closed month “a closed year”', async () => {
    const owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    const { settings } = await owner.get('/api/reference');
    const fy = financialYear(now, settings.fyEndMonth);
    // A cost early in this year; the books then closed through it by a month end, mid-year.
    const day = addDays(fy.start, 5);
    await owner.post('/api/costs', { date: day, description: 'Made-up fuel', supplier: 'Made-up Garage', amountCents: 40_000, categoryId: await r.cat('Petrol'), sourceId: bank });
    const monthEnd = addDays(`${day.slice(0, 7)}-01`, 40).slice(0, 7) + '-01';
    await env.sql`update settings set lock_date = ${addDays(monthEnd, -1)}::date where id`;
    const second = await owner.post<{ id: string }>('/api/accounts', { code: '1004', name: 'Made-up Second Bank', type: 'asset', statementLine: 'cash', active: true });
    const res = await owner.call({ method: 'PUT', url: `/api/sources/${bank}`, payload: { name: 'Business bank', kind: 'bank', accountId: second.id } });
    expect(res.statusCode).toBe(400);
    const error = res.json().error as string;
    // This year isn't closed: only the months up to the lock date are.
    expect(error).not.toMatch(/closed year/);
  });

  it('from a company file, keep Settings’ caution about a new account that has something in it', async () => {
    await env.sql`update settings set lock_date = null where id`;
    const owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    await owner.post('/api/costs', { date: now, description: 'Made-up tyres', supplier: 'Made-up Garage', amountCents: 25_000, categoryId: await r.cat('Petrol'), sourceId: bank });
    // A made-up unit trust, off cash, with money in it already.
    const ut = await owner.post<{ id: string }>('/api/accounts', { code: '1079', name: 'Made-up Unit Trust', type: 'asset', statementLine: 'other_current_assets', active: true });
    await owner.post('/api/journals', { date: now, description: 'Made-up unit trust bought', lines: [{ accountId: ut.id, debitCents: 5_000_000 }, { accountId: await r.acc('owner_loan'), creditCents: 5_000_000 }] });
    const settingsRes = await owner.call({ method: 'PUT', url: `/api/sources/${bank}`, payload: { name: 'Business bank', kind: 'bank', accountId: ut.id } });
    const fileRes = await owner.call({
      method: 'POST',
      url: '/api/company-file',
      payload: { password: 'test-password-1', file: { format: 'shap-company/1', sources: [{ name: 'Business bank', kind: 'bank', account: '1079' }] } },
    });
    expect(settingsRes.json().error).toMatch(/if the new account has nothing in it yet/);
    // The file's advice ("give the new account the same line in the file") would put R50 000 of
    // unit trust, and its history, on the cash line: Settings only says so for an empty account.
    expect(fileRes.json().error).toMatch(/nothing in it yet/);
  });
});

describe('the VAT201’s import VAT footer (words, SARS)', () => {
  it('covers import VAT journalled against cash, a card or your own money, as the code leaves those out too', () => {
    const screen = read('apps/web/src/components/TaxForms.tsx');
    const note = screen.slice(screen.indexOf('{data.handVatLines ? ('), screen.indexOf('<section className="panel">', screen.indexOf('{data.handVatLines ? (')));
    const footer = screen.slice(screen.indexOf('export function Vat201'), screen.indexOf('interface TurnoverData')).replace(note, '');
    const sentence = footer.slice(footer.search(/Import VAT journalled/), footer.indexOf('Box 4'));
    // handVat (lib/books.ts): VAT against cash, a card or the owner's loan is a payment as well.
    expect(sentence).toMatch(/card/);
    expect(sentence).toMatch(/own money|owner/);
  });
});

describe('the books audit’s 7.2 deposit words (words)', () => {
  it('have no brackets inside brackets', () => {
    const audit = read('apps/server/src/audit/books.ts');
    const line = audit.split('\n').find((l) => l.includes('cash is a judgement (money you can draw'))!;
    const text = line.replace(/\$\{[^}]*\}/g, 'X');
    let depth = 0;
    let most = 0;
    for (const ch of text) {
      if (ch === '(') most = Math.max(most, ++depth);
      if (ch === ')') depth--;
    }
    expect(most).toBe(1);
  });
});
