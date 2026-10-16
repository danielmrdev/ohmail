import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { accountSettings, accounts } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { consentSettings, setAutoSuggest } from "../src/consent-seed.js";
import type { ServiceContext } from "../src/context.js";

/**
 * THE AUTO-SUGGEST OPT-IN, ON REAL POSTGRES — mail 0040.
 *
 * ── WHY THIS FILE IS `.pg.test.ts` AND NOT A PGLITE TEST ─────────────────────────────────
 *
 * `account_settings` has ONE row per account and THREE writers that all create it lazily:
 * `confirmSeed`, `resetScreeningState`, and now `setAutoSuggest`. Onboarding runs the first and
 * the third within the same minute, on the same primary key, from two different requests.
 *
 * PGlite is a single connection, so two `await`ed writes in one process are sequential by
 * construction — a sequential test of a concurrent property is a test that CANNOT FAIL. Under
 * real Postgres the first insert holds the primary-key lock and the second blocks on it, which is
 * the ordering the `onConflictDoUpdate` is there to survive. A select-then-insert implementation
 * passes every PGlite test in this repo and raises a unique violation the first time two requests land
 * together on a live account.
 *
 * ── THE THREE PROPERTIES ─────────────────────────────────────────────────────────────────
 *
 * 1. An ABSENT ROW READS AS OFF. This is the default the whole feature rests on: the flag
 *    authorises spending, so "no answer" must never mean "yes". It is asserted before any write
 *    exists, because after one there is a row and the question stops being asked.
 * 2. CONCURRENT FIRST WRITES PRODUCE ONE ROW. Two `setAutoSuggest` calls racing to create the
 *    account's first settings row must not raise a duplicate-key error and must not leave two
 *    rows behind.
 * 3. A CONCURRENT WRITER DOES NOT CLOBBER A NEIGHBOURING COLUMN. `setAutoSuggest` touches
 *    `auto_suggest_at` and `updated_at` and nothing else, so a seed confirmation landing in the
 *    same window keeps its `seed_confirmed_at`. An implementation that read the row, changed one
 *    field of its own snapshot and wrote the whole thing back would lose one of the two settings,
 *    and which one it lost would depend on the interleaving.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ACCOUNT = randomUUID();
const NOW = new Date("2026-08-05T12:00:00.000Z");

const ctx = (): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId: ACCOUNT,
  userId: null,
  now: () => NOW,
  requestId: `auto-suggest-${randomUUID()}`,
} as ServiceContext);

describe.skipIf(!PG_UP)("mail 0040 — the auto-suggest opt-in on real Postgres", () => {
  beforeAll(async () => {
    // Four connections, because the point of the file is two writes IN FLIGHT AT ONCE. With
    // `max: 1` the pool serialises them and this suite becomes the PGlite test it replaces.
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
    await runMigrations(PG_TEST_URL);
    await db.insert(accounts).values({ id: ACCOUNT, name: `as-${ACCOUNT.slice(0, 8)}` });
  });

  afterAll(async () => {
    await db.delete(accountSettings).where(eq(accountSettings.accountId, ACCOUNT));
    await db.delete(accounts).where(eq(accounts.id, ACCOUNT));
    await client.end();
  });

  it("an account with NO settings row reads as OFF", async () => {
    const rows = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, ACCOUNT));
    // The premise of the assertion, stated so a later fixture change cannot make it vacuous:
    // there is genuinely no row, so what follows is about absence and not about a NULL column.
    expect(rows).toHaveLength(0);

    const settings = await consentSettings(ctx());
    expect(settings.autoSuggestAt).toBeNull();
  });

  it("turning it ON stores the instant, and turning it OFF clears it", async () => {
    const on = await setAutoSuggest(ctx(), true);
    expect(on.autoSuggestAt).toBe(NOW.toISOString());
    // Read through the SERVICE, not the row: the client's whole contract is what `GET /consent`
    // answers, and a setter that wrote a column the reader does not project would pass a
    // row-level assertion and ship a flag nobody can see.
    expect((await consentSettings(ctx())).autoSuggestAt).toBe(NOW.toISOString());

    const off = await setAutoSuggest(ctx(), false);
    expect(off.autoSuggestAt).toBeNull();
    expect((await consentSettings(ctx())).autoSuggestAt).toBeNull();
  });

  it("TWO CONCURRENT FIRST WRITES leave exactly one row and no duplicate-key error", async () => {
    // A second account with no settings row, so both calls below are racing to CREATE it.
    const fresh = randomUUID();
    await db.insert(accounts).values({ id: fresh, name: `as2-${fresh.slice(0, 8)}` });
    const c = (): ServiceContext => ({ ...ctx(), accountId: fresh } as ServiceContext);
    try {
      // `Promise.all`, not two awaits: both statements are in flight before either commits, which
      // is the interleaving PGlite cannot produce.
      const [a, b] = await Promise.all([setAutoSuggest(c(), true), setAutoSuggest(c(), true)]);
      expect(a.autoSuggestAt).toBe(NOW.toISOString());
      expect(b.autoSuggestAt).toBe(NOW.toISOString());

      const rows = await db.select().from(accountSettings)
        .where(eq(accountSettings.accountId, fresh));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.autoSuggestAt).not.toBeNull();
    } finally {
      await db.delete(accountSettings).where(eq(accountSettings.accountId, fresh));
      await db.delete(accounts).where(eq(accounts.id, fresh));
    }
  });

  it("it does NOT clobber a neighbouring setting written concurrently", async () => {
    const fresh = randomUUID();
    await db.insert(accounts).values({ id: fresh, name: `as3-${fresh.slice(0, 8)}` });
    const c = (): ServiceContext => ({ ...ctx(), accountId: fresh } as ServiceContext);
    const seededAt = new Date("2026-08-05T11:00:00.000Z");
    try {
      // The other writer, in the shape `confirmSeed` uses: a lazy upsert of the same row that
      // sets a DIFFERENT column. Raced against the opt-in.
      const otherWriter = db.insert(accountSettings)
        .values({ accountId: fresh, seedConfirmedAt: seededAt, seedConfirmedCount: 7 })
        .onConflictDoUpdate({
          target: accountSettings.accountId,
          set: { seedConfirmedAt: seededAt, seedConfirmedCount: 7, updatedAt: NOW },
        });
      await Promise.all([setAutoSuggest(c(), true), otherWriter]);

      const rows = await db.select().from(accountSettings)
        .where(eq(accountSettings.accountId, fresh));
      expect(rows).toHaveLength(1);
      // BOTH survive. Whichever landed second, neither column was written from a stale snapshot
      // of the other — the assertion that a read-modify-write implementation fails.
      expect(rows[0]!.autoSuggestAt).not.toBeNull();
      expect(rows[0]!.seedConfirmedAt?.toISOString()).toBe(seededAt.toISOString());
      expect(rows[0]!.seedConfirmedCount).toBe(7);
    } finally {
      await db.delete(accountSettings).where(eq(accountSettings.accountId, fresh));
      await db.delete(accounts).where(eq(accounts.id, fresh));
    }
  });
});
