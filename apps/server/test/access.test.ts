/**
 * Who may do what (docs/PEOPLE.md, packages/shared/src/access.ts): staff do what's ticked for
 * them, from a profile with their own changes on top. Every route's door is tried for every task,
 * and a person with nothing ticked gets nowhere. Then a teller, an admin and site staff at work,
 * with the books checked at the end. All people and data made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTANT_TASKS, neededBy, personAccess, shownGroups, TASK_KEYS, tweaksFor, withNeeds } from '@shap/shared';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectCleanAudit, ref, sessionFor, setup, type TestEnv } from './helpers.js';

const D = '2026-07-01';
const ID = '00000000-0000-4000-8000-000000000000';
const PDF = Buffer.from('%PDF-1.4\n% made up\n').toString('base64');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('the tasks themselves', () => {
  it('gives what a task needs with it, and keeps a person’s changes apart from their profile', () => {
    expect(withNeeds(['sales.refund'])).toEqual(['sales.refund', 'sales.view']);
    expect(withNeeds(['stock.buy'])).toEqual(['stock.view', 'stock.costs', 'stock.buy']);
    expect(withNeeds(['made.up', 'jobs.view'])).toEqual(['jobs.view']);
    // A teller who may also refund, but not see stock.
    const teller = ['sales.sell', 'stock.view'];
    const want = ['sales.sell', 'sales.refund'];
    const t = tweaksFor(teller, want);
    expect(t).toEqual({ add: ['sales.refund', 'sales.view'], remove: ['stock.view'] });
    expect(personAccess(teller, t.add, t.remove)).toEqual(withNeeds(want));
    // The profile later gains counting: they get it too; what was taken from them stays taken.
    expect(personAccess([...teller, 'stock.count'], t.add, t.remove)).toEqual(['sales.sell', 'sales.refund', 'sales.view', 'stock.view', 'stock.count']);
    expect(neededBy('sales.view')).toEqual(['sales.refund']);
  });

  it('shows only the headings and tasks for what’s switched on', () => {
    const off = shownGroups((f) => f === 'jobs');
    expect(off.map((g) => g.key)).toEqual(['documents', 'jobs', 'costs', 'books']);
    expect(off.find((g) => g.key === 'documents')!.label).toBe('Invoices');
    expect(off.find((g) => g.key === 'costs')!.tasks.map((t) => t.key)).toEqual(['costs.capture', 'costs.view', 'costs.manage']);
    expect(off.find((g) => g.key === 'jobs')!.tasks.map((t) => t.key)).not.toContain('time.track');
    expect(shownGroups(() => true).flatMap((g) => g.tasks.map((t) => t.key))).toEqual(TASK_KEYS);
  });

  it('lets the accountant read, and only read', () => {
    for (const t of ACCOUNTANT_TASKS) expect(t).toMatch(/\.(view|costs|money)$/);
  });
});

describe('every door, for every task', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof sessionFor>>;
  beforeAll(async () => {
    env = await setup();
    owner = await sessionFor(env, 'owner@example.co.za');
  });
  afterAll(() => env.close());

  /** A member of staff with exactly these tasks (and what they need), signed in. */
  let n = 0;
  const staff = async (access: string[]) => {
    const email = `staff${++n}@example.co.za`;
    await owner.post('/api/users', { name: `Staff ${n} (made up)`, email, role: 'staff', profileId: null, access, password: 'test-password-1' });
    return sessionFor(env, email);
  };

  // Open to anyone signed in, each narrowing what it shows inside (the tests below check what).
  const ANYONE = new Set([
    'GET /api/reference', 'GET /api/live', 'GET /api/notice', 'GET /api/dashboard', 'GET /api/clients', 'GET /api/projects', 'GET /api/projects/:id',
    'GET /api/workers', 'GET /api/costs/suppliers', 'GET /api/costs/:id', 'GET /api/costs/vat-in', 'GET /api/attachments/:id', 'POST /api/feedback',
  ]);

  it('gives every route a door: some roles, some tasks, or anyone signed in on purpose', () => {
    const unguarded = Object.entries(env.doors).filter(([r, d]) => !d && !r.startsWith('POST /api/auth/') && !r.startsWith('GET /api/auth/') && !/^(GET \/api\/(health|demo\/status)|POST \/api\/demo\/leave)$/.test(r));
    expect(unguarded.map(([r]) => r)).toEqual([]);
    const anyone = Object.entries(env.doors).filter(([, d]) => d?.roles && d.roles.length === 0).map(([r]) => r);
    expect(anyone.sort()).toEqual([...ANYONE].sort());
    // Staff are let in by tasks: no role-only door lets them in.
    expect(Object.entries(env.doors).filter(([, d]) => d?.roles?.includes('staff')).map(([r]) => r)).toEqual([]);
    // Every task opens at least one door, but seeing the jobs (and their money): the jobs are
    // everyone's to choose from, and what's shown of them depends on these (tested below).
    const used = new Set(Object.values(env.doors).flatMap((d) => d?.tasks ?? []));
    expect(TASK_KEYS.filter((t) => !used.has(t))).toEqual(['jobs.view', 'jobs.money']);
  });

  // Doors that take a second task inside: a quote from a job's plan, and time onto an invoice,
  // are also making the quote or invoice.
  const ALSO: Record<string, string> = { 'POST /api/projects/:id/quote-from-plan': 'documents.edit', 'POST /api/time/bill': 'documents.edit' };
  // Each try from its own address, so the doors with a rate limit answer rather than say “wait”.
  let calls = 0;
  const tryAll = async (who: Awaited<ReturnType<typeof sessionFor>>, has: readonly string[], role: 'staff' | 'accountant' = 'staff') => {
    const wrong: string[] = [];
    for (const [r, door] of Object.entries(env.doors)) {
      if (!door || ANYONE.has(r)) continue;
      const [method, path] = r.split(' ') as [string, string];
      const url = path.replace(/:[a-zA-Z]+/g, ID);
      const n = ++calls;
      const res = await who.call({ method: method as never, url, payload: method === 'GET' || method === 'DELETE' ? undefined : ({} as never), remoteAddress: `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}` });
      const opens = (door.tasks ? door.tasks.some((t) => has.includes(t)) : door.roles!.includes(role)) && (!ALSO[r] || role !== 'staff' || has.includes(ALSO[r]!));
      if (opens && res.statusCode === 403) wrong.push(`${r}: refused, but ${door.tasks!.join('/')} opens it`);
      if (!opens && res.statusCode !== 403) wrong.push(`${r}: ${res.statusCode}, but ${door.tasks ? `it takes ${door.tasks.join('/')}` : `it’s for ${door.roles!.join('/')}`}`);
    }
    return wrong;
  };

  it('lets someone with nothing ticked through no door at all', async () => {
    const nobody = await staff([]);
    expect(await tryAll(nobody, [])).toEqual([]);
  }, 60_000);

  it('opens exactly each task’s doors (with what it needs), and no others', async () => {
    const wrong: string[] = [];
    for (const t of TASK_KEYS) {
      const has = withNeeds([t]);
      const who = await staff([t]);
      expect((await who.get('/api/auth/me')).user.access).toEqual(has);
      for (const w of await tryAll(who, has)) wrong.push(`${t}: ${w}`);
    }
    expect(wrong).toEqual([]);
  }, 300_000);

  it('keeps the accountant to reading, as before', async () => {
    const acc = await sessionFor(env, 'accountant@example.co.za');
    expect((await acc.get('/api/auth/me')).user.access).toEqual([...ACCOUNTANT_TASKS]);
    expect(await tryAll(acc, ACCOUNTANT_TASKS, 'accountant')).toEqual([]);
  }, 60_000);
});

