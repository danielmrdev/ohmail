import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { organizerRequests } from "@trafficflow/db";
import { REQUEST_SET_MAX } from "@trafficflow/core/adapters/organizer-lease";
import { requestIdInSet, writeReaderRequestSet } from "../src/index.js";
import { makeCtx } from "./helpers.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  ONE PRESS, N RECORDS, ONE KEY — the set door itself
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The doors that USE it are measured in `reader-approval-and-bulk.test.ts`, against real runs and
 * real mail. This file measures the two properties those cases rest on and cannot show cheaply:
 * the id is DERIVED so a retry writes nothing new, and the queue BOUND refuses at the press.
 */

const HOLDER = { kind: "local" as const, name: "mila-thinkpad", since: null };

describe("requestIdInSet — derived, never minted", () => {
  it("is stable for one (key, member) and different for every other pair", () => {
    const a = requestIdInSet("press-1", "m1");
    expect(requestIdInSet("press-1", "m1")).toBe(a);
    expect(requestIdInSet("press-1", "m2")).not.toBe(a);
    expect(requestIdInSet("press-2", "m1")).not.toBe(a);
  });

  it("is a well-formed UUID, because the column is one", () => {
    // Not merely 32 hex characters that fit: a Postgres `uuid` column parses this, and a value
    // with no version nibble would be rejected on the first real insert and nowhere in a test.
    expect(requestIdInSet("press-1", "m1"))
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("cannot be collided by spelling one half like the other", () => {
    /* The two halves are joined through `JSON.stringify`, not concatenated: with a separator a
       member could spell, ("a", "b:c") and ("a:b", "c") would be the same record — one press
       silently swallowing another's. */
    expect(requestIdInSet("a", "b:c")).not.toBe(requestIdInSet("a:b", "c"));
    expect(requestIdInSet("a", '"b"')).not.toBe(requestIdInSet('a"', 'b'));
  });
});

describe("writeReaderRequestSet", () => {
  it("writes one row per member and reports the press's own size", async () => {
    const w = await makeCtx();
    const out = await writeReaderRequestSet(w.db, w.ctx, {
      mailboxId: w.mailboxId, kind: "message.move", holder: HOLDER,
      batchKey: "press-1",
      members: ["m1", "m2", "m3"].map((k) => ({ key: k, payload: { dedupKey: k, destination: "inbox" } })),
    });
    expect(out).toMatchObject({ pending: true, batchKey: "press-1", written: 3, of: 3 });

    const rows = await w.db.select().from(organizerRequests)
      .where(eq(organizerRequests.accountId, w.accountId));
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(out.requestIds));
    expect(rows.every((r) => r.state === "pending" && r.kind === "message.move")).toBe(true);
  });

  it("a REPEATED press writes nothing new and still answers for the whole set", async () => {
    const w = await makeCtx();
    const members = ["m1", "m2"].map((k) => ({ key: k, payload: { dedupKey: k, destination: "inbox" } }));
    const input = {
      mailboxId: w.mailboxId, kind: "message.move" as const, holder: HOLDER,
      batchKey: "press-1", members,
    };
    await writeReaderRequestSet(w.db, w.ctx, input);
    const again = await writeReaderRequestSet(w.db, w.ctx, input);

    // `written` is what THIS attempt inserted; `of` is what the press is. Conflating them would
    // let a retry report "nothing is waiting" over two records that are.
    expect(again).toMatchObject({ written: 0, of: 2 });
    const rows = await w.db.select().from(organizerRequests)
      .where(eq(organizerRequests.accountId, w.accountId));
    expect(rows).toHaveLength(2);
  });

  it("a row the organizer has already taken is NOT dragged back to pending", async () => {
    /* `onConflictDoNothing`, never an upsert: by the time a press is retried its first attempt
       may have been appended and applied, and an upsert would re-queue a decision that is done. */
    const w = await makeCtx();
    const input = {
      mailboxId: w.mailboxId, kind: "message.move" as const, holder: HOLDER,
      batchKey: "press-1",
      members: [{ key: "m1", payload: { dedupKey: "m1", destination: "inbox" } }],
    };
    await writeReaderRequestSet(w.db, w.ctx, input);
    await w.db.update(organizerRequests).set({ state: "sent", sentAt: w.ctx.now() })
      .where(eq(organizerRequests.accountId, w.accountId));

    await writeReaderRequestSet(w.db, w.ctx, input);
    const rows = await w.db.select().from(organizerRequests)
      .where(eq(organizerRequests.accountId, w.accountId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("sent");
  });

  it("refuses a press over the queue bound, at the press, before any row exists", async () => {
    const w = await makeCtx();
    const members = Array.from({ length: REQUEST_SET_MAX + 1 }, (_, i) => ({
      key: `m${i}`, payload: { dedupKey: `m${i}`, destination: "inbox" },
    }));
    await expect(writeReaderRequestSet(w.db, w.ctx, {
      mailboxId: w.mailboxId, kind: "message.move", holder: HOLDER,
      batchKey: "press-1", members,
    })).rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });

    const rows = await w.db.select().from(organizerRequests)
      .where(eq(organizerRequests.accountId, w.accountId));
    expect(rows).toEqual([]);
  });

  it("POSITIVE CONTROL — a press AT the bound is admitted whole", async () => {
    // Without this the refusal above proves only that the door is closed. The off-by-one is the
    // failure this pair exists to catch: `>` and `>=` are both plausible readings of "the bound".
    const w = await makeCtx();
    const members = Array.from({ length: REQUEST_SET_MAX }, (_, i) => ({
      key: `m${i}`, payload: { dedupKey: `m${i}`, destination: "inbox" },
    }));
    const out = await writeReaderRequestSet(w.db, w.ctx, {
      mailboxId: w.mailboxId, kind: "message.move", holder: HOLDER,
      batchKey: "press-1", members,
    });
    expect(out.of).toBe(REQUEST_SET_MAX);
    expect(out.written).toBe(REQUEST_SET_MAX);
  });
});
