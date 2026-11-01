import type postgres from 'postgres';
import type { PGliteInterface } from '@electric-sql/pglite';
import { createPgliteSql } from './pglite-sql.js';

// The query interface is postgres.js's (Shap's server uses it); on the phone it's PGlite behind
// the same shape (see pglite-sql.ts). Only the types come from postgres.js.
export type Sql = postgres.Sql<{}>;
export type Tx = postgres.TransactionSql<{}>;
/** Either the database or an open transaction. */
export type Db = Sql | Tx;

/** The books in a PGlite database (on the phone, or in memory for the tests). */
export function createDb(pg: PGliteInterface): Sql {
  return createPgliteSql(pg) as unknown as Sql;
}

/** Postgres error codes we handle explicitly. */
export const PG = {
  uniqueViolation: '23505',
  exclusionViolation: '23P01',
  foreignKeyViolation: '23503',
} as const;

export function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}
