import { describe, it, expect } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
import { mailboxes, messages, attachments } from "../src/index.js";

// Proves migration 0011 (Phase 2e-2) persists attachment METADATA — filename,
// contentType, sizeBytes, the IMAP part_id, contentId, inline — with the messages
// FK and the (account_id, message_id) index. The table holds NO blob column: bytes
// are fetched on-demand from IMAP and never stored (spec §13.2/§14).
describe("migration 0011 round-trip (attachment metadata)", () => {
  const acct = "00000000-0000-0000-0000-0000000011a0";

  async function seedMessage(db: Awaited<ReturnType<typeof makeTestDb>>): Promise<string> {
    const [mb] = await db.insert(mailboxes).values({ accountId: acct, provider: "imap", address: "g@x-ch.example" }).returning();
    const [m] = await db.insert(messages).values({
      accountId: acct, mailboxId: mb!.id, bodyHash: "h", dedupKey: `k:${crypto.randomUUID()}`,
    }).returning();
    return m!.id;
  }

  it("persists an attachment row with metadata + defaults", async () => {
    const db = await makeTestDb();
    const messageId = await seedMessage(db);
    const [row] = await db.insert(attachments).values({
      accountId: acct, messageId, filename: "invoice.pdf",
      contentType: "application/pdf", sizeBytes: 12345, partId: "2", contentId: null,
    }).returning();
    expect(row!.filename).toBe("invoice.pdf");
    expect(row!.contentType).toBe("application/pdf");
    expect(row!.sizeBytes).toBe(12345);
    expect(row!.partId).toBe("2");
    expect(row!.inline).toBe(false);            // default
    expect(row!.createdAt).toBeInstanceOf(Date);
  });

  it("has NO blob/content column (bytes are never stored)", async () => {
    const db = await makeTestDb();
    const messageId = await seedMessage(db);
    const [row] = await db.insert(attachments).values({
      accountId: acct, messageId, contentType: "text/plain", sizeBytes: 3,
    }).returning();
    // The Drizzle row exposes only metadata columns — nothing byte-bearing.
    //
    // `contentSha256` (mail 0028) is metadata and NOT a byte column, and the distinction is the
    // whole point of this test rather than a caveat to it: a digest is a fixed 64 hex characters
    // from which the file cannot be reconstructed, which is exactly what §13.2/§14 require. It is
    // listed here so that adding a column to `attachments` stays a decision somebody takes on
    // purpose — the failure this test exists to catch is a `content`/`bytes`/`blob` column arriving
    // quietly, and a list is what makes any arrival loud.
    expect(Object.keys(row!).sort()).toEqual(
      ["accountId", "contentId", "contentSha256", "contentType", "createdAt", "filename", "id",
        "inline", "messageId", "partId", "sizeBytes"],
    );
    // …and no column holds bytes, whatever it is called. `bytea` is the only type that could.
    const probe = await db.execute(sql`
      select column_name, udt_name from information_schema.columns
       where table_schema = 'public' and table_name = 'attachments'`);
    // PGlite's `execute` answers `{ rows }`; postgres-js answers an array. Handle both so this
    // assertion is not silently vacuous on one driver.
    const types = (Array.isArray(probe) ? probe : (probe as { rows: unknown[] }).rows) as
      Array<{ column_name: string; udt_name: string }>;
    expect(types.length, "the column probe found nothing — it would pass vacuously")
      .toBeGreaterThan(5);
    expect(types.filter((c) => c.udt_name === "bytea")).toEqual([]);
  });

  it("marks an inline (cid:) part", async () => {
    const db = await makeTestDb();
    const messageId = await seedMessage(db);
    const [row] = await db.insert(attachments).values({
      accountId: acct, messageId, contentType: "image/png", sizeBytes: 99,
      contentId: "logo@cid", inline: true, partId: "1.2",
    }).returning();
    expect(row!.inline).toBe(true);
    expect(row!.contentId).toBe("logo@cid");
  });

  it("FK rejects an orphan message id", async () => {
    const db = await makeTestDb();
    await expect(
      db.insert(attachments).values({
        accountId: acct, messageId: "00000000-0000-0000-0000-0000000000ff",
        contentType: "text/plain", sizeBytes: 1,
      }),
    ).rejects.toThrow();
  });

  it("scopes by (account_id, message_id)", async () => {
    const db = await makeTestDb();
    const messageId = await seedMessage(db);
    await db.insert(attachments).values([
      { accountId: acct, messageId, contentType: "text/plain", sizeBytes: 1, filename: "a.txt" },
      { accountId: acct, messageId, contentType: "text/plain", sizeBytes: 2, filename: "b.txt" },
    ]);
    const rows = await db.select().from(attachments)
      .where(and(eq(attachments.accountId, acct), eq(attachments.messageId, messageId)));
    expect(rows).toHaveLength(2);
  });
});
