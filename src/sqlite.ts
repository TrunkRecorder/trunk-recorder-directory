// The directory's database on SQLite (better-sqlite3): the dev server and the
// tests, with the same migrations D1 gets.

import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

/** ArgusRF's FCC database for tests and local runs: the fixture (its schema, with real DC-area rows), or a built one at `path` (ArgusRF's build/spectrum.db). */
export function fccSqlite(path?: string): Db & { raw: Database.Database } {
  if (path) return wrap(new Database(path, { readonly: true }));
  const raw = new Database(":memory:");
  raw.exec(readFileSync(join(import.meta.dirname, "..", "test", "fixtures", "fcc.sql"), "utf8"));
  return wrap(raw);
}

export function sqlite(path = ":memory:"): Db & { raw: Database.Database } {
  const raw = new Database(path);
  raw.pragma("journal_mode = WAL");
  raw.exec("CREATE TABLE IF NOT EXISTS d1_migrations (name TEXT PRIMARY KEY)");
  const done = new Set(raw.prepare("SELECT name FROM d1_migrations").all().map((r) => (r as { name: string }).name));
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    raw.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
    raw.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(f);
  }
  return wrap(raw);
}

function wrap(raw: Database.Database): Db & { raw: Database.Database } {
  const cache = new Map<string, Database.Statement>();
  // As D1: at most 100 parameters a statement (so tests catch what only D1 would refuse).
  const check = (params: unknown[] = []) => {
    if (params.length > 100) throw new Error(`too many SQL variables: ${params.length} (D1 allows 100)`);
  };
  const prep = (sql: string) => {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      if (cache.size < 500) cache.set(sql, s);
    }
    return s;
  };
  return {
    raw,
    async all<T>(sql: string, params: unknown[] = []) {
      check(params);
      return prep(sql).all(...(params as never[])) as T[];
    },
    async batch(stmts) {
      raw.transaction(() => {
        for (const s of stmts) {
          check(s.params);
          const p = prep(s.sql);
          if (p.reader) p.all(...(s.params as never[]));
          else p.run(...(s.params as never[]));
        }
      })();
    },
  };
}
