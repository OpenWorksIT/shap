import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addMonths, financialYear, formatZar, noIncomeTaxWords, offCashNote, vat201Due, vatPeriod } from '@shap/shared';
import { today } from '../../src/lib/books.js';
import { cashForecast } from '../../src/modules/forecast.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

// The sixth round of 1.33's reviews (SARS, IFRS, words): a refund SARS owes for any ended period
// isn't netted off another's VAT; VAT paid with PAYE, or a refund set off against it, is SARS's; a
// company file can't move a used payment account past Settings' checks; and the words that go with
// them. Made-up business and figures.

const root = join(__dirname, '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const now = today();
const vatOf = (f: Awaited<ReturnType<typeof cashForecast>>) => f.items.filter((x) => x.kind === 'vat').map((x) => ({ date: x.date, cents: x.cents }));

/** Made-up books on VAT category C (monthly): this period, the last, and the one before. */
async function vatBooks() {
  const env = await setup();
  const owner = await login(env.app, 'owner@example.co.za');
  const r = await ref(env.sql);
  const bank = await r.src('Business bank');
  const { settings } = await owner.get('/api/reference');
  await owner.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4000000002', vatCategory: 'C' }, 'PUT');
  const current = vatPeriod(now, 'C', settings.fyEndMonth);
  const last = vatPeriod(addMonths(current.start, -1), 'C', settings.fyEndMonth);
  const before = vatPeriod(addMonths(last.start, -1), 'C', settings.fyEndMonth);
  const client = await owner.post('/api/clients', { name: 'Made-up Client', address: '1 Made-up Street, Fictional Town' });
  const invoice = async (date: string, cents: number) => {
    const inv = await owner.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: date, dueDate: addDays(now, 200), lines: [{ category: 'labour', description: 'Work', qty: 1, unitPriceCents: cents }] });
    await owner.post(`/api/documents/${inv.id}/issue`);
  };
  return { env, owner, r, bank, current, last, before, invoice };
}

describe('VAT: a refund SARS owes for an older period, last period not paid yet (SARS)', () => {
  let b: Awaited<ReturnType<typeof vatBooks>>;
  beforeAll(async () => {
    b = await vatBooks();
  });
  afterAll(async () => {
    await expectCleanAudit(b.env.sql);
    await b.env.close();
  });

  it('isn’t netted off last period’s VAT201', async () => {
    // The period before last: R750 input VAT (a refund SARS hasn't paid). Last period: R3 000, not
    // paid yet. This period: R900. SARS sets a refund off only against a debt already overdue.
    await b.owner.post('/api/costs', { date: b.before.start, description: 'Made-up parts', supplier: 'Made-up Supplies', amountCents: 575_000, vatCents: 75_000, categoryId: await b.r.cat('Parts'), sourceId: b.bank });
    await b.invoice(b.last.start, 2_000_000);
    await b.invoice(b.current.start, 600_000);
    const due = (d: string) => (d < now ? now : d);
    expect(vatOf(await cashForecast(b.env.sql, now))).toEqual([
      { date: due(vat201Due(b.last.end)), cents: -300_000 },
      { date: vat201Due(b.current.end), cents: -90_000 },
    ]);
  });
});

