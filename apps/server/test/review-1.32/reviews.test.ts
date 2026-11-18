/**
 * Shap 1.32.0's five reviews (Shap Accountant from the first-run questions): what the IFRS, SARS,
 * accounting and words reviews found, each check failing on the commit they reviewed (the security
 * review's are in accountant/practice-setup.test.ts and ctl-script.test.ts). Screens are read from
 * their source, as the earlier words tests do. All data made up.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityOf, COMPILE_SIGNS, industryProfile, PRACTICE_CAUTION, PRACTICE_OWN_SERVER, PRACTICE_PROFILES, SALE_VAT, SERVER_NOT_MANAGED, setupCautions, TURNOVER_TAX_PROFESSIONAL } from '@shap/shared';
import { buildStatements } from '../../src/statements/build.js';
import { expectCleanAudit, login, ref, setup, type TestEnv } from '../helpers.js';

const ROOT = join(import.meta.dirname, '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const FY = '2026-02-28';

describe('IFRS for SMEs and company law', () => {
  it('a bookkeeper writes up; compiling signs the report in their own name, said where clients are given (1, 6)', () => {
    const [bookkeeper, manager] = PRACTICE_PROFILES;
    expect(bookkeeper!.hint).toMatch(/^Opens the clients they’re given, to write up their books\./);
    expect(bookkeeper!.hint).not.toMatch(/or reading them and compiling the statements/);
    // Given either way, a client can be opened to compile (the check of the fixes): said, and who may sign left to the practice.
    expect(bookkeeper!.hint).toMatch(/Whichever way they’re given a client, they can also open it to compile; compiling signs the compilation report \(a close corporation’s accounting officer’s report\) in their own name, and who may sign one is your practice’s to decide/);
    expect(manager!.hint).toMatch(/as a client’s owner in Shap/);
    expect(COMPILE_SIGNS).toMatch(/^Whichever way someone is given a client \(to write up or to compile\), they can open it to compile\. .*signs the compilation report \(for a close corporation, the accounting officer’s report\) in their own name\. Who in your practice may sign one is your practice’s to decide, under the law \(for a close corporation, its Act\) and its professional body’s rules\.$/);
    expect(COMPILE_SIGNS).not.toMatch(/give a client to compile only/);
    expect(read('apps/web/src/pages/Practice.tsx')).toMatch(/<p className="xs muted">\{COMPILE_SIGNS\}<\/p>/);
  });

  it('the nature of the business says what a practice does (7)', () => {
    expect(activityOf('accounting')).toBe('accounting, bookkeeping and tax services');
    expect(activityOf('builder')).toBe('Building contractor');
  });

  it('a practice’s own books: its revenue named for it, its recharged costs a cost type of their own, no Parts (3, 4)', () => {
    const p = industryProfile('accounting');
    expect(p.lines).toEqual({ labour: 'Fees', materials: 'Recharged costs', other: 'Other' });
    expect(p.revenue).toEqual({ labour: 'Fees', materials: 'Recharged costs', other: 'Other revenue', costOfMaterials: 'Costs recharged to clients' });
    expect(p.categories[0]).toEqual({ name: 'Costs recharged to clients', kind: 'materials', account: '5010' });
    expect(p.hide).toContain('Parts');
  });
});

describe('a practice’s own books, set up as setup does (IFRS 2–4, accounting 4)', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
  });
  afterAll(async () => {
    await expectCleanAudit(env.sql, FY);
    await env.close();
  });

  it('names the revenue accounts and lists the practice’s cost types first, Parts hidden', async () => {
    const { settings } = await me.get('/api/reference');
    await me.post('/api/settings', { ...settings, companyName: 'Fictional Ledger Practice', businessType: 'sole_prop', fyEndMonth: 2, industry: 'accounting', hourlyRateCents: 60_000, features: { ...settings.features, timeTracker: true, statements: true } }, 'PUT');
    const named = () => env.sql<{ systemKey: string; name: string }[]>`select system_key, name from accounts where system_key in ('revenue_labour', 'revenue_materials', 'revenue_other', 'cos_materials') order by system_key`;
    expect(await named()).toEqual([
      { systemKey: 'cos_materials', name: 'Costs recharged to clients' },
      { systemKey: 'revenue_labour', name: 'Fees' },
      { systemKey: 'revenue_materials', name: 'Recharged costs' },
      { systemKey: 'revenue_other', name: 'Other revenue' },
    ]);
    const cats = await env.sql<{ name: string; active: boolean }[]>`select name, active from cost_categories order by sort, name`;
    expect(cats.slice(0, 4).map((c) => c.name)).toEqual(['Costs recharged to clients', 'Software & subscriptions', 'Training & CPD', 'Office rent']);
    expect(cats.find((c) => c.name === 'Parts')!.active).toBe(false);
    // Another kind of business later brings Parts back.
    await me.post('/api/settings', { ...(await me.get('/api/reference')).settings, industry: 'builder' }, 'PUT');
    expect((await env.sql<{ active: boolean }[]>`select active from cost_categories where name = 'Parts'`)[0]!.active).toBe(true);
    // …and, while they're unused, Shap's own names for the accounts (the check of the fixes).
    expect((await named()).map((n) => n.name)).toEqual(['Cost of sales – project materials', 'Project revenue – labour', 'Project revenue – materials', 'Other income']);
    await me.post('/api/settings', { ...(await me.get('/api/reference')).settings, industry: 'accounting' }, 'PUT');
  });

  it('lists time not invoiced by the year end, and the revenue policy says only what’s so', async () => {
    const r = await ref(env.sql);
    await me.post('/api/journals', { date: '2025-04-01', description: 'Made-up capital', lines: [{ accountId: await r.acc('bank'), debitCents: 100_000 }, { accountId: await r.acc('owner_loan'), creditCents: 100_000 }] });
    const before = await buildStatements(env.sql, FY);
    expect(before.checks.find((c) => /not invoiced by the year end/.test(c.label))).toBeUndefined();
    await me.post('/api/time', { projectId: null, startedAt: '2026-02-27T08:00:00+02:00', endedAt: '2026-02-27T10:30:00+02:00', note: 'Made-up year-end work' });
    const s = await buildStatements(env.sql, FY);
    const item = s.checks.find((c) => /not invoiced by the year end/.test(c.label));
    expect(item).toMatchObject({ ok: false, level: 'look' });
    expect(item!.detail).toMatch(/^2\.5 hours of time tracked in the year \(or before it and invoiced only after the year end\) weren’t on an invoice issued by the year end \(R\s?1[\s,]?500\.00 at the hourly rates in Shap\)/);
    const policies = s.notes.find((n) => n.key === 'policies')!.paragraphs.join(' ');
    expect(policies).toMatch(/Revenue from services is recognised as the work is performed\./);
    expect(policies).not.toMatch(/invoices its work as it is done/);
  });

  it('counts time on a quote an issued invoice was made from as invoiced, and earlier years’ time never invoiced as not this year’s (the check of the fixes)', async () => {
    // Put the year-end time on an invoice dated after the year end: it was work in progress at it.
    const [t] = await env.sql<{ id: string }[]>`select id from time_entries where note = 'Made-up year-end work'`;
    const later = await me.post('/api/documents', { kind: 'invoice', issueDate: '2026-03-05', lines: [] });
    await me.post('/api/time/bill', { documentId: later.id, ids: [t!.id] });
    await me.post(`/api/documents/${later.id}/issue`, {});
    expect((await buildStatements(env.sql, FY)).checks.find((c) => /not invoiced by the year end/.test(c.label))?.detail).toMatch(/^2\.5 hours/);
    // The next year: that time was invoiced in it, so not listed.
    expect((await buildStatements(env.sql, '2027-02-28')).checks.find((c) => /not invoiced by the year end/.test(c.label))).toBeUndefined();
    // Time on a quote, the quote made into an invoice issued in the year: invoiced.
    const q = await me.post('/api/time', { projectId: null, startedAt: '2026-06-02T08:00:00+02:00', endedAt: '2026-06-02T11:00:00+02:00', note: 'Made-up quoted work' });
    const quote = await me.post('/api/documents', { kind: 'quote', issueDate: '2026-06-03', lines: [] });
    await me.post('/api/time/bill', { documentId: quote.id, ids: [q.id] });
    const inv = await me.post(`/api/documents/${quote.id}/convert`, {});
    // Dated in the year (a draft is dated the day it's made).
    await env.sql`update documents set issue_date = '2026-06-10' where id = ${inv.id}`;
    await me.post(`/api/documents/${inv.id}/issue`, {});
    // Time from long ago, never invoiced: not this year's.
    await me.post('/api/time', { projectId: null, startedAt: '2024-06-02T08:00:00+02:00', endedAt: '2024-06-02T09:00:00+02:00', note: 'Made-up old admin' });
    expect((await buildStatements(env.sql, '2027-02-28')).checks.find((c) => /not invoiced by the year end/.test(c.label))).toBeUndefined();
  });

  it('finds each time entry’s invoice quickly, however many there are (the accounting review’s third round)', async () => {
    // 6 000 draft invoices with an hour each on them (drafts: nothing in the ledger), the way a busy
    // practice's ten years of the time tracker would look to the query.
    const before = (await env.sql<{ n: number }[]>`select count(*)::int as n from documents`)[0]!.n;
    await env.sql`
      insert into documents (kind, number, status, issue_date, title, subtotal_cents, total_cents)
      select 'invoice', 'SPEED' || lpad(i::text, 6, '0'), 'draft', '2026-01-10', 'Made-up', 0, 0 from generate_series(1, 6000) i`;
    await env.sql`
      insert into time_entries (started_at, ended_at, minutes, note, billed_document_id)
      select '2026-01-05T08:00:00+02:00', '2026-01-05T09:00:00+02:00', 60, 'Made-up speed', d.id from documents d where d.number like 'SPEED%'`;
    try {
      const { unbilledTimeAt } = await import('../../src/statements/build.js');
      const t0 = Date.now();
      const r = await unbilledTimeAt(env.sql, '2025-03-01', FY);
      expect(Date.now() - t0).toBeLessThan(1500);
      expect(r.minutes).toBeGreaterThanOrEqual(6000 * 60);
    } finally {
      await env.sql`delete from time_entries where note = 'Made-up speed'`;
      await env.sql`delete from documents where number like 'SPEED%'`;
      expect((await env.sql<{ n: number }[]>`select count(*)::int as n from documents`)[0]!.n).toBe(before);
    }
  });

  it('puts a practice’s materials brought in from another package under its own cost type (the check of the fixes)', async () => {
    const bank = await (await ref(env.sql)).src('Business bank');
    const bills = `ContactName,InvoiceNumber,InvoiceDate,DueDate,Total,TaxTotal,InvoiceAmountPaid,InvoiceAmountDue,Description,Quantity,UnitAmount,LineAmount,AccountCode,Type,Status
Made-up Printers,B-901,10/03/2026,10/04/2026,500.00,0.00,500.00,0.00,Printing materials for clients,1,500.00,500.00,310,Bill,PAID
`;
    await me.post('/api/move-in', { files: [{ name: 'Bills.csv', text: bills }], options: { receiptSourceId: bank } });
    const [c] = await env.sql<{ name: string }[]>`select k.name from costs c join cost_categories k on k.id = c.category_id where c.description like 'Printing materials%'`;
    expect(c!.name).toBe('Costs recharged to clients');
  });

  it('leaves revenue accounts that have been used, and names the owner gave them, as they are', async () => {
    const other = await setup();
    try {
      const o = await login(other.app, 'owner@example.co.za');
      const r = await ref(other.sql);
      await o.post('/api/journals', { date: '2025-04-01', description: 'Made-up sale', lines: [{ accountId: await r.acc('bank'), debitCents: 10_000 }, { accountId: await r.acc('revenue_other'), creditCents: 10_000 }] });
      await other.sql`update accounts set name = 'Our own name' where system_key = 'revenue_labour'`;
      const { settings } = await o.get('/api/reference');
      await o.post('/api/settings', { ...settings, industry: 'accounting' }, 'PUT');
      const names = await other.sql<{ name: string }[]>`select name from accounts where system_key in ('revenue_labour', 'revenue_materials', 'revenue_other') order by system_key`;
      expect(names.map((n) => n.name)).toEqual(['Our own name', 'Recharged costs', 'Other income']);
      await expectCleanAudit(other.sql);
    } finally {
      await other.close();
    }
  });
});

describe('SARS and tax', () => {
  it('an accounting practice isn’t on turnover tax: setup switches it off and says why, Settings and the cautions say the rule (1)', () => {
    expect(TURNOVER_TAX_PROFESSIONAL).toMatch(/more than 20% of its receipts from professional services/);
    expect(setupCautions({ vatRegistered: false, employees: false, turnoverTax: true }).join(' ')).toContain(TURNOVER_TAX_PROFESSIONAL);
    const welcome = read('apps/web/src/pages/Welcome.tsx');
    expect(welcome).toMatch(/if \(f\.turnoverTax\) set\('turnoverTax', false\);/);
    expect(welcome).toMatch(/Turnover tax is switched off: an accounting practice can’t be on it, as more than 20% of its receipts are from professional services \(the Sixth Schedule to the Income Tax Act, para 3\(b\)\)/);
    expect(read('apps/web/src/pages/Settings.tsx')).toMatch(/f\.turnoverTax && PROFESSIONAL_SERVICE_INDUSTRIES\.includes\(settings\.industry\) && <div className="xs banner">\{TURNOVER_TAX_PROFESSIONAL\}<\/div>/);
    expect(read('docs/SARS.md')).toMatch(/Not a micro business, so no turnover tax: more than 20% of receipts from a professional service/);
  });

  it('an amount paid as the client’s agent: no invoice item makes it revenue, and the exempt option says it’s no supply (2, and the check of the fixes)', () => {
    expect(industryProfile('accounting').items.find((i) => /agent/i.test(i.d))).toBeUndefined();
    // Neither supply nor revenue: off the invoice (the IFRS review's check of the fixes).
    expect(SALE_VAT.exempt.hint).toMatch(/\(A fee you pay in a client’s name as their agent and recover at cost is generally neither your supply nor your revenue\. Shap counts every invoice line as revenue, so leave it off your Shap invoices and recover it another way: check with your accountant\. A courier you book yourself and charge on is your own supply, with VAT\.\)/);
    expect(read('docs/ACCOUNTANT.md')).toMatch(/generally is neither: it isn't\s+the practice's revenue \(IFRS for SMEs 23\.4 leaves amounts collected for others out\) or its supply\s+\(VAT\s+Act s54\(2\)\)/);
    expect(read('docs/ACCOUNTANT.md')).toMatch(/A client's database is opened only if this Shap's own login owns it/);
  });

  it('the personal-service caution for a practice’s own company, registration as a tax practitioner, and the industry hint’s aids (3–5)', () => {
    expect(read('apps/web/src/pages/YearEnd.tsx')).toMatch(/settings\.industry === 'accounting' && 'Accounting is a personal service: a practice with fewer than three full-time employees who aren’t connected to its owners usually can’t use it/);
    expect(PRACTICE_CAUTION).toMatch(/generally needs registration with SARS and a recognised controlling body \(Tax Administration Act s240, which has exceptions, such as work under a registered tax practitioner’s supervision\): that’s your practice’s own, and Shap doesn’t check it\./);
    expect(TURNOVER_TAX_PROFESSIONAL).toMatch(/for a company, its investment income counts too/);
    expect(read('apps/web/src/pages/Welcome.tsx')).toMatch(/industry === 'accounting' && preset\.turnoverTax && !f\.turnoverTax &&/);
    expect(read('apps/web/src/pages/Welcome.tsx')).toMatch(/some of the returns coming up, as aids to check; and draft engagement letters and working papers/);
  });
});

describe('accounting and arithmetic', () => {
  it('a retried setup doesn’t send the team twice, and another kind of business undoes the practice’s answers (1, 6)', () => {
    const welcome = read('apps/web/src/pages/Welcome.tsx');
    expect(welcome).toMatch(/const now = await api<ServerState>\('\/api\/practice\/server'\);\n\s+if \(!now\.othersSignIn\) await api\('\/api\/practice\/team'/);
    expect(welcome).toMatch(/if \(preset\.sales && sales === false\) setSales\(null\);/);
  });
});

describe('words on screen and liability', () => {
  const panel = read('apps/web/src/components/PracticeSetup.tsx');
  it('the server panel says what’s so in each state, asks only with a button or after the terms, never tells an added company’s server to break the wall (1–4, 8, 9, 11)', () => {
    expect(panel).not.toMatch(/Setting this server up|This server can keep your clients’ books|it takes a few seconds\./);
    expect(panel).toMatch(/'Ask the server'/);
    expect(panel).toMatch(/The server is busy with another request \(a check, an update or a backup\): Shap asks once it’s done\./);
    // Busy: asked again only every so often, never in a loop (the check of the fixes).
    expect(panel).toMatch(/const ASK_EVERY_MS = 15_000;/);
    expect(panel).toMatch(/if \(busyRef\.current && mayAsk\(s\) && Date\.now\(\) - lastAsk\.current >= ASK_EVERY_MS\)/);
    // A refusal over other companies since gone reads as never asked (the words review's third round).
    expect(panel).toMatch(/!\(state\.asked\.shared && !state\.otherCompanies\)/);
    // In setup, a failed answer has no button: Shap asks again at the end.
    expect(panel).toMatch(/if \(where === 'setup'\) body = `The server said: \$\{state\.asked!\.message\} When you accept the terms at the end, Shap asks the server again\./);
    expect(panel).toMatch(/When you accept the terms at the end, Shap asks the server/);
    expect(panel).toMatch(/Whoever runs the server can allow it by hand/);
    // Other companies on the server (not a test server): the own-server words, no command.
    expect(panel).toMatch(/if \(shared\) \{\n\s+head = 'Other companies’ books are on this server too';\n\s+body = state\.ready\n\s+\? `Shap can still make clients’ databases here\. \$\{PRACTICE_OWN_SERVER\}`\n\s+: `\$\{PRACTICE_OWN_SERVER\} Here, this Shap’s database login can’t make databases, so your clients’ books can’t be kept on this server\.`;/);
    expect(panel.slice(panel.indexOf('if (shared) {'), panel.indexOf('} else if (state.ready) {'))).not.toMatch(/command = true/);
    expect(read('apps/web/src/pages/Practice.tsx')).toMatch(/<PracticeServer where="practice" \/>/);
    const welcome = read('apps/web/src/pages/Welcome.tsx');
    expect(welcome).toMatch(/if \(practiceOn\) await askServerIfNeeded\(server\.current\);/);
    expect(welcome.indexOf("api('/api/practice/terms'")).toBeLessThan(welcome.indexOf('askServerIfNeeded(server.current)'));
    expect(welcome).toMatch(/sub="Shap checks whether this server can make a database for each client while you answer\."/);
  });

  it('a server of its own, said without a promise, the test-stack PC, or a menu that isn’t there (6, 7)', () => {
    expect(PRACTICE_OWN_SERVER).toMatch(/a VPS \(a server rented online\) or a computer that only your practice uses/);
    expect(PRACTICE_OWN_SERVER).not.toMatch(/your own PC|are your practice’s alone/);
    expect(PRACTICE_OWN_SERVER).toMatch(/The server’s security, its backups, and who can reach your clients’ books are then your practice’s to look after/);
    expect(SERVER_NOT_MANAGED).toMatch(/Settings → Updates & backups/);
    expect(SERVER_NOT_MANAGED).toMatch(/^This Shap’s database login isn’t allowed to make databases/);
    const log = read('CHANGELOG.md');
    const v132 = log.slice(log.indexOf('## 1.32.0'), log.indexOf('## 1.31.0'));
    for (const t of [SERVER_NOT_MANAGED, v132, read('docs/ACCOUNTANT.md')]) expect(t).not.toMatch(/Settings → System|got ready|gets the server ready|sets this up by itself/);
    expect(read('docs/ACCOUNTANT.md')).toMatch(/deploy\/test, which runs Shap on a PC through a tunnel, is for testing: it keeps no\s+backups/);
  });

  it('shap-ctl says whose login, and logs why; the team step says “their” and that payroll comes next (8, 16, 17)', () => {
    const ctl = read('deploy/vps/ctl/shap-ctl.sh');
    expect(ctl).toMatch(/This Shap’s database login \(\$login\) may now make databases\./);
    expect(ctl).toMatch(/echo "practice: Postgres said: \$out"/);
    expect(panel).toMatch(/\.replace\('your name and email', 'their name and email'\)/);
    expect(read('apps/web/src/pages/Welcome.tsx')).toMatch(/These are sign-ins to Shap\. Payroll, for anyone on a salary, is the next question\./);
  });
});
