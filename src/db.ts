// The database, as the directory uses it: reads, and writes applied together.
// D1 in the Worker (worker.ts), better-sqlite3 in tests and the dev server, so
// the same code runs on both.

export type Row = Record<string, unknown>;

export interface Stmt {
  sql: string;
  params: unknown[];
}

export interface Db {
  all<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  /** All of them, or none (a D1 batch is a transaction). */
  batch(stmts: Stmt[]): Promise<void>;
}

export async function first<T = Row>(db: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  return (await db.all<T>(sql, params))[0] ?? null;
}

/**
 * A value as an SQL literal, for multi-row INSERTs (D1 binds at most 100
 * parameters a statement): strings quoted with quotes doubled, numbers as
 * numbers, everything else (null, undefined, NaN) NULL; objects as JSON text.
 */
export function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return `'${s.replace(/\0/g, "").replace(/'/g, "''")}'`;
}

/** Statement size to stay under (D1 allows 100 KB). */
export const MAX_SQL = 90_000;

/**
 * `INSERT INTO table (cols) VALUES (…), (…)` for `rows`, as few statements as
 * fit (each under MAX_SQL); `tail` after each (an ON CONFLICT clause).
 */
export function insertRows(table: string, cols: string[], rows: unknown[][], tail = ""): Stmt[] {
  const head = `INSERT INTO ${table} (${cols.join(", ")}) VALUES `;
  const out: Stmt[] = [];
  let vals: string[] = [];
  let size = head.length + tail.length;
  for (const r of rows) {
    const v = `(${r.map(lit).join(", ")})`;
    if (vals.length && size + v.length + 2 > MAX_SQL) {
      out.push({ sql: `${head}${vals.join(", ")} ${tail}`, params: [] });
      vals = [];
      size = head.length + tail.length;
    }
    vals.push(v);
    size += v.length + 2;
  }
  if (vals.length) out.push({ sql: `${head}${vals.join(", ")} ${tail}`, params: [] });
  return out;
}

/** `?, ?, ?` for an IN list. */
export const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** D1 in the Worker. */
export function d1(db: D1Database): Db {
  const prep = (s: Stmt) => (s.params.length ? db.prepare(s.sql).bind(...s.params) : db.prepare(s.sql));
  return {
    async all<T>(sql: string, params: unknown[] = []) {
      return ((await prep({ sql, params }).all()).results ?? []) as T[];
    },
    async batch(stmts: Stmt[]) {
      if (stmts.length) await db.batch(stmts.map(prep));
    },
  };
}