describe('VAT with SARS’s other taxes on one journal (SARS)', () => {
  it('a refund SARS set off against PAYE is a refund, not R750 more VAT owed', async () => {
    const b = await vatBooks();
    await b.owner.post('/api/costs', { date: b.last.start, description: 'Made-up parts', supplier: 'Made-up Supplies', amountCents: 575_000, vatCents: 75_000, categoryId: await b.r.cat('Parts'), sourceId: b.bank });
    await b.owner.post('/api/journals', { date: b.current.start, description: 'Made-up VAT refund, part set off against PAYE', lines: [{ accountId: await b.r.acc('paye_payable'), debitCents: 50_000 }, { accountId: await b.r.acc('bank'), debitCents: 25_000 }, { accountId: await b.r.acc('vat'), creditCents: 75_000 }] });
    await b.invoice(b.current.start, 600_000);
    expect(vatOf(await cashForecast(b.env.sql, now))).toEqual([{ date: vat201Due(b.current.end), cents: -90_000 }]);
    expect(await b.owner.get(`/api/vat/return?on=${b.current.start}`)).toMatchObject({ handVatAddedCents: 0, handVatLines: 0 });
    await expectCleanAudit(b.env.sql);
    await b.env.close();
  });

  it('VAT paid with PAYE isn’t forecast again', async () => {
    const b = await vatBooks();
    await b.invoice(b.last.start, 2_000_000);
    await b.owner.post('/api/journals', { date: b.current.start, description: 'Made-up SARS: VAT and PAYE', lines: [{ accountId: await b.r.acc('vat'), debitCents: 300_000 }, { accountId: await b.r.acc('paye_payable'), debitCents: 50_000 }, { accountId: await b.r.acc('bank'), creditCents: 350_000 }] });
    await b.invoice(b.current.start, 600_000);
    expect(-vatOf(await cashForecast(b.env.sql, now)).reduce((t, x) => t + x.cents, 0)).toBe(90_000);
    expect(await b.owner.get(`/api/vat/return?on=${b.current.start}`)).toMatchObject({ handVatLines: 0 });
    await expectCleanAudit(b.env.sql);
    await b.env.close();
  });
});

describe('move-in: payroll taxes by balance side and name (SARS)', () => {
  it('leaves an SDL or UIF expense (a debit) off SARS’s payable, and puts dividends tax payable on SARS’s', async () => {
    const { suggestAccount } = await import('../../src/modules/movein.js');
    const acc = (systemKey: string, type: 'asset' | 'liability' | 'expense' = 'liability') => ({ id: systemKey, code: '', name: `Made-up ${systemKey}`, type, systemKey });
    const accounts = ['paye_payable', 'uif_payable', 'sdl_payable', 'wages_payable', 'payables', 'vat', 'income_tax_payable', 'dwt_payable'].map((k) => acc(k)).concat([acc('general_labour', 'expense')]);
    const guess = (name: string, cents: number) => suggestAccount({ code: '', name, cents } as never, accounts);
    expect(guess('Skills development levy', 1_200_000)).not.toBe('sdl_payable');
    expect(guess('SDL', 1_200_000)).not.toBe('sdl_payable');
    expect(guess('UIF company contributions', 600_000)).not.toBe('uif_payable');
    expect(guess('SDL payable', -100_000)).toBe('sdl_payable');
    expect(guess('UIF control', -100_000)).toBe('uif_payable');
    expect(guess('Employee tax payable', -500_000)).toBe('paye_payable');
    expect(guess('Dividends tax payable', -200_000)).toBe('dwt_payable');
  });
});

describe('moving a used payment account: what the refusal says (IFRS, words)', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('names last year’s figures only when last year has entries with it, and points at the account on the wrong line', async () => {
    const owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    const { settings } = await owner.get('/api/reference');
    const fy = financialYear(now, settings.fyEndMonth);
    await owner.post('/api/costs', { date: now, description: 'Made-up fuel', supplier: 'Made-up Garage', amountCents: 50_000, categoryId: await r.cat('Petrol'), sourceId: bank });
    const acc = await owner.post<{ id: string }>('/api/accounts', { code: '1079', name: 'Made-up Holding', type: 'asset', active: true });
    const move = async () => (await owner.call({ method: 'PUT', url: `/api/sources/${bank}`, payload: { name: 'Business bank', kind: 'bank', accountId: acc.id } })).json().error as string;
    const thisYear = await move();
    expect(thisYear).toMatch(/^What’s already captured with this would move on or off the statements’ cash line with it\. If the account it’s on now is on the wrong line, change that account’s line instead/);
    expect(thisYear).not.toMatch(/cash line with it, last year’s figures too/);
    expect(thisYear).not.toMatch(/Put the new account on the same line first/);
    // With something from last year too: said.
    await owner.post('/api/costs', { date: addDays(fy.start, -10), description: 'Made-up fuel last year', supplier: 'Made-up Garage', amountCents: 20_000, categoryId: await r.cat('Petrol'), sourceId: bank });
    expect(await move()).toMatch(/cash line with it, last year’s figures too\./);
  });
});

