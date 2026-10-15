import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq, ne, sql } from "drizzle-orm";
import { accountSettings, accounts, changeLog, folderState, messages, rules } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { consentSettings, setDormancyDays } from "../src/consent-seed.js";
import { DEFAULT_DORMANCY_DAYS, cutlineCounts } from "../src/consent-cutline.js";
import { ServiceError } from "../src/errors.js";
import type { ServiceContext } from "../src/context.js";

/**
 * THE DORMANCY DIAL, ON REAL POSTGRES — mail 0044 (SET-IA).
 *
 * The dial (`account_settings.dormancy_days`) had ZERO writers before this slice. `setDormancyDays`
 * is the first, and the properties that matter are the ones PGlite cannot see and the ones that make
 * the dial safe:
 *
 *  1. THE WRITE IS PURE VISIBILITY. It moves no mail — no `change_log` row, no `rules` row, no
 *     `folder_state` change. The test seeds nothing and asserts all three counts stay zero; making
 *     the writer stamp any of them turns the assertion red.
 *  2. THE CEILING IS LOAD-BEARING. A value legal under the old `> 0` floor alone (2e8) makes the
 *     read (`cutlineCounts` → `toISOString()`) throw `RangeError`, so `GET /consent` 500s for that
 *     account. 0044's CHECK refuses it at the database (23514) and the service refuses it with a 400,
 *     so the value that would crash the read can never be stored.
 *  3. IT NEVER STORES THE DEFAULT. `null` and 60 both persist NULL, so the account tracks the
 *     product default instead of freezing at a snapshot of it.
 *  4. IT DOES NOT CLOBBER A NEIGHBOUR under a concurrent seed confirmation — the column-scoped
 *     upsert PGlite serialises by construction, so this is a `.pg.test.ts`.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ACCOUNT = randomUUID();
const NOW = new Date("2026-08-05T12:00:00.000Z");

const ctxFor = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId,
  userId: null,
  now: () => NOW,
  requestId: `dormancy-${randomUUID()}`,
} as ServiceContext);

const ctx = (): ServiceContext => ctxFor(ACCOUNT);

/** All the tables the dial must NEVER touch, counted for the account. */
async function mutationCounts(accountId: string): Promise<{ changeLog: number; settingsRows: number; rules: number; folderState: number }> {
  // MAIL-MOVING change rows only: the dial now appends one `settings` doorbell per write (the
  // sync channel's consent re-ask signal — a row ABOUT the dial, never about mail), so the
  // moves-no-mail guard counts everything BUT that type, and the doorbell is counted separately
  // so its presence can be asserted rather than merely tolerated.
  const [cl] = await db.select({ n: sql<number>`count(*)::int` }).from(changeLog)
    .where(and(eq(changeLog.accountId, accountId), ne(changeLog.entityType, "settings")));
  const [st] = await db.select({ n: sql<number>`count(*)::int` }).from(changeLog)
    .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityType, "settings")));
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(rules)
    .where(eq(rules.accountId, accountId));
  // `folder_state` has no `account_id` — it is keyed by message — and the shared test database holds
  // rows from every other suite, so scope it to THIS account through `messages` or the guard would
  // measure the whole table's noise instead of the dial.
  const [fs] = await db.select({ n: sql<number>`count(*)::int` })
    .from(folderState)
    .innerJoin(messages, eq(messages.id, folderState.messageId))
    .where(eq(messages.accountId, accountId));
  return { changeLog: Number(cl!.n), settingsRows: Number(st!.n), rules: Number(r!.n), folderState: Number(fs!.n) };
}

