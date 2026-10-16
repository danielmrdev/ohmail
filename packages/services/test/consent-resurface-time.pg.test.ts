import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, accountSettings } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { consentSettings, setResurfaceTime } from "../src/consent-seed.js";
import type { ServiceContext } from "../src/context.js";

/**
 * `account_settings.resurface_time` AGAINST REAL POSTGRES — mail 0110.
 *
 * `consent-locale.pg.test.ts`'s three reasons, minus the CHECK it has and this column does not:
 * the migration is hand-written and nothing else replays it against a catalog, the write is an
 * upsert on a primary key onboarding writes four other knobs on within the same minute (PGlite
 * serialises those by construction and would green a writer that clobbered the row), and NULL —
 * "never chosen", the state every account starts in — is asserted against the COLUMN rather than
 * the echo, because the echo is code and the column is the fact every other device reads.
 */

const AVAILABLE = await realPgAvailable();

describe.skipIf(!AVAILABLE)("account_settings.resurface_time against real Postgres", () => {
  let owned: OwnedDb;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
  }, 120_000);

  afterAll(async () => { await owned?.close().catch(() => {}); });

  async function freshAccount(): Promise<string> {
    const accountId = randomUUID();
    await owned.db.insert(accounts).values({ id: accountId, name: `rst-${accountId.slice(0, 8)}` });
    return accountId;
  }

  const ctxFor = (accountId: string): ServiceContext =>
    ({ db: owned.db, accountId, now: () => new Date() } as unknown as ServiceContext);

  it("the column exists, round-trips a time, and 'never chosen' is stored as NULL", async () => {
    const accountId = await freshAccount();
    const ctx = ctxFor(accountId);

    // No row at all is a legal state and reads as "never chosen" — the built-in 09:00.
    expect((await consentSettings(ctx)).resurfaceTime).toBeNull();

    expect(await setResurfaceTime(ctx, "14:30")).toEqual({ resurfaceTime: "14:30" });
    const [row] = await owned.db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, accountId));
    expect(row!.resurfaceTime).toBe("14:30");
    expect((await consentSettings(ctx)).resurfaceTime).toBe("14:30");

    // Midnight is a time, not a falsy value — the one hour a truthiness read would lose, and the
    // read-side filter is a regex test rather than `row?.resurfaceTime ? … : null` for it.
    await setResurfaceTime(ctx, "00:00");
    expect((await consentSettings(ctx)).resurfaceTime).toBe("00:00");

    // Clearing stores NULL rather than the default string: "has not chosen" must stay sayable, or
    // the product can never move its own 09:00 again.
    expect(await setResurfaceTime(ctx, null)).toEqual({ resurfaceTime: null });
    const [cleared] = await owned.db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, accountId));
    expect(cleared!.resurfaceTime).toBeNull();
  });

  it("a value no writer can store reads as 'never chosen' rather than travelling", async () => {
    // The column carries no CHECK (the migration header argues it), so this state is reachable by
    // a hand-run UPDATE or a restore — exactly what the read-side filter exists for. Written here
    // through the column directly, because no door in the product can produce it.
    const accountId = await freshAccount();
    await owned.db.insert(accountSettings).values({ accountId, resurfaceTime: "25:00" });
    expect((await consentSettings(ctxFor(accountId))).resurfaceTime).toBeNull();
  });

  it("the write is COLUMN-SCOPED — it does not clobber the four knobs beside it", async () => {
    const accountId = await freshAccount();
    const now = new Date();
    await owned.db.insert(accountSettings).values({
      accountId,
      dormancyDays: 120,
      autoSuggestAt: now,
      blockRemoteImagesAt: now,
      seedConfirmedAt: now,
    });

    await setResurfaceTime(ctxFor(accountId), "07:15");

    const [row] = await owned.db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, accountId));
    expect(row!.resurfaceTime).toBe("07:15");
    expect(row!.dormancyDays, "the time write took the dial with it").toBe(120);
    expect(row!.autoSuggestAt, "the time write disarmed auto-suggest").not.toBeNull();
    expect(row!.blockRemoteImagesAt, "the time write cleared the images opt-out").not.toBeNull();
    expect(row!.seedConfirmedAt, "the time write erased the onboarding consent event")
      .not.toBeNull();
  });
});
