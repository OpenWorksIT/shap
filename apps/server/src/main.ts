import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { serverLogger } from './lib/logging.js';
import { migrate } from './db/migrate.js';
import { demoUrl, ensureDatabase } from './db/routing.js';
import { startMonthlyTimer } from './modules/monthly.js';

const config = loadConfig();
const sql = createDb(config.DATABASE_URL);

// No personal information in the log (lib/logging.ts).
const logger = serverLogger({ dev: config.NODE_ENV === 'development' });

// The demo company (Settings → Show the demo company): its own database next to the real one.
let demoSql: ReturnType<typeof createDb> | null = null;
if (config.DEMO_ENABLED) {
  const url = demoUrl(config.DATABASE_URL, config.DEMO_DATABASE_URL || undefined);
  if (new URL(url).pathname === new URL(config.DATABASE_URL).pathname) {
    console.warn('DEMO_DATABASE_URL is the real database: the demo company is off');
  } else {
    try {
      await ensureDatabase(sql, url);
      demoSql = createDb(url, { max: 3 });
    } catch (err) {
      console.warn(`The demo company is off (couldn't create its database: ${(err as Error).message})`);
    }
  }
}

const { app, ctx } = await buildApp({ config, sql, demoSql, logger });

// Apply pending migrations on start so an update is just "pull and restart".
await migrate(sql, (m) => app.log.info(m));
if (demoSql) await migrate(demoSql, (m) => app.log.info(`demo company: ${m}`)).catch((err) => app.log.warn({ err }, 'demo company: migrations failed'));

let stopMonthly: (() => void) | undefined;
const shutdown = async () => {
  stopMonthly?.();
  await app.close();
  await sql.end({ timeout: 5 });
  await demoSql?.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Something thrown where no request can catch it (a library's own callback): say what it was in
// the log before stopping, so it can be found; the container's restart policy brings Shap back.
process.on('uncaughtException', (err) => {
  app.log.fatal({ err }, 'Shap stopped on an unexpected error');
  process.exit(1);
});
process.on('unhandledRejection', (err) => app.log.error({ err }, 'A background task failed'));

await app.listen({ host: config.HOST, port: config.PORT });
// Monthly invoices go out on their day without anyone opening Shap.
stopMonthly = startMonthlyTimer(ctx, app.log);
app.log.info(`Two-factor sign-in: ${config.mfaRequired ? 'required' : 'optional'} · Email: ${config.SMTP_URL ? 'on' : 'off (logged only)'}`);
// Say straight away if the mailbox settings don't work, rather than at the first invoice.
void ctx.mailer.check?.().then((problem) =>
  problem ? app.log.error(`Email: ${problem}. Quotes and invoices can't be emailed until SMTP_URL is fixed.`) : config.SMTP_URL && app.log.info('Email: signed in to the mail server'),
);
