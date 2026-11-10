/**
 * Who may do what (Settings → People who sign in). The owner may do everything, and the
 * accountant reads everything (and compiles the financial statements). Everyone else is
 * **staff**, with the jobs they're given ticked: from a named profile (Teller, Admin, Site
 * staff…), changed for that person if need be. A profile's change reaches everyone on it, except
 * what was changed for them.
 *
 * Each task is one job someone does, under the heading of the part of Shap it's in. A heading or
 * a task belongs to a feature: switched off, it isn't shown (and what was ticked is kept for when
 * it's back on). A task can need another (refunding needs the sales to be seen): having one gives
 * the other.
 *
 * What's never anyone's but the owner's: the settings, the people who sign in and their profiles,
 * the year end, tax estimates, dividends and profit shares, approving the financial statements,
 * backups and the system.
 */
import type { Feature } from './features.js';

export interface AccessTask {
  key: string;
  label: string;
  hint?: string;
  /** Shown only while this feature is on. */
  feature?: Feature;
  /** Having this task gives these too. */
  needs?: readonly string[];
}
export interface AccessGroup {
  key: string;
  label: string;
  feature?: Feature;
  tasks: readonly AccessTask[];
}

export const ACCESS_GROUPS = [
  {
    key: 'selling',
    label: 'Selling',
    feature: 'sales',
    tasks: [
      { key: 'sales.sell', label: 'Sell at the counter', hint: 'Ring up sales, take the money, hand over the slip, make a sale an invoice. They see their own sales.' },
      { key: 'sales.refund', label: 'Refund', hint: 'Take goods back and pay the money out', needs: ['sales.view'] },
      { key: 'sales.view', label: 'See all sales and takings', hint: 'Everyone’s sales and each day’s takings' },
      { key: 'items.edit', label: 'Change items and prices' },
    ],
  },
  {
    key: 'inventory',
    label: 'Inventory',
    feature: 'inventory',
    tasks: [
      { key: 'stock.view', label: 'See stock', hint: 'What’s on hand and each item’s history, in quantities' },
      { key: 'stock.costs', label: 'See what stock cost', hint: 'Cost prices and what the stock is worth', needs: ['stock.view'] },
      { key: 'stock.buy', label: 'Supplier invoices, returns and credits', needs: ['stock.costs'] },
      { key: 'stock.count', label: 'Count stock', hint: 'Stock takes, with the reasons', needs: ['stock.view'] },
    ],
  },
  {
    key: 'documents',
    label: 'Quotes & invoices',
    tasks: [
      { key: 'documents.view', label: 'See quotes and invoices' },
      { key: 'documents.edit', label: 'Make and change them', hint: 'Draft, issue, send, convert, credit notes, monthly invoices', needs: ['documents.view'] },
      { key: 'documents.paid', label: 'Record what’s paid on them', hint: 'Payments received and write-offs', needs: ['documents.view'] },
      { key: 'clients.edit', label: 'Add and change clients' },
    ],
  },
  {
    key: 'jobs',
    label: 'Jobs',
    feature: 'jobs',
    tasks: [
      { key: 'jobs.view', label: 'See jobs', hint: 'The jobs and their parts lists, without the money' },
      { key: 'jobs.money', label: 'See what jobs make', hint: 'Quoted, invoiced, costs and profit', needs: ['jobs.view'] },
      { key: 'jobs.edit', label: 'Add and change jobs and their plans', needs: ['jobs.money'] },
      { key: 'time.track', label: 'Track time on jobs', feature: 'timeTracker', needs: ['jobs.view'] },
    ],
  },
  {
    key: 'workers',
    label: 'Casual workers',
    feature: 'workers',
    tasks: [
      { key: 'labour.log', label: 'Log days worked', hint: 'At each worker’s day rate; their own entries can be changed for a day' },
      { key: 'labour.view', label: 'See days worked and wages' },
      { key: 'workers.manage', label: 'Workers, rates and wages paid', needs: ['labour.view'] },
    ],
  },
  {
    key: 'costs',
    label: 'Costs & bills',
    tasks: [
      { key: 'costs.capture', label: 'Capture slips', hint: 'No VAT claimed and no bills; their own can be changed for a day' },
      { key: 'costs.view', label: 'See all costs' },
      { key: 'costs.manage', label: 'Capture and change any cost', hint: 'Supplier invoices with VAT, bills to pay later, splitting, merging and tidying', needs: ['costs.view'] },
      { key: 'bills.pay', label: 'Pay bills', feature: 'bills', needs: ['costs.view'] },
      { key: 'logbook.trips', label: 'Log trips in the travel logbook', feature: 'logbook' },
    ],
  },
  {
    key: 'payroll',
    label: 'Payroll',
    feature: 'payroll',
    tasks: [
      { key: 'payroll.view', label: 'See payroll and payslips', hint: 'Salaries, payslips and what’s owed to SARS' },
      { key: 'payroll.run', label: 'Run payroll', hint: 'Employees, pay runs and SARS payments', needs: ['payroll.view'] },
    ],
  },
  {
    key: 'books',
    label: 'Accounts & reports',
    tasks: [
      { key: 'reports.view', label: 'Reports, VAT201 and the ledger', hint: 'Every report and the books, read only, and the financial statements' },
      { key: 'bank.reconcile', label: 'Bank statements', hint: 'Bring them in and tick off what’s captured', feature: 'bank', needs: ['reports.view'] },
      { key: 'books.adjust', label: 'Journals, assets and balance checks', needs: ['reports.view'] },
    ],
  },
] as const satisfies readonly AccessGroup[];