describe('a company file brought in over books with history (IFRS)', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql);
    await env.close();
  });

  it('doesn’t carry a used payment account’s history off the cash line, nor move a closed year’s', async () => {
    const owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    const bank = await r.src('Business bank');
    await owner.post('/api/costs', { date: now, description: 'Made-up fuel', supplier: 'Made-up Garage', amountCents: 50_000, categoryId: await r.cat('Petrol'), sourceId: bank });
    const cash = async () => (await owner.get('/api/dashboard')).cash.inBankCents;
    const before = await cash();
    const bring = (file: unknown) => owner.call({ method: 'POST', url: '/api/company-file', payload: { password: 'test-password-1', file } });
    const res = await bring({ format: 'shap-company/1', accounts: [{ code: '1079', name: 'Made-up Holding', type: 'asset', statementLine: 'other_current_assets' }], sources: [{ name: 'Business bank', kind: 'bank', account: '1079' }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^The company file puts “Business bank” \(Paid from \/ into\) on another account\. What’s already captured with this would move on or off the statements’ cash line with it\. Change the file \(give it a new name there, or leave it out\) and load it again\. Or, if the new account has nothing in it yet, put it on the same line in the file, after checking with your accountant\.$/);
    expect(await cash()).toBe(before);
    expect((await env.sql<{ n: number }[]>`select count(*)::int as n from audit_log where action = 'moved_to_account'`)[0]!.n).toBe(0);

    // A closed year's entries: refused, as Settings refuses it.
    const { settings } = await owner.get('/api/reference');
    const fy = financialYear(now, settings.fyEndMonth);
    await owner.post('/api/accounts', { code: '1079', name: 'Made-up Holding', type: 'asset', active: true });
    const till = await owner.post<{ id: string }>('/api/sources', { name: 'Made-up till', kind: 'cash', accountId: await r.acc('bank') });
    await owner.post('/api/costs', { date: addDays(fy.start, -30), description: 'Made-up fuel last year', supplier: 'Made-up Garage', amountCents: 20_000, categoryId: await r.cat('Petrol'), sourceId: till.id });
    await env.sql`update settings set lock_date = ${addDays(fy.start, -1)}::date where id`;
    const closed = await bring({ format: 'shap-company/1', sources: [{ name: 'Made-up till', kind: 'cash', account: '1079' }] });
    expect(closed.statusCode).toBe(400);
    expect(closed.json().error).toMatch(/is in a closed period \(to \d+ \w+ \d{4}\), so its account can’t change/);
    const [on] = await env.sql<{ code: string }[]>`select a.code from payment_sources s join accounts a on a.id = s.account_id where s.id = ${till.id}`;
    expect(on!.code).toBe('1000');
    await env.sql`update settings set lock_date = null where id`;
  });

  it('logs a change of an account’s line it brings, and a move it may make, with both accounts', async () => {
    const owner = await login(env.app, 'owner@example.co.za');
    const r = await ref(env.sql);
    // An unused source moved onto another cash account, and that account's line given again.
    const spare = await owner.post<{ id: string }>('/api/sources', { name: 'Made-up spare', kind: 'bank', accountId: await r.acc('bank') });
    const res = await owner.call({
      method: 'POST',
      url: '/api/company-file',
      payload: { password: 'test-password-1', file: { format: 'shap-company/1', accounts: [{ code: '1079', name: 'Made-up Holding', type: 'asset', statementLine: 'cash' }], sources: [{ name: 'Made-up spare', kind: 'bank', account: '1079' }] } },
    });
    expect(res.statusCode).toBe(200);
    const log = await env.sql<{ action: string; details: Record<string, unknown> }[]>`select action, details from audit_log where action in ('account_line_changed', 'moved_to_account') order by id`;
    expect(log.map((l) => l.action)).toEqual(['account_line_changed', 'moved_to_account']);
    expect(log[0]!.details).toMatchObject({ name: 'Made-up Holding', to: { line: 'cash' }, by: 'the company file' });
    expect(log[1]!.details).toMatchObject({ name: 'Made-up spare', from: { code: '1000' }, to: { code: '1079', name: 'Made-up Holding', line: 'cash' }, by: 'the company file' });
    void spare;
  });
});

