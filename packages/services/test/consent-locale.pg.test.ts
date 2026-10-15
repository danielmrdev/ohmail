import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, accountSettings } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { SUPPORTED_LOCALES, consentSettings, setLocale } from "../src/consent-seed.js";
import type { ServiceContext } from "../src/context.js";

/**
 * `account_settings.locale` AGAINST REAL POSTGRES — mail 0053.
 *
 * Three things a PGlite-green cannot prove, and this repository has three production bugs on record
 * that were invisible until a `*.pg.test.ts` looked:
 *
 *  1. **THE COLUMN AND ITS CHECK ACTUALLY EXIST.** The migration is hand-written; nothing generates
 *     it and nothing else replays it in CI against a catalog. A `CHECK` that failed to apply leaves
 *     the column accepting anything, and every consumer of a bad locale degrades to English on
 *     purpose — so there is no error anywhere to find it by. This asserts the constraint by name and
 *     asserts that it REFUSES, which is the only way to know it is not decoration.
 *  2. **THE WRITE IS COLUMN-SCOPED UNDER A REAL CONFLICT.** `setLocale` upserts on the primary key
 *     alongside three other knobs that onboarding writes within the same minute. PGlite serialises
 *     these by construction and would report green for a writer that clobbered the row.
 *  3. **NULL IS WHAT IS STORED FOR THE DEFAULT.** Asserted against the column rather than against
 *     the echo, because the echo is code and the column is the fact every other device reads.
 */

const AVAILABLE = await realPgAvailable();

describe.skipIf(!AVAILABLE)("account_settings.locale against real Postgres", () => {
  let owned: OwnedDb;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
  }, 120_000);

  afterAll(async () => { await owned?.close().catch(() => {}); });

  async function freshAccount(): Promise<string> {
    const accountId = randomUUID();
    await owned.db.insert(accounts).values({ id: accountId, name: `loc-${accountId.slice(0, 8)}` });
    return accountId;
  }

  const ctxFor = (accountId: string): ServiceContext =>
    ({ db: owned.db, accountId, now: () => new Date() } as unknown as ServiceContext);

  it("the column exists, round-trips German, and the DEFAULT is stored as NULL", async () => {
    const accountId = await freshAccount();
    const ctx = ctxFor(accountId);

    // No row at all is a legal state and reads as "no preference".
    expect((await consentSettings(ctx)).locale).toBeNull();

    expect(await setLocale(ctx, "de")).toEqual({ locale: "de" });
    const [row] = await owned.db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, accountId));
    expect(row!.locale).toBe("de");
    expect((await consentSettings(ctx)).locale).toBe("de");

    // Asking for the default stores NOTHING — the column, not the echo, is what other devices read.
    expect(await setLocale(ctx, "en")).toEqual({ locale: null });
    const [afterEn] = await owned.db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, accountId));
    expect(afterEn!.locale,
      "storing 'en' would make this account OVERRIDE every device with the product default")
      .toBeNull();
  });

  it("the CHECK is real — the database refuses a locale nothing can load", async () => {
    const accountId = await freshAccount();
    await owned.db.insert(accountSettings).values({ accountId, locale: "de" });

    // The service refuses this too; here the SERVICE IS BYPASSED on purpose, because the question
    // is what a hand-run UPDATE, a future admin tool or a restore would meet.
    await expect(
      owned.db.execute(sql`update account_settings set locale = 'fr' where account_id = ${accountId}`),
    ).rejects.toThrow(/account_settings_locale_supported|violates check constraint/i);

    // …and the row is untouched by the refusal.
    const [row] = await owned.db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, accountId));
    expect(row!.locale).toBe("de");
  });

  it("the CHECK is named exactly what /health probes for, and admits NULL", async () => {
    // `SCHEMA_CHECK_MARKERS` in `packages/api/src/routes/health.ts` names this constraint, and a
    // deployment whose database is missing it answers `503 schema_incomplete` rather than serving a
    // language setting that silently does not work. The two spellings have to agree.
    const found = await owned.db.execute(sql`
      select conname, pg_get_constraintdef(oid) as def
      from pg_constraint
      where conrelid = 'account_settings'::regclass and conname = 'account_settings_locale_supported'
    `);
    const rows = found as unknown as Array<{ conname: string; def: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.def).toMatch(/locale IS NULL/i);
    for (const locale of SUPPORTED_LOCALES) {
      expect(rows[0]!.def, `the CHECK does not admit '${locale}'`).toContain(`'${locale}'`);
    }

    // NULL is admitted — the state every account starts in.
    const accountId = await freshAccount();
    await owned.db.insert(accountSettings).values({ accountId });
    const [row] = await owned.db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, accountId));
    expect(row!.locale).toBeNull();
  });

  it("the write is COLUMN-SCOPED — it does not clobber the three knobs beside it", async () => {
    const accountId = await freshAccount();
    const now = new Date();
    await owned.db.insert(accountSettings).values({
      accountId,
      dormancyDays: 120,
      autoSuggestAt: now,
      blockRemoteImagesAt: now,
      seedConfirmedAt: now,
    });

    await setLocale(ctxFor(accountId), "de");

    const [row] = await owned.db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, accountId));
    expect(row!.locale).toBe("de");
    expect(row!.dormancyDays, "the language write took the dial with it").toBe(120);
    expect(row!.autoSuggestAt, "the language write disarmed auto-suggest").not.toBeNull();
    expect(row!.blockRemoteImagesAt, "the language write cleared the images opt-out").not.toBeNull();
    expect(row!.seedConfirmedAt, "the language write erased the onboarding consent event")
      .not.toBeNull();
  });

  it("two concurrent writers on one primary key both land, and the row keeps both facts", async () => {
    // The upsert races `confirmSeed` and the other knobs on the SAME primary key. Run against real
    // Postgres because PGlite serialises this by construction: a writer that read-then-wrote the
    // whole row would pass there and lose one of the two settings here.
    const accountId = await freshAccount();
    const ctx = ctxFor(accountId);
    await Promise.all([
      setLocale(ctx, "de"),
      owned.db.insert(accountSettings)
        .values({ accountId, dormancyDays: 200 })
        .onConflictDoUpdate({ target: accountSettings.accountId, set: { dormancyDays: 200 } }),
    ]);
    const [row] = await owned.db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, accountId));
    expect(row!.locale).toBe("de");
    expect(row!.dormancyDays).toBe(200);
  });

  it("an unsupported value that somehow reached the column is refused on the READ side too", async () => {
    // The CHECK makes this unreachable through any writer. It is asserted anyway because the read
    // side's `SUPPORTED_LOCALES` filter is what stands between a restore from a pre-0053 database
    // and a client asking for a catalogue that does not exist — and a guard nobody has watched work
    // is not a guard. The constraint is dropped for the length of this case and put straight back.
    const accountId = await freshAccount();
    await owned.db.execute(
      sql`alter table account_settings drop constraint account_settings_locale_supported`);
    try {
      await owned.db.insert(accountSettings).values({ accountId, locale: "fr" });
      expect((await consentSettings(ctxFor(accountId))).locale,
        "an unsupported stored locale reached the client").toBeNull();
    } finally {
      await owned.db.execute(sql`delete from account_settings where account_id = ${accountId}`);
      await owned.db.execute(sql`
        alter table account_settings add constraint account_settings_locale_supported
        check (locale is null or locale in ('en', 'de'))`);
    }
  });
});
