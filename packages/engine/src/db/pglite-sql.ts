/**
 * The database on the phone: PGlite (PostgreSQL compiled to WebAssembly) behind the same
 * interface the rest of Shap uses from postgres.js, so every query, view and trigger runs
 * unchanged. What postgres.js does that Shap relies on, and so this does too:
 *
 * - tagged templates with $n parameters, nested fragments (`${sql`...`}`) and lists of them;
 * - helpers: `sql('name')` an identifier, `sql(obj)` / `sql([obj])` after insert / update set /
 *   select / in, `sql([1, 2])` after `in`, `sql.json(x)`, `sql.unsafe(text, params)`;
 * - snake_case columns read as camelCase, keys inside json too; camelCase written as snake;
 * - dates as 'YYYY-MM-DD' strings, bigint and numeric as numbers, timestamps as Date;
 * - results are arrays with `.count`; `sql.begin(tx => …)` and `tx.savepoint(…)`.
 *
 * PGlite is one connection. A transaction holds it; other queries wait their turn, the way a
 * single-user app on a phone would want anyway.
 * The query building follows postgres.js (src/types.js, released under the Unlicense).
 */
import type { PGliteInterface as PGlite, Results } from '@electric-sql/pglite';

// ---------------------------------------------------------------- naming
export const toCamel = (x: string) => {
  let s = x[0] ?? '';
  for (let i = 1; i < x.length; i++) s += x[i] === '_' ? (x[++i] ?? '').toUpperCase() : x[i];
  return s;
};
export const fromCamel = (x: string) => x.replace(/([A-Z])/g, '_$1').toLowerCase();
const escapeIdentifier = (s: string) => '"' + s.replace(/"/g, '""').replace(/\./g, '"."') + '"';
const ident = (x: string) => escapeIdentifier(fromCamel(x));

function camelJson(x: unknown): unknown {
  if (typeof x !== 'object' || x === null || x instanceof Date || x instanceof Uint8Array) return x;
  if (Array.isArray(x)) return x.map(camelJson);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x)) out[toCamel(k)] = camelJson(v);
  return out;
}

// ---------------------------------------------------------------- values
const T = { unknown: 0, bool: 16, bytea: 17, int8: 20, json: 114, text: 25, textArray: 1009, timestamptz: 1184 } as const;

class Identifier {
  constructor(readonly value: string) {}
}
class Parameter {
  constructor(
    readonly value: unknown,
    readonly type: number,
  ) {}
}
class Builder {
  constructor(
    readonly first: unknown,
    readonly rest: string[],
  ) {}
}

function inferType(x: unknown): number {
  if (x instanceof Parameter) return x.type;
  if (x instanceof Date) return T.timestamptz;
  if (x instanceof Uint8Array) return T.bytea;
  if (x === true || x === false) return T.bool;
  if (typeof x === 'bigint') return T.int8;
  if (Array.isArray(x)) return typeof firstLeaf(x) === 'string' ? T.textArray : inferType(firstLeaf(x)) === T.bool ? 1000 : T.unknown;
  return T.unknown;
}
const firstLeaf = (x: unknown[]): unknown => (Array.isArray(x[0]) ? firstLeaf(x[0] as unknown[]) : x[0]);

function arrayLiteral(xs: unknown[]): string {
  if (!xs.length) return '{}';
  return (
    '{' +
    xs
      .map((x) => {
        if (Array.isArray(x)) return arrayLiteral(x);
        if (x === null || x === undefined) return 'null';
        const s = x instanceof Date ? x.toISOString() : typeof x === 'boolean' ? (x ? 't' : 'f') : String(x);
        return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
      })
      .join(',') +
    '}'
  );
}

/** A value as PGlite should receive it: text, or bytes for bytea. */
function serialize(x: unknown, type: number): unknown {
  if (x === null) return null;
  if (x instanceof Uint8Array) return x;
  if (type === T.json) return typeof x === 'string' ? x : JSON.stringify(x);
  if (x instanceof Date) return x.toISOString();
  if (typeof x === 'boolean') return x ? 't' : 'f';
  if (Array.isArray(x)) return arrayLiteral(x);
  if (typeof x === 'object') return JSON.stringify(x);
  return String(x);
}

// ---------------------------------------------------------------- queries
interface Built {
  text: string;
  params: unknown[];
  types: number[];
}

type Run = (q: Query) => Promise<Result>;

export type Result = Record<string, unknown>[] & { count: number; command: string; columns: { name: string; type: number }[] };

