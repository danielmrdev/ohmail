import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { AccountErasedError, accounts, mailboxes, type AccessVerdict } from "@trafficflow/db";
import {
  accountLifecycleNotices, makeOwnedDb, plantReopenedCatchUp, type OwnedDb,
} from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import type { ServiceContext } from "@trafficflow/services";
import { reopenedCatchUp } from "../src/account-reopen.js";
import type { ApiDeps } from "../src/deps.js";

/**
 * THE CATCH-UP THE WORKER PLANTS AND THE DOOR TELLS, on real Postgres: the fence's share lock against
 * the sweep's, the upsert's guarded update under two transactions, and the insert fed by a select —
 * PGlite answers none of them. The worker's own half is `apps/worker/test/parked-account.test.ts`.
 * Every row is this file's own, removed after.
 */

const AVAILABLE = await realPgAvailable();
const PARKED = new Date("2026-09-27T21:40:00.000Z");
const BLOCKED = new Date("2026-09-27T21:42:30.000Z");
const NOW = new Date("2026-09-28T05:49:41.000Z");
const OPEN_AGAIN: AccessVerdict = {
  ok: true, limits: { mailboxes: 2, storageBytes: null, canAddMailbox: true, aiEnabled: true },
  lifecycle: {
    state: "active", closedReason: null, trialEndsAt: null, graceUntil: null,
    closedAt: null, erasureAt: null, erasedAt: null, formerlyPaid: true,
  },
};

