/**
 * First-run setup: create the owner login on a fresh install.
 *   npm run create-owner -- --email you@company.co.za --name "Your Name"
 * The password is read from OWNER_PASSWORD or typed at the prompt.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createUser } from '../auth.js';
import { loadConfig } from '../config.js';
import { createDb } from './index.js';
import { migrate } from './migrate.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const email = arg('email')?.trim().toLowerCase();
const name = arg('name')?.trim() ?? 'Owner';
const company = arg('company')?.trim();
if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
  console.error('Usage: npm run create-owner -- --email you@company.co.za [--name "Your Name"] [--company "Company (Pty) Ltd"]');
  process.exit(1);
}

let password = process.env.OWNER_PASSWORD ?? '';
if (!password) {
  const rl = createInterface({ input: stdin, output: stdout });
  password = await rl.question('Password (at least 10 characters): ');
  rl.close();
}
if (password.length < 10) {
  console.error('Password must be at least 10 characters.');
  process.exit(1);
}

const sql = createDb(loadConfig().DATABASE_URL, { max: 1 });
try {
  await migrate(sql);
  await createUser(sql, { name, email, password, role: 'owner' });
  if (company) await sql`update settings set company_name = ${company} where id`;
  console.log(`Created the owner login for ${email}. Sign in, fill in Settings → Company, then import your tracker under Settings → Import.`);
} catch (err) {
  console.error((err as Error).message.includes('duplicate') ? 'Someone already signs in with that email.' : (err as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
