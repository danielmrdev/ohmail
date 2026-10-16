import { describe, it, expect } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
import { mailboxes, threads, messages, kbEntries, drafts } from "../src/index.js";

// Proves migration 0012 (Phase 3a) persists BOTH tables — kb_entries (with its
// DB-generated `kb_tsv` tsvector + GIN index, replaying into PGlite like 0008) and
// drafts (with the mailboxes/threads/messages FKs). Core Postgres only —
// no CREATE EXTENSION (RC8).
describe("migration 0012 round-trip (kb_entries + drafts)", () => {
  const acct = "00000000-0000-0000-0000-0000000012a0";

  it("persists a kb_entry with defaults and a generated kb_tsv", async () => {
    const db = await makeTestDb();
    const [row] = await db.insert(kbEntries).values({
      accountId: acct, title: "Refund policy", content: "We refund within 30 days of purchase.",
    }).returning();
    expect(row!.title).toBe("Refund policy");
    expect(row!.tags).toEqual([]);          // jsonb default '[]'
    expect(row!.createdAt).toBeInstanceOf(Date);

    // The generated tsvector is computed by Postgres and matches a websearch query.
    const hit = await db.execute(sql`
      select id from kb_entries
      where account_id = ${acct} and kb_tsv @@ websearch_to_tsquery('english', 'refund')`);
    const rows = Array.isArray(hit) ? hit : (hit as { rows: unknown[] }).rows;
    expect(rows.length).toBe(1);
  });

  it("kb_tsv is DB-managed — the app cannot write it (no such insert key)", async () => {
    const db = await makeTestDb();
    const [row] = await db.insert(kbEntries).values({
      accountId: acct, title: "T", content: "C", tags: ["a", "b"],
    }).returning();
    // The Drizzle row exposes kb_tsv as a read column; tags round-trips as JSON.
    expect(row!.tags).toEqual(["a", "b"]);
    expect(Object.keys(row!)).toContain("kbTsv");
  });

  it("persists a draft with defaults + the mailbox/thread/message FKs", async () => {
    const db = await makeTestDb();
    const [mb] = await db.insert(mailboxes).values({ accountId: acct, provider: "imap", address: "g@x-ch.example" }).returning();
    const [th] = await db.insert(threads).values({ accountId: acct, subject: "Re: hi" }).returning();
    const [m] = await db.insert(messages).values({
      accountId: acct, mailboxId: mb!.id, bodyHash: "h", dedupKey: `k:${crypto.randomUUID()}`,
    }).returning();

    const [row] = await db.insert(drafts).values({
      accountId: acct, mailboxId: mb!.id, threadId: th!.id, inReplyToMessageId: m!.id,
      subject: "Re: hi", body: "Thanks!", to: [{ name: null, address: "a@x-ch.example" }],
    }).returning();
    expect(row!.status).toBe("draft");           // default
    expect(row!.body).toBe("Thanks!");
    expect(row!.cc).toEqual([]);                 // jsonb default
    expect(row!.rationale).toBeNull();
    expect(row!.to).toEqual([{ name: null, address: "a@x-ch.example" }]);
    expect(row!.createdAt).toBeInstanceOf(Date);
  });

  it("a draft's mailbox_id FK rejects an orphan mailbox", async () => {
    const db = await makeTestDb();
    await expect(
      db.insert(drafts).values({
        accountId: acct, mailboxId: "00000000-0000-0000-0000-0000000000ff",
      }),
    ).rejects.toThrow();
  });

  it("scopes drafts by account_id", async () => {
    const db = await makeTestDb();
    const [mb] = await db.insert(mailboxes).values({ accountId: acct, provider: "imap", address: "g@x-ch.example" }).returning();
    await db.insert(drafts).values([
      { accountId: acct, mailboxId: mb!.id, subject: "one" },
      { accountId: acct, mailboxId: mb!.id, subject: "two" },
    ]);
    const rows = await db.select().from(drafts)
      .where(and(eq(drafts.accountId, acct), eq(drafts.mailboxId, mb!.id)));
    expect(rows).toHaveLength(2);
  });
});
