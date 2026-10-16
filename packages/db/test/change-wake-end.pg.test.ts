import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { recordChange } from "../src/change-log.js";
import { runMigrations } from "../src/migrate.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { makeChangeWakeHub } from "../src/change-wake.js";

/**
 * THE ONE ADDITION the extraction made: `end()` — the prompt LISTEN release a SIGTERM-driven
 * host needs. Everything else about the hub is proven where it always was
 * (`apps/api-vercel/test/wake-hub.pg.test.ts` runs UNMOVED through that host's re-export shim,
 * which also pins the exact import path the managed composition uses; `wake-e2e.pg.test.ts`
 * proves the channel end to end). This file holds only the new guard: without `end()`, a
 * shutdown leaves the LISTEN connection holding the event loop for up to IDLE_CLOSE_MS after
 * the last stream — measured as a hang, which is why the method exists.
 */
const PG_UP = await realPgAvailable();

const writerSql = postgres(PG_TEST_URL, { max: 2 });
const writer = brandDialect(drizzle(writerSql), "pg");

const waitFor = async (predicate: () => boolean, ms = 4_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) return;
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe.skipIf(!PG_UP)("makeChangeWakeHub#end — the shutdown release", () => {
  beforeAll(async () => { await runMigrations(PG_TEST_URL); }, 60_000);
  afterAll(async () => { await writerSql.end({ timeout: 5 }); });

  it("end() releases a LIVE listen: later commits deliver nothing, and end() is idempotent", async () => {
    const hub = makeChangeWakeHub(PG_TEST_URL);
    const acct = randomUUID();
    const seen: bigint[] = [];
    hub.subscribe(acct, (seq) => { seen.push(seq); });
    await new Promise((r) => setTimeout(r, 300));   // let the lazy LISTEN establish

    await writer.transaction((tx) =>
      recordChange(tx, { accountId: acct, entityType: "message", entityId: randomUUID(), op: "create" }));
    await waitFor(() => seen.length > 0);
    expect(seen).toHaveLength(1);                    // the LISTEN was genuinely live

    await hub.end();
    await hub.end();                                 // idempotent — a second SIGTERM path costs nothing

    await writer.transaction((tx) =>
      recordChange(tx, { accountId: acct, entityType: "message", entityId: randomUUID(), op: "create" }));
    await new Promise((r) => setTimeout(r, 500));
    // Nothing more arrives: the connection is gone NOW, not IDLE_CLOSE_MS from now. (The
    // subscriber was never unsubscribed — end() must not depend on tidy callers at shutdown.)
    expect(seen).toHaveLength(1);
  });

  it("end() before any subscribe is a no-op that does not throw", async () => {
    const hub = makeChangeWakeHub(PG_TEST_URL);
    await expect(hub.end()).resolves.toBeUndefined();
  });
});
