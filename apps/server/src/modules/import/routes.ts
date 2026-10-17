import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, userOrThrow } from '../../auth.js';
import type { Ctx } from '../../context.js';
import { badRequest } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { applyTracker, isCompanyEmpty } from './apply.js';
import { readTracker } from './tracker.js';

const body = z.object({
  dataBase64: z.string().min(100),
  apply: z.boolean().default(false),
  replace: z.boolean().default(false),
  agreeTrialBalance: z.boolean().default(true),
});

export function registerImportRoutes(app: FastifyInstance, ctx: Ctx): void {
  /** Upload the tracker: first a preview (apply=false), then the import itself. */
  app.post('/api/import/tracker', { preHandler: requireRole('owner'), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const user = userOrThrow(req);
    const input = parse(body, req.body);
    let plan;
    try {
      plan = await readTracker(Buffer.from(input.dataBase64, 'base64'));
    } catch (err) {
      throw badRequest(`Couldn’t read that workbook: ${(err as Error).message}`);
    }
    const preview = {
      clients: plan.clients.length,
      projects: plan.projects.length,
      projectsNotOnSheet: plan.projects.filter((p) => !p.fromSheet).map((p) => p.name),
      invoices: plan.projects.filter((p) => p.invoiceNumber).length,
      costs: plan.costs.length,
      workers: plan.workers.map((w) => w.name),
      labour: plan.labour.length,
      unallocatedLabour: plan.labour.filter((l) => !l.projectKey).length,
      wagePayments: plan.wagePayments.length,
      savings: plan.savings.length,
      accounts: plan.accounts,
      types: plan.types,
      trialBalance: plan.trialBalance,
      warnings: plan.warnings,
      skipped: plan.skipped,
      firstDate: [...plan.costs.map((c) => c.date), ...plan.labour.map((l) => l.date)].sort()[0] ?? null,
      lastDate: [...plan.costs.map((c) => c.date), ...plan.labour.map((l) => l.date)].sort().at(-1) ?? null,
      companyEmpty: await isCompanyEmpty(ctx.sql),
    };
    if (!input.apply) return { preview };
    const result = await applyTracker(ctx.sql, plan, {
      replace: input.replace,
      agreeTrialBalance: input.agreeTrialBalance,
      userId: user.id,
    });
    return { preview, result };
  });
}
