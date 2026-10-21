/**
 * The demo company: a second, made-up company in its own database, shown instead of the real
 * one when you want to show Shap to someone without your figures on screen.
 *
 * Every request runs inside a scope that says which company it's for (from the demo cookie).
 * The `sql` handed to the route modules is a stand-in that sends each query to that company's
 * database, so no route needs to know. Outside a request (start-up, migrations) it is always
 * the real one; a request in demo mode with no demo database fails rather than falling back.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Sql } from './index.js';

export const dbScope = new AsyncLocalStorage<{ demo: boolean }>();

/** Is this request showing the demo company? */
export const inDemo = (): boolean => dbScope.getStore()?.demo === true;

export class DemoUnavailable extends Error {}

export function routedDb(real: Sql, demo: Sql | null): Sql {
  const pick = (): Sql => {
    if (!inDemo()) return real;
    if (!demo) throw new DemoUnavailable('The demo company isn’t set up on this server');
    return demo;
  };
  return new Proxy(real as unknown as (...a: unknown[]) => unknown, {
    apply: (_t, thisArg, args) => Reflect.apply(pick() as unknown as (...a: unknown[]) => unknown, thisArg, args),
    get: (_t, prop) => {
      const target = pick() as unknown as Record<string | symbol, unknown>;
      const v = target[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as unknown as Sql;
}

/** The demo database's address: DEMO_DATABASE_URL, or the real one with "_demo" on the name. */
export function demoUrl(realUrl: string, explicit?: string): string {
  if (explicit) return explicit;
  const u = new URL(realUrl);
  const name = u.pathname.replace(/^\//, '') || 'shap';
  u.pathname = `/${name}_demo`;
  return u.toString();
}

/** Creates the demo database next to the real one if it isn't there yet. */
export async function ensureDatabase(real: Sql, url: string): Promise<void> {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Unusable demo database name: ${name}`);
  const [has] = await real`select 1 from pg_database where datname = ${name}`;
  if (!has) await real.unsafe(`create database "${name}"`);
}
