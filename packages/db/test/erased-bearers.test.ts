import { randomUUID, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, refreshTokens, sessions, users, type Tx } from "@trafficflow/db";
import { erasedBearers, erasedBearerAccount, pruneErasedBearers, recordErasedBearers } from "@trafficflow/db/cloud";
import { ERASED_REFRESH_KEEP_DAYS } from "../src/erased-bearers.js";

/**
 * THE ERASED ACCOUNT'S TOKEN HASHES (cloud 0043): what the erasure keeps, what the session door
 * reads, and what the worker prunes. Live access tokens are kept to their own expiry; a family's
 * unspent refresh tail (live or already expired) and its newest consumed one are kept a further
 * `ERASED_REFRESH_KEEP_DAYS`; older consumed, revoked, killed and expired access ones are not.
 * The read requires the account's own erasure stamp, and a row past its expiry answers nothing and
 * is pruned. Watched red: the stamp dropped from the read, the newest-per-family order reversed.
 */
const DAY = 24 * 60 * 60 * 1000;
const KEEP_MS = ERASED_REFRESH_KEEP_DAYS * DAY;

const NOW = new Date("2026-09-24T12:00:00.000Z");
const LATER = new Date(NOW.getTime() + 3_600_000);
const EARLIER = new Date(NOW.getTime() - 3_600_000);
const hash = (t: string): string => createHash("sha256").update(t).digest("hex");

async function seeded() {
  const db = await makeTestDb();
  const tx = db as unknown as Tx;
  const [acct] = await db.insert(accounts).values({ name: "T" }).returning();
  const accountId = acct!.id;
  const [user] = await db.insert(users).values({
    accountId, email: `u+${accountId}@example.test`, displayName: "U",
  }).returning();
  const userId = user!.id;
  const session = async (token: string, o: { revokedAt?: Date; accessExpiresAt?: Date } = {}) => {
    const [s] = await db.insert(sessions).values({
      accountId, userId, familyId: randomUUID(), accessTokenHash: hash(token),
      accessExpiresAt: o.accessExpiresAt ?? LATER, refreshExpiresAt: LATER,
      revokedAt: o.revokedAt ?? null,
    }).returning();
    return s!.id;
  };
  const refresh = async (
    sessionId: string, token: string,
    o: { revokedAt?: Date; consumedAt?: Date; expiresAt?: Date; familyId?: string } = {},
  ) => {
    await db.insert(refreshTokens).values({
      accountId, userId, sessionId, familyId: o.familyId ?? randomUUID(), tokenHash: hash(token),
      expiresAt: o.expiresAt ?? LATER, revokedAt: o.revokedAt ?? null, consumedAt: o.consumedAt ?? null,
    });
  };
  return { db, tx, accountId, session, refresh };
}

describe("an erased account's token hashes", () => {
  it("keeps the live and expired refresh tails and each family's newest consumed one, and nothing else", async () => {
    const { db, tx, accountId, session, refresh } = await seeded();
    const live = await session("live-access");
    const family = randomUUID();
    await refresh(live, "live-refresh", { familyId: family });
    await refresh(live, "older-consumed", { familyId: family, consumedAt: new Date(EARLIER.getTime() - 60_000) });
    await refresh(live, "newest-consumed", { familyId: family, consumedAt: EARLIER });
    await refresh(live, "revoked-refresh", { revokedAt: EARLIER });
    await refresh(live, "expired-refresh", { expiresAt: EARLIER });
    await refresh(live, "killed-refresh", { consumedAt: EARLIER, expiresAt: EARLIER });
    await session("revoked-access", { revokedAt: EARLIER });
    await session("expired-access", { accessExpiresAt: EARLIER });

    // A tail that expired longer ago than the keep window authenticates nothing and is not kept.
    await refresh(live, "long-expired-refresh", { expiresAt: new Date(NOW.getTime() - KEEP_MS - DAY) });

    expect(await recordErasedBearers(tx, accountId, NOW)).toBe(4);
    const kept = await db.select().from(erasedBearers).where(eq(erasedBearers.accountId, accountId));
    expect(kept.map((r) => r.tokenHash).sort())
      .toEqual([hash("live-access"), hash("live-refresh"), hash("newest-consumed"), hash("expired-refresh")].sort());
    // Idempotent: a retried erasure keeps the same four rows.
    expect(await recordErasedBearers(tx, accountId, NOW)).toBe(0);
  });

  it("answers only for an account whose erasure stamp is set, and only before the expiry", async () => {
    const { db, tx, accountId, session } = await seeded();
    await session("t");
    await recordErasedBearers(tx, accountId, NOW);
    expect(await erasedBearerAccount(tx, hash("t"), NOW), "a row without the stamp answered").toBeNull();
    await db.update(accounts).set({ erasedAt: NOW }).where(eq(accounts.id, accountId));
    // The account the token belonged to, which is what the 410 names.
    expect(await erasedBearerAccount(tx, hash("t"), NOW)).toBe(accountId);
    expect(await erasedBearerAccount(tx, hash("someone-else"), NOW)).toBeNull();
    expect(await erasedBearerAccount(tx, hash("t"), new Date(LATER.getTime() + 1)), "an expired row answered").toBeNull();
  });

  it("prunes exactly the rows past their expiry", async () => {
    const { db, tx, accountId, session } = await seeded();
    await session("soon");
    await session("later", { accessExpiresAt: new Date(LATER.getTime() + 3_600_000) });
    await recordErasedBearers(tx, accountId, NOW);
    expect(await pruneErasedBearers(tx, new Date(LATER.getTime() + 1))).toBe(1);
    const left = await db.select().from(erasedBearers).where(eq(erasedBearers.accountId, accountId));
    expect(left.map((r) => r.tokenHash)).toEqual([hash("later")]);
  });

  it("names the account for a REFRESH token past its own expiry, up to the keep window", async () => {
    // ERASED-ACCOUNT-DEVICE-PAST-REFRESH-WINDOW-KEEPS-COPY: the hash expired with the token, so a
    // device silent past its window heard a plain refusal and kept its copy.
    const { db, tx, accountId, session, refresh } = await seeded();
    const s = await session("a");
    await refresh(s, "tail");
    await refresh(s, "gone-quiet", { expiresAt: EARLIER });
    await recordErasedBearers(tx, accountId, NOW);
    await db.update(accounts).set({ erasedAt: NOW }).where(eq(accounts.id, accountId));

    const monthPast = new Date(LATER.getTime() + 30 * DAY);
    expect(await erasedBearerAccount(tx, hash("tail"), monthPast), "a month past its window").toBe(accountId);
    expect(await erasedBearerAccount(tx, hash("gone-quiet"), NOW), "a tail already expired at the erasure").toBe(accountId);
    expect(await erasedBearerAccount(tx, hash("a"), monthPast), "an access hash keeps its own expiry").toBeNull();
    expect(await erasedBearerAccount(tx, hash("tail"), new Date(LATER.getTime() + KEEP_MS + 1))).toBeNull();

    // The prune keeps each row to the same horizon, and takes it after.
    await pruneErasedBearers(tx, monthPast);
    expect(await erasedBearerAccount(tx, hash("tail"), monthPast)).toBe(accountId);
    await pruneErasedBearers(tx, new Date(LATER.getTime() + KEEP_MS + 1));
    const left = await db.select().from(erasedBearers).where(eq(erasedBearers.accountId, accountId));
    expect(left).toEqual([]);
  });
});
