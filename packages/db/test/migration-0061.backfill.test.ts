import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { sql, eq } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
import { accounts, users, devices, sessions } from "../src/index.js";

/**
 * Proves migration 0061 (DEVICES) does exactly what its header claims, against SEEDED
 * old-shape data — the statements are read from the journal FILE, so the SQL under test is
 * the SQL production runs, not a re-typing of it. Four rows, one per arm of the predicate:
 *
 *  · an auto-minted "Web" device on a COOKIE-window session (90d)   → detached AND deleted
 *  · a PAIRED web-kind device someone labeled exactly "Web", on a
 *    NATIVE-window session (400d)                                   → kept, twice over (the
 *    interval conjunct excludes its session; the NOT-EXISTS keeps its row)
 *  · a paired device with a real label                              → untouched
 *  · the macos claim's "ohmail for Mac" row                         → untouched (kind)
 *
 * And the property the deploy leans on: RE-RUNNING both statements changes nothing.
 */

const MIGRATION = new URL("../../db-mail/drizzle/0061_web_sessions_deviceless.sql", import.meta.url);
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-21T12:00:00.000Z");

describe("migration 0061 backfill (web sessions go device-less)", () => {
  it("detaches exactly the auto-minted cookie-window rows; every named device survives", async () => {
    const db = await makeTestDb();
    const [acct] = await db.insert(accounts).values({ name: "B" }).returning();
    const [user] = await db.insert(users)
      .values({ accountId: acct!.id, email: "b@x.example", displayName: "B" }).returning();
    const me = { accountId: acct!.id, userId: user!.id };

    const mkDevice = async (label: string, kind = "web") =>
      (await db.insert(devices).values({ ...me, kind, label }).returning())[0]!.id;
    const mkSession = async (deviceId: string | null, windowMs: number) =>
      (await db.insert(sessions).values({
        ...me, deviceId, familyId: crypto.randomUUID(), accessTokenHash: "h",
        accessExpiresAt: new Date(NOW.getTime() + 60_000),
        // The lockstep invariant `establish`/`mintRotation` write: refresh window from NOW.
        refreshExpiresAt: new Date(NOW.getTime() + windowMs),
        lastSeenAt: NOW,
      }).returning())[0]!;

    // The flood: two historical browser sign-ins, each with its auto "Web" row (90d window).
    const auto1 = await mkDevice("Web");
    const auto2 = await mkDevice("Web");
    const s1 = await mkSession(auto1, 90 * DAY);
    const s2 = await mkSession(auto2, 90 * DAY);
    // The collision the interval conjunct exists for: a PAIRED device deliberately labeled
    // "Web" — its session is a native bearer (400d window), so the arithmetic excludes it.
    const collision = await mkDevice("Web");
    const sCollision = await mkSession(collision, 400 * DAY);
    // Ordinary named devices.
    const phone = await mkDevice("Mila's phone");
    const sPhone = await mkSession(phone, 400 * DAY);
    const mac = await mkDevice("ohmail for Mac", "macos");
    const sMac = await mkSession(mac, 400 * DAY);

    const src = readFileSync(fileURLToPath(MIGRATION), "utf8");
    const run = async () => {
      for (const stmt of src.split("--> statement-breakpoint")) {
        const s = stmt.trim();
        if (s) await db.execute(sql.raw(s));
      }
    };
    await run();

    const sessionById = async (id: string) =>
      (await db.select().from(sessions).where(eq(sessions.id, id)))[0]!;
    const deviceExists = async (id: string) =>
      (await db.select().from(devices).where(eq(devices.id, id))).length === 1;

    // The auto rows: sessions detached, rows gone.
    expect((await sessionById(s1.id)).deviceId).toBeNull();
    expect((await sessionById(s2.id)).deviceId).toBeNull();
    expect(await deviceExists(auto1)).toBe(false);
    expect(await deviceExists(auto2)).toBe(false);
    // Detached is NOT revoked: the sessions keep their lifecycle columns untouched.
    expect((await sessionById(s1.id)).revokedAt).toBeNull();

    // The collision: excluded by its own surface arithmetic, kept whole.
    expect((await sessionById(sCollision.id)).deviceId).toBe(collision);
    expect(await deviceExists(collision)).toBe(true);
    // The named devices: untouched.
    expect((await sessionById(sPhone.id)).deviceId).toBe(phone);
    expect((await sessionById(sMac.id)).deviceId).toBe(mac);
    expect(await deviceExists(phone)).toBe(true);
    expect(await deviceExists(mac)).toBe(true);

    // Idempotent: the runbook's post-alias re-run is a no-op on already-migrated data.
    const before = await db.select().from(sessions);
    await run();
    const after = await db.select().from(sessions);
    expect(after).toEqual(before);
  });
});
