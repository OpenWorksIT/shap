/**
 * Loads a fictional demo company: a generated tracker (imported the same way a real one
 * is), demo logins, a draft quote with a parts plan, and an asset.
 *   npm run db:seed -- --i-know-this-is-demo-data [--reset]
 * Refuses to touch a database that already has people signing in, unless --reset.
 */
import { addDays } from '@shap/shared';
import { createUser } from '../auth.js';
import { loadConfig } from '../config.js';
import { today } from '../lib/books.js';
import { createDocument } from '../modules/documents.js';
import { applyTracker } from '../modules/import/apply.js';
import { readTracker } from '../modules/import/tracker.js';
import { createDb, type Sql } from './index.js';
import { migrate } from './migrate.js';
import { buildDemoTracker } from './demo-tracker.js';

export const DEMO_USERS = [
  { email: 'owner@example.co.za', name: 'Demo Owner', role: 'owner' as const },
  { email: 'site@example.co.za', name: 'Sipho (site)', role: 'capture' as const },
  { email: 'accountant@example.co.za', name: 'Accountant', role: 'accountant' as const },
];

export async function seed(sql: Sql, opts: { reset?: boolean; password?: string } = {}): Promise<void> {
  if (opts.reset) {
    await sql.unsafe('drop schema public cascade; create schema public;');
  }
  await migrate(sql);
  const [users] = await sql<{ n: number }[]>`select count(*)::int as n from users`;
  if (users!.n > 0) throw new Error('This database already has users. Run with --reset to wipe it and load the demo company.');
  const password = opts.password ?? 'demo-shap-1';
  for (const u of DEMO_USERS) await createUser(sql, { ...u, password });
  await sql`update settings set company_name = 'Demo Builders (Pty) Ltd', trading_name = 'Demo Builders', reg_number = '2024/000000/07',
    address = ${'12 Example Street\nGqeberha 6001'}, phone = '041 000 0000', email = 'accounts@example.co.za',
    bank_details = ${'Example Bank · Business cheque account\nAccount 000 000 0000 · Branch 250655'} where id`;
  const { buffer } = await buildDemoTracker(today());
  await applyTracker(sql, await readTracker(buffer), { agreeTrialBalance: true });
  await sql`update clients set name = case code
      when 'Naidoo001' then 'Priya Naidoo' when 'Mokoena001' then 'Lerato Mokoena' when 'Smith001' then 'Jan Smith'
      when 'Dlamini001' then 'Dlamini Family Trust' when 'VanWyk001' then 'Van Wyk Properties' when 'Pillay001' then 'Kevin Pillay' else name end,
    email = lower(code) || '@example.com'`;

  // An open job with a parts plan and a draft quote made from it.
  const [job] = await sql<{ id: string; clientId: string }[]>`select id, client_id from projects where status = 'active' order by number desc limit 1`;
  if (job) {
    const items = [
      ['Roof sheets 3.6 m', 12, 'each', 28500, 'Builders'],
      ['Purlins 38x114', 8, 'each', 18900, 'Builders'],
      ['Roofing screws', 4, 'box', 21500, 'Mica'],
      ['Ridge capping', 3, 'each', 16500, 'Builders'],
    ] as const;
    let sort = 1;
    for (const [description, qty, unit, unitCostCents, supplier] of items) {
      await sql`insert into planned_items (project_id, description, qty, unit, unit_cost_cents, supplier, sort) values (${job.id}, ${description}, ${qty}, ${unit}, ${unitCostCents}, ${supplier}, ${sort++})`;
    }
    const [p] = await sql<{ name: string }[]>`select name from projects where id = ${job.id}`;
    await sql.begin((tx) =>
      createDocument(tx, null, 'quote', {
        projectId: job.id,
        issueDate: today(),
        title: `${p!.name}: new roof over the patio`,
        lines: [
          { category: 'labour', description: 'Strip old sheeting, fit purlins and new roof (2 builders)', qty: 4, unit: 'days', unitPriceCents: 180000 },
          ...items.map(([description, qty, unit, unitCostCents]) => ({ category: 'materials' as const, description, qty, unit, unitPriceCents: Math.round(unitCostCents * 1.35) })),
          { category: 'demo', description: 'Remove and dispose of old sheeting', qty: 1, unit: '', unitPriceCents: 95000 },
        ],
      }),
    );
  }
  const [bakkie] = await sql<{ id: string }[]>`select id from payment_sources where kind = 'owner' limit 1`;
  await sql`insert into assets (name, category, purchase_date, cost_cents, source_id, life_months, residual_cents, notes)
    values ('Isuzu bakkie', 'vehicles', ${addDays(today(), -300)}, 18500000, ${bakkie!.id}, 60, 3500000, 'Sold to the company by the owner')`;
}

if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  if (!process.argv.includes('--i-know-this-is-demo-data')) {
    console.error('This loads a FICTIONAL demo company. Run with --i-know-this-is-demo-data (and --reset to wipe the database first).');
    process.exit(1);
  }
  const sql = createDb(loadConfig().DATABASE_URL, { max: 2 });
  try {
    await seed(sql, { reset: process.argv.includes('--reset'), password: process.env.DEMO_PASSWORD });
    console.log(`Demo company loaded. Sign in as ${DEMO_USERS.map((u) => u.email).join(', ')} with password ${process.env.DEMO_PASSWORD ? '(DEMO_PASSWORD)' : 'demo-shap-1'}.`);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
