/**
 * The test server (docs/TEST_SERVER.md): made-up books for each kind of setup, and wiping them.
 * Only a server set up as a test server (TEST_SERVER=true) does either, only its owner may, and
 * nothing is shared from one. Each setup's made-up books pass the books audit like any books, and
 * the same setup always gets the same books.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addMonths, estimateTax, extrasFor, featuresFor, financialYear, idNumberProblem, isBusinessDay, monthEnd, taxNumberProblem, turnoverTax, turnoverTaxLimit, vat201Due, vatNumberProblem, vatPeriod, vatThresholds, type SetupExtras, type TaxEstimateFigures } from '@shap/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { today } from '../src/lib/books.js';
import { shareMarketRates } from '../src/modules/market.js';
import { reportUsage } from '../src/modules/feedback.js';
import { setMonthEndAside } from '../src/modules/test-server.js';
import { FILLING_SESSION } from '../src/auth.js';
import { appVersion } from '../src/modules/system.js';
import { newToken, sha256 } from '../src/lib/tokens.js';
import { populate, type Io } from '../src/testdata/populate.js';
import { GENERIC_GOODS, tradeFor } from '../src/testdata/catalogue.js';
import { idNumber, luhnNumber, rng } from '../src/testdata/rng.js';
import { expectCleanAudit, sessionFor, setup, type TestEnv } from './helpers.js';

interface Answers {
  businessType: string;
  industry: string;
  vat?: boolean;
  vatCategory?: 'A' | 'B' | 'C';
  workflow: 'quote_job_invoice' | 'quote_invoice' | 'invoice';
  employees?: boolean;
  casual?: boolean;
  sales?: boolean;
  inventory?: boolean;
  extras?: Partial<SetupExtras>;
  fyEndMonth?: number;
  turnoverTax?: boolean;
  sdl?: boolean;
  monthEnd?: 'manual' | 'auto';
}

// Made up: each passes its check digit.
const VAT_NUMBER = '4000000002';
const PAYE_REF = '7000000002';

/** What the first-run questions save (pages/Welcome.tsx) for these answers. */
async function setUp(env: TestEnv, a: Answers) {
  const owner = await sessionFor(env, 'owner@example.co.za');
  const ref = await owner.get('/api/reference');
  const company = ['company', 'inc', 'cc', 'coop', 'trust'].includes(a.businessType);
  const features = {
    ...ref.settings.features,
    ...featuresFor({
      workflow: a.workflow,
      employees: Boolean(a.employees),
      casual: Boolean(a.casual),
      company,
      extras: { ...extrasFor(a.industry), ...a.extras },
      selling: { sales: Boolean(a.sales), inventory: Boolean(a.inventory) },
      statements: true,
    }),
  };
  const { termsAcceptedAt: _t, logoId: _l, ...rest } = ref.settings;
  await owner.post(
    '/api/settings',
    {
      ...rest,
      companyName: `Test ${a.businessType} ${a.industry} (made up)`,
      businessType: a.businessType,
      industry: a.industry,
      vatRegistered: Boolean(a.vat),
      vatNumber: a.vat ? VAT_NUMBER : '',
      vatCategory: a.vatCategory ?? 'B',
      turnoverTax: Boolean(a.turnoverTax),
      fyEndMonth: a.fyEndMonth ?? 2,
      features,
      setupDone: true,
      payeRegistered: a.employees ? true : null,
      payeRef: a.employees ? PAYE_REF : '',
      uifRegistered: a.employees ? true : null,
      uifRef: a.employees ? '1234567/8' : '',
      sdl: Boolean(a.sdl),
    },
    'PUT',
  );
  if (a.sales && a.monthEnd) await owner.post('/api/periods/month-end', { mode: a.monthEnd, day: 7 }, 'PUT');
  return owner;
}

const io = (o: Awaited<ReturnType<typeof sessionFor>>): Io => ({
  get: (url) => o.get(url),
  send: (method, url, body) => o.post(url, body ?? {}, method),
});

