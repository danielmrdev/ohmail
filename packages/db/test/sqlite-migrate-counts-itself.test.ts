import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { SQLITE_JOURNAL, type SqliteJournalEntry } from "@ohmail/db-mail/sqlite-journal";
import { migrateSqlite, SQLITE_MIGRATIONS_TABLE } from "../src/sqlite-migrate.js";

/**
 * THE DEVICE STORE'S UPGRADE COUNTS ITSELF (FIX-026 row 95). The phone's relaunch runs this
 * migrator and shows "3 of 12" from its hooks, so the hooks must count THIS open's owed entries
 * (never the journal's length), say whether the store is fresh, announce BEFORE each entry, and
 * never announce an entry that failed as applied. Mutations: `owed` → `journal.length`, `fresh`
 * read after the CREATE, `onApplied` moved above the COMMIT.
 */

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { all(...a: unknown[]): unknown[] };
  };
};
type Store = InstanceType<typeof DatabaseSync>;

const targetFor = (db: Store) => ({
  run: async (statement: string): Promise<void> => { db.exec(statement); },
  all: async <T,>(statement: string): Promise<T[]> => db.prepare(statement).all() as T[],
});

interface Heard { entries: [number, number, string, boolean][]; applied: string[] }
const listen = (): Heard & { hooks: Parameters<typeof migrateSqlite>[2] } => {
  const heard: Heard = { entries: [], applied: [] };
  return {
    ...heard,
    hooks: {
      onEntry: (a, p, n, f) => { heard.entries.push([a, p, n, f]); },
      onApplied: (n) => { heard.applied.push(n); },
    },
  };
};

describe("the device store's upgrade counts itself", () => {
  it("a fresh store is said to be fresh, and every entry is owed", async () => {
    const db = new DatabaseSync(":memory:");
    const h = listen();
    const applied = await migrateSqlite(targetFor(db), SQLITE_JOURNAL, h.hooks);
    expect(applied).toHaveLength(SQLITE_JOURNAL.length);
    expect(h.entries.every(([, , , fresh]) => fresh), "a first launch was not called fresh").toBe(true);
    expect(h.entries[0]).toEqual([0, SQLITE_JOURNAL.length, SQLITE_JOURNAL[0]!.name, true]);
  });

  it("an upgrade counts the entries THIS open owed, before each one, and is not fresh", async () => {
    const db = new DatabaseSync(":memory:");
    const owed = 3;
    await migrateSqlite(targetFor(db), SQLITE_JOURNAL.slice(0, SQLITE_JOURNAL.length - owed));
    const h = listen();
    const applied = await migrateSqlite(targetFor(db), SQLITE_JOURNAL, h.hooks);
    expect(SQLITE_JOURNAL.length, "control: the journal holds more than the owed entries").toBeGreaterThan(owed);
    const tail = SQLITE_JOURNAL.slice(-owed).map((e) => e.name);
    expect(applied).toEqual(tail);
    expect(h.entries).toEqual(tail.map((name, i) => [i, owed, name, false]));
    expect(h.applied).toEqual(tail);
    /* An ordinary launch owes nothing and announces nothing. */
    const quiet = listen();
    expect(await migrateSqlite(targetFor(db), SQLITE_JOURNAL, quiet.hooks)).toEqual([]);
    expect(quiet.entries).toEqual([]);
  });

  it("a failing entry is refused BY NAME and is never announced as applied", async () => {
    const db = new DatabaseSync(":memory:");
    await migrateSqlite(targetFor(db), SQLITE_JOURNAL);
    const bad: SqliteJournalEntry = { ...SQLITE_JOURNAL[0]!, name: "9999_fix026_planted", statements: ["SELECT nope FROM nowhere"] };
    const h = listen();
    await expect(migrateSqlite(targetFor(db), [...SQLITE_JOURNAL, bad], h.hooks))
      .rejects.toThrow("the SQLite journal stopped at 9999_fix026_planted");
    expect(h.entries.map(([, , n]) => n)).toEqual(["9999_fix026_planted"]);
    expect(h.applied, "a refused entry was reported as applied").toEqual([]);
    const ledger = db.prepare(`SELECT name FROM ${SQLITE_MIGRATIONS_TABLE} WHERE name = '9999_fix026_planted'`).all();
    expect(ledger).toEqual([]);
  });
});
