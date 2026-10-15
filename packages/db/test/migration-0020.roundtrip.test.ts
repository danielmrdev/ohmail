import { describe, it, expect } from "vitest";
import { makeTestDb } from "../src/testing.js";
import { invites, waitlist } from "../src/cloud.js";

/**
 * Migration 0020 (Stage-2) — the funnel's two tables, and the four constraints the
 * product's behaviour rests on. Core Postgres only (RC8), so it replays into PGlite.
 *
 * Each assertion below corresponds to a decision the migration's header argues for. A
 * schema comment is a claim; this is the check.
 */
describe("migration 0020 round-trip (waitlist + invites)", () => {
  const NOW = new Date("2026-07-31T12:00:00.000Z");

  it("waitlist: one row per address, defaults applied, UPSERT-shaped", async () => {
    const db = await makeTestDb();
    const [row] = await db.insert(waitlist).values({ email: "a@example.com" }).returning();
    expect(row!.tier).toBe("undecided");
    expect(row!.source).toBe("landing");
    expect(row!.invitedAt).toBeNull();
    expect(row!.registeredAt).toBeNull();

    // The UNIQUE is what makes "three submissions are one entry" enforceable rather than
    // hoped for — `WaitlistService.join` relies on it for `onConflictDoUpdate`.
    await expect(db.insert(waitlist).values({ email: "a@example.com" })).rejects.toThrow();

    const [updated] = await db.insert(waitlist)
      .values({ email: "a@example.com", tier: "pro" })
      .onConflictDoUpdate({ target: waitlist.email, set: { tier: "pro", updatedAt: NOW } })
      .returning();
    expect(updated!.tier).toBe("pro");
    // `created_at` is never touched by the upsert: when they first asked is a fact.
    expect(updated!.createdAt.getTime()).toBe(row!.createdAt.getTime());
  });

  it("waitlist: the tier CHECK is exhaustive over the landing's five options", async () => {
    const db = await makeTestDb();
    for (const tier of ["desktop", "solo", "plus", "pro", "undecided"]) {
      await expect(db.insert(waitlist).values({ email: `${tier}@example.com`, tier }))
        .resolves.toBeDefined();
    }
    // A tier this column cannot hold is a tier the mail template's exhaustive
    // `Record<WaitlistTier, string>` lookup cannot fail on.
    await expect(db.insert(waitlist).values({ email: "x@example.com", tier: "enterprise" }))
      .rejects.toThrow();
  });

  it("invites: the code hash is UNIQUE — the single-use UPDATE can match at most one row", async () => {
    const db = await makeTestDb();
    const base = { email: "a@example.com", expiresAt: new Date(NOW.getTime() + 86_400_000) };
    const [row] = await db.insert(invites).values({ codeHash: "h1", ...base }).returning();
    expect(row!.issuedBy).toBe("operator");
    expect(row!.consumedAt).toBeNull();
    expect(row!.consumedByUserId).toBeNull();

    // Without this, `UPDATE … WHERE code_hash = $1 AND consumed_at IS NULL RETURNING id`
    // could match two rows and hand two callers a "win".
    await expect(db.insert(invites).values({ codeHash: "h1", ...base })).rejects.toThrow();
  });

  it("invites: `expires_at` has NO default — a never-expiring invite cannot be created by omission", async () => {
    const db = await makeTestDb();
    await expect(
      // @ts-expect-error — the column is NOT NULL with no default, on purpose.
      db.insert(invites).values({ codeHash: "h2", email: "a@example.com" }),
    ).rejects.toThrow();
  });

  it("invites: `email` is NOT NULL — an unbound invite is not representable", async () => {
    // THE anti-enumeration property, at the schema level rather than in a caller. An
    // unbound code would let its holder put any address through `POST /auth/register` and
    // read the 201-vs-409 answer as an account-existence oracle.
    const db = await makeTestDb();
    await expect(
      // @ts-expect-error — deliberately omitting the binding.
      db.insert(invites).values({ codeHash: "h3", expiresAt: new Date(NOW.getTime() + 1000) }),
    ).rejects.toThrow();
  });

  it("invites: `consumed_by_user_id` carries NO foreign key — Art. 17 erasure stays possible", async () => {
    const db = await makeTestDb();
    // An account that has been erased must not leave an invite row that cannot be written
    // or a delete that cannot complete. The id is retained as a bare reference.
    const [row] = await db.insert(invites).values({
      codeHash: "h4", email: "a@example.com",
      expiresAt: new Date(NOW.getTime() + 86_400_000),
      consumedAt: NOW, consumedByUserId: crypto.randomUUID(),
    }).returning();
    expect(row!.consumedByUserId).toBeTruthy();
  });
});
