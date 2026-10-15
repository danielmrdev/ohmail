import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { accounts, changeLog, flagState, folderState, mailboxes, messages, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { readStateRetroPass, READ_RETRO_FOLDERS } from "../src/read-retro.js";

/**
 * MARKING THE SCREENED-OUT + SPAM BACKLOG READ.
 *
 * A green run over an empty database is not evidence, so every case seeds real unread mail and
 * asserts what got a read-mark and — the half that matters more — what did NOT. The safety scope
 * (only `ohmail/Screened` and `ohmail/Quarantine`) is the property the stated constraint turns
 * on, so it is the first thing asserted and it is asserted as an ABSENCE on the other four folders.
 *
 * The transactional guarantee (the flag write, the unread mirror and the delta committing
 * together) and `FOR UPDATE` under contention are green-by-construction on PGlite (single
 * connection); they live in `read-retro.pg.test.ts` on :5433, per CLAUDE.md.
 */
interface World { db: Tx; accountId: string; mailboxId: string; }

async function newWorld(): Promise<World> {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `f2r-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`,
  }).returning();
  return { db, accountId, mailboxId: mb!.id };
}

/** One message filed to `folder` with a `folder_state` row and the given read state. */
async function seed(w: World, folder: string, unread: boolean): Promise<string> {
  const [m] = await w.db.insert(messages).values({
    accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: randomUUID(), dedupKey: `f2r:${randomUUID()}`,
    subject: "x", fromAddress: "s@e.test", unread, nativeLocator: { folder, ref: "1:1" },
  }).returning();
  await w.db.insert(folderState).values({
    messageId: m!.id, desiredFolder: folder, observedFolder: folder,
    lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  return m!.id;
}

const flagsFor = (w: World, ids: string[]) => w.db.select({
  id: flagState.messageId, desiredSeen: flagState.desiredSeen, status: flagState.reconcileStatus,
}).from(flagState).where(inArray(flagState.messageId, ids));

const unreadFor = (w: World, ids: string[]) => w.db.select({ id: messages.id, unread: messages.unread })
  .from(messages).where(inArray(messages.id, ids));

describe("readStateRetroPass — marks the demoting backlog read, and only that", () => {
  it("marks unread Screened + Quarantine mail read: flag_state pending, unread flipped, one delta each", async () => {
    const w = await newWorld();
    const screened = await seed(w, "ohmail/Screened", true);
    const spam = await seed(w, "ohmail/Quarantine", true);

    const r = await readStateRetroPass(w.db, { accountId: w.accountId });
    expect(r.marked).toBe(2);
    expect(r.capped).toBe(false);

    const flags = await flagsFor(w, [screened, spam]);
    expect(flags).toHaveLength(2);
    expect(flags.every((f) => f.desiredSeen === true && f.status === "pending")).toBe(true);
    expect((await unreadFor(w, [screened, spam])).every((r2) => r2.unread === false)).toBe(true);

    const deltas = await w.db.select().from(changeLog).where(and(
      eq(changeLog.accountId, w.accountId), eq(changeLog.op, "update"),
    ));
    expect(deltas.map((d) => d.entityId).sort()).toEqual([screened, spam].sort());
  });

  it("NEVER touches INBOX / Reads / Receipts / Screener, or already-read mail", async () => {
    const w = await newWorld();
    const safe = [
      await seed(w, "INBOX", true),
      await seed(w, "ohmail/News", true),
      await seed(w, "ohmail/Receipts", true),
      await seed(w, "ohmail/Screener", true),          // awaiting a decision — must stay bold
      await seed(w, "ohmail/Screened", false),          // already read — nothing to do
    ];

    const r = await readStateRetroPass(w.db, { accountId: w.accountId });
    expect(r.marked).toBe(0);
    expect(await flagsFor(w, safe)).toHaveLength(0);
    expect((await unreadFor(w, safe.slice(0, 4))).every((x) => x.unread === true)).toBe(true);
  });

  it("is idempotent — a second run marks nothing", async () => {
    const w = await newWorld();
    await seed(w, "ohmail/Screened", true);
    await seed(w, "ohmail/Quarantine", true);
    expect((await readStateRetroPass(w.db, { accountId: w.accountId })).marked).toBe(2);
    expect((await readStateRetroPass(w.db, { accountId: w.accountId })).marked).toBe(0);
  });

  it("does not cross account boundaries", async () => {
    const w = await newWorld();
    const other = await newWorld();
    const mine = await seed(w, "ohmail/Screened", true);
    const theirs = await seed(other, "ohmail/Screened", true);
    await readStateRetroPass(w.db, { accountId: w.accountId });
    // `w.db` and `other.db` are distinct PGlite instances, so cross-account leakage would show as
    // a mark on `theirs` in ITS db. Assert both: mine marked, theirs untouched.
    expect((await unreadFor(w, [mine]))[0]!.unread).toBe(false);
    expect((await unreadFor(other, [theirs]))[0]!.unread).toBe(true);
  });

  it("respects the per-cycle write budget and finishes on a second invocation", async () => {
    const w = await newWorld();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await seed(w, "ohmail/Screened", true));

    const first = await readStateRetroPass(w.db, { accountId: w.accountId, batch: 2, writesPerCycle: 3 });
    expect(first.marked).toBe(3);
    expect(first.capped).toBe(true);

    const second = await readStateRetroPass(w.db, { accountId: w.accountId, batch: 2, writesPerCycle: 3 });
    expect(second.marked).toBe(2);
    expect(second.capped).toBe(false);

    expect((await unreadFor(w, ids)).every((x) => x.unread === false)).toBe(true);
  });

  it("READ_RETRO_FOLDERS is exactly the two demoting folders", () => {
    expect([...READ_RETRO_FOLDERS].sort()).toEqual(["ohmail/Quarantine", "ohmail/Screened"]);
  });
});
