import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { awayResponders } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import type { OpenSendAdapter } from "@trafficflow/core";
import { runAwayResponderPass } from "../src/away-responder-pass.js";

/**
 * WHICH RESPONDERS ARE LIVE RIGHT NOW — the predicate that ran on every drain and failed on one store.
 *
 * The pass reads its live responders before it reads a single message, so its window predicate is
 * the first statement of every drain. Both bounds were written as explicit server casts of an
 * instant, and on the device store that is not a slow path or a wrong answer: it is
 * `unrecognized token: ":"`, which took the DRAIN down rather than the responder.
 *
 * The instant now goes through the seam's timestamp binder, which writes each store its own
 * literal for one moment — the server's cast, byte for byte what it was, and this store's epoch
 * millisecond. The behaviour the two must agree on is here: an absent bound is OPEN at that end
 * and never "now", because reading an absent start as the current instant would make an enabled
 * responder with no dates answer nobody.
 *
 * `accounts` is the effect to read: it counts the accounts whose responder this invocation found
 * live. Nothing else is seeded, so the pass looks, finds no candidates, and stops — which makes
 * this a test of the window and of nothing else.
 *
 * ── WATCHED FAIL ──────────────────────────────────────────────────────────────────────────
 *
 * With `d.ts(at)` restored to `${at.toISOString()}::timestamptz`, the device run answers
 * `unrecognized token: ":"` on every case while the server run stays green.
 */
const NEVER_SENDS: OpenSendAdapter = () => {
  throw new Error("this pass must not reach the transport: nothing is seeded for it to send");
};

const AT = new Date("2026-06-15T12:00:00.000Z");
const before = (days: number) => new Date(AT.getTime() - days * 86_400_000);
const after = (days: number) => new Date(AT.getTime() + days * 86_400_000);

async function seed(
  db: Awaited<ReturnType<typeof makeTestDb>>,
  accountId: string,
  window: { startsAt: Date | null; endsAt: Date | null },
) {
  await db.insert(awayResponders).values({
    accountId,
    enabled: true,
    enabledAt: before(30),
    body: "Away until July.",
    ...window,
  });
}

const liveAccounts = async (db: Awaited<ReturnType<typeof makeTestDb>>) => {
  const result = await runAwayResponderPass(db as never, {
    openSendAdapter: NEVER_SENDS,
    now: () => AT,
  });
  return result.accounts;
};

describe("the away window is read the same way on both stores", () => {
  it("finds a responder whose window is open at this instant", async () => {
    const db = await makeTestDb();
    await seed(db, randomUUID(), { startsAt: before(1), endsAt: after(1) });
    expect(await liveAccounts(db)).toBe(1);
  });

  it("does not find one whose window has not started", async () => {
    const db = await makeTestDb();
    await seed(db, randomUUID(), { startsAt: after(1), endsAt: after(5) });
    expect(await liveAccounts(db)).toBe(0);
  });

  it("does not find one whose window has ended", async () => {
    const db = await makeTestDb();
    await seed(db, randomUUID(), { startsAt: before(5), endsAt: before(1) });
    expect(await liveAccounts(db)).toBe(0);
  });

  it("treats an absent bound as OPEN at that end, never as this instant", async () => {
    // The case the comment on the predicate exists for: an enabled responder with no dates at all
    // must answer everybody, not nobody.
    const db = await makeTestDb();
    await seed(db, randomUUID(), { startsAt: null, endsAt: null });
    await seed(db, randomUUID(), { startsAt: null, endsAt: after(1) });
    await seed(db, randomUUID(), { startsAt: before(1), endsAt: null });
    expect(await liveAccounts(db)).toBe(3);
  });

  it("is inclusive at both ends, so a window that begins or ends exactly now is open", async () => {
    // The bound is `<=` / `>=` on both stores. An off-by-one here is a responder that goes silent
    // for the first or last second of its own window — which is not something a person would ever
    // report, and is exactly the kind of difference two dialects can drift into.
    const db = await makeTestDb();
    await seed(db, randomUUID(), { startsAt: AT, endsAt: after(1) });
    await seed(db, randomUUID(), { startsAt: before(1), endsAt: AT });
    expect(await liveAccounts(db)).toBe(2);
  });
});
