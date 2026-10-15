import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "../src/testing.js";
import { mailboxes, drafts, outboundSends } from "../src/index.js";

// Proves migration 0013 (Phase 3c) persists `outbound_sends` — the gated-send state
// machine — with its `pending` default, the draft FK, and (crucially) the
// UNIQUE(account_id, idempotency_key) reservation gate that makes a same-key double
// reservation impossible. Core Postgres only (RC8); replays into PGlite.
describe("migration 0013 round-trip (outbound_sends)", () => {
  const acct = "00000000-0000-0000-0000-0000000013a0";

  async function seedDraft(db: Awaited<ReturnType<typeof makeTestDb>>): Promise<string> {
    const [mb] = await db.insert(mailboxes).values({ accountId: acct, provider: "imap", address: "g@x-ch.example" }).returning();
    const [d] = await db.insert(drafts).values({ accountId: acct, mailboxId: mb!.id, subject: "Re: hi" }).returning();
    return d!.id;
  }

  it("persists a pending reservation with defaults", async () => {
    const db = await makeTestDb();
    const draftId = await seedDraft(db);
    const [row] = await db.insert(outboundSends).values({
      accountId: acct, idempotencyKey: "key-1", draftId, mintedMessageId: "<abc@x-ch.example>",
    }).returning();
    expect(row!.status).toBe("pending");          // default
    expect(row!.providerMessageId).toBeNull();
    expect(row!.sentAt).toBeNull();
    expect(row!.createdAt).toBeInstanceOf(Date);
  });

  it("UNIQUE(account_id, idempotency_key) rejects a duplicate reservation", async () => {
    const db = await makeTestDb();
    const draftId = await seedDraft(db);
    await db.insert(outboundSends).values({
      accountId: acct, idempotencyKey: "dup", draftId, mintedMessageId: "<one@x-ch.example>",
    });
    // Same (account, key) → the reservation gate rejects it.
    await expect(
      db.insert(outboundSends).values({
        accountId: acct, idempotencyKey: "dup", draftId, mintedMessageId: "<two@x-ch.example>",
      }),
    ).rejects.toThrow();

    // A DIFFERENT account may reuse the SAME key (the gate is per-account).
    const other = randomUUID();
    const [mb] = await db.insert(mailboxes).values({ accountId: other, provider: "imap", address: "o@x-ch.example" }).returning();
    const [d2] = await db.insert(drafts).values({ accountId: other, mailboxId: mb!.id }).returning();
    await expect(
      db.insert(outboundSends).values({
        accountId: other, idempotencyKey: "dup", draftId: d2!.id, mintedMessageId: "<three@x-ch.example>",
      }),
    ).resolves.toBeDefined();
  });

  it("ON CONFLICT DO NOTHING makes the reservation idempotent (0 rows on the 2nd insert)", async () => {
    const db = await makeTestDb();
    const draftId = await seedDraft(db);
    const first = await db.insert(outboundSends).values({
      accountId: acct, idempotencyKey: "reserve", draftId, mintedMessageId: "<r1@x-ch.example>",
    }).onConflictDoNothing({ target: [outboundSends.accountId, outboundSends.idempotencyKey] }).returning({ id: outboundSends.id });
    const second = await db.insert(outboundSends).values({
      accountId: acct, idempotencyKey: "reserve", draftId, mintedMessageId: "<r2@x-ch.example>",
    }).onConflictDoNothing({ target: [outboundSends.accountId, outboundSends.idempotencyKey] }).returning({ id: outboundSends.id });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);              // the 2nd reservation is a no-op
  });

  it("the draft_id FK rejects an orphan draft", async () => {
    const db = await makeTestDb();
    await expect(
      db.insert(outboundSends).values({
        accountId: acct, idempotencyKey: "k", draftId: "00000000-0000-0000-0000-0000000000ff",
        mintedMessageId: "<x@x-ch.example>",
      }),
    ).rejects.toThrow();
  });
});