describe('profiles and people', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof sessionFor>>;
  const profile = async (name: string) => (await owner.get('/api/profiles')).find((p: { name: string }) => p.name === name);
  beforeAll(async () => {
    env = await setup();
    owner = await sessionFor(env, 'owner@example.co.za');
  });
  afterAll(() => env.close());

  it('starts every business with Teller, Admin and Site staff, and site capture is Site staff', async () => {
    const all = await owner.get('/api/profiles');
    expect(all.map((p: { name: string }) => p.name)).toEqual(['Admin', 'Site staff', 'Teller']);
    expect((await profile('Site staff')).people).toBe(1);
    const site = await sessionFor(env, 'site@example.co.za');
    expect((await site.get('/api/auth/me')).user).toMatchObject({ role: 'staff', access: ['jobs.view', 'labour.log', 'costs.capture'] });
  });

  it('moves site capture onto Site staff when Shap is upgraded', async () => {
    const body = await readFile(join(__dirname, '../migrations/042_access.sql'), 'utf8');
    await env.sql.begin(async (tx) => {
      await tx`alter table users drop constraint users_role_check`;
      await tx`alter table users drop constraint users_staff_access`;
      await tx`insert into users (name, email, password_hash, role) values ('Old capture (made up)', 'old-capture@example.co.za', 'x', 'capture')`;
      await tx.unsafe(body);
    });
    const [u] = await env.sql<{ role: string; profile: string }[]>`select u.role, p.name as profile from users u join profiles p on p.id = u.profile_id where u.email = 'old-capture@example.co.za'`;
    expect(u).toEqual({ role: 'staff', profile: 'Site staff' });
    // Run again, nothing changes (and the profiles aren't doubled).
    await env.sql.unsafe(body);
    expect((await owner.get('/api/profiles')).length).toBe(3);
  });

  it('gives a change to a profile to everyone on it at once, except what was changed for them', async () => {
    const teller = await profile('Teller');
    await owner.post('/api/users', { name: 'Nomsa (made up)', email: 'nomsa@example.co.za', role: 'staff', profileId: teller.id, password: 'test-password-1' });
    // Lindiwe: a teller who may refund, but doesn't see the stock.
    await owner.post('/api/users', { name: 'Lindiwe (made up)', email: 'lindiwe@example.co.za', role: 'staff', profileId: teller.id, access: ['sales.sell', 'sales.refund'], password: 'test-password-1' });
    const nomsa = await sessionFor(env, 'nomsa@example.co.za');
    const lindiwe = await sessionFor(env, 'lindiwe@example.co.za');
    expect((await nomsa.get('/api/auth/me')).user.access).toEqual(['sales.sell', 'stock.view']);
    expect((await lindiwe.get('/api/auth/me')).user.access).toEqual(['sales.sell', 'sales.refund', 'sales.view']);
    const [row] = await env.sql<{ accessAdd: string[]; accessRemove: string[] }[]>`select access_add, access_remove from users where email = 'lindiwe@example.co.za'`;
    expect(row).toEqual({ accessAdd: ['sales.refund', 'sales.view'], accessRemove: ['stock.view'] });
    // Tellers now count stock too: both have it, in the sessions they already have.
    await owner.post(`/api/profiles/${teller.id}`, { name: 'Teller', access: ['sales.sell', 'stock.view', 'stock.count'] }, 'PUT');
    expect((await nomsa.get('/api/auth/me')).user.access).toEqual(['sales.sell', 'stock.view', 'stock.count']);
    expect((await lindiwe.get('/api/auth/me')).user.access).toEqual(['sales.sell', 'sales.refund', 'sales.view', 'stock.view', 'stock.count']);
    // Untick stock for the profile: Nomsa loses it at once.
    await owner.post(`/api/profiles/${teller.id}`, { name: 'Teller', access: ['sales.sell'] }, 'PUT');
    expect((await nomsa.call({ method: 'GET', url: '/api/stock/takes' })).statusCode).toBe(403);
    const users = await owner.get('/api/users');
    expect(users.find((u: { email: string }) => u.email === 'lindiwe@example.co.za')).toMatchObject({ profileName: 'Teller', access: ['sales.sell', 'sales.refund', 'sales.view'] });
  });

  it('keeps profiles and people the owner’s, refuses removing a profile in use, and drops made-up tasks', async () => {
    const nomsa = await sessionFor(env, 'nomsa@example.co.za');
    const [me] = await env.sql<{ id: string }[]>`select id from users where email = 'nomsa@example.co.za'`;
    expect((await nomsa.call({ method: 'PUT', url: `/api/users/${me!.id}`, payload: { name: 'Nomsa', email: 'nomsa@example.co.za', role: 'owner' } })).statusCode).toBe(403);
    expect((await nomsa.call({ method: 'POST', url: '/api/profiles', payload: { name: 'Mine', access: TASK_KEYS } })).statusCode).toBe(403);
    expect((await nomsa.call({ method: 'GET', url: '/api/users' })).statusCode).toBe(403);
    const teller = await profile('Teller');
    expect((await owner.call({ method: 'DELETE', url: `/api/profiles/${teller.id}` })).statusCode).toBe(400);
    const odd = await owner.post('/api/profiles', { name: 'Odd jobs (made up)', access: ['jobs.edit', 'settings.everything'] });
    expect(odd.access).toEqual(['jobs.view', 'jobs.money', 'jobs.edit']);
    expect((await owner.call({ method: 'POST', url: '/api/profiles', payload: { name: 'odd JOBS (made up)' } })).statusCode).toBe(409);
    await owner.post(`/api/profiles/${odd.id}`, {}, 'DELETE');
    // Only staff are on a profile: making someone the accountant takes them off it.
    await owner.post(`/api/users/${me!.id}`, { name: 'Nomsa', email: 'nomsa@example.co.za', role: 'accountant', profileId: teller.id, access: ['sales.sell'] }, 'PUT');
    const [row] = await env.sql<{ profileId: string | null; accessAdd: string[] }[]>`select profile_id, access_add from users where id = ${me!.id}`;
    expect(row).toEqual({ profileId: null, accessAdd: [] });
    const audits = await env.sql<{ entity: string; action: string }[]>`select entity, action from audit_log where entity = 'profile' order by id`;
    expect(audits.map((a) => a.action)).toEqual(['update', 'update', 'create', 'delete']);
  });
});

