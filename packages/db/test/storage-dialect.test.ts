import { describe, it, expect } from "vitest";
import { eq, sql as sqlTag } from "drizzle-orm";
import {
  accountStorage, applyBodyBytesDelta, releaseBodyBytes, reserveBodyBytes, storageUsageOf,
} from "@trafficflow/db";
import { dialect, dialectOf } from "../src/dialect/index.js";
import { makeTestDb } from "../src/testing.js";

/**
 * THE STORED-BODY COUNTER, ON BOTH STORES — the one write that rides every message.
 *
 * `reserveBodyBytes` runs once per body the engine stores, so of everything in this module it is
 * the statement a phone executes most and the one whose failure takes ingest down rather than
 * degrading a feature. It carried two constructs the device store does not have: `now()`, which
 * is not a function there, and `greatest`, which is `max` — a name that store already gives to
 * the AGGREGATE, so the wrong spelling would not have failed, it would have collapsed the result
 * and answered a different question.
 *
 * Both now go through the seam, and this file is the control for each arm. It is deliberately
 * written against `account_storage` alone: that table has no foreign key, so the same file seeds
 * and runs identically under both projects, which is what makes "it passes on both" a fact rather
 * than two different tests agreeing.
 *
 * ── WATCHED FAIL ──────────────────────────────────────────────────────────────────────────
 *
 * With `d.now()` restored to `sql`now()``, the SQLite run answers `no such function: now` at the
 * first reserve and the Postgres run stays green. With `d.greatest(sql`0`, …)` restored to
 * `greatest(0, …)`, the SQLite run answers `no such function: greatest`. Neither mutation is
 * visible to the other store, which is the whole reason the second run exists.
 */
const ACCOUNT = "00000000-0000-4000-8000-0000000000aa";
const LONG_AGO = new Date("2020-01-01T00:00:00.000Z");

async function freshCounter(db: Awaited<ReturnType<typeof makeTestDb>>, bytes: number) {
  await db.delete(accountStorage).where(eq(accountStorage.accountId, ACCOUNT));
  await db.insert(accountStorage).values({ accountId: ACCOUNT, bytes });
  // Stamped into the past so "the bump moved it" is a comparison rather than a coincidence: a
  // row written and updated inside one test can otherwise carry the same instant twice.
  await db.update(accountStorage).set({ updatedAt: LONG_AGO })
    .where(eq(accountStorage.accountId, ACCOUNT));
}

const rowOf = async (db: Awaited<ReturnType<typeof makeTestDb>>) => {
  const [row] = await db.select().from(accountStorage)
    .where(eq(accountStorage.accountId, ACCOUNT)).limit(1);
  return row;
};

describe("a transaction knows which store it is on, without being told", () => {
  /**
   * The property almost every statement in this engine depends on, proved against BOTH real stores
   * rather than against a stub.
   *
   * A transaction is a fresh object the query builder makes, so a brand on the handle does not
   * travel to it — and a statement composed per dialect inside one therefore refused. Branding a
   * handle now wraps its `transaction`, so the callback receives a branded object, recursively.
   *
   * This is where it matters: the device store's handle is branded AFTER the one-transaction mutex
   * is put around it (`brandDialect(oneTransactionAtATime(db), "sqlite")`), so the wrapper this
   * relies on wraps the MUTEX's transaction and brands whatever that hands over. Getting that order
   * the other way round would brand the raw handle and leave the serialized one bare.
   */
  it("answers inside a transaction", async () => {
    const db = await makeTestDb();
    const outer = dialect(db).name;
    const inside = await db.transaction(async (tx) => dialectOf(tx));
    expect(inside).toBe(outer);
  });

  it("answers inside a SAVEPOINT, at the depth a nested writer opens one", async () => {
    const db = await makeTestDb();
    const inside = await db.transaction(async (tx) =>
      (tx as unknown as { transaction: (f: (s: object) => unknown) => Promise<unknown> })
        .transaction(async (sp) => dialectOf(sp)));
    expect(inside).toBe(dialect(db).name);
  });

  it("composes a real statement through the seam from inside one, which is the point", async () => {
    // Not merely "the brand is readable": the thing that used to fail is composing a statement,
    // so this composes one. `d.now()` is the member whose absence stopped the first drain.
    const db = await makeTestDb();
    await freshCounter(db, 7);
    await db.transaction(async (tx) => {
      const d = dialect(tx);
      await (tx as unknown as typeof db).update(accountStorage)
        .set({ bytes: 9, updatedAt: d.now() })
        .where(eq(accountStorage.accountId, ACCOUNT));
    });
    expect(await storageUsageOf(db as never, ACCOUNT)).toBe(9);
  });
});

