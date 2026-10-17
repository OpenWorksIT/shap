import postgres from 'postgres';

export type Sql = postgres.Sql<{}>;
export type Tx = postgres.TransactionSql<{}>;
/** Either the pool or an open transaction. */
export type Db = Sql | Tx;

export function createDb(url: string, opts: { max?: number } = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 10,
    // The ledger is one large view over small tables. Postgres's JIT judges it by the plan's
    // estimated cost and spends seconds compiling a query that runs in milliseconds.
    connection: { jit: 'off' },
    // snake_case columns <-> camelCase in JS
    transform: postgres.camel,
    // Return `date` columns as plain YYYY-MM-DD strings rather than local-midnight Date objects.
    types: {
      date: {
        to: 1082,
        from: [1082],
        serialize: (x: string) => x,
        parse: (x: string) => x,
      },
      // Money is bigint cents and sums come back as numeric: both well inside 2^53, so plain numbers.
      bigint: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
      numeric: { to: 1700, from: [1700], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
    },
    onnotice: () => {},
  }) as unknown as Sql;
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