describe('staff at work', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof sessionFor>>;
  let till: string;
  let bills: string;
  let bank: string;
  let globe: { id: string };
  beforeAll(async () => {
    env = await setup();
    owner = await sessionFor(env, 'owner@example.co.za');
    const { settings, sources } = await owner.get('/api/reference');
    await owner.post('/api/settings', { ...settings, vatRegistered: true, vatNumber: '4740101508', features: { ...settings.features, inventory: true, bills: true } }, 'PUT');
    till = (await env.sql<{ id: string }[]>`select id from payment_sources where till`)[0]!.id;
    bills = sources.find((s: { role: string | null }) => s.role === 'bills').id;
    bank = await (await ref(env.sql)).src('Business bank');
    globe = await owner.post('/api/items', { description: 'LED globe 9W (made up)', sku: 'LED9', unitPriceCents: 4_600, priceIncludesVat: true, stocked: true });
    await owner.post('/api/stock/purchases', { date: D, supplier: 'Fictional Wholesale', reference: 'FW-1', sourceId: bills, lines: [{ itemId: globe.id, qtyInvoiced: 10, unitCostCents: 2_000 }] });
    const profiles = await owner.get('/api/profiles');
    const id = (n: string) => profiles.find((p: { name: string }) => p.name === n).id;
    for (const [email, p] of [['thabo@example.co.za', 'Teller'], ['zanele@example.co.za', 'Teller'], ['admin@example.co.za', 'Admin']] as const) {
      await owner.post('/api/users', { name: `${email.split('@')[0]} (made up)`, email, role: 'staff', profileId: id(p), password: 'test-password-1' });
    }
  });
  afterAll(() => env.close());

  it('a teller sells, sees their own sales and slips, and not what stock cost', async () => {
    const thabo = await sessionFor(env, 'thabo@example.co.za');
    const zanele = await sessionFor(env, 'zanele@example.co.za');
    const items = await thabo.get('/api/items');
    expect(items[0]).toMatchObject({ description: 'LED globe 9W (made up)', qtyOnHand: 10, unitPriceCents: 4_600 });
    expect(Object.keys(items[0]).filter((k) => /cost|value/i.test(k))).toEqual([]);
    const history = await thabo.get(`/api/items/${globe.id}/history`);
    expect(history.moves[0].qty).toBe(10);
    expect(JSON.stringify(history)).not.toMatch(/valueCents|lastCostCents|stockValueCents/);
    const sale = await thabo.post('/api/sales', { date: D, sourceId: till, method: 'cash', lines: [{ itemId: globe.id, description: 'LED globe 9W (made up)', qty: 2, unitPriceCents: 4_600 }] });
    const other = await zanele.post('/api/sales', { date: D, sourceId: till, method: 'cash', lines: [{ itemId: globe.id, description: 'LED globe 9W (made up)', qty: 1, unitPriceCents: 4_600 }] });
    expect((await thabo.get('/api/sales')).map((s: { id: string }) => s.id)).toEqual([sale.id]);
    expect((await thabo.get(`/api/sales/${sale.id}`)).stock[0]).not.toHaveProperty('valueCents');
    expect((await thabo.call({ method: 'GET', url: `/api/sales/${other.id}` })).statusCode).toBe(404);
    expect((await thabo.call({ method: 'GET', url: `/api/documents/${sale.id}/pdf` })).statusCode).toBe(200);
    expect((await thabo.call({ method: 'GET', url: `/api/documents/${other.id}/pdf` })).statusCode).toBe(404);
    expect(await thabo.get('/api/sales-today')).toMatchObject({ mine: true });
    // Not refunds, not the stock's cost, not the invoices, not the books.
    const refund = { date: D, money: 'paid_out', sourceId: till, reason: 'Broken (made up)', lines: [{ lineId: (await owner.get(`/api/sales/${sale.id}`)).lines[0].id, qty: 1 }] };
    expect((await thabo.call({ method: 'POST', url: `/api/documents/${sale.id}/refund`, payload: refund })).statusCode).toBe(403);
    for (const url of ['/api/stock/valuation', '/api/documents', '/api/reports/trial-balance', '/api/costs']) expect((await thabo.call({ method: 'GET', url })).statusCode).toBe(403);
    // The names and pickers, not the company's bank details or numbering.
    const r = await thabo.get('/api/reference');
    expect(r.accounts).toEqual([]);
    expect(r.settings).not.toHaveProperty('bankDetails');
    expect(r.settings.features).toMatchObject({ sales: true, inventory: true });
    expect((await thabo.get('/api/dashboard')).limited).toBe(true);
    // With “Refund” ticked for Thabo alone, he refunds (any sale: refunding sees them all).
    const [t] = await env.sql<{ id: string; profileId: string }[]>`select id, profile_id from users where email = 'thabo@example.co.za'`;
    await owner.post(`/api/users/${t!.id}`, { name: 'thabo (made up)', email: 'thabo@example.co.za', role: 'staff', profileId: t!.profileId, access: ['sales.sell', 'stock.view', 'sales.refund'] }, 'PUT');
    expect((await thabo.call({ method: 'POST', url: `/api/documents/${sale.id}/refund`, payload: refund })).statusCode).toBe(200);
    expect((await thabo.get('/api/sales')).length).toBe(2);
    // An invoice that wasn't a sale isn't the counter's to take goods back on.
    const client = await owner.post('/api/clients', { name: 'Fictional Builders', address: '3 Test Road, Fictional Town' });
    const inv = await owner.post('/api/documents', { kind: 'invoice', clientId: client.id, issueDate: D, lines: [{ category: 'materials', description: 'Taps (made up)', qty: 1, unitPriceCents: 10_000 }] });
    await owner.post(`/api/documents/${inv.id}/issue`);
    const invLine = (await owner.get(`/api/sales/${inv.id}`)).lines[0].id;
    expect((await thabo.call({ method: 'POST', url: `/api/documents/${inv.id}/refund`, payload: { ...refund, money: 'off_owing', lines: [{ lineId: invLine, qty: 1 }] } })).statusCode).toBe(403);
    expect((await thabo.call({ method: 'GET', url: `/api/sales/${inv.id}` })).statusCode).toBe(404);
  });

  it('an admin captures a supplier’s invoice with its VAT, pays it, and reads the reports; never the settings', async () => {
    const admin = await sessionFor(env, 'admin@example.co.za');
    const cat = (await env.sql<{ id: string }[]>`select id from cost_categories where kind = 'overhead' limit 1`)[0]!.id;
    const bill = await admin.post('/api/costs', { date: D, description: 'Printer paper (made up)', supplier: 'Fictional Stationers', billNumber: 'FS-9', amountCents: 11_500, vatCents: 1_500, vatCode: 'standard', categoryId: cat, sourceId: bills });
    expect(bill.vatCents).toBe(1_500);
    await admin.post(`/api/costs/${bill.id}/bill-payments`, { date: D, amountCents: 11_500, sourceId: bank });
    expect((await admin.get('/api/reports/trial-balance')).length ?? 1).toBeTruthy();
    expect((await admin.call({ method: 'GET', url: '/api/vat/return?period=2026-08' })).statusCode).not.toBe(403);
    const r = await admin.get('/api/reference');
    expect(r.accounts.length).toBeGreaterThan(10);
    const { settings } = r;
    for (const [method, url, payload] of [
      ['PUT', '/api/settings', settings],
      ['GET', '/api/users', undefined],
      ['POST', '/api/profiles', { name: 'More', access: [] }],
      ['POST', '/api/statements/2027-02-28/approve', { name: 'x', date: D }],
      ['PUT', '/api/year-ends', {}],
      ['GET', '/api/audit', undefined],
    ] as const) expect((await admin.call({ method, url, payload: payload as never })).statusCode).toBe(403);
  });

  it('site staff capture a slip without its VAT; whoever manages the costs captures it whole', async () => {
    const site = await sessionFor(env, 'site@example.co.za');
    const cat = (await env.sql<{ id: string }[]>`select id from cost_categories where kind = 'materials' limit 1`)[0]!.id;
    const slip = await site.post('/api/costs', { date: D, description: 'Cement (made up)', supplier: 'Fictional Hardware', amountCents: 23_000, vatCents: 3_000, vatCode: 'standard', categoryId: cat, sourceId: bank });
    expect(slip.vatCents).toBe(0);
    expect((await site.call({ method: 'POST', url: '/api/costs', payload: { date: D, description: 'On account', amountCents: 1_000, categoryId: cat, sourceId: bills } })).statusCode).toBe(400);
  });

  it('opens a slip for those who see the costs, but never a bank statement pointed at from a cost', async () => {
    const owner2 = owner;
    await owner2.post('/api/statement-files', { sourceId: bank, month: '2026-07', filename: 'july.pdf', mime: 'application/pdf', dataBase64: PDF });
    const [st] = await env.sql<{ attachmentId: string }[]>`select attachment_id from statement_files limit 1`;
    // A bookkeeper who sees and captures the costs, but not the books.
    await owner.post('/api/users', { name: 'Costs only (made up)', email: 'costs@example.co.za', role: 'staff', profileId: null, access: ['costs.view', 'costs.capture'], password: 'test-password-1' });
    const costs = await sessionFor(env, 'costs@example.co.za');
    const site = await sessionFor(env, 'site@example.co.za');
    const photo = await site.post('/api/attachments', { filename: 'slip.png', mime: 'image/png', dataBase64: PNG });
    const cat = (await env.sql<{ id: string }[]>`select id from cost_categories where kind = 'materials' limit 1`)[0]!.id;
    await site.post('/api/costs', { date: D, description: 'Sand (made up)', amountCents: 5_000, categoryId: cat, sourceId: bank, receiptId: photo.id });
    expect((await costs.call({ method: 'GET', url: `/api/attachments/${photo.id}` })).statusCode).toBe(200);
    await costs.post('/api/costs', { date: D, description: 'Pointing at the statement', amountCents: 1_000, categoryId: cat, sourceId: bank, receiptId: st!.attachmentId });
    expect((await costs.call({ method: 'GET', url: `/api/attachments/${st!.attachmentId}` })).statusCode).toBe(404);
    expect((await site.call({ method: 'GET', url: `/api/attachments/${st!.attachmentId}` })).statusCode).toBe(404);
    expect((await owner.call({ method: 'GET', url: `/api/attachments/${st!.attachmentId}` })).statusCode).toBe(200);
  });

  it('leaves the books as they should be', async () => {
    await expectCleanAudit(env.sql, D);
  });
});
