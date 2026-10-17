import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { migrate } from './db/migrate.js';

const config = loadConfig();
const sql = createDb(config.DATABASE_URL);

const logger =
  config.NODE_ENV === 'development'
    ? { level: 'info', transport: { target: 'pino-pretty', options: { ignore: 'pid,hostname' } } }
    : { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] };

const { app } = await buildApp({ config, sql, logger });

// Apply pending migrations on start so an update is just "pull and restart".
await migrate(sql, (m) => app.log.info(m));

const shutdown = async () => {
  await app.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: config.HOST, port: config.PORT });
app.log.info(`Two-factor sign-in: ${config.mfaRequired ? 'required' : 'optional'} · Email: ${config.SMTP_URL ? 'on' : 'off (logged only)'}`);
