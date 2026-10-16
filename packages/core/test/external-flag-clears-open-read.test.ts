import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { mailboxes, messages } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { DrizzleRepo } from "../src/adapters/drizzle-repo.js";

/**
 * A `\Seen` CHANGE FROM ANOTHER CLIENT NEVER PLACES A ROW (owner 2026-10-07): `applyExternalFlag`
 * adopts the server's flag. Unset there (`seen = false`), the message is unread again and its open
 * read is gone with it — `open_read_at` clears in the same statement. Set there (`seen = true`), it
 * writes `last_read_at` and never `open_read_at`: a read in another app keeps the row's arrival slot.
 */
const ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
const MAILBOX = "00000000-0000-4000-8000-0000000000b1";
const STAMP = new Date("2026-10-06T09:00:00.000Z");

async function seeded(unread: boolean, stamped: boolean) {
  const db = await makeTestDb();
  await db.insert(mailboxes).values({ id: MAILBOX, accountId: ACCOUNT, provider: "imap", address: "flag@example.test", status: "connected" });
  const [m] = await db.insert(messages).values({
    accountId: ACCOUNT, mailboxId: MAILBOX, dedupKey: "mid:<f1@example.test>", messageIdHeader: "f1@example.test",
    bodyHash: "h1", subject: "s", fromAddress: "someone@example.test", nativeLocator: { folder: "INBOX", ref: "1:7" }, unread,
  }).returning();
  if (stamped) await db.update(messages).set({ openReadAt: STAMP, lastReadAt: STAMP }).where(eq(messages.id, m!.id));
  const read = async () => (await db.select().from(messages).where(eq(messages.id, m!.id)))[0]! as
    typeof messages.$inferSelect & { openReadAt?: Date | null };
  return { repo: new DrizzleRepo(db as never), read };
}

describe("applyExternalFlag and the open read", () => {
  it("seen=false elsewhere: the row is unread and its open read is cleared", async () => {
    const { repo, read } = await seeded(false, true);
    expect((await read()).openReadAt?.getTime(), "the premise: stamped").toBe(STAMP.getTime());
    const out = await repo.applyExternalFlag(MAILBOX, { folder: "INBOX", ref: "1:7" }, false);
    expect(out?.changed).toBe(true);
    const row = await read();
    expect(row.unread).toBe(true);
    expect(row.openReadAt, "an unread clears the open read").toBeNull();
  });

  it("seen=true elsewhere: the read lands, the open read is neither written nor touched", async () => {
    const fresh = await seeded(true, false);
    await fresh.repo.applyExternalFlag(MAILBOX, { folder: "INBOX", ref: "1:7" }, true);
    const row = await fresh.read();
    expect(row.unread).toBe(false);
    expect(row.lastReadAt).toBeInstanceOf(Date);
    expect("openReadAt" in row ? row.openReadAt : "absent", "a read in another app places nothing").toBeNull();
  });
});
