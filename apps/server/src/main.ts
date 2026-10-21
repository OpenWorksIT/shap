import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { demoUrl, ensureDatabase } from './db/routing.js';

const config = loadConfig();
const sql = createDb(config.DATABASE_URL);

const logger =
  config.NODE_ENV === 'development'
    ? { level: 'info', transport: { target: 'pino-pretty', options: { ignore: 'pid,hostname' } } }
    : { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] };

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

const { app } = await buildApp({ config, sql, demoSql, logger });

// Apply pending migrations on start so an update is just "pull and restart".
await migrate(sql, (m) => app.log.info(m));
if (demoSql) await migrate(demoSql, (m) => app.log.info(`demo company: ${m}`)).catch((err) => app.log.warn({ err }, 'demo company: migrations failed'));

const shutdown = async () => {
  await app.close();
  await sql.end({ timeout: 5 });
  await demoSql?.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: config.HOST, port: config.PORT });
app.log.info(`Two-factor sign-in: ${config.mfaRequired ? 'required' : 'optional'} · Email: ${config.SMTP_URL ? 'on' : 'off (logged only)'}`);
