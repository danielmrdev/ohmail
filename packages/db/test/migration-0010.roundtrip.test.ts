import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
import {
  accounts, contacts, threads, contactNotes, threadNotes, snippets, notifyRules, awayResponders,
} from "../src/index.js";

// Proves migration 0010 (Phase 2e-1) persists contacts.name + the five reference/
// compose tables, their FKs, the account UNIQUE on away_responders, and the
// nullable columns — each is served REST-only (no change_log wiring).
describe("migration 0010 round-trip (reference & compose niceties)", () => {
  const acct = "00000000-0000-0000-0000-0000000010a0";

  async function seedContact(db: Awaited<ReturnType<typeof makeTestDb>>): Promise<string> {
    const [c] = await db.insert(contacts).values({ accountId: acct, address: "sender@example.com" }).returning();
    return c!.id;
  }
  async function seedThread(db: Awaited<ReturnType<typeof makeTestDb>>): Promise<string> {
    const [t] = await db.insert(threads).values({ accountId: acct, subject: "Hi" }).returning();
    return t!.id;
  }

  it("contacts.name is a nullable, editable column", async () => {
    const db = await makeTestDb();
    const id = await seedContact(db);
    const [before] = await db.select().from(contacts).where(eq(contacts.id, id));
    expect(before!.name).toBeNull();
    await db.update(contacts).set({ name: "Ada Lovelace" }).where(eq(contacts.id, id));
    const [after] = await db.select().from(contacts).where(eq(contacts.id, id));
    expect(after!.name).toBe("Ada Lovelace");
  });

  it("contact_notes stores a note with defaulted timestamps and the contacts FK", async () => {
    const db = await makeTestDb();
    const contactId = await seedContact(db);
    const [row] = await db.insert(contactNotes).values({ accountId: acct, contactId, body: "VIP" }).returning();
    expect(row!.body).toBe("VIP");
    expect(row!.createdAt).toBeInstanceOf(Date);
    expect(row!.updatedAt).toBeInstanceOf(Date);
    const rows = await db.select().from(contactNotes)
      .where(and(eq(contactNotes.accountId, acct), eq(contactNotes.contactId, contactId)));
    expect(rows).toHaveLength(1);
  });

  it("contact_notes FK rejects an orphan contact id", async () => {
    const db = await makeTestDb();
    await expect(
      db.insert(contactNotes).values({ accountId: acct, contactId: "00000000-0000-0000-0000-0000000000ff", body: "x" }),
    ).rejects.toThrow();
  });

  it("thread_notes stores a note with the threads FK", async () => {
    const db = await makeTestDb();
    const threadId = await seedThread(db);
    const [row] = await db.insert(threadNotes).values({ accountId: acct, threadId, body: "follow up" }).returning();
    expect(row!.threadId).toBe(threadId);
    await expect(
      db.insert(threadNotes).values({ accountId: acct, threadId: "00000000-0000-0000-0000-0000000000ff", body: "x" }),
    ).rejects.toThrow();
  });

  it("snippets stores title/body + nullable shortcut", async () => {
    const db = await makeTestDb();
    const [row] = await db.insert(snippets).values({ accountId: acct, title: "Sig", body: "Cheers, Ada" }).returning();
    expect(row!.shortcut).toBeNull();
    const [row2] = await db.insert(snippets).values({ accountId: acct, title: "Addr", body: "1 St", shortcut: "/addr" }).returning();
    expect(row2!.shortcut).toBe("/addr");
  });

  it("notify_rules defaults kind to 'sender'", async () => {
    const db = await makeTestDb();
    const [row] = await db.insert(notifyRules).values({ accountId: acct, target: "boss@example.com" }).returning();
    expect(row!.kind).toBe("sender");
    expect(row!.createdAt).toBeInstanceOf(Date);
  });

  it("away_responders enforces one row per account (UNIQUE) and defaults enabled=false", async () => {
    const db = await makeTestDb();
    const [row] = await db.insert(awayResponders).values({ accountId: acct }).returning();
    expect(row!.enabled).toBe(false);
    expect(row!.subject).toBeNull();
    await expect(db.insert(awayResponders).values({ accountId: acct })).rejects.toThrow();
  });

  it("away_responders upserts on the account UNIQUE (PUT semantics)", async () => {
    const db = await makeTestDb();
    await db.insert(accounts).values({ id: acct, name: "T" }).onConflictDoNothing();
    const now = new Date("2026-07-28T00:00:00Z");
    await db.insert(awayResponders).values({ accountId: acct, enabled: true, subject: "Away", updatedAt: now })
      .onConflictDoUpdate({ target: awayResponders.accountId, set: { enabled: true, subject: "Away", updatedAt: now } });
    await db.insert(awayResponders).values({ accountId: acct, enabled: false, subject: "Back", updatedAt: now })
      .onConflictDoUpdate({ target: awayResponders.accountId, set: { enabled: false, subject: "Back", updatedAt: now } });
    const rows = await db.select().from(awayResponders).where(eq(awayResponders.accountId, acct));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subject).toBe("Back");
  });
});
