import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  accounts, mailboxes, messages, readDrainCursor, writeDrainCursor,
  unsubscribeDrainState, unsubscribeExamined, unsubscribeRecords,
} from "@trafficflow/db";
import { makeTestDb } from "../src/testing.js";

/**
 * THE DRAIN'S TWO MEMORIES AS STATEMENTS, ON BOTH STORES (mail 0116).
 *
 * The standalone phone runs the unsubscribe pass over its own store, so the two writes it gained
 * are dialect questions: an `ON CONFLICT DO NOTHING` on a primary key, an `ON CONFLICT DO UPDATE`
 * reading `excluded`, and a timestamp column the two stores hold as different types. What the
 * drain DECIDES with them is measured in `packages/services/test/unsubscribe-drain-cursor.test.ts`
 * on the server twin; what is here is the pair of statements, run on whichever store this project
 * substituted.
 */

/* The drain's pass name (`PASS_NAME`, not `PASS`: the push gate reads a quoted value under a `PASS` key as a password). */
const PASS_NAME = "dialect-probe";

async function world(): Promise<{ db: Awaited<ReturnType<typeof makeTestDb>>; messageId: string; recordId: string; accountId: string }> {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "d" });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: "d@example.test",
  }).returning();
  const [m] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `d:${randomUUID()}`,
    subject: "s", fromAddress: "news@sender.example",
    nativeLocator: { folder: "ohmail/Screened", ref: "1:1" },
  }).returning();
  const [rec] = await db.insert(unsubscribeRecords).values({
    accountId, mailboxId: mb!.id, listKey: "list:sender.example|x",
    state: "sent", messageId: m!.id,
  }).returning();
  return { db, messageId: m!.id, recordId: rec!.id, accountId };
}

describe("the unsubscribe drain's cursor and mark, on whichever store this project substituted", () => {
  it("the cursor round-trips, and clearing it is a position of its own", async () => {
    const { db } = await world();
    const tx = db as never;
    expect(await readDrainCursor(tx, PASS_NAME), "no row is the head of the window").toBeNull();

    const at = new Date("2026-07-28T11:59:03.000Z");
    const messageId = randomUUID();
    await writeDrainCursor(tx, PASS_NAME, { at, messageId }, new Date("2026-07-28T12:00:00Z"));
    const back = await readDrainCursor(tx, PASS_NAME);
    expect(back!.messageId).toBe(messageId);
    // THE TYPE, not just the value: this store holds the instant as an integer and the server as
    // a `timestamptz`, and a cursor that comes back as a string compares as a string in the walk.
    expect(back!.at).toBeInstanceOf(Date);
    expect(back!.at.getTime()).toBe(at.getTime());

    // The UPDATE arm — one row per pass, never a second. `excluded` is what carries the new pair.
    const second = new Date(at.getTime() + 5_000);
    const other = randomUUID();
    await writeDrainCursor(tx, PASS_NAME, { at: second, messageId: other }, new Date());
    expect(await db.select().from(unsubscribeDrainState).where(eq(unsubscribeDrainState.pass, PASS_NAME)))
      .toHaveLength(1);
    expect((await readDrainCursor(tx, PASS_NAME))!.messageId).toBe(other);

    // …and a finished lap clears it back to the head, through the same statement.
    await writeDrainCursor(tx, PASS_NAME, null, new Date());
    expect(await readDrainCursor(tx, PASS_NAME)).toBeNull();
  });

  it("a second mark for one message is not a second row", async () => {
    const { db, messageId, recordId, accountId } = await world();
    const mark = () => db.insert(unsubscribeExamined)
      .values({ messageId, recordId, accountId, createdAt: new Date() })
      .onConflictDoNothing({ target: unsubscribeExamined.messageId });
    await mark();
    await mark();
    const rows = await db.select().from(unsubscribeExamined)
      .where(eq(unsubscribeExamined.messageId, messageId));
    expect(rows, "the mark is per message, and the first one is the true one").toHaveLength(1);
    expect(rows[0]!.recordId).toBe(recordId);
  });
});
