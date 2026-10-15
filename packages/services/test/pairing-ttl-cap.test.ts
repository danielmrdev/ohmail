import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, users } from "@trafficflow/db";
import type { ServiceContext } from "../src/context.js";
import { DEVICE_PAIR_TTL_MS, PAIRING_TTL_BOUNDS, mintPairingToken } from "../src/pairing.js";

/**
 * A DEVICE-PAIR CODE LIVES FIVE MINUTES, AND NOTHING MINTS ONE LONGER. The default was five and the
 * ceiling fifteen, so the hosted `POST /pair` admitted a quarter-hour code the page said could not
 * exist. Default and ceiling are one constant now: 300 seconds is admitted, 301 refused by name.
 */
const NOW = new Date("2026-10-05T12:00:00.000Z");

async function minter(): Promise<(ttlSeconds?: number) => ReturnType<typeof mintPairingToken>> {
  const db = await makeTestDb();
  const [acct] = await db.insert(accounts).values({ name: "p" }).returning();
  const [user] = await db.insert(users).values({ accountId: acct!.id, email: `p+${randomUUID()}@example.test` }).returning();
  const ctx: ServiceContext = {
    db: db as unknown as ServiceContext["db"], accountId: acct!.id, userId: user!.id, sessionId: null,
    now: () => NOW, requestId: `cap-${randomUUID()}`, ip: "192.0.2.1",
  };
  return (ttlSeconds) => mintPairingToken(ctx, { grant: "device-pair", ...(ttlSeconds === undefined ? {} : { ttlSeconds }) });
}

describe("the device-pair code's ceiling is its default", () => {
  it("one constant: five minutes, default and ceiling", () => {
    expect(DEVICE_PAIR_TTL_MS).toBe(5 * 60_000);
    expect(PAIRING_TTL_BOUNDS["device-pair"]).toMatchObject({ defaultMs: DEVICE_PAIR_TTL_MS, maxMs: DEVICE_PAIR_TTL_MS });
  });

  it("300 seconds is admitted, the default is the same five minutes, and 301 is refused by name", async () => {
    const mint = await minter();
    expect((await mint(300)).expiresAt.getTime() - NOW.getTime()).toBe(300_000);
    expect((await mint()).expiresAt.getTime() - NOW.getTime()).toBe(300_000);
    await expect(mint(301)).rejects.toMatchObject({
      code: "validation_failed", message: "ttlSeconds for a device-pair token must be between 60 and 300",
    });
  });
});