describe("the stored-body counter moves on whichever store the engine opened", () => {
  it("adds the body's bytes and advances the stamp, unmetered", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    await freshCounter(db, 1_000);

    expect(await reserveBodyBytes(db as never, d, ACCOUNT, 250, null)).toBe(true);

    expect(await storageUsageOf(db as never, ACCOUNT)).toBe(1_250);
    // The stamp is the `now()` arm's own effect: it is the only thing that write moves besides
    // the count, so an unported spelling cannot hide behind a correct number.
    const after = await rowOf(db);
    expect(after?.updatedAt).toBeInstanceOf(Date);
    expect((after?.updatedAt as Date).getTime()).toBeGreaterThan(LONG_AGO.getTime());
  });

  it("declines once the count has reached the cap, and stores the message that crosses it", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    await freshCounter(db, 900);

    // Below the cap: admitted IN FULL even though it crosses — the predicate is `bytes < cap`
    // before adding, which is the conservative direction and bounded by one message.
    expect(await reserveBodyBytes(db as never, d, ACCOUNT, 500, 1_000)).toBe(true);
    expect(await storageUsageOf(db as never, ACCOUNT)).toBe(1_400);
    // At or over the cap: the next one is the decline, and the counter does not move.
    expect(await reserveBodyBytes(db as never, d, ACCOUNT, 10, 1_000)).toBe(false);
    expect(await storageUsageOf(db as never, ACCOUNT)).toBe(1_400);
  });

  it("clamps a compensation at zero rather than writing a negative count", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    await freshCounter(db, 400);

    // The largest-of member's own arm. On the device store this is spelled `max`, where ONE
    // argument is the aggregate — the seam refuses that call, and this is the two-argument use
    // it exists for.
    await releaseBodyBytes(db as never, d, ACCOUNT, 1_000);
    expect(await storageUsageOf(db as never, ACCOUNT)).toBe(0);
    const after = await rowOf(db);
    expect((after?.updatedAt as Date).getTime()).toBeGreaterThan(LONG_AGO.getTime());
  });

  it("applies a repair's delta in both directions, and never below zero", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    await freshCounter(db, 100);

    await applyBodyBytesDelta(db as never, d, ACCOUNT, 60);
    expect(await storageUsageOf(db as never, ACCOUNT)).toBe(160);
    await applyBodyBytesDelta(db as never, d, ACCOUNT, -50);
    expect(await storageUsageOf(db as never, ACCOUNT)).toBe(110);
    await applyBodyBytesDelta(db as never, d, ACCOUNT, -10_000);
    expect(await storageUsageOf(db as never, ACCOUNT)).toBe(0);
  });

  it("reads a raw statement back POSITIONALLY through the seam, on both stores", async () => {
    // The shape the recompute and the eviction page now depend on. The server's driver answers
    // named objects and the device's answers arrays; the seam's `exec` returns one shape, and a
    // caller reading `row[0]` has to be right on both or it is right on neither.
    const db = await makeTestDb();
    const d = dialect(db);
    await freshCounter(db, 4_242);

    const rows = await d.exec(db, sqlSelect(ACCOUNT));
    expect(rows).toHaveLength(1);
    expect(Array.isArray(rows[0])).toBe(true);
    expect(Number(rows[0]?.[0])).toBe(4_242);
    expect(String(rows[0]?.[1])).toBe(ACCOUNT);
  });
});

/** Kept out of the case above so the two columns' ORDER is visible beside the reads of them. */
function sqlSelect(accountId: string) {
  return sqlTag`select bytes, account_id from account_storage where account_id = ${accountId}`;
}