describe.skipIf(!PG_UP)("mail 0044 — the dormancy dial on real Postgres", () => {
  beforeAll(async () => {
    // Four connections: the concurrency test needs two writes IN FLIGHT AT ONCE.
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
    await runMigrations(PG_TEST_URL);
    await db.insert(accounts).values({ id: ACCOUNT, name: `dorm-${ACCOUNT.slice(0, 8)}` });
  });

  afterAll(async () => {
    await db.delete(accountSettings).where(eq(accountSettings.accountId, ACCOUNT));
    await db.delete(accounts).where(eq(accounts.id, ACCOUNT));
    await client.end();
  });

  it("an account with NO settings row reads the dial as NULL (the default)", async () => {
    const rows = await db.select().from(accountSettings).where(eq(accountSettings.accountId, ACCOUNT));
    expect(rows).toHaveLength(0);
    expect((await consentSettings(ctx())).dormancyDays).toBeNull();
  });

  it("stores a chosen window and reads it back; the echo is the effective window", async () => {
    const res = await setDormancyDays(ctx(), 90);
    expect(res.dormancyDays).toBe(90);
    // Read through the SERVICE, the client's actual contract, not the raw row.
    expect((await consentSettings(ctx())).dormancyDays).toBe(90);
    const [row] = await db.select().from(accountSettings).where(eq(accountSettings.accountId, ACCOUNT));
    expect(row!.dormancyDays).toBe(90);
  });

  it("NEVER stores the default — 60 and null both persist NULL and echo the default", async () => {
    await setDormancyDays(ctx(), 90);                     // move it off first
    const def = await setDormancyDays(ctx(), DEFAULT_DORMANCY_DAYS);
    expect(def.dormancyDays).toBe(DEFAULT_DORMANCY_DAYS); // the echo is the effective window
    let [row] = await db.select().from(accountSettings).where(eq(accountSettings.accountId, ACCOUNT));
    expect(row!.dormancyDays).toBeNull();                 // …but NULL is what is stored

    await setDormancyDays(ctx(), 120);
    const reverted = await setDormancyDays(ctx(), null);
    expect(reverted.dormancyDays).toBe(DEFAULT_DORMANCY_DAYS);
    [row] = await db.select().from(accountSettings).where(eq(accountSettings.accountId, ACCOUNT));
    expect(row!.dormancyDays).toBeNull();
  });

  /* ══════════════════════════════════════════════════════════════════════════════════════
     "ALL TIME" IS A MODE OF THIS SAME DIAL (mail 0083)

     `screening_scope` decides whether the cutline exists at all, so it is the OTHER ANSWER to
     the window's own question rather than a knob beside it — one writer, one upsert, one lock.
     What these cases pin is the property that makes that safe: EITHER field may be absent, and
     absent means UNTOUCHED. Without it the two can disagree, and an account reading `all_time`
     with a 90-day window under it has two answers to "how far back does the Screener ask?".

     Against REAL Postgres, not PGlite: the upsert's `ON CONFLICT … DO UPDATE` with a partial
     `set`, the `returning` that reads both columns back out of the row the write produced, and
     the concurrent-writer case below are exactly the shapes PGlite serialises away.
     ══════════════════════════════════════════════════════════════════════════════════════ */

  it("stores the mode, and reads it back through the service", async () => {
    const res = await setDormancyDays(ctx(), undefined, "all_time");
    expect(res.screeningScope).toBe("all_time");
    expect((await consentSettings(ctx())).screeningScope).toBe("all_time");
    const back = await setDormancyDays(ctx(), undefined, "window");
    expect(back.screeningScope).toBe("window");
    expect((await consentSettings(ctx())).screeningScope).toBe("window");
  });

  it("creates the row when there is none — a fresh standalone install has NO settings row", async () => {
    // The measured case: on a fresh local install `account_settings` is EMPTY, so an UPDATE
    // would match zero rows, report success and store nothing — the ladder somebody just chose
    // silently discarded on the door where the flow that offers it is the funnel. Its own
    // account, because the suite shares one and the emptiness IS the precondition under test.
    const fresh = randomUUID();
    await db.insert(accounts).values({ id: fresh, name: `dorm-new-${fresh.slice(0, 8)}` });
    try {
      const before = await db.select().from(accountSettings).where(eq(accountSettings.accountId, fresh));
      expect(before).toHaveLength(0);
      const res = await setDormancyDays(ctxFor(fresh), undefined, "all_time");
      expect(res.screeningScope).toBe("all_time");
      // …and the window it never named is the product default, not a zero or a frozen snapshot.
      expect(res.dormancyDays).toBe(DEFAULT_DORMANCY_DAYS);
      const [row] = await db.select().from(accountSettings).where(eq(accountSettings.accountId, fresh));
      expect(row!.dormancyDays).toBeNull();
      expect(row!.screeningScope).toBe("all_time");
    } finally {
      await db.delete(accountSettings).where(eq(accountSettings.accountId, fresh));
      await db.delete(accounts).where(eq(accounts.id, fresh));
    }
  });

  it("naming only the window leaves an all-time account in all time", async () => {
    await setDormancyDays(ctx(), undefined, "all_time");
    const res = await setDormancyDays(ctx(), 90);
    expect(res.dormancyDays).toBe(90);
    // THE ASSERTION THAT MATTERS: the echo reports the mode as it still is, and the row agrees.
    expect(res.screeningScope).toBe("all_time");
    const [row] = await db.select().from(accountSettings).where(eq(accountSettings.accountId, ACCOUNT));
    expect(row!.screeningScope).toBe("all_time");
    expect(row!.dormancyDays).toBe(90);
  });

  it("naming only the mode leaves the stored window alone", async () => {
    await setDormancyDays(ctx(), 180);
    const res = await setDormancyDays(ctx(), undefined, "all_time");
    expect(res.dormancyDays).toBe(180);
    const [row] = await db.select().from(accountSettings).where(eq(accountSettings.accountId, ACCOUNT));
    expect(row!.dormancyDays).toBe(180);
    // Widening does not forget the window: narrowing back must restore what was chosen, not a
    // default — which is what "extend later" promises and what the copy is pinned to.
    const narrowed = await setDormancyDays(ctx(), undefined, "window");
    expect(narrowed.dormancyDays).toBe(180);
    expect(narrowed.screeningScope).toBe("window");
  });

  it("writes both in ONE call when the person answers both", async () => {
    const res = await setDormancyDays(ctx(), 365, "window");
    expect(res).toEqual({ dormancyDays: 365, screeningScope: "window" });
    const [row] = await db.select().from(accountSettings).where(eq(accountSettings.accountId, ACCOUNT));
    expect(row!.dormancyDays).toBe(365);
    expect(row!.screeningScope).toBe("window");
  });

  it("refuses a mode outside the closed set, and refuses a call that names neither", async () => {
    const fresh = randomUUID();
    await db.insert(accounts).values({ id: fresh, name: `dorm-bad-${fresh.slice(0, 8)}` });
    try {
      await expect(setDormancyDays(ctxFor(fresh), 90, "everything" as never))
        .rejects.toMatchObject({ httpStatus: 400 });
      // A write that changes nothing and reports success is a control that lies about having
      // acted — the route's own rule for an empty body, applied at the writer.
      await expect(setDormancyDays(ctxFor(fresh), undefined, undefined))
        .rejects.toMatchObject({ httpStatus: 400 });
      // …and a REFUSAL PERSISTS NOTHING. The bad-mode call named a legal window beside an
      // illegal mode, so a writer that validated in the wrong order would have stored 90 under
      // a 400 — the partial write this route's transaction exists to prevent.
      const rows = await db.select().from(accountSettings).where(eq(accountSettings.accountId, fresh));
      expect(rows).toHaveLength(0);
    } finally {
      await db.delete(accountSettings).where(eq(accountSettings.accountId, fresh));
      await db.delete(accounts).where(eq(accounts.id, fresh));
    }
  });

  it("refuses a value outside 1–365 with a 400 — 0, 400, and a non-integer", async () => {
    for (const bad of [0, 400, 60.5, -1]) {
      await expect(setDormancyDays(ctx(), bad)).rejects.toBeInstanceOf(ServiceError);
      await expect(setDormancyDays(ctx(), bad)).rejects.toMatchObject({ httpStatus: 400 });
    }
    // 1 and 365 are the inclusive edges and must be accepted.
    expect((await setDormancyDays(ctx(), 1)).dormancyDays).toBe(1);
    expect((await setDormancyDays(ctx(), 365)).dormancyDays).toBe(365);
  });

  it("the CHECK refuses at the database what the service refuses at the edge (Postgres 23514)", async () => {
    const fresh = randomUUID();
    await db.insert(accounts).values({ id: fresh, name: `dorm-chk-${fresh.slice(0, 8)}` });
    try {
      // A raw write bypassing the service. A value far past the ceiling is a legal `integer` and legal under the old
      // `> 0` floor alone — 0044's ceiling is the only thing that stops it, and it is why the ceiling
      // exists: stored, this value makes the read below throw.
      await expect(
        db.insert(accountSettings).values({ accountId: fresh, dormancyDays: 200_000_000 }),
      ).rejects.toMatchObject({ code: "23514" });
      // The floor (0035) and the ceiling (0044) both bite raw writes.
      await expect(
        db.insert(accountSettings).values({ accountId: fresh, dormancyDays: 400 }),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        db.insert(accountSettings).values({ accountId: fresh, dormancyDays: 0 }),
      ).rejects.toMatchObject({ code: "23514" });
      // NULL is always legal — the default is not stored.
      await db.insert(accountSettings).values({ accountId: fresh, dormancyDays: null });
      expect(await db.select().from(accountSettings).where(eq(accountSettings.accountId, fresh)))
        .toHaveLength(1);
    } finally {
      await db.delete(accountSettings).where(eq(accountSettings.accountId, fresh));
      await db.delete(accounts).where(eq(accounts.id, fresh));
    }
  });

  it("WHY the ceiling exists: a value legal under `> 0` alone makes the READ throw RangeError", async () => {
    // `cutlineCounts` builds the cutoff as a JS `Date` and serialises it with `toISOString()`. For a
    // window of 2e8 days the arithmetic overflows the valid Date range, and `toISOString()` throws
    // `RangeError: Invalid time value` — BEFORE the query is issued, so this is a read-time crash of
    // `GET /consent`, not a database error. This is the 500-for-ever the 0044 CHECK prevents by making
    // the value unstorable (the test above). The two together are the before/after of the cap.
    await expect(cutlineCounts(ctx(), { dormancyDays: 200_000_000 }))
      .rejects.toThrow(/Invalid time value/);
    // And an in-bounds window (≤ 365) can never reach the overflow — the read is fine.
    await expect(cutlineCounts(ctx(), { dormancyDays: 365 })).resolves.toBeDefined();
  });

  it("MOVES NO MAIL — zero mail-moving change_log, zero rules, zero folder_state; the doorbell rings", async () => {
    const before = await mutationCounts(ACCOUNT);
    await setDormancyDays(ctx(), 180);
    await setDormancyDays(ctx(), null);
    await setDormancyDays(ctx(), 30);
    const after = await mutationCounts(ACCOUNT);
    // Nothing the dial touches may have moved MAIL. Making the writer stamp a mail-typed
    // `change_log` row, insert a `rules` row or write `folder_state` turns one of these red —
    // which is the whole guard. The NEW consumer is named rather than the assertion weakened:
    // each write appends exactly one `settings` doorbell (the sync channel's consent re-ask
    // signal), which is a row ABOUT the dial and moves nothing — and it must be there, because
    // a dial that rings no wake leaves every other signed-in surface partitioning with the old
    // window until reload.
    expect(after.changeLog).toBe(before.changeLog);
    expect(after.rules).toBe(before.rules);
    expect(after.folderState).toBe(before.folderState);
    expect(after.settingsRows - before.settingsRows).toBe(3);
    // …and this account genuinely holds none of the mail rows, so the equality is about
    // absence, not a wash.
    expect({ changeLog: after.changeLog, rules: after.rules, folderState: after.folderState })
      .toEqual({ changeLog: 0, rules: 0, folderState: 0 });
  });

  it("a dial write concurrent with a seed confirmation clobbers neither column", async () => {
    const fresh = randomUUID();
    await db.insert(accounts).values({ id: fresh, name: `dorm-race-${fresh.slice(0, 8)}` });
    const seededAt = new Date("2026-08-05T11:00:00.000Z");
    try {
      // The other writer in the shape `confirmSeed` uses: a lazy upsert of the same PK setting a
      // DIFFERENT column, raced against the dial. `Promise.all`, so both are in flight before either
      // commits — the interleaving PGlite cannot produce.
      const otherWriter = db.insert(accountSettings)
        .values({ accountId: fresh, seedConfirmedAt: seededAt, seedConfirmedCount: 7 })
        .onConflictDoUpdate({
          target: accountSettings.accountId,
          set: { seedConfirmedAt: seededAt, seedConfirmedCount: 7, updatedAt: NOW },
        });
      await Promise.all([setDormancyDays(ctxFor(fresh), 90), otherWriter]);

      const [row] = await db.select().from(accountSettings).where(eq(accountSettings.accountId, fresh));
      // BOTH survive: neither column was written from a stale snapshot of the other, which is exactly
      // the assertion a read-modify-write implementation fails.
      expect(row!.dormancyDays).toBe(90);
      expect(row!.seedConfirmedAt?.toISOString()).toBe(seededAt.toISOString());
      expect(row!.seedConfirmedCount).toBe(7);
    } finally {
      await db.delete(accountSettings).where(eq(accountSettings.accountId, fresh));
      await db.delete(accounts).where(eq(accounts.id, fresh));
    }
  });
});