export type Task = (typeof ACCESS_GROUPS)[number]['tasks'][number]['key'];
export const TASKS: readonly AccessTask[] = ACCESS_GROUPS.flatMap((g) => g.tasks as readonly AccessTask[]);
export const TASK_KEYS = TASKS.map((t) => t.key) as Task[];
const byKey = new Map(TASKS.map((t) => [t.key, t]));
export const isTask = (k: string): k is Task => byKey.has(k);

/** What the accountant has: every task that only reads. */
export const ACCOUNTANT_TASKS: readonly Task[] = ['sales.view', 'stock.view', 'stock.costs', 'documents.view', 'jobs.view', 'jobs.money', 'labour.view', 'costs.view', 'payroll.view', 'reports.view'];

/** The tasks and everything they need (transitively), in the catalogue's order. Unknown keys are dropped. */
export function withNeeds(tasks: Iterable<string>): Task[] {
  const have = new Set<string>();
  const add = (k: string) => {
    const t = byKey.get(k);
    if (!t || have.has(k)) return;
    have.add(k);
    for (const n of t.needs ?? []) add(n);
  };
  for (const k of tasks) add(k);
  return TASK_KEYS.filter((k) => have.has(k));
}

/** What a profile gives, changed for one person: ticked on top, unticked taken away. */
export function personAccess(profile: Iterable<string>, add: Iterable<string>, remove: Iterable<string>): Task[] {
  const off = new Set(remove);
  return withNeeds([...new Set([...profile, ...add])].filter((k) => !off.has(k)));
}

/** The changes that make `want` from a profile's tasks (what's ticked beyond it, what's unticked of it). */
export function tweaksFor(profile: Iterable<string>, want: Iterable<string>): { add: Task[]; remove: Task[] } {
  const base = new Set(withNeeds(profile));
  const w = new Set(withNeeds(want));
  return { add: TASK_KEYS.filter((k) => w.has(k) && !base.has(k)), remove: TASK_KEYS.filter((k) => base.has(k) && !w.has(k)) };
}

/** Tasks that need this one (to untick them with it). */
export function neededBy(task: string): Task[] {
  return TASK_KEYS.filter((k) => withNeeds([k]).includes(task as Task) && k !== task);
}

/** The headings and tasks to show while these features are on. */
export function shownGroups(on: (f: Feature) => boolean): { key: string; label: string; tasks: AccessTask[] }[] {
  return ACCESS_GROUPS.filter((g) => !('feature' in g) || on(g.feature as Feature))
    .map((g) => ({ key: g.key, label: g.key === 'documents' && !on('quotes') ? 'Invoices' : g.label, tasks: (g.tasks as readonly AccessTask[]).filter((t) => !t.feature || on(t.feature)) }))
    .filter((g) => g.tasks.length > 0);
}

/** The profiles a business starts with (each can be changed, renamed or removed). */
export const STARTING_PROFILES: readonly { name: string; access: readonly Task[] }[] = [
  { name: 'Teller', access: ['sales.sell', 'stock.view'] },
  { name: 'Admin', access: ['documents.edit', 'documents.paid', 'clients.edit', 'costs.manage', 'bills.pay', 'stock.buy', 'reports.view', 'bank.reconcile', 'sales.view', 'labour.view'] },
  { name: 'Site staff', access: ['labour.log', 'costs.capture', 'jobs.view'] },
];
