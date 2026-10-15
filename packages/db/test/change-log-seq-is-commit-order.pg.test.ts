import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { brandDialect } from "../src/dialect/index.js";
import { recordChanges } from "../src/change-log.js";
import { schema } from "../src/schema.js";
import { runMigrations } from "../src/migrate.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * ═══ A READER PARKED AT `max(seq)` HAS SEEN EVERY ROW BELOW IT ══════════════════════════════
 *
 * The polled list's cheap unchanged answer rests on one identity: a cursor equal to
 * `max(change_log.seq)` means the empty delta, exactly — not probably. That is true only while no
 * row with a seq at or below the one a reader just read can become VISIBLE afterwards. Two
 * writers whose allocations overlap would break it: the one holding the LOWER seq could commit
 * SECOND, a reader between the two commits would read the higher seq as its max, and the lower
 * row would appear below a cursor that had already passed it — gone for ever, with no error
 * anywhere and the window quietly missing a message.
 *
 * ── WHY IT CANNOT HAPPEN, read out of the code rather than assumed ──────────────────────────
 *
 * `recordChanges` allocates through `allocateSeqRange`, which opens with
 * `assertLedgerTx(tx, "allocateSeqRange")` — a handle with no `rollback` is refused with
 * `NotInTransactionError`, so the allocation is inside the caller's transaction by refusal and
 * not by convention. Its UPDATE of `account_sync_state.next_seq` takes that counter row's lock,
 * and PostgreSQL holds a row lock until the transaction ends. So a second writer cannot ALLOCATE
 * until the first has COMMITTED: allocation order is commit order, and the visible seqs are
 * always a contiguous prefix.
 *
 * ── WHAT THIS FILE DRIVES ───────────────────────────────────────────────────────────────────
 *
 * Two real writers on two real connections, deliberately overlapped so the second asks for its
 * seq while the first is still uncommitted, and a reader sampling throughout. Every sample must
 * be a contiguous prefix. The second arm is the control that the first is not vacuous: the SAME
 * reader, against the unsafe shape the assertion exists to forbid (allocate in one autocommit
 * statement, insert in another), SEES a skip — so the assertion can fail, and what stops it is
 * the transaction rather than the test's own timing.
 *
 * ── HOW TO WATCH THE PRODUCT ARM FAIL ───────────────────────────────────────────────────────
 *
 * Delete the `assertLedgerTx(tx, "allocateSeqRange")` line in `packages/db/src/change-log.ts` and
 * hand `recordChanges` the bare `db` here instead of `tx`: the allocation auto-commits, the
 * writers interleave, and the prefix assertion reddens naming the seq the reader stepped over.
 */

const PG_UP = await realPgAvailable();
const sql = postgres(PG_TEST_URL, { max: 8, onnotice: () => {} });
const db = brandDialect(drizzle(sql, { schema }), "pg");

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await sql.end({ timeout: 5 }); });

/** Every seq this account has, in order — the reader's whole world. */
async function visibleSeqs(accountId: string): Promise<number[]> {
  const rows = await sql`select seq from change_log where account_id = ${accountId} order by seq`;
  return rows.map((r) => Number(r.seq));
}

/** A contiguous run from 1, which is what "no row was skipped" means for a fresh account. */
function isPrefix(seqs: number[]): boolean {
  return seqs.every((s, i) => s === i + 1);
}

const change = (accountId: string) => ({
  accountId, entityType: "draft" as const, entityId: randomUUID(), op: "update" as const, meta: null,
});

describe.skipIf(!PG_UP)("a reader parked at max(seq) never steps over a row", () => {
  it("two overlapping writers commit in seq order, and every sample is a contiguous prefix", async () => {
    const accountId = randomUUID();
    const samples: number[][] = [];
    let sampling = true;
    const reader = (async () => {
      while (sampling) {
        samples.push(await visibleSeqs(accountId));
        await new Promise((r) => setTimeout(r, 2));
      }
      samples.push(await visibleSeqs(accountId));
    })();

    /* THE OVERLAP, MADE TO HAPPEN rather than hoped for: A allocates and then waits on a promise
       this test resolves, so B is provably asking for its seq while A is uncommitted. */
    let releaseA = (): void => {};
    const aHolds = new Promise<void>((r) => { releaseA = r; });
    let aAllocated = (): void => {};
    const aHasAllocated = new Promise<void>((r) => { aAllocated = r; });

    const writerA = db.transaction(async (tx) => {
      await recordChanges(tx as never, [change(accountId)]);
      aAllocated();
      await aHolds;
    });
    await aHasAllocated;

    let bDone = false;
    const writerB = db.transaction(async (tx) => {
      await recordChanges(tx as never, [change(accountId)]);
    }).then(() => { bDone = true; });

    // B is blocked on the counter's row lock — not merely slow. 250 ms is two orders of magnitude
    // more than the allocation takes when it is free, and it is asserted rather than assumed.
    await new Promise((r) => setTimeout(r, 250));
    expect(bDone, "the second writer allocated while the first held the counter — the row lock is not serializing")
      .toBe(false);

    releaseA();
    await writerA;
    await writerB;
    sampling = false;
    await reader;

    // THE READING. Every sample the reader took is a contiguous prefix of the account's log.
    for (const [i, s] of samples.entries()) {
      expect(isPrefix(s), `sample ${i} skipped a row: ${JSON.stringify(s)}`).toBe(true);
    }
    expect(await visibleSeqs(accountId)).toEqual([1, 2]);
    // The positive control for the RACE: the reader saw the log part-written, so the samples
    // cover the window the identity is about rather than only its two ends.
    expect(samples.some((s) => s.length === 0), "the reader never saw the log empty").toBe(true);
    expect(samples.length, "the reader took too few samples to have watched anything").toBeGreaterThan(5);
  }, 60_000);

  it("CONTROL — the unsafe shape this forbids produces the skip, so the assertion above can fail", async () => {
    const accountId = randomUUID();
    /* The allocation and the insert as two AUTOCOMMIT statements, which is what
       `assertLedgerTx` refuses: the counter moves and the lock is gone at the end of its own
       statement, so a second writer allocates immediately and can insert FIRST. */
    const allocate = async (): Promise<number> => {
      await sql`insert into account_sync_state (account_id) values (${accountId}) on conflict do nothing`;
      const [row] = await sql`update account_sync_state set next_seq = next_seq + 1
        where account_id = ${accountId} returning next_seq`;
      return Number(row!.next_seq);
    };
    const insert = async (seq: number): Promise<void> => {
      await sql`insert into change_log (account_id, seq, entity_type, entity_id, op)
        values (${accountId}, ${seq}, 'draft', ${randomUUID()}, 'update')`;
    };

    const seqA = await allocate();
    const seqB = await allocate();
    expect([seqA, seqB]).toEqual([1, 2]);
    // The later seq lands FIRST — the ordering the transaction makes impossible.
    await insert(seqB);
    const seen = await visibleSeqs(accountId);
    expect(seen, "the unsafe shape did not produce the skip this control exists to show").toEqual([2]);
    expect(isPrefix(seen), "a reader here reads max = 2 with seq 1 still to come").toBe(false);
    await insert(seqA);
    expect(await visibleSeqs(accountId)).toEqual([1, 2]);
  }, 60_000);
});
