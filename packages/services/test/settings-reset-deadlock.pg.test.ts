import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import { accounts, accountSettings, accountSyncState, changeLog, mailboxes, rules } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { setBlockRemoteImages, setMailboxFoldersEnabled } from "../src/consent-seed.js";
import { resetScreeningState } from "../src/consent-reset.js";
import { deleteAccount } from "../src/account-deletion-service.js";
import type { ServiceContext } from "../src/context.js";

/**
 * A SETTINGS WRITE RACING THE SCREENING RESET MUST QUEUE, NEVER DEADLOCK — real Postgres only.
 *
 * ── THE CYCLE THIS PINS ────────────────────────────────────────────────────────────────────
 *
 * Every transaction touching both of the account's contended rows takes them in ONE global
 * order — `account_settings` first, the change-log sequence row second (the order `confirmSeed`
 * designed around and `ScreenerService.decide` follows; `recordSettingsChange` states the
 * rule). `resetScreeningState` was the long-standing writer that took them the other way round
 * — the per-rule change rows first, the settings row last — an opposite-order pair against
 * every settings writer: each holds what the other wants, and Postgres kills one with 40P01.
 * The reset now TAKES the settings row up front, so a racing pair queues on it and both
 * commit. (The first fix pointed the other way — every knob ringing first — which merely moved
 * the cycle onto `confirmSeed` and `decide`; the second review round caught it, and this file
 * was re-pointed at the conformed reset.)
 *
 * ── WHY `.pg.test.ts` ──────────────────────────────────────────────────────────────────────
 *
 * PGlite is one connection: two `await`ed transactions are sequential by construction, so a
 * deadlock test there CANNOT fail. Only real Postgres runs the two transactions on two backends
 * with real row locks. The race is staggered because a deadlock needs the writer to hit its
 * first lock inside the reset's window; with the reset's up-front settings take REVERTED this
 * file goes red with 40P01 within a handful of rounds (watched, both directions of the cycle,
 * before this comment was written).
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const NOW = new Date("2026-08-26T12:00:00.000Z");

describe.skipIf(!PG_UP)("the settings doorbell and the screening reset share a lock order", () => {
  beforeAll(async () => {
    client = postgres(PG_TEST_URL, { max: 8, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
    await runMigrations(PG_TEST_URL);
  });
  afterAll(async () => {
    await client?.end({ timeout: 5 });
  });

  it("staggered concurrent rounds of reset × settings write: no 40P01, both effects land", async () => {
    // The writer starts at a swept offset INSIDE the reset's lock window. The reset's window is
    // real work — one recordChange per doomed rule, then the deletes — widened here by doom
    // volume so the sweep reliably lands at least several starts between the reset's first lock
    // (the sequence row) and its last (the settings row). With the reversed writer order this
    // sweep produces 40P01 within a handful of rounds (watched red under mutation); with the
    // shared order the writer just queues.
    for (let round = 0; round < 16; round++) {
      const accountId = randomUUID();
      const ctx = (): ServiceContext => ({
        db: db as unknown as ServiceContext["db"],
        accountId,
        userId: null,
        now: () => NOW,
        requestId: `dl-${round}-${randomUUID()}`,
      } as ServiceContext);

      await db.insert(accounts).values({ id: accountId, name: `dl-${accountId.slice(0, 8)}` });
      // Rules to doom, so the reset's transaction opens with recordChange (the sequence row)
      // and holds it across its deletes — the window the writer's first lock must survive.
      await db.insert(rules).values(Array.from({ length: 160 }, () => ({
        id: randomUUID(), accountId, kind: "sender" as const,
        match: `${randomUUID()}@example.test`, destination: "INBOX", priority: 0,
        provenance: "manual" as const, enabled: true,
      })));

      // The race. Neither side may throw — a 40P01 rejects one of these promises.
      const offsetMs = (round % 8) * 5;
      await Promise.all([
        resetScreeningState(ctx()),
        (async () => {
          await new Promise((r) => setTimeout(r, offsetMs));
          await setBlockRemoteImages(ctx(), true);
        })(),
      ]);

      // Both effects landed: the rules are gone AND the settings write survived beside the
      // reset's own settings-row write (column-scoped upserts, whichever committed second).
      const left = await db.select({ id: rules.id }).from(rules).where(eq(rules.accountId, accountId));
      expect(left).toHaveLength(0);
      const doorbells = await db.select({ seq: changeLog.seq }).from(changeLog).where(and(
        eq(changeLog.accountId, accountId), eq(changeLog.entityType, "settings"),
      ));
      expect(doorbells.length).toBeGreaterThan(0);
      const [row] = await db.select({ at: accountSettings.blockRemoteImagesAt })
        .from(accountSettings).where(eq(accountSettings.accountId, accountId));
      expect(row?.at).not.toBeNull();
    }
  }, 120_000);

  /**
   * THE SAME CYCLE AGAINST ACCOUNT ERASURE — round 2's finding. `deleteAccount` deletes
   * `change_log` and `account_sync_state` (section 6) BEFORE `account_settings`, which is the
   * reverse of the global order — a consent PATCH racing an Art. 17 erasure could be the
   * transaction Postgres kills. The erasure now takes the settings row up front; this drives
   * the same staggered race against the REAL `deleteAccount` and requires both to settle
   * without 40P01 (the writer may 404 or no-op after the erasure — a refusal is fine, a
   * deadlock is not).
   */
  it("staggered concurrent rounds of erasure × settings write: no 40P01", async () => {
    for (let round = 0; round < 12; round++) {
      const accountId = randomUUID();
      const ctx = (): ServiceContext => ({
        db: db as unknown as ServiceContext["db"],
        accountId,
        userId: null,
        now: () => NOW,
        requestId: `dle-${round}-${randomUUID()}`,
      } as ServiceContext);
      await db.insert(accounts).values({ id: accountId, name: `dle-${accountId.slice(0, 8)}` });
      // Sync-state and settings rows both EXIST before the race — the shape the finding names.
      await setBlockRemoteImages(ctx(), true);

      const offsetMs = (round % 6) * 4;
      const outcomes = await Promise.allSettled([
        deleteAccount(ctx()),
        (async () => {
          await new Promise((r) => setTimeout(r, offsetMs));
          await setBlockRemoteImages(ctx(), false);
        })(),
      ]);
      for (const o of outcomes) {
        if (o.status === "rejected") {
          const code = (o.reason as { code?: string } | null)?.code;
          expect(code, `a racer died: ${String(o.reason)}`).not.toBe("40P01");
        }
      }
    }
  }, 120_000);

  /**
   * …AND AGAINST THE PER-MAILBOX WRITER, whose first draft locked the MAILBOX row before the
   * settings row — a cycle with erasure, which holds the settings row while deleting toward
   * `mailboxes` (round 3's finding). The writer now takes the settings row first (the 404-check
   * SELECT locks nothing), completing the chain settings → mailboxes → sequence row that the
   * erasure's own delete order follows.
   */
  /**
   * ── THE ERASURE FENCE'S ACCEPTANCE (ERASE-WRITE-RACE) — the PATCH may WIN the race, and
   *    zero rows survive anyway ──────────────────────────────────────────────────────────────
   *
   * The no-40P01 rounds above prove the two transactions cannot kill each other; this proves
   * the thing the Art. 17 sweep actually promises. Before the fence, a settings write whose
   * transaction was in flight when the erasure committed would land its `account_settings`
   * upsert — and the doorbell's `change_log` / `account_sync_state` rows — AFTER the sweep
   * counted zero. The fence (`erasure-fence.ts`) closes BOTH orders: a writer that took the
   * accounts row `FOR SHARE` first holds the erasure's stamp until it commits, so the deletes
   * take its rows; a writer that arrives after the stamp refuses `account_erased`. Either way,
   * once both settle: zero settings rows, zero change rows, zero sync-state rows, and the
   * stamp on the surviving account row.
   *
   * The stagger sweeps the writer's start across the erasure's whole window — including
   * offsets where the writer's transaction opens FIRST (offset 0 with a head start), which is
   * the pairing the gap row's acceptance names ("lets the PATCH win the race"). Watched red
   * against the unfenced code: with the fence's stamp and FOR SHARE removed, the late-writer
   * rounds leave `account_settings` and doorbell rows behind and this test names them.
   */
  it("erasure × settings write, the PATCH may win: ZERO settings/doorbell rows survive", async () => {
    for (let round = 0; round < 16; round++) {
      const accountId = randomUUID();
      const ctx = (): ServiceContext => ({
        db: db as unknown as ServiceContext["db"],
        accountId,
        userId: null,
        now: () => NOW,
        requestId: `fence-${round}-${randomUUID()}`,
      } as ServiceContext);
      await db.insert(accounts).values({ id: accountId, name: `fence-${accountId.slice(0, 8)}` });
      // Both contended rows exist before the race, the shape the gap row names.
      await setBlockRemoteImages(ctx(), true);

      // Rounds alternate who gets the head start, so both lock orders are actually driven:
      // even rounds give the WRITER the head start (it can win the accounts share lock and
      // force the erasure to wait it out), odd rounds give the erasure one.
      const writerFirst = round % 2 === 0;
      const offsetMs = (round % 8) * 3;
      const outcomes = await Promise.allSettled([
        (async () => {
          if (writerFirst) await new Promise((r) => setTimeout(r, offsetMs));
          return deleteAccount(ctx());
        })(),
        (async () => {
          if (!writerFirst) await new Promise((r) => setTimeout(r, offsetMs));
          return setBlockRemoteImages(ctx(), false);
        })(),
      ]);
      for (const o of outcomes) {
        if (o.status === "rejected") {
          const code = (o.reason as { code?: string } | null)?.code;
          // The writer may be refused by the fence — that is the fence working. Nothing may
          // deadlock, and the ERASURE may not fail at all.
          expect(code, `a racer died unexpectedly: ${String(o.reason)}`).toBe("account_erased");
        }
      }

      // The sweep's promise, measured after both settled: nothing recreated, stamp standing.
      const settings = await db.select().from(accountSettings)
        .where(eq(accountSettings.accountId, accountId));
      expect(settings, `round ${round}: account_settings rows survived the erasure`).toHaveLength(0);
      const change = await db.select({ seq: changeLog.seq }).from(changeLog)
        .where(eq(changeLog.accountId, accountId));
      expect(change, `round ${round}: change_log rows survived the erasure`).toHaveLength(0);
      const syncState = await db.select().from(accountSyncState)
        .where(eq(accountSyncState.accountId, accountId));
      expect(syncState, `round ${round}: account_sync_state rows survived the erasure`).toHaveLength(0);
      const [acct] = await db.select({ erasedAt: accounts.erasedAt })
        .from(accounts).where(eq(accounts.id, accountId));
      expect(acct?.erasedAt, `round ${round}: the erasure left no stamp`).not.toBeNull();
    }
  }, 120_000);

  it("staggered concurrent rounds of erasure × per-mailbox folders write: no 40P01", async () => {
    for (let round = 0; round < 12; round++) {
      const accountId = randomUUID();
      const ctx = (): ServiceContext => ({
        db: db as unknown as ServiceContext["db"],
        accountId,
        userId: null,
        now: () => NOW,
        requestId: `dlm-${round}-${randomUUID()}`,
      } as ServiceContext);
      await db.insert(accounts).values({ id: accountId, name: `dlm-${accountId.slice(0, 8)}` });
      const [mb] = await db.insert(mailboxes)
        .values({ accountId, provider: "imap", address: `dlm-${accountId.slice(0, 8)}@example.test` })
        .returning();
      await setBlockRemoteImages(ctx(), true); // both contended rows exist before the race

      const offsetMs = (round % 6) * 4;
      const outcomes = await Promise.allSettled([
        deleteAccount(ctx()),
        (async () => {
          await new Promise((r) => setTimeout(r, offsetMs));
          await setMailboxFoldersEnabled(ctx(), mb!.id, false);
        })(),
      ]);
      for (const o of outcomes) {
        if (o.status === "rejected") {
          const code = (o.reason as { code?: string } | null)?.code;
          expect(code, `a racer died: ${String(o.reason)}`).not.toBe("40P01");
        }
      }
    }
  }, 120_000);
});
