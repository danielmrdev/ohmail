import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accountSettings, accounts, folderState, mailboxes, messageBodies, messages, threads, type Tx } from "@trafficflow/db";
import { screenerAutoApplyPass } from "../src/screener-auto.js";

/**
 * A STRANGER THE PERSON ANSWERED FROM A MAILBOX THEY LATER REMOVED STAYS AT THE GATE. The
 * we-answered shield keeps every address the person has written from, so a reply sent from the
 * removed mailbox still keeps that sender's held mail where it is. The control: the same held
 * message with no reply in its thread is filed.
 */
const SCREENER = "ohmail/Screener";
const STRONG_BULK = { "list-unsubscribe": ["<https://x.test/u>"], "list-id": ["<news.shop.test>"] };

async function world(replied: boolean) {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "answered-removed" });
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "main@shop-reader.test", organizerRole: "organizer" }).returning();
  const [old] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: "old@shop-reader.test", status: "disabled", disabledReason: null,
  }).returning();
  await db.insert(accountSettings).values({ accountId, screenerAutoApplyAt: new Date() });
  const [t] = await db.insert(threads).values({ accountId, subject: "News" }).returning();
  const [m] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `ar:${randomUUID()}`, subject: "Weekly news",
    fromAddress: "news@shop.test", threadId: t!.id, nativeLocator: { folder: SCREENER, ref: "1:1" },
  }).returning();
  await db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: STRONG_BULK });
  await db.insert(folderState).values({ messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false });
  if (replied) {
    await db.insert(messages).values({
      accountId, mailboxId: old!.id, bodyHash: "s", dedupKey: `ar:${randomUUID()}`, subject: "Re: Weekly news",
      fromAddress: "old@shop-reader.test", toAddresses: [{ name: null, address: "news@shop.test" }], ccAddresses: [],
      threadId: t!.id, nativeLocator: { folder: "Sent", ref: "1:2" },
    } as never);
  }
  const pass = () => screenerAutoApplyPass(db, { accountId });
  const desired = async () =>
    (await db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, m!.id)))[0]!.d;
  return { pass, desired };
}

describe("the auto-apply pass and a reply from a since-removed mailbox", () => {
  it("keeps the answered sender's held mail at the gate", async () => {
    const w = await world(true);
    const out = await w.pass();
    expect({ moved: out.moved, desired: await w.desired() }).toEqual({ moved: 0, desired: SCREENER });
  });

  it("CONTROL: with no reply in the thread the same message is filed", async () => {
    const w = await world(false);
    const out = await w.pass();
    expect({ moved: out.moved, desired: await w.desired() }).toEqual({ moved: 1, desired: "ohmail/News" });
  });
});
