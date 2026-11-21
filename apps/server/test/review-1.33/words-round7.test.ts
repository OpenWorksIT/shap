import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNT_TYPE_LABELS, formatDate, formatZar, latePayNote, STATEMENT_LINES, vatPeriod } from '@shap/shared';
import { today } from '../../src/lib/books.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

// The seventh round of 1.33's reviews (words): what the sixth round's words broke or left unsaid.
// Made-up business, names and figures. Each test here but the two marked (holds) fails on aa09d96.

const root = join(__dirname, '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const now = today();

/** The audit log screen's detailText, as it is in AuditLog.tsx (its helpers given). */
function auditDetail(): (d: Record<string, unknown>) => string {
  const src = read('apps/web/src/components/AuditLog.tsx');
  const from = src.indexOf('function accountWords');
  const to = src.indexOf('export function AuditLog');
  const js = ts.transpileModule(src.slice(from, to), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('STATEMENT_LINES', 'ACCOUNT_TYPE_LABELS', 'formatZar', 'formatDate', `${js}; return detailText;`)(STATEMENT_LINES, ACCOUNT_TYPE_LABELS, formatZar, formatDate);
}

describe('the audit log’s new "by" detail (words)', () => {
  const detail = auditDetail();
  it('still says what date the books were locked through', () => {
    // books.ts lockAfterSettings: a month end locking by itself.
    const row = detail({ through: '2026-10-31', was: '2026-09-30', by: 'month end, by itself' });
    expect(row).toMatch(/2026-10-31/);
    expect(row).not.toMatch(/by month end, by itself/);
  });
  it('still names the practice that unlinked', () => {
    expect(detail({ practice: 'Made-up Practice', by: 'the practice' })).toMatch(/Made-up Practice/);
  });
  it('doesn’t show import ids as who did it', () => {
    const row = detail({ kind: 'trial_balance', from: '2026-03-01', to: '2026-03-31', file: 'made-up-tb.csv', by: '4a6c8e0b-2d4f-4a6b-8c0d-1e2f3a4b5c6d,5b7d9f1c-3e5a-4b7c-9d1e-2f3a4b5c6d7e' });
    expect(row).not.toMatch(/by 4a6c8e0b/);
    expect(row).toMatch(/made-up-tb\.csv/);
  });
  it('(holds) names both accounts of a move', () => {
    expect(detail({ name: 'Made-up bank', from: { code: '1000', name: 'Bank', line: 'cash' }, to: { code: '1079', name: 'Made-up Holding', line: 'other_current_assets' }, by: 'the company file' })).toBe(
      'Made-up bank · from 1000 Bank (Cash and cash equivalents) to 1079 Made-up Holding (Other current assets) · by the company file',
    );
  });
});

describe('a company file’s refusal says what to do with the file (words)', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('doesn’t only give Settings’ advice', async () => {
    const owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    await owner.post('/api/costs', { date: now, description: 'Made-up fuel', supplier: 'Made-up Garage', amountCents: 50_000, categoryId: await r.cat('Petrol'), sourceId: bank });
    const res = await owner.call({
      method: 'POST',
      url: '/api/company-file',
      payload: { password: 'test-password-1', file: { format: 'shap-company/1', accounts: [{ code: '1079', name: 'Made-up Holding', type: 'asset', statementLine: 'other_current_assets' }], sources: [{ name: 'Business bank', kind: 'bank', account: '1079' }] } },
    });
    expect(res.statusCode).toBe(400);
    const tail = (res.json().error as string).replace(/^The company file puts “Business bank” \(Paid from \/ into\) on another account\. /, '');
    // What follows is Settings' advice ("make a new payment account for what's coming"), which
    // doesn't get the file in: it should say to change the file, or leave the account out of it.
    expect(tail).toMatch(/\bthe file\b/);
    expect(tail).not.toMatch(/Make a new one|add a new one under/);
    expect(tail).toMatch(/Or, if the new account has nothing in it yet, put it on the same line in the file/);
  });
});

describe('import VAT journalled against the bank (words, SARS)', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('is said on the VAT201 screen when it’s the only journal on the VAT account', async () => {
    const owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const { settings } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4000000002', vatCategory: 'C' }, 'PUT');
    const p = vatPeriod(now, 'C', settings.fyEndMonth);
    // Made-up customs entry: R1 500 import VAT paid to SARS at the border, journalled against the bank.
    await owner.post('/api/journals', { date: p.start, description: 'Made-up import VAT (customs)', lines: [{ accountId: await r.acc('vat'), debitCents: 150_000 }, { accountId: await r.acc('bank'), creditCents: 150_000 }] });
    const ret = await owner.get(`/api/vat/return?on=${p.start}`);
    // No typed-in note (it looks like a payment to SARS) ...
    expect(ret.handVatLines).toBe(0);
    // ... so the import VAT sentence, which is only inside that note, isn't shown: the boxes leave
    // out R1 500 of input tax and nothing on the screen says why. It belongs where it's always shown.
    const screen = read('apps/web/src/components/TaxForms.tsx');
    const note = screen.slice(screen.indexOf('{data.handVatLines ? ('), screen.indexOf('<section className="panel">', screen.indexOf('{data.handVatLines ? (')));
    const rest = screen.slice(screen.indexOf('export function Vat201'), screen.indexOf('interface TurnoverData')).replace(note, '');
    expect(rest).toMatch(/import VAT journalled against the bank/i);
  });
});

describe('the books audit’s new deposit words (words)', () => {
  it('have curly apostrophes, as the typed-in VAT line beside them now does', () => {
    const audit = read('apps/server/src/audit/books.ts');
    const line = audit.split('\n').find((l) => l.includes('a fixed or notice deposit of about three months'))!;
    expect(line).not.toMatch(/[a-z]'[a-z]/);
  });
});

describe('(holds) the late pay note’s three openings', () => {
  it('say the right dates', () => {
    expect(latePayNote('2027-02', '2027-03-05')).toMatch(/^The pay date is in the next tax year \(from 1 March 2027\)\. .* which EMP201 this goes on and which tax year’s tables apply are for your accountant to check/);
    expect(latePayNote('2026-03', '2026-02-27')).toMatch(/^The pay date is in the previous tax year \(to 28 February 2026\)\./);
    expect(latePayNote('2026-06', '2026-08-03')).toMatch(/^The pay date is more than a month after June 2026\. .* which EMP201 this goes on is for your accountant/);
    expect(latePayNote('2026-06', '2026-07-03')).toBeNull();
  });
});
