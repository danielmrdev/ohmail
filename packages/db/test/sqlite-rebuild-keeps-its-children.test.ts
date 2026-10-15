import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { SQLITE_JOURNAL, type SqliteJournalEntry } from "@ohmail/db-mail/sqlite-journal";
import { migrateSqlite, SQLITE_MIGRATIONS_TABLE } from "../src/sqlite-migrate.js";

/**
 * A REBUILD MAY NOT CASCADE ITS CHILDREN AWAY.
 *
 * This store cannot ALTER a constraint, so a constraint change is a table rebuild — create, copy,
 * DROP, rename. With foreign keys ON, `DROP TABLE` performs an implicit DELETE FROM, and every
 * ON DELETE CASCADE child of the table being rebuilt loses its rows to the migration. The journal
 * already carries one such entry. The migrator now runs the documented dance around every entry,
 * and this file is what says the dance is what decides: the same entry, on the same seeded store,
 * loses the row the old way and keeps it the new way.
 */

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown };
  };
};

type Store = InstanceType<typeof DatabaseSync>;

/** `migrateSqlite`'s target over one `node:sqlite` handle — one connection, as the phone has. */
const targetFor = (db: Store) => ({
  run: async (statement: string): Promise<void> => { db.exec(statement); },
  all: async <T,>(statement: string): Promise<T[]> => db.prepare(statement).all() as T[],
});

const FP = "0".repeat(64);
const ENTRY_95 = SQLITE_JOURNAL.find((e) => e.name.startsWith("0095")) as SqliteJournalEntry;
const BEFORE_95 = SQLITE_JOURNAL.slice(0, SQLITE_JOURNAL.indexOf(ENTRY_95));

/** A store at the state just before 0095, holding one send and one fingerprint of it. */
async function seededBefore95(): Promise<Store> {
  const db = new DatabaseSync(":memory:");
  await migrateSqlite(targetFor(db), BEFORE_95);
  db.exec(`INSERT INTO accounts (id, name) VALUES ('a1','a')`);
  db.exec(`INSERT INTO mailboxes (id, account_id, provider, address) VALUES ('m1','a1','imap','x@y.test')`);
  db.exec(`INSERT INTO drafts (id, account_id, mailbox_id) VALUES ('d1','a1','m1')`);
  db.exec(`INSERT INTO outbound_sends (id, account_id, idempotency_key, draft_id, minted_message_id)
           VALUES ('s1','a1','k1','d1','<m@x>')`);
  db.exec(`INSERT INTO outbound_send_fingerprints (id, account_id, mailbox_id, send_id, fingerprint)
           VALUES ('fp1','a1','m1','s1','${FP}')`);
  return db;
}

const fingerprints = (db: Store): number =>
  Number((db.prepare("SELECT count(*) c FROM outbound_send_fingerprints").get() as { c: number }).c);

describe("a rebuild keeps the rows that reference the table it rebuilds", () => {
  it("LOSES the child row the way this migrator used to apply an entry", async () => {
    // The shape this file replaced, written out rather than named: keys ON, one transaction, no
    // check. A control that does not reproduce the failure cannot say the fix is what decides.
    const db = await seededBefore95();
    expect(fingerprints(db)).toBe(1);
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("BEGIN");
    for (const s of ENTRY_95.statements) db.exec(s);
    db.exec("COMMIT");
    expect(fingerprints(db)).toBe(0);
  });

  it("KEEPS the child row through the migrator", async () => {
    const db = await seededBefore95();
    expect(fingerprints(db)).toBe(1);
    const applied = await migrateSqlite(targetFor(db), [...BEFORE_95, ENTRY_95]);
    expect(applied).toEqual([ENTRY_95.name]);
    expect(fingerprints(db)).toBe(1);
    // and the send it names is still there, so the surviving row is not an orphan
    expect(Number((db.prepare(
      `SELECT count(*) c FROM outbound_send_fingerprints f
         JOIN outbound_sends s ON s.id = f.send_id`).get() as { c: number }).c)).toBe(1);
  });

  it("REFUSES an entry that leaves a reference dangling, by name", async () => {
    // With keys off for the entry, an entry CAN take a parent away and leave the child pointing at
    // nothing. The check inside the transaction is what makes that a refusal and not a silent
    // store — and it runs before the commit, so the refusal also undoes it.
    const db = await seededBefore95();
    const planted: SqliteJournalEntry = {
      name: "9999_planted_dangling_reference.sql",
      statements: [`DELETE FROM "outbound_sends" WHERE "id" = 's1'`],
    };
    await expect(migrateSqlite(targetFor(db), [...BEFORE_95, planted]))
      .rejects.toThrow(/9999_planted_dangling_reference/);
    expect(fingerprints(db)).toBe(1);
    const recorded = db.prepare(
      `SELECT count(*) c FROM ${SQLITE_MIGRATIONS_TABLE} WHERE name = '9999_planted_dangling_reference.sql'`,
    ).get() as { c: number };
    expect(Number(recorded.c)).toBe(0);
  });

  it("names the table the dangling reference is in", async () => {
    const db = await seededBefore95();
    const planted: SqliteJournalEntry = {
      name: "9999_planted.sql",
      statements: [`DELETE FROM "outbound_sends" WHERE "id" = 's1'`],
    };
    await expect(migrateSqlite(targetFor(db), [...BEFORE_95, planted]))
      .rejects.toThrow(/outbound_send_fingerprints/);
  });

  it("leaves foreign keys ON after a refusal", async () => {
    // A throw that left them off hands the caller a store whose keys are advisory — worse than
    // the migration having failed at all.
    const db = await seededBefore95();
    const planted: SqliteJournalEntry = {
      name: "9999_planted.sql",
      statements: [`DELETE FROM "outbound_sends" WHERE "id" = 's1'`],
    };
    await migrateSqlite(targetFor(db), [...BEFORE_95, planted]).catch(() => undefined);
    expect(Number((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys)).toBe(1);
  });
});
