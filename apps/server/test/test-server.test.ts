/**
 * The test server (docs/TEST_SERVER.md): made-up books for each kind of setup, and wiping them.
 * Only a server set up as a test server (TEST_SERVER=true) does either, only its owner may, and
 * nothing is shared from one. Each setup's made-up books pass the books audit like any books, and
 * the same setup always gets the same books.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, extrasFor, featuresFor, financialYear, idNumberProblem, taxNumberProblem, vatNumberProblem, type SetupExtras } from '@shap/shared';
import { today } from '../src/lib/books.js';
import { shareMarketRates } from '../src/modules/market.js';
import { reportUsage } from '../src/modules/feedback.js';
import { populate, type Io } from '../src/testdata/populate.js';
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
      sdl: false,
    },
    'PUT',
  );
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
    const owner = await setUp(env, { businessType: 'sole_prop', industry: 'consulting', workflow: 'quote_invoice', extras: { hourly: true } });
    await env.sql`update settings set month_end_mode = 'auto'`;
    expect(await owner.get('/api/test-server')).toMatchObject({ on: true, setupDone: true, empty: true });
    const started = await owner.post('/api/test-server/populate');
    expect(started.started).toBe(true);
    // While it fills: changes wait (even one claiming to be the filling's own), and it won't start twice.
    const held = await owner.call({ method: 'POST', url: '/api/clients', payload: { name: 'Squeezed in (made up)' }, headers: { 'x-shap-internal': 'guess' } });
    expect(held.statusCode).toBe(423);
    expect((await owner.call({ method: 'POST', url: '/api/test-server/populate', payload: {} })).statusCode).toBe(423);
    expect((await owner.call({ method: 'POST', url: '/api/test-server/wipe', payload: { confirm: 'WIPE' } })).statusCode).toBe(423);

    const after = await waitForFill(owner);
    expect(after.fill.error).toBeNull();
    expect(after.fill.summary.invoices).toBeGreaterThan(10);
    expect(after.empty).toBe(false);
    // Month end as it was set; the filling's own sign-in gone; who filled it, in the audit log.
    expect((await env.sql`select month_end_mode from settings`)[0]!.monthEndMode).toBe('auto');
    expect((await env.sql`select 1 from sessions where user_agent like 'Shap test server%'`).length).toBe(0);
    expect((await env.sql`select 1 from audit_log where action = 'test_populate'`).length).toBe(1);
    // Most costs have their (made-up) slip; drawings don't.
    const [slips] = await env.sql<{ with: number; all: number }[]>`select count(receipt_id)::int as with, count(*)::int as all from costs where vat_cents > 0 or source_id <> (select id from payment_sources where name = 'Business bank')`;
    expect(slips!.with).toBeGreaterThan(0);
    await expectCleanAudit(env.sql);

    // Filled books aren't filled again.
    const again = await owner.call({ method: 'POST', url: '/api/test-server/populate', payload: {} });
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toMatch(/new books only/);
  }, 300_000);

  it('wipes back to the setup questions, keeping everyone’s sign-ins', async () => {
    const owner = await sessionFor(env, 'owner@example.co.za');
    expect((await owner.call({ method: 'POST', url: '/api/test-server/wipe', payload: { confirm: 'please' } })).statusCode).toBe(400);
    await owner.post('/api/test-server/wipe', { confirm: 'wipe' });
    expect(await owner.get('/api/test-server')).toMatchObject({ on: true, setupDone: false, empty: true });
    expect((await env.sql`select count(*)::int as n from users`)[0]!.n).toBe(3);
    expect((await env.sql`select 1 from audit_log where action = 'test_wipe'`).length).toBe(1);
    // Set up again as something else: new books, ready to fill.
    const again = await setUp(env, { businessType: 'company', industry: 'design', vat: true, workflow: 'quote_invoice' });
    expect((await again.get('/api/test-server')).empty).toBe(true);
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
      await owner.post('/api/test-server/wipe', { confirm: 'WIPE' });
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
];

describe('test server: every kind of setup passes the books audit', () => {
  for (const a of SETUPS) {
    it(`${a.businessType}, ${a.industry}${a.vat ? `, VAT ${a.vatCategory ?? 'B'}` : ''}${a.sales ? ', sells' : ''}${a.inventory ? ', stock' : ''}${a.employees ? ', payroll' : ''}`, async () => {
      const env = await setup({ env: { TEST_SERVER: 'true' } });
      try {
        await env.sql`delete from workers`;
        const owner = await setUp(env, a);
        const summary = await populate(io(owner), env.sql, { today: today(), scale: 0.2 });
        expect(summary.invoices + summary.sales).toBeGreaterThan(0);
        await expectCleanAudit(env.sql);
      } finally {
        await env.close();
      }
    }, 300_000);
  }
});
