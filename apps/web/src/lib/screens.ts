/**
 * Which screens someone sees, from what they may do (their tasks) and what's switched on: the
 * menu (Shell.tsx) and the routes (App.tsx) both ask here, so what's in the menu is what opens.
 * The server refuses the same (requireAccess); hiding a screen is only so nobody is shown a door
 * that won't open.
 */
import { paysOutProfit, type Feature, type Role, type Task } from '@shap/shared';

export function screensFor(u: { role: Role }, can: (t: Task) => boolean, has: (f: Feature) => boolean, businessType: string) {
  const any = (...ts: Task[]) => ts.some(can);
  const owner = u.role === 'owner';
  return {
    '/log': any('labour.log', 'workers.manage', 'costs.capture', 'costs.manage') && (has('workers') || any('costs.capture', 'costs.manage')),
    '/jobs': has('jobs') && can('jobs.view'),
    '/workers': has('workers') && any('labour.view', 'workers.manage'),
    '/payroll': (has('payroll') && can('payroll.view')) || (paysOutProfit(businessType) && has('dividends') && can('reports.view')),
    '/sales': has('sales') && any('sales.sell', 'sales.view', 'items.edit'),
    '/inventory': has('inventory') && can('stock.view'),
    '/costs': any('costs.view', 'costs.manage'),
    '/bills': has('bills') && any('bills.pay', 'costs.view'),
    '/logbook': has('logbook') && any('logbook.trips', 'reports.view'),
    '/documents': can('documents.view'),
    '/clients': any('documents.view', 'clients.edit', 'reports.view'),
    '/accounts': can('reports.view'),
    '/guides': has('guides') && can('reports.view'),
    '/settings': owner,
    '/move-in': owner,
  } satisfies Record<string, boolean>;
}
export type Screens = ReturnType<typeof screensFor>;