/** What the books hold, to compare two fillings. */
async function fingerprint(env: TestEnv) {
  const [f] = await env.sql<Record<string, string>[]>`
    select (select count(*) from documents where kind = 'invoice') as invoices,
           (select coalesce(sum(total_cents), 0) from documents where kind = 'invoice') as invoiced,
           (select count(*) from documents where counter) as sales,
           (select count(*) from costs) as costs,
           (select coalesce(sum(amount_cents), 0) from costs) as spent,
           (select coalesce(sum(amount_cents), 0) from receipts) as received`;
  return f;
}

const waitForFill = async (owner: Awaited<ReturnType<typeof sessionFor>>) => {
  for (let i = 0; i < 1500; i++) {
    const s = await owner.get('/api/test-server');
    if (!s.fill.running) return s;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('the filling never finished');
};

describe('test server: off on every other Shap', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => env.close());

  it('says it isn’t one, and refuses to fill or wipe the books', async () => {
    const owner = await sessionFor(env, 'owner@example.co.za');
    expect(await owner.get('/api/test-server')).toEqual({ on: false });
    const client = await owner.post('/api/clients', { name: 'A real client (made up)' });
    for (const [url, body] of [['/api/test-server/populate', {}], ['/api/test-server/wipe', { confirm: 'WIPE' }]] as const) {
      const r = await owner.call({ method: 'POST', url, payload: body });
      expect(r.statusCode).toBe(404);
      expect(r.json().code).toBe('not_test_server');
    }
    // Nothing was wiped.
    expect((await env.sql`select 1 from clients where id = ${client.id}`).length).toBe(1);
  });

  it('filling and wiping are the owner’s (and the status needs a sign-in)', () => {
    expect(env.doors['POST /api/test-server/populate']).toEqual({ roles: ['owner'] });
    expect(env.doors['POST /api/test-server/wipe']).toEqual({ roles: ['owner'] });
    expect(env.routes).toContain('GET /api/test-server');
  });
});