describe('the sixth round’s words', () => {
  it('net profit’s words by who pays the tax, on turnover tax too (IFRS, words)', () => {
    expect(noIncomeTaxWords({ businessType: 'company' })).toBe('; before income tax (none captured in the books)');
    expect(noIncomeTaxWords({ businessType: 'sole_prop', turnoverTax: true })).toBe('; the owner’s turnover tax is their own, not the business’s');
    expect(noIncomeTaxWords({ businessType: 'trust', turnoverTax: true })).toBe('; before income tax (none captured in the books)');
    expect(noIncomeTaxWords({ businessType: 'partnership', turnoverTax: true })).toBe('; the partners’ turnover tax is their own, not the business’s');
    expect(noIncomeTaxWords({ businessType: 'company', turnoverTax: true })).toBe('; turnover tax is in it only as far as it’s captured in the books');
    expect(noIncomeTaxWords({ businessType: 'npc', approvedPbo: true })).toBe('; before any income tax on trading beyond the PBO exemption (none captured in the books)');
  });

  it('the off-cash note doesn’t send staff to Settings, which is the owner’s (words)', () => {
    const off = [{ name: 'Made-up Savings', cents: 400_000 }];
    const fmt = (c: number) => formatZar(c, { cents: false });
    expect(offCashNote(off, fmt)).toMatch(/the books audit \(Settings → Updates & backups\) says more\.$/);
    expect(offCashNote(off, fmt, { owner: false })).toMatch(/the owner’s books audit \(Settings → Updates & backups\) says more\.$/);
    expect(read('apps/web/src/pages/Forecast.tsx')).toMatch(/offCashNote\(data\.offCash, \(c\) => formatZar\(c, \{ cents: false \}\), \{ owner: isOwner \}\)/);
  });

  it('the leaving note shows only with salaries, and names the EMP201 (words, SARS)', () => {
    const forecast = read('apps/web/src/pages/Forecast.tsx');
    expect(forecast).toMatch(/data\.leavingAhead === false && data\.items\.some\(\(i\) => i\.kind === 'payroll'\) && <p className="xs muted">\{LEAVING_NOTE\}<\/p>/);
    expect(forecast).toMatch(/LEAVING_NOTE = 'Salaries and the EMP201 here go on for everyone who hasn’t left yet: only someone who sees payroll gets a forecast that counts leaving dates still to come\.'/);
  });

  it('the audit log names the new entries, and the accounts either side (words, IFRS)', () => {
    const log = read('apps/web/src/components/AuditLog.tsx');
    for (const key of ["account: 'Account'", "payment_source: 'Paid from / into'", "cost_category: 'Cost type'", "account_line_changed: 'line or type changed'", "moved_to_account: 'moved onto another account'"]) expect(log).toContain(`  ${key}`);
    expect(log).toMatch(/bits\.push\(`from \$\{accountWords\(d\.from\)\} to \$\{accountWords\(d\.to\)\}\$\{movedWords\(d\.moved\)\}\$\{typeof d\.by === 'string' \? ` · by \$\{d\.by\}` : ''\}`\)/);
  });

  it('the VAT201 note says only the parts that are there (words)', () => {
    const screen = read('apps/web/src/components/TaxForms.tsx');
    expect(screen).not.toMatch(/Journals typed in added <Money cents=\{data\.handVatAddedCents \?\? 0\} \/> to the VAT owed and took/);
    expect(screen).toMatch(/\(data\.handVatAddedCents \?\? 0\) > 0 \? \(/);
  });

  it('the books audit lists names with "and", and its deposit words follow 7.2 (words, IFRS)', () => {
    const audit = read('apps/server/src/audit/books.ts');
    expect(audit).toMatch(/xs\.length > 1 \? `\$\{xs\.slice\(0, -1\)\.join\(', '\)\} and \$\{xs\[xs\.length - 1\]\}`/);
    expect(audit).toMatch(/a fixed or notice deposit of about three months or less when it was made, for a known amount with its interest and little risk of its value changing, kept to pay what’s coming, usually counts too; one for longer, or whose value goes up and down, such as shares or most unit trusts, usually doesn’t/);
    expect(read('docs/IFRS.md')).toMatch(/a fixed or notice deposit of about three months or less when it was made, readily convertible to a known amount of cash \(with its interest\) with little risk of its value changing/);
  });
});
