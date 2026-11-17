/**
 * For the Shap Pocket share tests: a second database plays the phone (its books made through the
 * app, as Pocket's are: the same accounting code and tables), and its shares are made with the same
 * shared code Pocket's engine uses (modules/share.ts there: records, entries, hashes). All made up.
 */
import { entryHash, figuresHash, POCKET_SHARE_FORMAT, SHARE_TABLES, SHARE_USER_COLUMNS, shareEntries, type PocketShare } from '@shap/shared';
import { freshTotals } from '../../src/lib/books.js';
import { trialBalance } from '../../src/modules/reports.js';
import type { Sql } from '../../src/db/index.js';
import { login, ref, setup, type TestEnv } from '../helpers.js';

/** A share of `src`'s books, the way Pocket's engine makes one. */
export async function makeShare(src: Sql, o: { number: number; madeAt: string; through: string; books: string; previous?: number | null }): Promise<PocketShare> {
  await freshTotals(src);
  const records: Record<string, Record<string, unknown>[]> = {};
  for (const t of SHARE_TABLES) {
    const rows = await src.unsafe<{ j: string }[]>(`select row_to_json(t)::text as j from ${t.table} t`);
    records[t.table] = rows.map((r) => {
      const row = JSON.parse(r.j) as Record<string, unknown>;
      for (const c of t.leaveOut ?? []) delete row[c];
      for (const c of SHARE_USER_COLUMNS) if (c in row) row[c] = null;
      return row;
    });
  }
  const entries = await shareEntries(src as never);
  return {
    format: POCKET_SHARE_FORMAT,
    stamp: { number: o.number, madeAt: o.madeAt, through: o.through, previous: o.previous ? { number: o.previous, madeAt: '2026-10-01T08:00:00.000Z' } : null, app: 'Shap Pocket', books: o.books, version: '1.11.0' },
    records,
    entries: entries.map((e) => ({ key: e.key, hash: entryHash(e), figures: figuresHash(e) })),
    changes: { added: 0, changed: 0, removed: 0 },
  };
}

export const b64 = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64');
export const tbOf = async (db: Sql, d: string) => (await trialBalance(db, d)).rows.map((r) => [r.code, Number(r.balanceCents)] as [string, number]).filter(([, c]) => c !== 0);

/** The practice (with Shap Accountant on) and a phone, each its own database. */
export async function practiceAndPhone(phoneDb: string) {
  const env: TestEnv = await setup();
  await env.sql.unsafe(`drop database if exists "${phoneDb}" with (force)`);
  await env.sql.unsafe(`create database "${phoneDb}"`);
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${phoneDb}`;
  const phone = await setup({ env: { DATABASE_URL: url.toString() } });
  const drop = async () => {
    const pattern = `${env.ctx.clients.practiceDb.replace(/_/g, '\\_')}\\_\\_c\\_%`;
    for (const { datname } of await env.sql<{ datname: string }[]>`select datname from pg_database where datname like ${pattern}`) await env.sql.unsafe(`drop database if exists "${datname}" with (force)`);
  };
  await drop();
  const me = await login(phone.app, 'owner@example.co.za');
  const r = await ref(phone.sql);
  const owner = await login(env.app, 'owner@example.co.za');
  const s = (await owner.get('/api/reference')).settings;
  await owner.post('/api/settings', { ...s, features: { ...s.features, practice: true } }, 'PUT');
  let n = 0;
  const client = async (name: string) => (await owner.post('/api/practice/clients', { name, kind: 'pocket' })).id as string;
  const copyOf = async (id: string) => env.ctx.clients.get((await env.sql<{ dbName: string }[]>`select db_name from practice_clients where id = ${id}`)[0]!.dbName);
  const bringIn = (id: string, file: unknown) =>
    owner.call({ method: 'POST', url: `/api/practice/clients/${id}/pocket-share`, payload: { name: 'Made-up share.json', dataBase64: b64(file), acceptTerms: true }, remoteAddress: `10.69.${(++n >> 8) & 255}.${n & 255}` });
  const open = async (id: string, as: 'books' | 'compile') => {
    const res = await owner.call({ method: 'POST', url: `/api/practice/clients/${id}/open`, payload: { as } });
    if (res.statusCode !== 200) throw new Error(res.body);
    const cookies = Object.fromEntries(res.cookies.filter((c) => c.value).map((c) => [c.name, c.value]));
    return { get: (url: string) => owner.call({ method: 'GET', url, cookies }) };
  };
  const close = async () => {
    await env.ctx.clients.end();
    await drop();
    await phone.close();
    await env.sql.unsafe(`drop database if exists "${phoneDb}" with (force)`);
    await env.close();
  };
  return { env, phone, me, r, owner, client, copyOf, bringIn, open, close };
}