describe('test server: filling, refusing, wiping', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup({ env: { TEST_SERVER: 'true' } });
    await env.sql`delete from workers`;
  });
  afterAll(async () => env.close());

  it('shares nothing: no anonymous prices, no usage notes', async () => {
    await env.sql`update settings set market_consent = true, market_notice_seen = true, usage_consent = true`;
    const log = { warn: () => undefined };
    expect(await shareMarketRates(env.ctx, env.sql, log)).toBe('off');
    expect(await reportUsage(env.ctx, { usageConsent: true, installId: 'x', businessType: 'company', industry: 'builder', features: [], vatRegistered: false, tone: 'casual' }, log)).toBe(false);
  });

  it('only the owner fills or wipes', async () => {
    const accountant = await sessionFor(env, 'accountant@example.co.za');
    const site = await sessionFor(env, 'site@example.co.za');
    for (const who of [accountant, site]) {
      expect((await who.call({ method: 'POST', url: '/api/test-server/populate', payload: {} })).statusCode).toBe(403);
      expect((await who.call({ method: 'POST', url: '/api/test-server/wipe', payload: { confirm: 'WIPE' } })).statusCode).toBe(403);
    }
    expect((await env.app.inject({ method: 'GET', url: '/api/test-server' })).statusCode).toBe(401);
  });

  it('fills new books in the background, holding other changes back till it’s done', async () => {
    // A business that sells, its months set to lock by themselves (setup's own answer, through the API).
    const answers: Answers = { businessType: 'sole_prop', industry: 'consulting', workflow: 'quote_invoice', sales: true, monthEnd: 'auto', extras: { hourly: true } };
    let owner = await setUp(env, answers);
    expect(await owner.get('/api/test-server')).toMatchObject({ on: true, setupDone: true, empty: true });
    // Two at once (two tabs, a retry), and a wipe with them: exactly one gets going, the others are told why.
    const tries = await Promise.all([
      owner.call({ method: 'POST', url: '/api/test-server/populate', payload: {} }),
      owner.call({ method: 'POST', url: '/api/test-server/populate', payload: {} }),
      owner.call({ method: 'POST', url: '/api/test-server/wipe', payload: { confirm: 'WIPE', password: 'test-password-1' } }),
    ]);
    expect(tries.map((t) => t.statusCode).filter((c) => c === 200)).toHaveLength(1);
    for (const t of tries.filter((x) => x.statusCode !== 200)) expect(t.json().error).toMatch(tries[2]!.statusCode === 200 ? /being wiped|Set the business up first/ : /being filled|Wait till the books are filled/);
    if (tries[2]!.statusCode === 200) {
      // The wipe got there first (it can, on a busy machine): set up again, and fill.
      owner = await setUp(env, answers);
      expect((await owner.call({ method: 'POST', url: '/api/test-server/populate', payload: {} })).statusCode).toBe(200);
    }
    // While it fills: changes wait (even one claiming to be the filling's own), and it won't start twice.
    const held = await owner.call({ method: 'POST', url: '/api/clients', payload: { name: 'Squeezed in (made up)' }, headers: { 'x-shap-internal': 'guess' } });
    expect(held.statusCode).toBe(423);
    expect((await owner.call({ method: 'POST', url: '/api/test-server/populate', payload: {} })).statusCode).toBe(423);
    expect((await owner.call({ method: 'POST', url: '/api/test-server/wipe', payload: { confirm: 'WIPE', password: 'test-password-1' } })).statusCode).toBe(423);

    const after = await waitForFill(owner);
    expect(after.fill.error).toBeNull();
    expect(after.fill.summary.invoices).toBeGreaterThan(10);
    expect(after.empty).toBe(false);
    // Month end as it was set; the filling's own sign-in gone; who filled it, in the audit log.
    expect((await env.sql`select month_end_mode from settings`)[0]!.monthEndMode).toBe('auto');
    expect((await env.sql`select 1 from sessions where user_agent like 'Shap test server%'`).length).toBe(0);
    expect((await env.sql`select 1 from audit_log where action = 'test_populate'`).length).toBe(1);
    expect((await env.sql`select 1 from journals where reference = 'START'`).length).toBe(1);
    // Month end locks by itself again from the next change.
    expect((await env.sql`select lock_date from settings`)[0]!.lockDate).toBeNull();
    await owner.post('/api/clients', { name: 'After the filling (made up)' });
    expect((await env.sql`select lock_date::text as d from settings`)[0]!.d).not.toBeNull();
    // Most costs have their (made-up) slip; drawings don't.
    const [slips] = await env.sql<{ with: number; all: number }[]>`select count(receipt_id)::int as with, count(*)::int as all from costs where vat_cents > 0 or source_id <> (select id from payment_sources where name = 'Business bank')`;
    expect(slips!.with).toBeGreaterThan(0);
    await expectCleanAudit(env.sql);

    // Filled books aren't filled again.
    const again = await owner.call({ method: 'POST', url: '/api/test-server/populate', payload: {} });
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toMatch(/new books only/);
  }, 300_000);

  it('wipes back to the setup questions with WIPE and the owner’s password, keeping everyone’s sign-ins', async () => {
    const owner = await sessionFor(env, 'owner@example.co.za');
    expect((await owner.call({ method: 'POST', url: '/api/test-server/wipe', payload: { confirm: 'please', password: 'test-password-1' } })).statusCode).toBe(400);
    for (const password of [undefined, 'not-the-password']) {
      expect((await owner.call({ method: 'POST', url: '/api/test-server/wipe', payload: { confirm: 'WIPE', password } })).statusCode).toBeGreaterThanOrEqual(400);
      expect(await owner.get('/api/test-server')).toMatchObject({ empty: false });
    }
    const wipes = (await env.sql`select 1 from audit_log where action = 'test_wipe'`).length;
    await owner.post('/api/test-server/wipe', { confirm: 'wipe', password: 'test-password-1' });
    expect(await owner.get('/api/test-server')).toMatchObject({ on: true, setupDone: false, empty: true });
    expect((await env.sql`select count(*)::int as n from users`)[0]!.n).toBe(3);
    expect((await env.sql`select 1 from audit_log where action = 'test_wipe'`).length).toBe(wipes + 1);
    // Set up again as something else: new books, ready to fill.
    const again = await setUp(env, { businessType: 'company', industry: 'design', vat: true, workflow: 'quote_invoice' });
    expect((await again.get('/api/test-server')).empty).toBe(true);
  });
});

