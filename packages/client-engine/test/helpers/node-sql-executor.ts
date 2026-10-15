import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import type { SqlExecutor, SqlRow, SqlStatement, SqlValue } from "@ohmail/client-engine";

/**
 * `node:sqlite`, LOADED THROUGH `createRequire` RATHER THAN AN IMPORT STATEMENT — not a
 * stylistic choice. The suite runs under vite, and vite 5.4's builtin list predates
 * `node:sqlite`: a static `import { DatabaseSync } from "node:sqlite"` gets its prefix
 * stripped and dies resolving a package called `sqlite` that does not exist. `createRequire`
 * resolves at runtime in node itself, where the module is real (node ≥ 22.5). The `import
 * type` above is erased before vite ever sees it, so the types stay exact.
 */
const requireNode = createRequire(import.meta.url);
const sqlite = requireNode("node:sqlite") as typeof import("node:sqlite");

export type { DatabaseSync };

/** A fresh in-memory sqlite database. */
export function newDb(): DatabaseSync {
  return new sqlite.DatabaseSync(":memory:");
}

/**
 * `node:sqlite` behind the {@link SqlExecutor} seam — the test-side twin of the SQL runner the
 * mobile app builds over expo-sqlite. `batch` is a real transaction (`BEGIN IMMEDIATE` …
 * `COMMIT`, `ROLLBACK` on throw), because the atomicity of a batch IS the contract the store's
 * tests exist to hold; faking it with sequential runs would make every atomicity test pass
 * vacuously in the one place it must be able to fail.
 */
export function nodeSqlExecutor(db: DatabaseSync): SqlExecutor {
  return {
    async all(sql: string, params: ReadonlyArray<SqlValue> = []): Promise<SqlRow[]> {
      return db.prepare(sql).all(...params) as SqlRow[];
    },
    async batch(statements: ReadonlyArray<SqlStatement>): Promise<void> {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const { sql, params = [] } of statements) db.prepare(sql).run(...params);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

/**
 * A named-database world, the sqlite analogue of a fresh `IDBFactory` per test: `open` hands
 * every distinct name its own in-memory database and the SAME database on every re-open, so
 * "close the store, open a new one over the same name" exercises real persistence.
 */
export function sqlWorld() {
  const dbs = new Map<string, DatabaseSync>();
  return {
    open: (name: string): SqlExecutor => {
      let db = dbs.get(name);
      if (!db) {
        db = newDb();
        dbs.set(name, db);
      }
      return nodeSqlExecutor(db);
    },
    /** Every database name ever opened — the twin of `IDBFactory.databases()`. */
    names: (): string[] => [...dbs.keys()].sort(),
  };
}
