import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { accounts, mailboxes } from "@trafficflow/db";
import { accountLifecycleNotices, makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import type { ServiceContext } from "@trafficflow/services";
import { reopenedCatchUp, resumeAfterReopen } from "../src/account-reopen.js";
import type { ApiDeps } from "../src/deps.js";

/**
 * THE REOPENING DOOR'S TRANSACTION ON REAL POSTGRES (mail 0135). The block clear and the `join`
 * commit together behind the account's erasure fence — a real `BEGIN` with a real row lock, which
 * PGlite answers by construction. Every row is scoped to this file's own accounts, and removed after.
 */

const AVAILABLE = await realPgAvailable();
const PARKED = new Date("2026-09-23T02:15:07.000Z");
const NOW = new Date("2026-09-28T05:49:41.000Z");

describe.skipIf(!AVAILABLE)("the reopening door on real Postgres", () => {
  let owned: OwnedDb;
  let db: OwnedDb["db"];
  const seeded: string[] = [];

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
    db = owned.db;
  }, 180_000);

  afterAll(async () => {
    if (!AVAILABLE) return;
    if (seeded.length > 0) {
      await db.delete(accountLifecycleNotices).where(inArray(accountLifecycleNotices.accountId, seeded));
      await db.delete(mailboxes).where(inArray(mailboxes.accountId, seeded));
      await db.delete(accounts).where(inArray(accounts.id, seeded));
    }
    await owned?.close().catch(() => {});
  });

  async function world() {
    const [acct] = await db.insert(accounts).values({ name: `reopen-${randomUUID().slice(0, 8)}` }).returning();
    const accountId = acct!.id;
    seeded.push(accountId);
    const row = async (extra: Partial<typeof mailboxes.$inferInsert>) => (await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `reopen-${randomUUID().slice(0, 8)}@example.invalid`,
      organizerRole: "reader", organizeConsentedAt: new Date("2026-08-01T00:00:00.000Z"),
      syncBlockedReason: "account_closed", syncBlockedSince: PARKED, ...extra,
    }).returning({ id: mailboxes.id }))[0]!.id;
    const deps = { db, now: () => NOW } as unknown as ApiDeps;
    const ctx = { accountId, db, now: () => NOW } as unknown as ServiceContext;
    return {
      accountId, deps, ctx,
      walled: await row({ organizerParkedAt: PARKED, organizerReleasedAt: PARKED }),
      stopped: await row({ organizerReleasedAt: PARKED }),
    };
  }
  const rowOf = async (id: string) => (await db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]!;

  it("clears account_closed and stamps the wall's release as a join, in one transaction", async () => {
    const w = await world();
    await resumeAfterReopen(w.deps, w.ctx);
    const walled = await rowOf(w.walled);
    expect([walled.syncBlockedReason, walled.syncBlockedSince]).toEqual([null, null]);
    expect(walled.takeoverAuthorizedAt?.toISOString()).toBe(NOW.toISOString());
    expect(walled.takeoverIntent).toBe("join");
    expect(walled.syncRequestedAt?.toISOString()).toBe(NOW.toISOString());
    const stopped = await rowOf(w.stopped);
    expect(stopped.syncBlockedReason).toBeNull();
    expect(stopped.takeoverAuthorizedAt, "the person's stop is never asked back").toBeNull();
  });

  it("an ERASED account's fence refuses both writes, and the read still answers", async () => {
    const w = await world();
    await db.update(accounts).set({ erasedAt: NOW }).where(eq(accounts.id, w.accountId));
    await expect(resumeAfterReopen(w.deps, w.ctx)).resolves.toBeUndefined();
    const walled = await rowOf(w.walled);
    expect(walled.syncBlockedReason, "nothing is written behind the sweep").toBe("account_closed");
    expect(walled.takeoverAuthorizedAt).toBeNull();
  });

  it("the banner is anchored on the park and answered once, across the promotion", async () => {
    const w = await world();
    await db.insert(accountLifecycleNotices).values({
      accountId: w.accountId, kind: "closed", anchor: new Date("2026-08-25T18:55:08.000Z"),
    });
    expect(await reopenedCatchUp(w.deps, w.ctx)).toEqual({ since: PARKED.toISOString() });
    await db.update(mailboxes).set({ organizerParkedAt: null }).where(eq(mailboxes.accountId, w.accountId));
    expect(await reopenedCatchUp(w.deps, w.ctx), "the promotion starts no second banner").toBeNull();
  });
});
