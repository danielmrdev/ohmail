import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { accounts } from "@trafficflow/db";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { SCHEDULED_STORE_METHODS, inStoreLane } from "../src/store-lanes.js";
import { freshDataDir } from "./_datadir.js";

/**
 * measured on the handle the desktop engine serves from. PGlite is one connection and
 * the engine dispatches concurrently, so the question is whether a statement from another caller
 * can land INSIDE an open transaction. A drain-lane transaction writes a row and is held open;
 * a read, a write and a second transaction are issued beside it. They wait for it, see nothing it
 * wrote, and the outside write survives its rollback. The transaction's own handle is the control.
 */
const dirs: string[] = [];
const opened: OpenLocalDb[] = [];
afterEach(async () => {
  for (const o of opened.splice(0)) await o.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("a statement from another caller never lands inside an open transaction", () => {
  it("CONTROL: a transaction opened by a bare BEGIN on the shared handle IS joined by the next caller", async () => {
    const dir = await freshDataDir("ohmail-pglite-dispatch-");
    dirs.push(dir);
    const store = await openLocalDb(dir);
    opened.push(store);
    const { db } = store;
    const row = randomUUID();
    await db.execute(sql`begin`);
    await db.insert(accounts).values({ id: row, name: "inside a bare begin" });
    // Another caller, on the same handle: it runs inside the open transaction and sees its row.
    const seen = (await db.select().from(accounts).where(eq(accounts.id, row))).length;
    await db.execute(sql`rollback`);
    expect(seen, "the detector reads an interleave where one exists").toBe(1);
  });

  it("the scheduler admits a whole transaction as one turn", () => {
    expect([...SCHEDULED_STORE_METHODS]).toContain("transaction");
  });

  it("read, write and transaction beside a held one wait for it, see none of it, and outlive its rollback", async () => {
    const dir = await freshDataDir("ohmail-pglite-dispatch-");
    dirs.push(dir);
    const store = await openLocalDb(dir);
    opened.push(store);
    const { db } = store;
    const held = randomUUID();
    const outside = randomUUID();
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    let seenInside = -1;

    const drain = inStoreLane("ingest", () => db.transaction(async (tx) => {
      await tx.insert(accounts).values({ id: held, name: "held open" });
      seenInside = (await tx.select().from(accounts).where(eq(accounts.id, held))).length;
      await hold;
      throw new Error("rolled back on purpose");
    })).then(() => "committed", (err: unknown) => (err as Error).message);
    const until = Date.now() + 5000;
    while (seenInside < 0 && Date.now() < until) await sleep(5);
    expect(seenInside, "CONTROL: inside the transaction its own write is visible").toBe(1);

    const settled = { read: false, write: false, transaction: false };
    const read = db.select().from(accounts).where(eq(accounts.id, held))
      .then((rows) => { settled.read = true; return rows.length; });
    const write = db.insert(accounts).values({ id: outside, name: "written beside it" })
      .then(() => { settled.write = true; });
    const second = db.transaction(async (tx) => (await tx.select().from(accounts).where(eq(accounts.id, held))).length)
      .then((n) => { settled.transaction = true; return n; });
    await sleep(200);
    expect(settled, "all three wait for the held transaction").toEqual({ read: false, write: false, transaction: false });

    release();
    expect(await drain).toBe("rolled back on purpose");
    expect(await read, "the read never saw the uncommitted row").toBe(0);
    expect(await second, "nor did the second transaction").toBe(0);
    await write;
    expect((await db.select().from(accounts).where(eq(accounts.id, outside))).length,
      "the outside write did not join the rollback").toBe(1);
    expect((await db.select().from(accounts).where(eq(accounts.id, held))).length).toBe(0);
  }, 30_000);
});