/** A query that runs when awaited, or is spliced in when used inside another one. */
export class Query implements PromiseLike<Result> {
  private promise?: Promise<Result>;
  constructor(
    readonly strings: readonly string[],
    readonly args: unknown[],
    private readonly run: Run,
    readonly unsafe?: { text: string; params: unknown[] },
  ) {}
  build(): Built {
    const b: Built = { text: '', params: [], types: [] };
    if (this.unsafe) return { text: this.unsafe.text, params: this.unsafe.params.map((p) => serialize(p, inferType(p))), types: this.unsafe.params.map(inferType) };
    b.text = stringify(this, b);
    return b;
  }
  private exec() {
    return (this.promise ??= this.run(this));
  }
  then<A = Result, B = never>(ok?: ((v: Result) => A | PromiseLike<A>) | null, fail?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    return this.exec().then(ok, fail);
  }
  catch<B = never>(fail?: (e: unknown) => B | PromiseLike<B>) {
    return this.exec().catch(fail);
  }
  finally(f?: () => void) {
    return this.exec().finally(f);
  }
}

function stringify(q: Query, b: Built): string {
  if (q.unsafe) return q.unsafe.text;
  let s = q.strings[0]!;
  for (let i = 1; i < q.strings.length; i++) s += value(s, q.args[i - 1], b) + q.strings[i];
  return s;
}

function value(before: string, x: unknown, b: Built): string {
  if (x instanceof Builder) return build(x, before, b);
  if (x instanceof Query) return stringify(x, b);
  if (x instanceof Identifier) return x.value;
  if (Array.isArray(x) && x[0] instanceof Query) return x.reduce((acc: string, q: Query) => acc + ' ' + stringify(q, b), '');
  return param(x, b);
}

function param(x: unknown, b: Built): string {
  const v = x instanceof Parameter ? x.value : x;
  if (v === undefined) throw Object.assign(new Error('Undefined values are not allowed'), { code: 'UNDEFINED_VALUE' });
  const type = inferType(x);
  b.params.push(serialize(v, type));
  b.types.push(type);
  return '$' + b.params.length;
}

const columnsOf = (first: unknown, rest: string[]) => (rest.length ? rest.flat() : Object.keys((Array.isArray(first) ? first[0] : first) as object));
const rowsOf = (first: unknown) => (Array.isArray(first) ? first : [first]) as Record<string, unknown>[];
const valuesList = (rows: Record<string, unknown>[], cols: string[], b: Built) => rows.map((r) => '(' + cols.map((c) => value('values', r[c], b)).join(',') + ')').join(',');

function values(first: unknown, rest: string[], b: Built) {
  if (Array.isArray(first) && !Array.isArray(first[0]) && (first.length === 0 || typeof first[0] !== 'object' || first[0] === null || first[0] instanceof Date))
    return '(' + first.map((x) => value('values', x, b)).join(',') + ')';
  const multi = Array.isArray((first as unknown[])[0]);
  return valuesList(multi ? (first as Record<string, unknown>[]) : [first as Record<string, unknown>], columnsOf(first, rest), b);
}
function select(first: unknown, rest: string[], b: Built) {
  if (typeof first === 'string') first = [first, ...rest];
  if (Array.isArray(first)) return first.map((x) => ident(String(x))).join(',');
  const o = first as Record<string, unknown>;
  return columnsOf(first, rest)
    .map((k) => {
      const v = o[k];
      return (v instanceof Query ? stringify(v, b) : v instanceof Identifier ? v.value : param(v, b)) + ' as ' + ident(k);
    })
    .join(',');
}
const BUILDERS: [RegExp, (first: unknown, rest: string[], b: Built) => string][] = (
  [
    ['values', values],
    ['in', (f: unknown, r: string[], b: Built) => {
      const x = values(f, r, b);
      return x === '()' ? '(null)' : x;
    }],
    ['select', select],
    ['as', select],
    ['returning', select],
    ['\\(', select],
    ['update', (f: unknown, r: string[], b: Built) => columnsOf(f, r).map((k) => ident(k) + '=' + value('values', (f as Record<string, unknown>)[k], b)).join(',')],
    ['insert', (f: unknown, r: string[], b: Built) => {
      const cols = columnsOf(f, r);
      return '(' + cols.map(ident).join(',') + ')values' + valuesList(rowsOf(f), cols, b);
    }],
  ] as const
).map(([x, fn]) => [new RegExp('((?:^|[\\s(])' + x + '(?:$|[\\s(]))(?![\\s\\S]*\\1)', 'i'), fn]);

