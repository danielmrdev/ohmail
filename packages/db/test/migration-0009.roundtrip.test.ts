import { describe, it, expect } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
import { mailboxes, messages, trackerEvents } from "../src/index.js";

// Proves migration 0009 persists the tracker_events audit table (Phase 2d) with its
// nullable host/url, the FK to messages, and the two account-scoped indexes usable
// for the "who tried to spy on you" feed.
describe("migration 0009 round-trip (tracker_events)", () => {
  const acct = "00000000-0000-0000-0000-0000000000d9";

  async function seedMessage(db: Awaited<ReturnType<typeof makeTestDb>>): Promise<string> {
    const [mb] = await db.insert(mailboxes).values({
      accountId: acct, provider: "imap", address: "mila@lichtgrat.example",
    }).returning();
    const [m] = await db.insert(messages).values({
      accountId: acct, mailboxId: mb!.id, bodyHash: "h", dedupKey: `d:${crypto.randomUUID()}`,
      fromAddress: "spy@sender.example",
    }).returning();
    return m!.id;
  }

  it("stores a pixel event with host + url and defaults detectedAt", async () => {
    const db = await makeTestDb();
    const messageId = await seedMessage(db);
    const [row] = await db.insert(trackerEvents).values({
      accountId: acct, messageId, kind: "pixel",
      trackerHost: "analytics.example.com", url: "https://analytics.example.com/o.gif",
    }).returning();
    expect(row!.kind).toBe("pixel");
    expect(row!.trackerHost).toBe("analytics.example.com");
    expect(row!.detectedAt).toBeInstanceOf(Date);
  });

  it("allows null host/url (a beacon with no resolvable host)", async () => {
    const db = await makeTestDb();
    const messageId = await seedMessage(db);
    const [row] = await db.insert(trackerEvents).values({
      accountId: acct, messageId, kind: "remote_image",
    }).returning();
    expect(row!.trackerHost).toBeNull();
    expect(row!.url).toBeNull();
  });

  it("queries account+message scoped, newest-first (the feed's access path)", async () => {
    const db = await makeTestDb();
    const messageId = await seedMessage(db);
    await db.insert(trackerEvents).values([
      { accountId: acct, messageId, kind: "pixel", detectedAt: new Date("2026-01-01T00:00:00Z") },
      { accountId: acct, messageId, kind: "remote_image", detectedAt: new Date("2026-02-01T00:00:00Z") },
    ]);
    const rows = await db.select().from(trackerEvents)
      .where(and(eq(trackerEvents.accountId, acct), eq(trackerEvents.messageId, messageId)))
      .orderBy(desc(trackerEvents.detectedAt));
    expect(rows.map((r) => r.kind)).toEqual(["remote_image", "pixel"]);
  });

  it("the message FK rejects an orphan tracker event", async () => {
    const db = await makeTestDb();
    await expect(
      db.insert(trackerEvents).values({
        accountId: acct, messageId: "00000000-0000-0000-0000-0000000000ff", kind: "pixel",
      }),
    ).rejects.toThrow();
  });
});