describe('test server: after a restart part way, and feedback', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup({ env: { TEST_SERVER: 'true', COLLECTOR_URL: 'https://collector.example.invalid/collect' } });
  });
  afterAll(async () => env.close());

  it('removes the filling’s sign-in and puts month end back when the server starts', async () => {
    const [owner] = await env.sql<{ id: string }[]>`select id from users where role = 'owner'`;
    await env.sql`insert into sessions (token_hash, user_id, expires_at, user_agent) values ('leftover', ${owner!.id}, now() + interval '30 days', 'Shap test server: filling the books')`;
    await env.sql`insert into audit_log (user_id, action, entity, details) values (${owner!.id}, 'test_populate', 'books', ${env.sql.json({ monthEndMode: 'auto' })})`;
    await env.sql`update settings set month_end_mode = 'manual'`;
    const config = loadConfig({ ...process.env, TEST_SERVER: 'true' });
    const again = await buildApp({ config, sql: env.sql, mailer: { send: async () => undefined } });
    await again.app.ready();
    expect((await env.sql`select 1 from sessions where token_hash = 'leftover'`).length).toBe(0);
    expect((await env.sql`select month_end_mode from settings`)[0]!.monthEndMode).toBe('auto');
    await again.app.close();
  });

  it('the filling’s sign-in keeps its few hours (it doesn’t slide like a person’s)', async () => {
    const [owner] = await env.sql<{ id: string }[]>`select id from users where role = 'owner'`;
    const token = newToken();
    await env.sql`insert into sessions (token_hash, user_id, expires_at, last_seen_at, user_agent) values (${sha256(token)}, ${owner!.id}, now() + interval '3 hours', now() - interval '2 minutes', ${FILLING_SESSION})`;
    const res = await env.app.inject({ method: 'GET', url: '/api/test-server', headers: { 'x-shap-version': appVersion() }, cookies: { shap_session: token } });
    expect(res.statusCode).toBe(200);
    const [row] = await env.sql<{ left: number; seen: boolean }[]>`select extract(epoch from expires_at - now())::float as left, last_seen_at > now() - interval '1 minute' as seen from sessions where token_hash = ${sha256(token)}`;
    expect(row!.seen).toBe(true);
    expect(row!.left).toBeLessThanOrEqual(3 * 3600);
    await env.sql`delete from sessions where token_hash = ${sha256(token)}`;
  });

  it('keeps feedback on the test server', async () => {
    const realFetch = globalThis.fetch;
    const sent: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      sent.push(String(url));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      const owner = await sessionFor(env, 'owner@example.co.za');
      await owner.post('/api/feedback', { kind: 'idea', message: 'A made-up wish', page: '/', at: new Date().toISOString(), trail: [] });
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(sent.filter((u) => u.includes('collector.example.invalid'))).toEqual([]);
  });
});

describe('test server: the same setup gets the same books', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup({ env: { TEST_SERVER: 'true' } });
    await env.sql`delete from workers`;
  });
  afterAll(async () => env.close());

  it('filled twice, the books are the same', async () => {
    const answers: Answers = { businessType: 'cc', industry: 'retail', vat: true, workflow: 'invoice', sales: true, inventory: true, employees: true, extras: { bills: true } };
    const t = today();
    const from = addDays(financialYear(t, 2).start, -60);
    const prints = [];
    for (let i = 0; i < 2; i++) {
      const owner = await setUp(env, answers);
      await populate(io(owner), env.sql, { today: t, from, scale: 0.15 });
      prints.push(await fingerprint(env));
      await expectCleanAudit(env.sql);
      await owner.post('/api/test-server/wipe', { confirm: 'WIPE', password: 'test-password-1' });
    }
    expect(Number(prints[0]!.invoices) + Number(prints[0]!.sales)).toBeGreaterThan(20);
    expect(prints[1]).toEqual(prints[0]);
  }, 300_000);

  it('makes up ID, tax and VAT numbers that pass Shap’s checks', () => {
    const r = rng('numbers');
    for (let i = 0; i < 50; i++) {
      expect(idNumberProblem(idNumber(r, `19${r.int(60, 99)}-0${r.int(1, 9)}-1${r.int(0, 9)}`))).toBeNull();
      expect(taxNumberProblem(luhnNumber(r, '0', 10))).toBeNull();
      expect(vatNumberProblem(luhnNumber(r, '4', 10))).toBeNull();
    }
  });
});

