import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, changeLog, mailboxes } from "@trafficflow/db";
import { clearOrganizerStandDown, markMailboxReleased, markMailboxStoodDown } from "../src/mailboxes.js";

/**
 * EVERY ROLE FLIP RINGS THE ARRANGEMENT. Whether a surface presents a mailbox by its organizer's
 * document turns on `organizer_role`, and a surface learns of a flip only from the delta: a
 * promotion that rang nothing would leave the old organizer's rules deciding a mailbox this
 * install now organizes, on every other screen, until its next full boot.
 */

const NOW = new Date("2026-09-26T08:00:00.000Z");

async function world(role: "organizer" | "reader", extra: Record<string, unknown> = {}) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `flip-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `flip-${accountId.slice(0, 8)}@ohmail.test`, organizerRole: role, ...extra,
  }).returning();
  const rings = async (): Promise<number> => (await db.select().from(changeLog).where(and(
    eq(changeLog.accountId, accountId), eq(changeLog.entityType, "mailbox_profile"), eq(changeLog.entityId, mb!.id),
  ))).length;
  return { db, mailboxId: mb!.id, rings };
}

describe("a role flip announces the arrangement it changes", () => {
  it("a stand-down rings once", async () => {
    const w = await world("organizer");
    expect(await markMailboxStoodDown(w.db as never, w.mailboxId, "organized_elsewhere:local", { now: NOW })).toBe(true);
    expect(await w.rings()).toBe(1);
  });

  it("a release rings once", async () => {
    const w = await world("organizer", { releaseRequestedAt: new Date(NOW.getTime() - 60_000) });
    expect(await markMailboxReleased(w.db as never, w.mailboxId, { now: NOW })).toBe(true);
    expect(await w.rings()).toBe(1);
  });

  it("a promotion rings once — the entity must drain as a tombstone", async () => {
    const w = await world("reader");
    expect(await clearOrganizerStandDown(w.db as never, w.mailboxId, { now: NOW })).toBe(true);
    expect(await w.rings()).toBe(1);
  });

  it("a write that did not land rings nothing", async () => {
    // A release with no standing request is refused by its own guard, and announces nothing.
    const w = await world("organizer");
    expect(await markMailboxReleased(w.db as never, w.mailboxId, { now: NOW })).toBe(false);
    expect(await w.rings()).toBe(0);
  });
});
