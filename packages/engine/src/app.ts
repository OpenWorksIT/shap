/**
 * Shap Pocket's "server": the same route modules as Shap, running inside the app against the
 * database on the phone. Nothing leaves the phone.
 */
import { deviceOwner } from './auth.js';
import type { Ctx } from './context.js';
import type { Sql } from './db/index.js';
import { App, type Logger } from './http.js';
import { registerBankRoutes } from './modules/bank/routes.js';
import { registerClientRoutes } from './modules/clients.js';
import { registerCompanyFileRoutes } from './modules/company-file.js';
import { registerCostRoutes } from './modules/costs.js';
import { registerDashboardRoutes } from './modules/dashboard.js';
import { registerDocumentRoutes } from './modules/documents.js';
import { registerDuplicateRoutes } from './modules/duplicates.js';
import { registerPayrollRoutes } from './modules/payroll.js';
import { registerProjectRoutes } from './modules/projects.js';
import { registerRecurringRoutes } from './modules/recurring.js';
import { registerReportRoutes } from './modules/reports.js';
import { registerSettingsRoutes } from './modules/settings.js';
import { registerStatementRoutes } from './modules/statements.js';
import { registerVatRoutes } from './modules/vat.js';
import { registerWorkerRoutes } from './modules/workers.js';
import { registerYearEndRoutes } from './modules/yearend.js';
import { registerArchiveRoutes } from './modules/archive.js';
import { registerTaxFormRoutes } from './modules/taxforms.js';
import { registerBillRoutes } from './modules/bills.js';
import { registerLogbookRoutes } from './modules/logbook.js';
import { registerTimeRoutes } from './modules/timetrack.js';
import { registerAccountantExportRoutes } from './modules/accountantExport.js';
import { registerMoveInRoutes } from './modules/movein.js';

export interface BuildOptions {
  sql: Sql;
  log?: Logger;
  /** Largest photo or file accepted, in MB. */
  uploadMb?: number;
}

export async function buildApp(opts: BuildOptions): Promise<{ app: App; ctx: Ctx }> {
  const app = new App(opts.log);
  const ctx: Ctx = { sql: opts.sql, config: { UPLOAD_MB: opts.uploadMb ?? 15 } };
  app.user = await deviceOwner(opts.sql);

  app.get('/api/health', async () => {
    await opts.sql`select 1`;
    return { ok: true, time: new Date().toISOString() };
  });
  registerSettingsRoutes(app, ctx);
  registerDashboardRoutes(app, ctx);
  registerClientRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerWorkerRoutes(app, ctx);
  registerDuplicateRoutes(app, ctx);
  registerRecurringRoutes(app, ctx);
  registerCostRoutes(app, ctx);
  registerDocumentRoutes(app, ctx);
  registerVatRoutes(app, ctx);
  registerReportRoutes(app, ctx);
  registerYearEndRoutes(app, ctx);
  registerArchiveRoutes(app, ctx);
  registerTaxFormRoutes(app, ctx);
  registerBillRoutes(app, ctx);
  registerLogbookRoutes(app, ctx);
  registerTimeRoutes(app, ctx);
  registerAccountantExportRoutes(app, ctx);
  registerMoveInRoutes(app, ctx);
  registerBankRoutes(app, ctx);
  registerStatementRoutes(app, ctx);
  registerCompanyFileRoutes(app, ctx);
  registerPayrollRoutes(app, ctx);
  return { app, ctx };
}
