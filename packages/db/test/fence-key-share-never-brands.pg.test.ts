import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect, dialect } from "@trafficflow/db/dialect";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, AccountErasedError, fenceErased, fencedAccountOf, fencedAccountWrite, type Tx } from "../src/index.js";

/**
 * A KEY-SHARE READ NEVER BRANDS A TRANSACTION AS FENCED (REVIEW-026 LOW-1). The erasure's stamp is a
 * plain UPDATE, which waits on FOR SHARE and not on FOR KEY SHARE, so only a share-or-stronger opener
 * may let a later fence in its transaction skip the account read. Driven with the stamp on a second
 * connection: under a key-share opener it lands and the inner fence refuses; under share it waits.
 */
const PG_UP = await realPgAvailable();
let client: ReturnType<typeof postgres>;
let sweep: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  if (!PG_UP) return;
  await runMigrations(PG_TEST_URL);
  client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
  sweep = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
  db = brandDialect(drizzle(client, { schema }), "pg");
});
afterAll(async () => { await client?.end({ timeout: 5 }); await sweep?.end({ timeout: 5 }); });

/** The erasure's first statement, bounded so a held lock answers 55P03 rather than hanging. */
async function stamp(accountId: string): Promise<string> {
  return sweep.begin(async (s) => {
    await s`set local lock_timeout = '1500ms'`;
    await s`update accounts set erased_at = now() where id = ${accountId}`;
  }).then(() => "stamped", (e: { code?: string }) => `refused:${e.code ?? "?"}`);
}

async function race(lock: "share" | "key share"): Promise<{ branded: boolean; stamp: string; writer: string }> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "fence-key-share" });
  let branded = false;
  let open!: () => void; const opened = new Promise<void>((r) => { open = r; });
  let go!: () => void; const gate = new Promise<void>((r) => { go = r; });
  const writer = fencedAccountWrite(db as unknown as Tx, { accountId, lock }, async (tx) => {
    branded = fencedAccountOf(tx) === accountId;
    open();
    await gate;
    try { await fenceErased(tx, dialect(tx), { accountId }); } catch (e) { return e instanceof AccountErasedError ? "refused" : "other"; }
    return "wrote";
  });
  await opened;
  const s = await stamp(accountId);
  go();
  return { branded, stamp: s, writer: await writer };
}

describe.skipIf(!PG_UP)("the erasure fence's brand on real Postgres", () => {
  it("a key-share opener is not branded: the stamp lands and the transaction's next fence refuses", async () => {
    expect(await race("key share")).toEqual({ branded: false, stamp: "stamped", writer: "refused" });
  });

  it("CONTROL: a share opener is branded, and the stamp waits on its hold", async () => {
    expect(await race("share")).toEqual({ branded: true, stamp: "refused:55P03", writer: "wrote" });
  });
});
