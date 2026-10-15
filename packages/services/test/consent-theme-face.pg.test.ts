import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, accountSettings } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { SUPPORTED_THEME_FACES, consentSettings, setThemeFace, setLocale } from "../src/consent-seed.js";
import type { ServiceContext } from "../src/context.js";

/**
 * `account_settings.theme_face` AGAINST REAL POSTGRES — mail 0082, `consent-locale.pg.test.ts`'s
 * three reasons applied to the face:
 *
 *  1. **THE COLUMN AND ITS CHECK ACTUALLY EXIST.** Hand-written migration, nothing else replays
 *     it against a catalog in CI, and every consumer of a bad face degrades to paper on purpose
 *     — no error anywhere to find a decorative CHECK by. Asserted by refusal, not by name alone.
 *  2. **COLUMN-SCOPED UNDER A REAL CONFLICT.** The face is set beside the language and the other
 *     knobs on one primary key; PGlite serialises what Postgres interleaves.
 *  3. **WHAT IS STORED IS THE CONTRACT — and here that includes the INVERSION:** `'paper'` is a
 *     real stored value (it is what overrides a Linux device's ohmarchy detection — the
 *     migration's header carries the argument), where `locale` stores NULL for its default.
 *     Asserted against the column, because the column is what every other device reads.
 */

const AVAILABLE = await realPgAvailable();

describe.skipIf(!AVAILABLE)("account_settings.theme_face against real Postgres", () => {
  let owned: OwnedDb;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
  }, 120_000);

  afterAll(async () => { await owned?.close().catch(() => {}); });

  async function freshAccount(): Promise<string> {
    const accountId = randomUUID();
    await owned.db.insert(accounts).values({ id: accountId, name: `face-${accountId.slice(0, 8)}` });
    return accountId;
  }

  const ctxFor = (accountId: string): ServiceContext =>
    ({ db: owned.db, accountId, now: () => new Date() } as unknown as ServiceContext);

  it("round-trips both faces — and 'paper' IS stored, never collapsed to NULL", async () => {
    const accountId = await freshAccount();
    const ctx = ctxFor(accountId);

    // No row at all is a legal state and reads as "no account-wide choice".
    expect((await consentSettings(ctx)).themeFace).toBeNull();

    expect(await setThemeFace(ctx, "ohmarchy")).toEqual({ themeFace: "ohmarchy" });
    const [row] = await owned.db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, accountId));
    expect(row!.themeFace).toBe("ohmarchy");
    expect((await consentSettings(ctx)).themeFace).toBe("ohmarchy");

    // THE INVERSION (mail 0082's header): an explicit account-wide paper is the instruction
    // that overrides a Linux device's detection — collapsing it to NULL would store nothing
    // on exactly the class of device it targets.
    expect(await setThemeFace(ctx, "paper")).toEqual({ themeFace: "paper" });
    const [afterPaper] = await owned.db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, accountId));
    expect(afterPaper!.themeFace,
      "'paper' collapsed to NULL — the Linux default would immediately reassert itself")
      .toBe("paper");

    // `null` remains sendable: drop the account-wide choice entirely.
    expect(await setThemeFace(ctx, null)).toEqual({ themeFace: null });
    const [afterNull] = await owned.db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, accountId));
    expect(afterNull!.themeFace).toBeNull();
  });

  it("the CHECK is real — the database refuses a face nothing renders", async () => {
    const accountId = await freshAccount();
    await owned.db.insert(accountSettings).values({ accountId, themeFace: "ohmarchy" });

    // The service refuses this too; the SERVICE IS BYPASSED on purpose — the question is what
    // a hand-run UPDATE, a future admin tool or a pre-constraint restore would meet.
    await expect(
      owned.db.execute(
        sql`update account_settings set theme_face = 'tokyo-night' where account_id = ${accountId}`,
      ),
    ).rejects.toThrow(/account_settings_theme_face_supported|violates check constraint/i);

    // And an unsupported value planted UNDER the constraint (simulated by reading a value the
    // set no longer contains) never reaches a client: the read side filters to the same set.
    expect(SUPPORTED_THEME_FACES).toEqual(["paper", "ohmarchy"]);
  });

  it("the write is column-scoped — a face never clobbers the language beside it", async () => {
    const accountId = await freshAccount();
    const ctx = ctxFor(accountId);
    await setLocale(ctx, "de");
    await setThemeFace(ctx, "ohmarchy");
    const [row] = await owned.db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, accountId));
    expect(row!.locale, "setThemeFace upserted the whole row and erased the language").toBe("de");
    expect(row!.themeFace).toBe("ohmarchy");
  });
});