/**
 * Every kind of business, across the trades and the parts of Shap a setup switches on, over the
 * last full financial year and this one to date (a fifth of a real business's activity, to keep
 * the tests quick): each one's books pass the books audit.
 */
const SETUPS: Answers[] = [
  { businessType: 'sole_prop', industry: 'builder', workflow: 'quote_job_invoice', casual: true, extras: { bills: true, travel: true } },
  { businessType: 'partnership', industry: 'electrician', vat: true, vatCategory: 'C', workflow: 'quote_job_invoice', casual: true, extras: { bills: true } },
  { businessType: 'company', industry: 'it', vat: true, workflow: 'quote_job_invoice', employees: true, extras: { hourly: true, bills: true, travel: true } },
  { businessType: 'inc', industry: 'health', vat: true, vatCategory: 'A', workflow: 'invoice', sales: true, inventory: true, extras: { hourly: true } },
  { businessType: 'cc', industry: 'retail', vat: true, workflow: 'invoice', sales: true, inventory: true, employees: true, extras: { bills: true }, fyEndMonth: 6 },
  { businessType: 'trust', industry: 'garden', workflow: 'quote_invoice', employees: true },
  { businessType: 'npc', industry: 'tutor', workflow: 'invoice', fyEndMonth: 12 },
  { businessType: 'coop', industry: 'catering', vat: true, workflow: 'quote_invoice', sales: true, employees: true, extras: { upfront: true } },
  { businessType: 'sole_prop', industry: 'hair', workflow: 'invoice', sales: true, turnoverTax: true },
  { businessType: 'company', industry: 'mechanic', vat: true, workflow: 'quote_job_invoice', sales: true, inventory: true, employees: true, casual: true, extras: { bills: true }, fyEndMonth: 12 },
  // From the reviews: jobs paid up front with casual workers; stock without VAT; a June year end in
  // VAT category A with the logbook; a payroll with SDL; months that lock by themselves.
  { businessType: 'company', industry: 'builder', vat: true, workflow: 'quote_job_invoice', employees: true, casual: true, extras: { upfront: true, travel: true, bills: true } },
  { businessType: 'sole_prop', industry: 'retail', workflow: 'invoice', sales: true, inventory: true, monthEnd: 'auto' },
  { businessType: 'cc', industry: 'handyman', vat: true, vatCategory: 'A', workflow: 'quote_job_invoice', employees: true, fyEndMonth: 6, extras: { travel: true } },
  { businessType: 'inc', industry: 'consulting', vat: true, workflow: 'quote_invoice', employees: true, sdl: true, extras: { hourly: true } },
];

describe('test server: every kind of setup passes the books audit', () => {
  for (const a of SETUPS) {
    it(`${a.businessType}, ${a.industry}${a.vat ? `, VAT ${a.vatCategory ?? 'B'}` : ''}${a.sales ? ', sells' : ''}${a.inventory ? ', stock' : ''}${a.employees ? ', payroll' : ''}`, async () => {
      const env = await setup({ env: { TEST_SERVER: 'true' } });
      try {
        await env.sql`delete from workers`;
        const owner = await setUp(env, a);
        // As the route does: month end set aside while it fills, then back.
        const monthEnd = await setMonthEndAside(env.sql);
        const summary = await populate(io(owner), env.sql, { today: today(), scale: 0.2 });
        await monthEnd.restore();
        expect(summary.invoices + summary.sales).toBeGreaterThan(0);
        await expectCleanAudit(env.sql);
        await checkMadeUp(env, owner, a, summary.from);
      } finally {
        await env.close();
      }
    }, 300_000);
  }
});

