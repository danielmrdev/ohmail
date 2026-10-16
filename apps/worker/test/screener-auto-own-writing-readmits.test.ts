import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accountSettings, accounts, folderState, mailboxes, messageBodies, messages, recordChange, threads, type Tx,
} from "@trafficflow/db";
import { newScreenerAutoWalk, screenerAutoApplyPass } from "../src/screener-auto.js";

/**
 * OUR OWN WRITING CHANGING RE-ADMITS A KEPT ROW ON THE NEXT CYCLE (AUTO-APPLY-UNLOGGED-READMITS-
 * WAIT-FOR-THE-HOUR). Exclusion 5 keeps a stranger we answered at the gate; when our reply leaves
 * their thread (the merge in `thread-service.ts`, the join heal) the only change row is OUR
 * message's, which the incremental walk never read, so the row waited for the hourly full walk.
 * The walk's mark now reads a change to one of the account's own messages as a re-admission.
 */

const SCREENER = "ohmail/Screener";
const STRONG_BULK = { "list-unsubscribe": ["<https://x.test/u>"], "list-id": ["<news.shop.test>"] };

async function world() {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "own-writing" });
  const own = `me-${accountId.slice(0, 6)}@example.test`;
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: own, organizerRole: "organizer" }).returning();
  await db.insert(accountSettings).values({ accountId, screenerAutoApplyAt: new Date() });
  const [t1] = await db.insert(threads).values({ accountId, subject: "News" }).returning();
  const [t2] = await db.insert(threads).values({ accountId, subject: "Other" }).returning();
  const held = await db.transaction(async (tx) => {
    const [m] = await tx.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `ow:${randomUUID()}`, subject: "Weekly news",
      fromAddress: "news@shop.test", threadId: t1!.id, nativeLocator: { folder: SCREENER, ref: "1:1" },
    }).returning();
    await tx.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: STRONG_BULK });
    await tx.insert(folderState).values({ messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false });
    await recordChange(tx as never, { accountId, entityType: "message", entityId: m!.id, op: "create", meta: null });
    return m!.id;
  });
  const [reply] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, bodyHash: "s", dedupKey: `ow:${randomUUID()}`, subject: "Re: Weekly news",
    fromAddress: own, toAddresses: [{ name: null, address: "news@shop.test" }], ccAddresses: [],
    threadId: t1!.id, nativeLocator: { folder: "Sent", ref: "1:2" },
  } as never).returning();
  const walk = newScreenerAutoWalk();
  const first = await screenerAutoApplyPass(db, { accountId, walk });
  expect(first, "premise: our reply keeps them at the gate").toMatchObject({ mode: "full", moved: 0 });
  const desired = async () =>
    (await db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, held)))[0]!.d;
  const change = (id: string, op: "update" | "delete") =>
    db.transaction(async (tx) => { await recordChange(tx as never, { accountId, entityType: "message", entityId: id, op, meta: null }); });
  return { db, accountId, held, reply: reply!.id, t2: t2!.id, walk, desired, change };
}

describe("a change to our own writing re-admits a kept row on the next cycle", () => {
  it("our reply re-threaded away: the next cycle walks in full and files them", async () => {
    const w = await world();
    await w.db.update(messages).set({ threadId: w.t2 }).where(eq(messages.id, w.reply));
    await w.change(w.reply, "update");
    const next = await screenerAutoApplyPass(w.db, { accountId: w.accountId, walk: w.walk });
    expect({ mode: next.mode, moved: next.moved, desired: await w.desired() })
      .toEqual({ mode: "full", moved: 1, desired: "ohmail/News" });
  });

  it("our reply deleted and kept as a tombstone: the next cycle walks in full, and the answer still stands", async () => {
    const w = await world();
    await w.db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, w.reply));
    await w.change(w.reply, "delete");
    const next = await screenerAutoApplyPass(w.db, { accountId: w.accountId, walk: w.walk });
    expect({ mode: next.mode, moved: next.moved }).toEqual({ mode: "full", moved: 0 });
  });

  it("our reply purged: its change row joins nothing, so the next cycle stays incremental (nextCycle 0, the hour's bound)", async () => {
    const w = await world();
    await w.db.delete(messages).where(eq(messages.id, w.reply));
    await w.change(w.reply, "delete");
    const next = await screenerAutoApplyPass(w.db, { accountId: w.accountId, walk: w.walk });
    expect({ mode: next.mode, nextCycle: next.moved }).toEqual({ mode: "incremental", nextCycle: 0 });
    // The hourly full walk is where the purge is read: the exclusion did lift.
    expect((await screenerAutoApplyPass(w.db, { accountId: w.accountId })).moved).toBe(1);
  });

  it("a change to somebody else's message re-admits nothing (the control)", async () => {
    const w = await world();
    await w.change(w.held, "update");
    const [other] = await w.db.insert(messages).values({
      accountId: w.accountId, mailboxId: (await w.db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.accountId, w.accountId)))[0]!.id,
      bodyHash: "o", dedupKey: `ow:${randomUUID()}`, subject: "Hi", fromAddress: "friend@else.test", nativeLocator: { folder: "INBOX", ref: "1:3" },
    }).returning();
    await w.change(other!.id, "update");
    const next = await screenerAutoApplyPass(w.db, { accountId: w.accountId, walk: w.walk });
    expect(next.mode).toBe("incremental");
  });
});
