/**
 * Scale test: ten years of a busy small team's books, then every main screen timed, and five
 * people using Shap at the same time. Skipped in the normal run (it takes a few minutes):
 *
 *   SCALE=1 npx vitest run test/scale.test.ts
 *
 * SCALE_YEARS (default 10) changes the size. The numbers are printed as a table at the end.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser } from '../src/auth.js';
import { appVersion } from '../src/modules/system.js';
import { login, setup, type TestEnv } from './helpers.js';

const on = Boolean(process.env.SCALE);
const YEARS = Number(process.env.SCALE_YEARS ?? 10);
// A year for a busy five-person team: 3 000 invoices, 1 000 quotes, 6 000 costs, 5 000 labour days.
const PER_YEAR = { invoices: 3000, quotes: 1000, costs: 6000, labour: 5000, clients: 200, projects: 300 };

describe.skipIf(!on)('Shap at scale', () => {
  let env: TestEnv;
  const rows: { what: string; ms: number; note?: string }[] = [];
  const sizes: Record<string, number> = {};

  beforeAll(async () => {
    env = await setup();
    const { sql } = env;
    const t0 = Date.now();
    const n = (k: keyof typeof PER_YEAR) => PER_YEAR[k] * YEARS;
    const start = `${2026 - YEARS}-03-01`;
    await sql.unsafe(`
      insert into clients (code, name, email, phone, address)
        select 'C' || i, 'Client ' || i, 'client' || i || '@example.co.za', '082 000 ' || lpad(i::text, 4, '0'), i || ' Example Street'
        from generate_series(1, ${n('clients')}) i;
      insert into workers (name, kind, day_rate_cents) select 'Worker ' || i, 'casual', 45000 from generate_series(1, 5) i;
      insert into projects (number, name, client_id, status, start_date)
        select i, 'Job ' || i, (select id from clients where code = 'C' || (1 + i % ${n('clients')})), case when i % 10 = 0 then 'active' else 'done' end,
               date '${start}' + (i * ${YEARS * 365} / ${n('projects')})
        from generate_series(1, ${n('projects')}) i;
    `);
    // Invoices and quotes with three lines each, spread evenly over the years.
    await sql.unsafe(`
      create temporary table g as
        select i, (date '${start}' + (i * ${YEARS * 365} / ${n('invoices')}))::date as d,
               (select id from clients where code = 'C' || (1 + i % ${n('clients')})) as client_id,
               case when i % 3 = 0 then (select id from projects where number = 1 + i % ${n('projects')}) end as project_id,
               100000 + (i::bigint * 7919) % 900000 as amount
        from generate_series(1, ${n('invoices')}) i;
      insert into documents (kind, number, status, client_id, project_id, issue_date, due_date, title, subtotal_cents, total_cents)
        select 'invoice', 'INV' || lpad(i::text, 6, '0'), 'issued', client_id, project_id, d, d + 7, 'Work ' || i, amount, amount from g;
      insert into document_lines (document_id, sort, category, description, qty, unit, unit_price_cents, line_total_cents)
        select doc.id, s, (array['labour','materials','other'])[s], (array['Labour','Materials','Call-out'])[s] || ' ' || (g.i % 50), 1, '',
               case s when 1 then g.amount / 2 when 2 then g.amount / 3 else g.amount - g.amount / 2 - g.amount / 3 end,
               case s when 1 then g.amount / 2 when 2 then g.amount / 3 else g.amount - g.amount / 2 - g.amount / 3 end
        from g join documents doc on doc.number = 'INV' || lpad(g.i::text, 6, '0') and doc.kind = 'invoice', generate_series(1, 3) s;
      insert into receipts (invoice_id, date, amount_cents, source_id, reference)
        select doc.id, doc.issue_date + 5, doc.total_cents, (select id from payment_sources where name = 'Business bank'), doc.number
        from documents doc where doc.kind = 'invoice' and doc.issue_date < current_date - 60;
      insert into documents (kind, number, status, client_id, issue_date, due_date, title, subtotal_cents, total_cents)
        select 'quote', 'Q' || lpad(i::text, 6, '0'), case when i % 2 = 0 then 'accepted' else 'sent' end,
               (select id from clients where code = 'C' || (1 + i % ${n('clients')})),
               (date '${start}' + (i * ${YEARS * 365} / ${n('quotes')}))::date, null, 'Quote ' || i, 150000, 150000
        from generate_series(1, ${n('quotes')}) i;
    `);
    await sql.unsafe(`
      insert into costs (date, description, amount_cents, supplier, category_id, source_id, project_id)
        select (date '${start}' + (i * ${YEARS * 365} / ${n('costs')}))::date, 'Cost ' || (i % 400), 5000 + (i::bigint * 104729) % 300000, 'Supplier ' || (i % 60),
               (select id from cost_categories where name = (array['Parts','Petrol','Cellphone','Tool','Sundry'])[1 + i % 5]),
               (select id from payment_sources where name = 'Business bank'),
               case when i % 5 = 0 then (select id from projects where number = 1 + i % ${n('projects')}) end
        from generate_series(1, ${n('costs')}) i;
      insert into labour_entries (date, worker_id, project_id, days, wage_cents)
        select (date '${start}' + (i * ${YEARS * 365} / ${n('labour')}))::date, (select id from workers where name = 'Worker ' || (1 + i % 5)),
               (select id from projects where number = 1 + i % ${n('projects')}), 1, 45000
        from generate_series(1, ${n('labour')}) i;
      insert into wage_payments (date, worker_id, amount_cents, source_id)
        select (date '${start}' + (i * 7))::date, (select id from workers where name = 'Worker ' || (1 + i % 5)), 450000, (select id from payment_sources where name = 'Business bank')
        from generate_series(1, ${YEARS * 52 * 5 / 5}) i;
      analyze;
    `);
    for (const t of ['documents', 'document_lines', 'receipts', 'costs', 'labour_entries', 'clients', 'projects']) {
      const [r] = await sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${t}`);
      sizes[t] = r!.n;
    }
    const [db] = await sql<{ s: string }[]>`select pg_size_pretty(pg_database_size(current_database())) as s`;
    sizes.load_seconds = Math.round((Date.now() - t0) / 1000);
    rows.push({ what: 'Database size', ms: 0, note: db!.s });
    for (let i = 1; i <= 5; i++) await createUser(sql, { name: `Person ${i}`, email: `p${i}@example.co.za`, password: 'test-password-1', role: i === 1 ? 'owner' : 'staff' });
  }, 600_000);

  afterAll(async () => {
    console.log(`\nScale test, ${YEARS} years: ${JSON.stringify(sizes)}`);
    console.table(rows.map((r) => ({ what: r.what, ms: r.ms, note: r.note ?? '' })));
    await env?.close();
  });

  it('opens every main screen quickly', async () => {
    const me = await login(env.app, 'owner@example.co.za');
    const client = (await env.sql<{ id: string }[]>`select id from clients where code = 'C7'`)[0]!.id;
    const project = (await env.sql<{ id: string }[]>`select id from projects where number = 10`)[0]!.id;
    const doc = (await env.sql<{ id: string }[]>`select id from documents where number = 'INV000100'`)[0]!.id;
    const screens: [string, string][] = [
      ['Home', '/api/dashboard'],
      ['Reference (opening the app)', '/api/reference'],
      ['Invoices list', '/api/documents?kind=invoice'],
      ['Quotes list', '/api/documents?kind=quote'],
      ['One invoice', `/api/documents/${doc}`],
      ['Invoice PDF', `/api/documents/${doc}/pdf`],
      ['Usual items', '/api/documents/usual-lines'],
      ['Costs list', '/api/costs'],
      ['Clients', '/api/clients'],
      ['One client', `/api/clients/${client}`],
      ['Jobs', '/api/projects'],
      ['One job', `/api/projects/${project}`],
      ['Workers', '/api/workers'],
      ['Labour list', '/api/labour'],
      ['Income statement (this year)', '/api/reports/income-statement'],
      ['Balance sheet', '/api/reports/balance-sheet'],
      ['Trial balance', '/api/reports/trial-balance'],
      ['Balance checks', '/api/balance-checks'],
      ['Provisional tax', '/api/reports/provisional-tax'],
      ['Year ends', '/api/year-ends'],
    ];
    for (const [what, url] of screens) {
      await me.call({ method: 'GET', url }); // warm
      const t = performance.now();
      const r = await me.call({ method: 'GET', url });
      const ms = Math.round(performance.now() - t);
      rows.push({ what, ms, note: r.statusCode === 200 ? '' : `HTTP ${r.statusCode}` });
      expect(r.statusCode, `${what} ${r.body.slice(0, 200)}`).toBe(200);
    }
    // Saving: a new invoice with lines, issued and paid.
    const t = performance.now();
    const inv = await me.post('/api/documents', { kind: 'invoice', clientId: client, issueDate: '2026-11-02', lines: [{ category: 'labour', description: 'Labour', qty: 2, unitPriceCents: 55000 }] });
    await me.post(`/api/documents/${inv.id}/issue`);
    rows.push({ what: 'Make and issue an invoice', ms: Math.round(performance.now() - t) });
    // The first report after a change works the totals out again.
    const t2 = performance.now();
    await me.get('/api/dashboard');
    rows.push({ what: 'Home right after a change (totals rebuilt)', ms: Math.round(performance.now() - t2) });
    // Screens within 2 s; the one report after a change that rebuilds the totals within 4 s.
    const slow = rows.filter((r) => r.ms > (r.what.includes('rebuilt') ? 4000 : 2000));
    expect(slow, JSON.stringify(slow)).toEqual([]);
  }, 600_000);

  it('serves five people at once', async () => {
    await env.app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(env.app.server.address() as AddressInfo).port}`;
    const cookies: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shap-version': appVersion() }, body: JSON.stringify({ email: `p${i}@example.co.za`, password: 'test-password-1' }) });
      cookies.push(r.headers.get('set-cookie')!.split(';')[0]!);
    }
    const project = (await env.sql<{ id: string }[]>`select id from projects where number = 20`)[0]!.id;
    const worker = (await env.sql<{ id: string }[]>`select id from workers limit 1`)[0]!.id;
    const times: number[] = [];
    let errors = 0;
    const person = async (i: number) => {
      const h = { cookie: cookies[i]!, 'x-shap-version': appVersion(), 'content-type': 'application/json' };
      for (let k = 0; k < 20; k++) {
        const t = performance.now();
        const r =
          i === 0
            ? await fetch(`${base}${['/api/dashboard', '/api/documents?kind=invoice', '/api/costs', '/api/reports/income-statement'][k % 4]}`, { headers: h })
            : k % 2
              ? await fetch(`${base}/api/labour`, { method: 'POST', headers: h, body: JSON.stringify({ date: '2026-11-02', projectId: project, entries: [{ workerId: worker, days: 1, wageCents: 45000 }] }) })
              : await fetch(`${base}/api/dashboard`, { headers: h });
        await r.arrayBuffer();
        if (r.status >= 400 && r.status !== 404) errors++;
        times.push(performance.now() - t);
      }
    };
    const t0 = performance.now();
    await Promise.all([0, 1, 2, 3, 4].map(person));
    const wall = Math.round(performance.now() - t0);
    times.sort((a, b) => a - b);
    const p = (q: number) => Math.round(times[Math.floor(q * (times.length - 1))]!);
    rows.push({ what: '5 people × 20 requests at once: median', ms: p(0.5) });
    rows.push({ what: '5 people × 20 requests at once: 95th percentile', ms: p(0.95) });
    rows.push({ what: '5 people × 20 requests at once: all done', ms: wall, note: `${errors} errors` });
    expect(errors).toBe(0);
  }, 600_000);
});