describe('test server: kept under turnover tax’s limit, it trades to the end of each month', () => {
  it('a busy salon on turnover tax, at full size: each month near the cap, under it, and selling in its last days', async () => {
    const env = await setup({ env: { TEST_SERVER: 'true' } });
    try {
      await env.sql`delete from workers`;
      const a: Answers = { businessType: 'sole_prop', industry: 'hair', workflow: 'invoice', sales: true, turnoverTax: true };
      const owner = await setUp(env, a);
      const t = today();
      const from = addMonths(`${t.slice(0, 7)}-01`, -3);
      await populate(io(owner), env.sql, { today: t, from, scale: 1 });
      await expectCleanAudit(env.sql);
      for (let m = from; m < `${t.slice(0, 7)}-01`; m = addMonths(m, 1)) {
        const end = monthEnd(m);
        const cap = (Math.min(vatThresholds(m).compulsoryCents, turnoverTaxLimit(financialYear(m, 2).end)) * 0.7) / 12;
        const [x] = await env.sql<{ t: string; last: string }[]>`
          select coalesce(-sum(l.amount_cents), 0)::bigint as t,
                 (select max(issue_date)::text from documents where kind = 'invoice' and status = 'issued' and issue_date between ${m}::date and ${end}::date) as last
          from ledger l join accounts a on a.id = l.account_id where a.type = 'income' and l.date between ${m}::date and ${end}::date`;
        expect(Number(x!.t), `${m.slice(0, 7)} under the cap`).toBeLessThanOrEqual(cap);
        expect(Number(x!.t), `${m.slice(0, 7)} near the cap`).toBeGreaterThan(cap * 0.8);
        expect(x!.last >= addDays(end, -4), `${m.slice(0, 7)} sold till ${x!.last}`).toBe(true);
      }
    } finally {
      await env.close();
    }
  }, 600_000);
});