describe.skipIf(!AVAILABLE)("the catch-up across the worker's plant and the door's tell", () => {
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

  /** An account closed and reopened: an organizer row carries park and block, a reader row the block. */
  async function world(kind: "organizer" | "reader", handle: OwnedDb["db"] = db) {
    const [acct] = await db.insert(accounts).values({ name: `plant-${randomUUID().slice(0, 8)}` }).returning();
    const accountId = acct!.id;
    seeded.push(accountId);
    const [row] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `plant-${randomUUID().slice(0, 8)}@example.invalid`,
      organizerRole: "reader", organizeConsentedAt: new Date("2026-08-01T00:00:00.000Z"),
      syncBlockedReason: "account_closed", syncBlockedSince: BLOCKED,
      ...(kind === "organizer" ? { organizerParkedAt: PARKED, organizerReleasedAt: PARKED } : {}),
    }).returning({ id: mailboxes.id });
    const deps = { db: handle, now: () => NOW } as unknown as ApiDeps;
    const ctx = { accountId, db: handle, now: () => NOW } as unknown as ServiceContext;
    return { accountId, mailboxId: row!.id, deps, ctx };
  }
  const reopened = async (accountId: string) => (await db.select().from(accountLifecycleNotices)
    .where(and(eq(accountLifecycleNotices.accountId, accountId), eq(accountLifecycleNotices.kind, "reopened"))))
    .map((n) => ({ anchor: n.anchor.toISOString(), told: n.sentAt.getTime() !== n.anchor.getTime() }));
  /** The pass's two spends, as the worker makes them: the promotion's, then the pass end's. */
  const promote = (mailboxId: string) =>
    db.update(mailboxes).set({ organizerParkedAt: null }).where(eq(mailboxes.id, mailboxId));
  const clearBlock = (mailboxId: string) =>
    db.update(mailboxes).set({ syncBlockedReason: null, syncBlockedSince: null }).where(eq(mailboxes.id, mailboxId));

  it("worker first: the plant is untold at the park, the first read tells it, the second says nothing", async () => {
    const w = await world("organizer");
    expect((await plantReopenedCatchUp(db, w.accountId))?.toISOString()).toBe(PARKED.toISOString());
    await promote(w.mailboxId);
    await clearBlock(w.mailboxId);
    expect(await reopened(w.accountId)).toEqual([{ anchor: PARKED.toISOString(), told: false }]);
    expect(await reopenedCatchUp(w.deps, w.ctx)).toEqual({ since: PARKED.toISOString() });
    expect(await reopenedCatchUp(w.deps, w.ctx), "never twice").toBeNull();
    expect(await reopened(w.accountId)).toEqual([{ anchor: PARKED.toISOString(), told: true }]);
  });

  it("door first: the door tells a fresh row, the plant after it does nothing", async () => {
    const w = await world("organizer");
    expect(await reopenedCatchUp(w.deps, w.ctx)).toEqual({ since: PARKED.toISOString() });
    expect(await plantReopenedCatchUp(db, w.accountId), "DO NOTHING").toBeNull();
    expect(await reopened(w.accountId)).toEqual([{ anchor: PARKED.toISOString(), told: true }]);
  });

  it("two reads at once over one planted row: exactly one tells it", async () => {
    const w = await world("reader");
    await plantReopenedCatchUp(db, w.accountId);
    await clearBlock(w.mailboxId);
    // Both reads held at the fence until each has read the row as untold, then let go together.
    let both: Promise<Array<{ since: string } | null | "fault">> | null = null;
    await db.transaction(async (gate) => {
      await gate.execute(sql`select 1 from accounts where id = ${w.accountId} for update`);
      both = Promise.all([reopenedCatchUp(w.deps, w.ctx), reopenedCatchUp(w.deps, w.ctx)]);
      await new Promise((r) => setTimeout(r, 300));
    });
    const answers = await both!;
    expect(answers.filter((a) => a !== null && a !== "fault")).toEqual([{ since: BLOCKED.toISOString() }]);
    expect(answers.filter((a) => a === null)).toHaveLength(1);
  });

  it("an older closed notice beside a newer untold row: the untold anchor is told", async () => {
    const w = await world("reader");
    await db.insert(accountLifecycleNotices).values({
      accountId: w.accountId, kind: "closed", anchor: new Date("2026-08-25T18:55:08.000Z"),
    });
    await plantReopenedCatchUp(db, w.accountId);
    await clearBlock(w.mailboxId);
    expect(await reopenedCatchUp(w.deps, w.ctx)).toEqual({ since: BLOCKED.toISOString() });
  });

  it("a read mid-pass (park spent, block standing) tells the planted row and mints none", async () => {
    const w = await world("organizer");
    await plantReopenedCatchUp(db, w.accountId);
    await promote(w.mailboxId);
    expect(await reopenedCatchUp(w.deps, w.ctx)).toEqual({ since: PARKED.toISOString() });
    await clearBlock(w.mailboxId);
    expect(await reopenedCatchUp(w.deps, w.ctx)).toBeNull();
    expect(await reopened(w.accountId), "one row for one closure").toEqual([{ anchor: PARKED.toISOString(), told: true }]);
  });

  it("a told row whose database clock trailed its anchor is never told again", async () => {
    const w = await world("organizer");
    // Told by a door that read seconds after a worker whose clock runs ahead of the database's.
    await db.insert(accountLifecycleNotices).values({
      accountId: w.accountId, kind: "reopened", anchor: PARKED, sentAt: new Date(PARKED.getTime() - 30_000),
    });
    expect(await reopenedCatchUp(w.deps, w.ctx)).toBeNull();
    await promote(w.mailboxId);
    await clearBlock(w.mailboxId);
    expect(await reopenedCatchUp(w.deps, w.ctx)).toBeNull();
  });

  it("each account's plant anchors on its own rows alone", async () => {
    const a = await world("organizer");
    const b = await world("reader");
    await db.update(mailboxes).set({ syncBlockedSince: NOW }).where(eq(mailboxes.id, b.mailboxId));
    expect((await plantReopenedCatchUp(db, a.accountId))?.toISOString()).toBe(PARKED.toISOString());
    expect((await plantReopenedCatchUp(db, b.accountId))?.toISOString()).toBe(NOW.toISOString());
    expect(await reopened(a.accountId)).toEqual([{ anchor: PARKED.toISOString(), told: false }]);
    expect(await reopened(b.accountId)).toEqual([{ anchor: NOW.toISOString(), told: false }]);
  });

  it("a plant racing the erasure: the fence waits for the sweep, refuses, and no row is left", async () => {
    const w = await world("organizer");
    let plant: Promise<string> | null = null;
    await db.transaction(async (tx) => {
      // The sweep's own order: the account row locked, then stamped.
      await tx.execute(sql`select 1 from accounts where id = ${w.accountId} for update`);
      plant = plantReopenedCatchUp(db, w.accountId).then(
        () => "planted", (err: unknown) => (err instanceof AccountErasedError ? "erased" : "other"));
      await new Promise((r) => setTimeout(r, 300));
      await tx.update(accounts).set({ erasedAt: NOW }).where(eq(accounts.id, w.accountId));
    });
    expect(await plant!).toBe("erased");
    expect(await reopened(w.accountId)).toEqual([]);
  });

  it("a tell that faults holds the door's resume back: the block and the park stand", async () => {
    const { accountRoutes } = await import("../src/routes/account.js");
    const route = accountRoutes.find((r) => r.method === "GET" && r.pattern === "/account/access")!;
    const call = async (handle: OwnedDb["db"], accountId: string) => {
      const deps = {
        db: handle, now: () => NOW,
        session: { accountId, userId: null, sessionId: null },
        services: { entitlementsPort: {
          access: async () => OPEN_AGAIN, accessOrFault: async () => OPEN_AGAIN,
          spend: async () => ({ verdict: "fault" }), release: async () => "settled",
          manageLink: async () => null, releaseAccount: async () => "none",
        } },
      } as unknown as ApiDeps;
      return (await route.handler(new Request("http://api.test/account/access"), deps, {})).json();
    };
    // CONTROL: a healthy tell answers the catch-up and the resume clears the block.
    const healthy = await world("organizer");
    const ok = await call(db, healthy.accountId) as { caughtUp?: unknown };
    expect(ok.caughtUp).toEqual({ since: PARKED.toISOString() });
    const cleared = (await db.select().from(mailboxes).where(eq(mailboxes.id, healthy.mailboxId)))[0]!;
    expect(cleared.syncBlockedReason).toBeNull();

    // The tell's insert refused inside the door's own transaction, the handle it is given included.
    const refusing = faultyNoticesWrites(db);
    const w = await world("organizer");
    const body = await call(refusing.db, w.accountId) as { access?: unknown; caughtUp?: unknown };
    expect(body.access).toBe("open");
    expect(body.caughtUp).toBeUndefined();
    expect(refusing.refused(), "the fault is the tell's").toBeGreaterThan(0);
    expect(refusing.mailboxWrites(), "no resume statement ran in that request").toBe(0);
    const row = (await db.select().from(mailboxes).where(eq(mailboxes.id, w.mailboxId)))[0]!;
    expect([row.syncBlockedReason, row.organizerParkedAt?.toISOString(), row.takeoverAuthorizedAt])
      .toEqual(["account_closed", PARKED.toISOString(), null]);
  });
});

