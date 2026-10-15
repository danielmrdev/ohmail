import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { runMigrations } from "../src/migrate.js";
import { allocateSeq } from "../src/change-log.js";
import { schema } from "../src/schema.js";
import { pgTestUrl } from "../src/testing.js";

/**
 * Resolution the ONE test PGlite cannot host. Proves `allocateSeq` is
 * gap-free / no-duplicate / strictly-monotonic under TWO concurrent blocking
 * transactions on separate physical connections to a REAL Postgres (docker
 * compose service on :5433). A bare `bigserial` or an app-side read-modify-write
 * would leak gaps or duplicates here; the row-lock on account_sync_state cannot.
 */
const URL = pgTestUrl(import.meta.url);

const sqlA = postgres(URL, { max: 5 });
const sqlB = postgres(URL, { max: 5 });
const dbA = brandDialect(drizzle(sqlA, { schema }), "pg");
const dbB = brandDialect(drizzle(sqlB, { schema }), "pg");

describe("allocateSeq under real-Postgres concurrency", () => {
  beforeAll(async () => { await runMigrations(URL); });
  afterAll(async () => { await sqlA.end({ timeout: 5 }); await sqlB.end({ timeout: 5 }); });

  function assertContiguous(seqs: bigint[], total: number) {
    const sorted = [...seqs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(sorted).toHaveLength(total);
    expect(new Set(sorted.map(String)).size).toBe(total);             // no duplicates
    for (let i = 0; i < total; i++) expect(sorted[i]).toBe(BigInt(i + 1)); // gap-free 1..N, strictly monotonic
  }

  it("two long-lived blocking transactions each allocating K seqs → contiguous 1..2K", async () => {
    const acct = randomUUID();
    const K = 25;

    // Each transaction holds the account_sync_state row lock from its first
    // allocation until commit, so the other transaction BLOCKS on its first
    // allocateSeq — genuine concurrent-but-serialized writers.
    const worker = (db: typeof dbA) =>
      db.transaction(async (tx) => {
        const out: bigint[] = [];
        for (let i = 0; i < K; i++) out.push(await allocateSeq(tx, acct));
        return out;
      });

    const [ra, rb] = await Promise.all([worker(dbA), worker(dbB)]);

    // Each transaction's own allocations are internally contiguous (it held the lock).
    for (const run of [ra, rb]) {
      for (let i = 1; i < run.length; i++) expect(run[i]).toBe(run[i - 1]! + 1n);
    }
    assertContiguous([...ra, ...rb], 2 * K);
  });

  it("many concurrent small transactions across two connections → no gaps, no dupes", async () => {
    const acct = randomUUID();
    const N = 60;

    const tasks: Array<Promise<bigint>> = [];
    for (let i = 0; i < N; i++) {
      const db = i % 2 === 0 ? dbA : dbB;
      tasks.push(db.transaction((tx) => allocateSeq(tx, acct)));
    }
    const seqs = await Promise.all(tasks);
    assertContiguous(seqs, N);
  });

  /**
   * THE AUTOCOMMIT HANDLE IS REFUSED, LOUDLY.
   *
   * Everything above proves the row lock works INSIDE a transaction. On a top-level handle the
   * allocating UPDATE is its own transaction: it commits and releases the counter row lock before
   * its caller inserts the `change_log` row, so allocation 5 can still be unwritten while 6 is
   * committed and visible. A client polling `after=4` in that window advances its cursor to 6 and
   * can never be offered 5 again — the message behind seq 5 is permanently missing from that
   * mirror, with nothing failing anywhere.
   *
   * `allocateSeq(tx: LedgerTx, …)` makes that uncompilable for every direct caller, which is the
   * real fix; this covers the seam a type cannot reach — `DrizzleRepo`'s single `db` field, which
   * is legitimately either scope and therefore casts. Delete the `assertLedgerTx` call in
   * `allocateSeqRange` and this goes red by silently succeeding.
   */
  it("refuses a top-level handle instead of quietly committing the allocation on its own", async () => {
    const acct = randomUUID();
    await expect(allocateSeq(dbA as never, acct)).rejects.toThrow(/must be called inside db.transaction/);
    // And nothing was written: the refusal is BEFORE the statement, so no counter row appears and
    // no seq is burned.
    const rows = await sqlA<Array<{ n: string }>>`
      select count(*)::text as n from account_sync_state where account_id = ${acct}`;
    expect(rows[0]!.n).toBe("0");
  });
});