function build(x: Builder, before: string, b: Built): string {
  const hit = BUILDERS.map(([re, fn]) => ({ fn, i: before.search(re) }))
    .sort((p, q) => p.i - q.i)
    .pop()!;
  if (hit.i === -1) return (Array.isArray(x.first) ? x.first : [x.first]).map((c) => ident(String(c))).join(',');
  return hit.fn(x.first, x.rest, b);
}

// ---------------------------------------------------------------- results
const PARSERS = {
  1082: (x: string) => x, // date: as written
  20: (x: string) => Number(x), // bigint cents
  1700: (x: string) => Number(x), // numeric sums
  // bytea: a Buffer, as postgres.js gives (the app polyfills Buffer on the phone)
  17: (x: string) => {
    const hex = x.slice(2);
    const B = (globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer;
    return B ? B.from(hex, 'hex') : Uint8Array.from({ length: hex.length / 2 }, (_, i) => parseInt(hex.substring(i * 2, i * 2 + 2), 16));
  },
};

function toResult(r: Results<Record<string, unknown>>, text: string): Result {
  const jsonCols = new Set(r.fields.filter((f) => f.dataTypeID === 114 || f.dataTypeID === 3802).map((f) => f.name));
  const rows = r.rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) out[toCamel(k)] = jsonCols.has(k) ? camelJson(v) : v;
    return out;
  }) as Result;
  const command = (/^\s*(\w+)/.exec(text)?.[1] ?? '').toUpperCase();
  rows.count = r.fields.length && command !== 'INSERT' && command !== 'UPDATE' && command !== 'DELETE' ? rows.length : (r.affectedRows ?? rows.length);
  rows.command = command;
  rows.columns = r.fields.map((f) => ({ name: toCamel(f.name), type: f.dataTypeID }));
  return rows;
}

// ---------------------------------------------------------------- the sql function
export interface PgliteSql {
  <T = Result>(strings: TemplateStringsArray, ...args: unknown[]): Query & PromiseLike<T>;
  (first: unknown, ...rest: string[]): Builder | Identifier;
  json(x: unknown): Parameter;
  unsafe<T = Result>(text: string, params?: unknown[]): Query & PromiseLike<T>;
  begin<T>(fn: (tx: PgliteSql) => Promise<T>): Promise<T>;
  savepoint<T>(fn: (tx: PgliteSql) => Promise<T>): Promise<T>;
  end(): Promise<void>;
  readonly pglite: PGlite;
}

export function createPgliteSql(pg: PGlite): PgliteSql {
  // One connection: a queue. A transaction keeps its place until it ends.
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
  const exec = async (q: Query): Promise<Result> => {
    const { text, params, types } = q.build();
    if (!params.length && /;\s*\S/.test(text.trim().replace(/;\s*$/, ''))) {
      // Several statements (a migration): no parameters allowed, as in Postgres.
      const all = await pg.exec(text, { parsers: PARSERS });
      return toResult(all[all.length - 1] ?? { rows: [], fields: [], affectedRows: 0 }, text);
    }
    return toResult(await pg.query<Record<string, unknown>>(text, params, { parsers: PARSERS, paramTypes: types }), text);
  };

  let savepoints = 0;
  const make = (run: Run, inTx: boolean): PgliteSql => {
    const sql = ((first: unknown, ...rest: unknown[]) => {
      if (Array.isArray(first) && 'raw' in (first as object)) return new Query(first as unknown as string[], rest, run);
      if (typeof first === 'string' && !rest.length) return new Identifier(ident(first));
      return new Builder(first, rest as string[]);
    }) as PgliteSql;
    sql.json = (x) => new Parameter(x, T.json);
    sql.unsafe = (text, params = []) => new Query([text], [], run, { text, params }) as never;
    sql.begin = async (fn) => {
      if (inTx) return sql.savepoint(fn);
      return exclusive(async () => {
        const direct: Run = (q) => exec(q);
        const tx = make(direct, true);
        await pg.query('begin');
        try {
          const out = await fn(tx);
          await pg.query('commit');
          return out;
        } catch (err) {
          await pg.query('rollback').catch(() => undefined);
          throw err;
        }
      });
    };
    sql.savepoint = async (fn) => {
      if (!inTx) return sql.begin(fn);
      const name = `s${++savepoints}`;
      await pg.query(`savepoint ${name}`);
      try {
        const out = await fn(sql);
        await pg.query(`release savepoint ${name}`);
        return out;
      } catch (err) {
        await pg.query(`rollback to savepoint ${name}`);
        throw err;
      }
    };
    sql.end = async () => {
      if (!inTx) await exclusive(() => pg.close());
    };
    Object.defineProperty(sql, 'pglite', { value: pg });
    return sql;
  };
  return make((q) => exclusive(() => exec(q)), false);
}