/** What the four reviews of 1.25 found the filling got wrong, checked on every setup's books. */
async function checkMadeUp(env: TestEnv, owner: Awaited<ReturnType<typeof sessionFor>>, a: Answers, from: string) {
  const t = today();
  const sql = env.sql;
  const num = (v: unknown) => Number(v ?? 0);
  // The bank never goes below nothing: the owners lend what's needed. Nor does the till.
  for (const key of ['bank']) {
    const [m] = await sql<{ min: string | null }[]>`
      with d as (select l.date, sum(l.amount_cents) as amt from ledger l join accounts a on a.id = l.account_id where a.system_key = ${key} and l.date <= ${t}::date group by l.date)
      select min(run)::bigint as min from (select sum(amt) over (order by date) as run from d) x`;
    expect(num(m!.min), `${key} went below nothing`).toBeGreaterThanOrEqual(0);
  }
  const [till] = await sql<{ min: string | null }[]>`
    with d as (select l.date, sum(l.amount_cents) as amt from ledger l where l.account_id = (select account_id from payment_sources where till limit 1) and l.date <= ${t}::date group by l.date)
    select min(run)::bigint as min from (select sum(amt) over (order by date) as run from d) x`;
  expect(num(till!.min)).toBeGreaterThanOrEqual(0);
  // Not registered for VAT, or on turnover tax: any twelve months' turnover stays under the lines.
  if (!a.vat || a.turnoverTax) {
    const fy = financialYear(addDays(financialYear(t, a.fyEndMonth ?? 2).start, -1), a.fyEndMonth ?? 2);
    const [tv] = await sql<{ t: string }[]>`select coalesce(-sum(l.amount_cents), 0)::bigint as t from ledger l join accounts a on a.id = l.account_id where a.type = 'income' and l.date between ${fy.start}::date and ${fy.end}::date`;
    if (!a.vat) expect(num(tv!.t)).toBeLessThan(vatThresholds(fy.end).compulsoryCents);
    if (a.turnoverTax) expect(num(tv!.t)).toBeLessThan(turnoverTaxLimit(fy.end));
  }
  // Rent every month for a trade with premises (on the month's first business day, so this month's
  // only once that's come).
  const onOrAfter = (d: string) => {
    let x = d;
    while (!isBusinessDay(x)) x = addDays(x, 1);
    return x;
  };
  const months = new Set<string>();
  for (let d = from; d <= t; d = addDays(d, 1)) if ((d === from || d.endsWith('-01')) && onOrAfter(d) <= t) months.add(d.slice(0, 7));
  const [rent] = await sql<{ n: number }[]>`select count(*)::int as n from costs where description = 'Rent for the premises'`;
  if (['retail', 'hair', 'mechanic', 'catering', 'health'].includes(a.industry)) expect(rent!.n).toBe(months.size);
  // Every VAT period the books reach, once due, has its VAT201: field 20 paid on its due date, or
  // the refund in (about three weeks after); none for a nil return.
  if (a.vat) {
    const done = new Set<string>();
    let checked = 0;
    for (let d = from; d <= t; d = addDays(d, 1)) {
      const p = vatPeriod(d, a.vatCategory ?? 'B', a.fyEndMonth ?? 2);
      if (done.has(p.end) || addDays(vat201Due(p.end), 30) > t) continue;
      done.add(p.end);
      const f20 = Number((await owner.get(`/api/vat/return?on=${p.end}`)).fields.field20);
      const js = await sql<{ date: string; amt: string }[]>`
        select j.date::text as date, sum(jl.debit_cents)::bigint as amt from journals j join journal_lines jl on jl.journal_id = j.id
        where j.reference = 'VAT201' and j.description like ${`VAT201 ${p.start} to ${p.end}:%`} group by j.id, j.date`;
      expect(js.length, `VAT201 for ${p.start} to ${p.end}`).toBe(f20 === 0 ? 0 : 1);
      if (f20 === 0) continue;
      expect(num(js[0]!.amt)).toBe(Math.abs(f20));
      if (f20 > 0) expect(js[0]!.date).toBe(vat201Due(p.end));
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  }
  // The last full year's provisional tax (or the owners' own, as drawings) and turnover tax's
  // interim payments: about the year's tax, as Shap works it out on the year's own figures.
  {
    const fy = financialYear(addDays(financialYear(t, a.fyEndMonth ?? 2).start, -1), a.fyEndMonth ?? 2);
    const p = await owner.get(`/api/reports/provisional-tax?fyEnd=${fy.end}&asAt=${fy.end}`);
    const sum = (k: string) => (p.lines as { type: string; projectedCents: number }[]).filter((l) => l.type === k).reduce((x, l) => x + Number(l.projectedCents), 0);
    const est = estimateTax({ kind: p.kind as TaxEstimateFigures['kind'], profitCents: sum('income') - sum('cost_of_sales') - sum('expense'), assessedLossCents: Number(p.assessedLossCents), fyEnd: fy.end, sbc: p.sbc === true, distributedCents: Number(p.distributedCents), approvedPbo: p.approvedPbo, partners: p.partners });
    const near = (paid: number, tax: number, what: string) => expect(Math.abs(paid - tax), `${what}: paid ${paid}, the year's tax ${tax}`).toBeLessThanOrEqual(Math.max(100_000, tax * 0.15));
    if (a.turnoverTax) {
      if (['sole_prop', 'partnership'].includes(a.businessType)) {
        const [income] = await sql<{ t: string }[]>`select coalesce(-sum(l.amount_cents), 0)::bigint as t from ledger l join accounts a on a.id = l.account_id where a.type = 'income' and coalesce(a.system_key, '') not in ('disposal_gain_loss', 'interest_income') and l.date between ${fy.start}::date and ${fy.end}::date`;
        const tax = turnoverTax(num(income!.t), fy.end);
        const tt = await sql<{ n: number; paid: string }[]>`select count(*)::int as n, coalesce(sum(amount_cents), 0)::bigint as paid from costs where description like 'Turnover tax (TT02) interim payment%' and date between ${fy.start}::date and ${fy.end}::date`;
        if (tax > 50_000) expect(tt[0]!.n).toBe(2);
        near(num(tt[0]!.paid), tax, 'TT02');
      }
    } else if (['sole_prop', 'partnership'].includes(a.businessType)) {
      for (const x of est.partners ?? [{ name: '', taxCents: est.taxCents }]) {
        const [own] = await sql<{ paid: string }[]>`select coalesce(sum(amount_cents), 0)::bigint as paid from costs where description like ${`Provisional tax (IRP6) for ${x.name}%`} and date between ${fy.start}::date and ${fy.end}::date`;
        near(num(own!.paid), Math.max(0, x.taxCents), `IRP6 for ${x.name || 'the owner'}`);
      }
    } else if (!(a.businessType === 'npc' && p.approvedPbo)) {
      const [irp6] = await sql<{ paid: string }[]>`select coalesce(sum(amount_cents), 0)::bigint as paid from sars_payments where kind = 'irp6' and period = ${fy.end.slice(0, 7)}`;
      near(num(irp6!.paid), Math.max(0, est.taxCents), 'IRP6');
    }
  }
  // Someone new starts on the first business day after the leaver's last.
  const left = await sql<{ end: string }[]>`select end_date::text as end from employees where end_date is not null`;
  for (const l of left) {
    const starts = onOrAfter(addDays(l.end, 1));
    expect((await sql`select 1 from employees where start_date = ${starts}::date`).length, `someone new from ${starts}`).toBe(1);
  }
  // No costs on a job after its last invoice: they'd wait in work in progress for ever.
  const [late] = await sql<{ n: number }[]>`
    select count(*)::int as n from labour_entries e where e.project_id is not null
      and exists (select 1 from documents d where d.project_id = e.project_id and d.kind = 'invoice' and d.status = 'issued')
      and e.date > (select max(d.issue_date) from documents d where d.project_id = e.project_id and d.kind = 'invoice' and d.status = 'issued')`;
  expect(late!.n).toBe(0);
  // Payroll: under R500 000 a tax year without SDL; no medical credits without a medical aid.
  if (a.employees && !a.sdl) {
    const years = await sql<{ y: string; gross: string }[]>`
      select case when substr(r.period, 6, 2)::int >= 3 then substr(r.period, 1, 4)::int + 1 else substr(r.period, 1, 4)::int end as y,
             sum(l.salary_cents + l.overtime_cents + l.commission_cents + l.extra_cents)::bigint as gross
      from pay_lines l join pay_runs r on r.id = l.run_id where r.status = 'final' group by 1`;
    for (const y of years) expect(num(y.gross)).toBeLessThan(500_000_00);
  }
  expect((await sql`select 1 from employees where medical_members > 0`).length).toBe(0);
  // A trust distributes once a year, on its year end; a co-op to its five members.
  if (a.businessType === 'trust') {
    const d = await sql<{ on: string }[]>`select declared_on::text as on from dividends`;
    for (const x of d) expect(x.on.slice(5, 7)).toBe(String(a.fyEndMonth ?? 2).padStart(2, '0'));
  }
  if (a.businessType === 'coop') {
    const d = await sql<{ n: number }[]>`select count(distinct shareholder)::int as n from dividends`;
    if ((await sql`select 1 from dividends`).length) expect(d[0]!.n).toBe(5);
  }
  // Stock bought by a business not registered for VAT carries the VAT it paid (IFRS for SMEs 13.6):
  // each standard-rated item's average cost is the supplier's price with VAT.
  if (a.inventory) {
    const goods = tradeFor(a.industry).goods ?? GENERIC_GOODS;
    const items = await sql<{ sku: string; v: string; q: string }[]>`select sku, stock_value_cents as v, qty_on_hand as q from items where stocked and qty_on_hand > 0 and vat_code = 'standard'`;
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) {
      const cost = Math.round(goods.find((g) => g[1] === i.sku)![2] * 100);
      const expected = a.vat ? cost : Math.round(cost * 1.15);
      expect(Math.abs(num(i.v) / Number(i.q) - expected)).toBeLessThan(1);
    }
  }
  // The logbook: by SARS's tax year, the odometer moving by the trips, private use under 5%.
  if (a.extras?.travel) {
    const lb = await owner.get(`/api/logbook?yearEnd=${financialYear(addDays(financialYear(t, 2).start, -1), 2).end}`);
    expect(lb.totalKm).toBeGreaterThan(0);
    expect(lb.totalKm).toBe(lb.loggedKm);
    expect(lb.businessShare).toBeGreaterThanOrEqual(0.95);
  }
  // The statements name the made-up owners.
  const details = await owner.get('/api/statements/details');
  expect(details.directors.length).toBeGreaterThan(0);
  expect(details.directors.every((d: { name: string }) => d.name !== 'Owner')).toBe(true);
}
