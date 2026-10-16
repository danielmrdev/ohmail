import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { recordChange } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { makeChangeWakeHub } from "../src/wake-hub.js";

/**
 * THE WHOLE PUSH PATH, END TO END, AGAINST REAL POSTGRES:
 * `recordChanges` (NOTIFY at commit) → the hub's per-instance LISTEN → the account-scoped
 * callback an `/events` stream registers. PGlite cannot host this — LISTEN delivery across
 * physical connections is the thing under test — and no smaller test proves the two halves
 * actually speak the same channel and payload: the db side and the hub side each pass alone
 * with a typo'd channel name, and production then pushes nothing, silently, for ever.
 */
const PG_UP = await realPgAvailable();

const writerSql = postgres(PG_TEST_URL, { max: 5 });
const writer = brandDialect(drizzle(writerSql), "pg");

const waitFor = async (predicate: () => boolean, ms = 4_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) return;
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe.skipIf(!PG_UP)("makeChangeWakeHub against a real LISTEN", () => {
  beforeAll(async () => { await runMigrations(PG_TEST_URL); }, 60_000);
  afterAll(async () => { await writerSql.end({ timeout: 5 }); });

  it("a committed recordChange wakes THIS account's subscriber with the seq, and nobody else", async () => {
    const hub = makeChangeWakeHub(PG_TEST_URL);
    const acct = randomUUID();
    const other = randomUUID();
    const mine: bigint[] = [];
    const theirs: bigint[] = [];
    const un1 = hub.subscribe(acct, (seq) => { mine.push(seq); });
    const un2 = hub.subscribe(other, (seq) => { theirs.push(seq); });
    // The LISTEN dials lazily on the first subscribe; give it a beat to be established, or the
    // NOTIFY below can legitimately race the subscription (production's poll covers that gap).
    await new Promise((r) => setTimeout(r, 300));

    const seq = await writer.transaction((tx) =>
      recordChange(tx, { accountId: acct, entityType: "message", entityId: randomUUID(), op: "create" }));

    await waitFor(() => mine.length > 0);
    expect(mine, "the commit never reached the subscribed stream").toEqual([seq]);
    expect(theirs, "a wake crossed account boundaries").toEqual([]);

    un1();
    un1();                                   // idempotent — stop() can run twice
    un2();

    // After unsubscribe, further commits deliver nothing: a leaked callback would keep every
    // closed stream's closure alive for the instance's life.
    await writer.transaction((tx) =>
      recordChange(tx, { accountId: acct, entityType: "message", entityId: randomUUID(), op: "create" }));
    await new Promise((r) => setTimeout(r, 300));
    expect(mine).toEqual([seq]);
  }, 15_000);

  it("a hub with an unreachable database degrades silently: subscribe still answers, nothing throws", async () => {
    // Port 1 answers nothing. The stream this subscription belongs to must keep serving off
    // its poll loop, so the ONLY acceptable behaviours here are quiet ones.
    const hub = makeChangeWakeHub("postgres://u:p@127.0.0.1:1/nope?connect_timeout=1", { error: () => {} });
    const un = hub.subscribe(randomUUID(), () => {});
    await new Promise((r) => setTimeout(r, 200));
    expect(typeof un).toBe("function");
    un();
  }, 15_000);
});
