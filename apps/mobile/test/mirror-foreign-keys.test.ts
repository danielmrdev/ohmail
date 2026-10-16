import { describe, it, expect, afterEach } from "vitest";
import { SqlMirrorStore } from "@ohmail/client-engine";
import { expoShapedWorld } from "./helpers/expo-sqlite-shape";
import { serialSqlExecutor } from "../src/engine/sql-queue";

/**
 * THE MIRROR'S REFERENCES ARE ENFORCED ON THE CONNECTION THE APP ACTUALLY WRITES THROUGH.
 *
 * `PRAGMA foreign_keys` is per-connection and SQLite defaults it OFF. The migrator turns it on for
 * the connection it runs on, and says in its own comment that a target which opens further
 * connections owes the same on each of them. The device's did not: `withExclusiveTransactionAsync`
 * opens a fresh connection for every batch, so every write the app made ran with the schema's
 * references unenforced, and an orphaned row committed exactly as readily as a good one.
 *
 * The second case is the control, and it is the reason the first means anything. It drives the old
 * arrangement directly and shows the orphan landing — so the model is known to be able to express
 * the defect, and a green first case is not simply a fixture that could never have gone red.
 */
const SCHEMA = [
  "CREATE TABLE mailboxes (id TEXT PRIMARY KEY)",
  "CREATE TABLE messages (id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id))",
];

let world: ReturnType<typeof expoShapedWorld> | undefined;
afterEach(() => { world?.cleanup(); world = undefined; });

describe("writes through the mirror's batch runner", () => {
  it("refuses a row that points at a mailbox which is not there", async () => {
    world = expoShapedWorld();
    const db = world.open("mirror");
    const sqlExecutor = serialSqlExecutor(db);
    await sqlExecutor.batch(SCHEMA.map((sql) => ({ sql })));

    await expect(sqlExecutor.batch([
      { sql: "INSERT INTO messages (id, mailbox_id) VALUES (?, ?)", params: ["m1", "no-such-mailbox"] },
    ])).rejects.toThrow(/FOREIGN KEY/i);

    const left = await sqlExecutor.all("SELECT id FROM messages", []);
    expect(left, "a refused batch must leave nothing behind").toEqual([]);
  });

  it("still commits a row whose mailbox exists, so the refusal is not simply everything failing", async () => {
    world = expoShapedWorld();
    const db = world.open("mirror");
    const sqlExecutor = serialSqlExecutor(db);
    await sqlExecutor.batch(SCHEMA.map((sql) => ({ sql })));
    await sqlExecutor.batch([
      { sql: "INSERT INTO mailboxes (id) VALUES (?)", params: ["mb"] },
      { sql: "INSERT INTO messages (id, mailbox_id) VALUES (?, ?)", params: ["m1", "mb"] },
    ]);
    expect(await sqlExecutor.all("SELECT id FROM messages", [])).toEqual([{ id: "m1" }]);
  });

  it("shows the orphan landing under the arrangement this replaced", async () => {
    // THE CONTROL, and the defect itself. Same file, same schema, same statement — run through
    // expo's exclusive transaction, which opens a connection nothing configured. If this ever
    // starts refusing, the model has stopped reproducing the platform and the case above is
    // grading something else.
    world = expoShapedWorld();
    const db = world.open("mirror");
    const sqlExecutor = serialSqlExecutor(db);
    await sqlExecutor.batch(SCHEMA.map((sql) => ({ sql })));

    await db.withExclusiveTransactionAsync(async (txn) => {
      await txn.runAsync("INSERT INTO messages (id, mailbox_id) VALUES (?, ?)", ["m2", "no-such-mailbox"]);
    });

    const orphans = await sqlExecutor.all("SELECT id FROM messages WHERE mailbox_id = ?", ["no-such-mailbox"]);
    expect(orphans, "the second connection enforces nothing, which is the whole finding").toEqual([{ id: "m2" }]);
  });
});

/**
 * The phone's queued changes are rows in this file, and emptying the outbox is a commit like any
 * other. On the device's journal (SQLite's default, `delete`) a commit is on the disk only once
 * the directory is flushed after the journal's unlink, which is what EXTRA adds, on this connection.
 */
describe("commits through the mirror's batch runner", () => {
  it("reach the disk before they resolve: the store's connection runs at synchronous EXTRA", async () => {
    world = expoShapedWorld();
    const sqlExecutor = serialSqlExecutor(world.open("mirror"));
    expect(await sqlExecutor.all("PRAGMA journal_mode", []), "the device's journal").toEqual([{ journal_mode: "delete" }]);
    expect(await sqlExecutor.all("PRAGMA synchronous", []), "control: SQLite's default, FULL").toEqual([{ synchronous: 2 }]);
    const store = new SqlMirrorStore({ owner: "acct-A", open: () => sqlExecutor });
    await store.load();
    expect(await sqlExecutor.all("PRAGMA synchronous", []), "3 is EXTRA").toEqual([{ synchronous: 3 }]);
    store.close();
  });
});
