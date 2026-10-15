import { describe, it, expect } from "vitest";
import { makeTestDb } from "../src/testing.js";
import { accounts, users, sessions } from "../src/index.js";

// Proves migration 0017 (Stage-2) adds `sessions.scope` with the two
// properties the enrollment gate depends on: 'full' is the DEFAULT — so every
// session written by code that predates the column keeps exactly the privileges it
// had — and the CHECK makes ('full','enrollment') exhaustive, so no third value can
// ever be persisted for `resolveSession` to mis-classify. Core Postgres only (RC8);
// replays into PGlite.
describe("migration 0017 round-trip (sessions.scope)", () => {
  async function seedUser(db: Awaited<ReturnType<typeof makeTestDb>>) {
    const [acct] = await db.insert(accounts).values({ name: "Scope" }).returning();
    const [user] = await db.insert(users)
      .values({ accountId: acct!.id, email: "scope@x.example", displayName: "S" }).returning();
    return { accountId: acct!.id, userId: user!.id };
  }

  const window = (now: Date) => ({
    accessExpiresAt: new Date(now.getTime() + 60_000),
    refreshExpiresAt: new Date(now.getTime() + 60_000),
  });

  it("defaults to 'full' and round-trips 'enrollment'", async () => {
    const db = await makeTestDb();
    const { accountId, userId } = await seedUser(db);
    const now = new Date("2026-07-30T00:00:00.000Z");

    const [full] = await db.insert(sessions).values({
      accountId, userId, familyId: crypto.randomUUID(), accessTokenHash: "h1", ...window(now),
    }).returning();
    expect(full!.scope).toBe("full");            // pre-0017 writers keep full privilege

    const [enrollment] = await db.insert(sessions).values({
      accountId, userId, familyId: crypto.randomUUID(), accessTokenHash: "h2",
      scope: "enrollment", lastTwofaAt: null, ...window(now),
    }).returning();
    expect(enrollment!.scope).toBe("enrollment");
    expect(enrollment!.lastTwofaAt).toBeNull(); // never satisfies step-up
    expect(enrollment!.deviceId).toBeNull();    // no device row for an enrollment session
  });

  it("the CHECK constraint rejects any other scope", async () => {
    const db = await makeTestDb();
    const { accountId, userId } = await seedUser(db);
    const now = new Date("2026-07-30T00:00:00.000Z");
    await expect(
      db.insert(sessions).values({
        accountId, userId, familyId: crypto.randomUUID(), accessTokenHash: "h3",
        scope: "admin", ...window(now),
      }),
    ).rejects.toThrow();
  });
});
