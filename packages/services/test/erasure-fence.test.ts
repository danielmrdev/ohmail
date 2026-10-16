import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accountSettings, accounts, accountSyncState, changeLog } from "@trafficflow/db";
import {
  deleteAccount,
  resetScreeningState,
  setAutoSuggest,
  setBlockAutoUnsubscribe,
  setBlockRemoteImages,
  setBlockTrackingPixels,
  setDormancyDays,
  setFoldersEnabled,
  setLocale,
  setScreeningPreference,
  requestOhboxTidy,
  ServiceError,
  type ServiceContext,
} from "../src/index.js";
import { NOW, LATER, seedFullAccount, type Db } from "./helpers/erasure-fixture.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE ERASURE FENCE — a settings write after erasure REFUSES instead of recreating rows
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ERASE-WRITE-RACE: `accounts` survives Art. 17 erasure (the pseudonymous billing subject), so a
 * late settings writer used to be able to recreate `account_settings` plus the doorbell's
 * `change_log` / `account_sync_state` rows AFTER the sweep counted zero. The fence is two-sided —
 * `deleteAccount` stamps `accounts.erased_at` first, every settings writer reads it `FOR SHARE`
 * first and refuses on a stamp (`erasure-fence.ts`).
 *
 * What PGlite CAN see, and what this file therefore asserts, is the ORDERED half: erasure
 * committed, then a write arrives — every fenced writer refuses `account_erased` 410 and the
 * swept tables stay at zero. The CONCURRENT half — the write's transaction already open when the
 * erasure commits, which is the race the gap row names — needs two real backends and lives in
 * `settings-reset-deadlock.pg.test.ts` ("the PATCH wins the race…"), because PGlite serialises
 * two `await`ed transactions by construction and would pass a fence that does not lock.
 *
 * Mutations watched red, then restored:
 *  · the stamp removed from `deleteAccount` → every refusal case here red (writes land again),
 *    and the recreation case reproduces the original defect verbatim;
 *  · `fenceErasedAccount` gutted to a no-op → same reds;
 *  · the fence's throw demoted to a return → the zero-row assertions red.
 */

const ctxFor = (db: Db, accountId: string, userId: string | null): ServiceContext =>
  ({ db, accountId, userId, now: () => LATER, requestId: "fence" } as ServiceContext);

const sweptCounts = async (db: Db, accountId: string) => ({
  settings: (await db.select().from(accountSettings).where(eq(accountSettings.accountId, accountId))).length,
  changeLog: (await db.select().from(changeLog).where(eq(changeLog.accountId, accountId))).length,
  syncState: (await db.select().from(accountSyncState).where(eq(accountSyncState.accountId, accountId))).length,
});

describe("the erasure fence", () => {
  it("stamps erased_at in the erasure transaction, and a retry keeps the first stamp", async () => {
    const db = await makeTestDb();
    const seeded = await seedFullAccount(db);
    const ctx = ctxFor(db, seeded.accountId, seeded.userId);

    await deleteAccount(ctx);
    const [afterFirst] = await db.select({ erasedAt: accounts.erasedAt })
      .from(accounts).where(eq(accounts.id, seeded.accountId));
    expect(afterFirst?.erasedAt).toEqual(LATER);

    // The retry (the caller may re-run after a network failure) must not re-date the erasure.
    const retryCtx = { ...ctx, now: () => new Date(LATER.getTime() + 86_400_000) } as ServiceContext;
    await deleteAccount(retryCtx);
    const [afterRetry] = await db.select({ erasedAt: accounts.erasedAt })
      .from(accounts).where(eq(accounts.id, seeded.accountId));
    expect(afterRetry?.erasedAt).toEqual(LATER);
  });

  it("every settings writer refuses 410 on an erased account, and the swept tables stay at zero", async () => {
    const db = await makeTestDb();
    const seeded = await seedFullAccount(db);
    const ctx = ctxFor(db, seeded.accountId, seeded.userId);
    await deleteAccount(ctx);
    expect(await sweptCounts(db, seeded.accountId)).toEqual({ settings: 0, changeLog: 0, syncState: 0 });

    // Every fenced writer, by name — a writer missing from this list is a writer somebody must
    // rule on, because each one of these could recreate the erased scalars and the doorbell.
    const writers: Array<[string, () => Promise<unknown>]> = [
      ["setAutoSuggest", () => setAutoSuggest(ctx, true)],
      ["setFoldersEnabled", () => setFoldersEnabled(ctx, true)],
      ["setDormancyDays", () => setDormancyDays(ctx, 30)],
      ["setBlockRemoteImages", () => setBlockRemoteImages(ctx, true)],
      ["setBlockTrackingPixels", () => setBlockTrackingPixels(ctx, true)],
      ["setBlockAutoUnsubscribe", () => setBlockAutoUnsubscribe(ctx, true)],
      ["setLocale", () => setLocale(ctx, "de")],
      ["resetScreeningState", () => resetScreeningState(ctx)],
      ["setScreeningPreference", () => setScreeningPreference(ctx, { ohboxBar: "people I know" })],
      ["requestOhboxTidy", () => requestOhboxTidy(ctx)],
    ];
    for (const [name, run] of writers) {
      const err = await run().then(() => null, (e: unknown) => e);
      expect(err, `${name} did not refuse on an erased account`).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code, name).toBe("account_erased");
      expect((err as ServiceError).httpStatus, name).toBe(410);
    }

    // The promise the sweep makes: still zero, after every writer had its chance.
    expect(await sweptCounts(db, seeded.accountId)).toEqual({ settings: 0, changeLog: 0, syncState: 0 });
  });

  it("a live account is untouched by the fence — the writers still write", async () => {
    const db = await makeTestDb();
    const seeded = await seedFullAccount(db);
    const ctx = ctxFor(db, seeded.accountId, seeded.userId);

    // Not erased: the same writers go through, and the doorbell rings.
    const { autoSuggestAt } = await setAutoSuggest(ctx, true);
    expect(autoSuggestAt).not.toBeNull();
    const after = await sweptCounts(db, seeded.accountId);
    expect(after.settings).toBe(1);
    expect(after.changeLog).toBeGreaterThan(0);
  });
});