/**
 * A handle whose every transaction refuses a write to the notices table and counts its writes to
 * `mailboxes`. It wraps the TRANSACTION the handle gives its callback too, which is where the door
 * writes: a proxy of the outer handle alone would never see the write.
 */
function faultyNoticesWrites(db: OwnedDb["db"]) {
  let refused = 0;
  let mailboxWrites = 0;
  const wrapTx = (tx: object): object => new Proxy(tx, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop === "insert") {
        return (table: unknown) => {
          if (table === accountLifecycleNotices) { refused += 1; throw new Error("the notices table refused a write"); }
          return (value as (t: unknown) => unknown).call(target, table);
        };
      }
      if (prop === "update") {
        return (table: unknown) => {
          if (table === mailboxes) mailboxWrites += 1;
          return (value as (t: unknown) => unknown).call(target, table);
        };
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  const handle = new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop === "transaction") {
        return (fn: (tx: object) => Promise<unknown>, ...rest: unknown[]) =>
          (value as (...a: unknown[]) => Promise<unknown>).call(target, (tx: object) => fn(wrapTx(tx)), ...rest);
      }
      if (prop === "update") {
        return (table: unknown) => {
          if (table === mailboxes) mailboxWrites += 1;
          return (value as (t: unknown) => unknown).call(target, table);
        };
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db: handle as OwnedDb["db"], refused: () => refused, mailboxWrites: () => mailboxWrites };
}
