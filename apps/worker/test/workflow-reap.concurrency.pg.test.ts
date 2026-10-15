import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq, sql as sqlExpr } from "drizzle-orm";
import { auditLog, folderState, kbEntries, mailboxes, messages, workflows, workflowRuns, type Tx } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { workflowDrainPass, unconfiguredDrafter, STALE_CLAIM_MS } from "../src/workflow-cron.js";
import { pgTestUrl } from "@trafficflow/db/testing";

/**
 * CRASH-RESUME, and the two properties PGlite structurally cannot decide.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────────────────────
 *
 * `workflowDrainPass` claimed a run `pending → running` and handed it to the step runner. A worker
 * that died in between — a Railway deploy, an OOM kill, a lost lock — left the row at `running`
 * for ever: the drain selected `status='pending'` ONLY, so nothing ever looked at that row
 * again. Never retried, never failed, never surfaced. `test/every-pass-has-a-producer.test.ts`
 * part B was red on exactly this.
 *
 * ── WHY THE STRANDED ROW IS CONSTRUCTED AND NOT PRODUCED ──────────────────────────────────
 *
 * A genuine mid-run death cannot be staged from inside the process under test: every failure
 * the step runner can *observe* is caught and marks the run `failed`, which is terminal and
 * correct. The stranding case is precisely the one where no code ran at all after the claim. So
 * these tests write the row state a `SIGKILL` leaves behind — `status='running'`, a `stepCursor`
 * at whatever committed, a `claimed_at` in the past — and assert what happens to it next. That
 * IS the input the reaper exists to handle.
 *
 * ── WHY REAL POSTGRES (:5433) ─────────────────────────────────────────────────────────────
 *
 * The second case races two reapers on SEPARATE physical connections. The guard is an UPDATE
 * that re-asserts both `status='running'` and the OBSERVED `claimed_at`, so the loser matches 0
 * rows — and "matches 0 rows because the other connection's UPDATE committed first" is a claim
 * about two connections. PGlite has one, on which two `drainPass` calls interleave inside a
 * single serialized session and a broken guard would still look green. A reaper two workers can
 * both win is worse than the stranding it fixes: it puts two step runners on one run.
 */
const URL_ = pgTestUrl(import.meta.url);

/** Fixed clock. `claimed_at` is always written relative to it, never to the wall clock. */
const NOW = new Date("2026-07-28T12:00:00Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

/** Comfortably past the threshold, and comfortably inside it. */
const STALE = ago(STALE_CLAIM_MS + 60_000);
const FRESH = ago(60_000);

const sqlA = postgres(URL_, { max: 5 });
const sqlB = postgres(URL_, { max: 5 });
/** The BARRIER connection. `max: 1` so BEGIN / … / ROLLBACK are provably one session. */
const sqlC = postgres(URL_, { max: 1 });
const dbA = brandDialect(drizzle(sqlA, { schema }), "pg");
const dbB = brandDialect(drizzle(sqlB, { schema }), "pg");

interface Seeded { accountId: string; messageId: string }

/**
 * One account with one message. The account id is a fresh uuid per case and EVERY statement
 * below is scoped to it — this database is shared with every other `*.pg.test.ts`, and an
 * unscoped `UPDATE workflow_runs` here would reach another file's rows.
 */
async function seed(): Promise<Seeded> {
  const accountId = randomUUID();
  const [mb] = await dbA.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `s39-${randomUUID().slice(0, 8)}@tf.example` }).returning();
  const dedup = `mid:${randomUUID()}`;
  const [m] = await dbA.insert(messages).values({
    accountId, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
    subject: "s", fromAddress: "a@ex.example", snippet: "x", nativeLocator: { folder: "INBOX", ref: "1:1" },
  }).returning();
  return { accountId, messageId: m!.id };
}

/** The two-step deterministic workflow: a desired-state move, then a KB write. No drafter, no money. */
function twoSteps(messageId: string): unknown[] {
  return [
    { tool: "file_message", args: { messageId, toFolder: "ohmail/News" } },
    { tool: "add_kb_entry", args: { title: "t", content: "c" } },
  ];
}

/** A run row written DIRECTLY into the post-crash state: claimed, never finished. */
async function stranded(
  w: Seeded, steps: unknown[], cursor: number, claimedAt: Date | null, createdAt?: Date,
): Promise<string> {
  const [wf] = await dbA.insert(workflows).values({
    accountId: w.accountId, name: "wf", enabled: true, trigger: { kind: "manual" }, steps,
  }).returning();
  const [run] = await dbA.insert(workflowRuns).values({
    accountId: w.accountId, workflowId: wf!.id, status: "running", trigger: { kind: "manual" },
    stepCursor: cursor, claimedAt, ...(createdAt ? { createdAt } : {}),
  }).returning();
  return run!.id;
}

const runRow = async (id: string): Promise<typeof workflowRuns.$inferSelect> =>
  (await dbA.select().from(workflowRuns).where(eq(workflowRuns.id, id)))[0]!;

/** Scoped to ONE account, always. */
const kbOf = (accountId: string): Promise<unknown[]> =>
  dbA.select().from(kbEntries).where(eq(kbEntries.accountId, accountId));

/**
 * How many backends are currently BLOCKED on a lock inside a `workflow_runs` statement.
 *
 * The race below is worthless without this. Two `Promise.all`'d passes do not reliably
 * interleave: pool B's SELECT lands after pool A's UPDATE has already committed, B sees nothing
 * stale, and no race occurs. Measured, not assumed — a reaper with BOTH re-assertions deleted
 * from its UPDATE passed that version of this test. So the test holds a row lock, waits until
 * both reapers are provably parked on it, and only then lets go.
 */
async function blockedOnWorkflowRuns(): Promise<number> {
  const [row] = await sqlA<Array<{ n: number }>>`
    select count(*)::int as n from pg_stat_activity
     where datname = current_database()
       and wait_event_type = 'Lock'
       and query ilike '%workflow_runs%'`;
  return row!.n;
}

async function waitForBlocked(n: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await blockedOnWorkflowRuns() >= n) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${n} backends to block on workflow_runs`);
}

beforeAll(async () => { await runMigrations(URL_); }, 120_000);
afterAll(async () => {
  await sqlA.end({ timeout: 5 });
  await sqlB.end({ timeout: 5 });
  await sqlC.end({ timeout: 5 });
});

describe("a run stranded in `running` is reclaimed (real Postgres)", () => {
  it("past the threshold: reclaimed, resumed and finished", async () => {
    const w = await seed();
    const runId = await stranded(w, twoSteps(w.messageId), 0, STALE);

    const res = await workflowDrainPass(
      dbA as unknown as Tx, { drafter: unconfiguredDrafter, accountId: w.accountId }, NOW,
    );
    expect(res.reaped).toBe(1);
    expect(res.drained).toBe(1);

    const run = await runRow(runId);
    expect(run.status).toBe("succeeded");
    expect(run.stepCursor).toBe(2);
    // Both effects landed: the run really executed rather than merely changing status.
    const [fs] = await dbA.select().from(folderState).where(eq(folderState.messageId, w.messageId));
    expect(fs!.desiredFolder).toBe("ohmail/News");
    expect(await kbOf(w.accountId)).toHaveLength(1);
  });

  it("RESUMES FROM THE CURSOR — a step that already committed is not re-run", async () => {
    // The ruling under test. `stepCursor: 1` says step 0 committed before the crash, so a
    // resumed run must execute step 1 ONLY. A reaper that restarted the run from zero would
    // re-apply step 0 — which for `file_message` is a user-visible mailbox move.
    const w = await seed();
    const runId = await stranded(w, twoSteps(w.messageId), 1, STALE);

    const res = await workflowDrainPass(
      dbA as unknown as Tx, { drafter: unconfiguredDrafter, accountId: w.accountId }, NOW,
    );
    expect(res.reaped).toBe(1);

    expect((await runRow(runId)).status).toBe("succeeded");
    // Step 1 ran…
    expect(await kbOf(w.accountId)).toHaveLength(1);
    // …and step 0 did NOT: no folder_state row exists for this message at all.
    expect(await dbA.select().from(folderState).where(eq(folderState.messageId, w.messageId)))
      .toEqual([]);
    // Exactly one audit row, and it is step 1's — the canonical proof of what was applied.
    const audits = await dbA.select({ payload: auditLog.payload }).from(auditLog)
      .where(and(eq(auditLog.accountId, w.accountId), eq(auditLog.action, "workflow_step")));
    expect(audits).toHaveLength(1);
    expect((audits[0]!.payload as { stepIndex: number }).stepIndex).toBe(1);
  });

  it("INSIDE the threshold: a live worker's run is left alone", async () => {
    // The safety half, and the reason the threshold exists at all. Reaping a run whose owner is
    // merely slow puts a second step runner on it. Nothing may be touched here.
    const w = await seed();
    const runId = await stranded(w, twoSteps(w.messageId), 0, FRESH);

    const res = await workflowDrainPass(
      dbA as unknown as Tx, { drafter: unconfiguredDrafter, accountId: w.accountId }, NOW,
    );
    expect(res.reaped).toBe(0);
    expect(res.drained).toBe(0);

    const run = await runRow(runId);
    expect(run.status).toBe("running");
    expect(run.claimedAt?.toISOString()).toBe(FRESH.toISOString());
    expect(run.stepCursor).toBe(0);
    expect(await kbOf(w.accountId)).toEqual([]);
  });

  it("a NULL claimed_at falls back to created_at — the pre-migration row is reapable", async () => {
    // Rows already stranded when this shipped carry no claim stamp, and so does anything the OLD
    // code claims during the deploy window. This arm is the ONLY thing that rescues either:
    // `0033` deliberately ships no backfill, because `claimed_at = created_at` would copy a
    // microsecond-precision `now()` into a column whose guard re-asserts a millisecond-precision
    // JS `Date` — selected as stale for ever, requeued never. So this case is not a nicety; it
    // is the whole migration path for the existing backlog.
    const w = await seed();
    const runId = await stranded(w, twoSteps(w.messageId), 0, null, ago(3600_000));

    const res = await workflowDrainPass(
      dbA as unknown as Tx, { drafter: unconfiguredDrafter, accountId: w.accountId }, NOW,
    );
    expect(res.reaped).toBe(1);
    expect((await runRow(runId)).status).toBe("succeeded");
  });

  it("a MICROSECOND-precision stamp is unreapable — the measurement behind 0033's missing backfill", async () => {
    // READ THE ASSERTION AS A CONSTRAINT ON WRITERS, NOT AS DESIRED BEHAVIOUR. A row in this
    // state is a bug; this case exists so that the bug is reproducible instead of merely
    // described, because it is invisible everywhere else.
    //
    // The reaper's guarded requeue re-asserts the `claimed_at` it observed, and that observation
    // has round-tripped through a JS `Date` — milliseconds. Postgres `now()` stores microseconds.
    // So a stamp written from SQL time can never be matched again: the row is SELECTED as stale
    // on every pass (`reaped` stays 0 only because the UPDATE matches nothing) and requeued by
    // none of them. It is stranded exactly as before, with a column that says otherwise.
    //
    // That is why `claimed_at` is documented as JS-`Date`-only, and why migration 0033 ships no
    // `claimed_at = created_at` backfill: the backfill would have put EVERY already-stranded run
    // permanently into this state, and no fixture-based test could have noticed.
    const w = await seed();
    const runId = await stranded(w, twoSteps(w.messageId), 0, STALE);
    // Overwrite the well-formed stamp with a microsecond one, scoped to this run alone.
    await dbA.execute(
      sqlExpr`update workflow_runs set claimed_at = ${STALE.toISOString()}::timestamptz + interval '402 microseconds'
                where id = ${runId}::uuid`,
    );

    const res = await workflowDrainPass(
      dbA as unknown as Tx, { drafter: unconfiguredDrafter, accountId: w.accountId }, NOW,
    );
    expect(res.reaped).toBe(0);
    expect((await runRow(runId)).status).toBe("running");

    // …and the same row with the sub-millisecond part removed reaps immediately, so the failure
    // is attributable to the precision and to nothing else about this row.
    await dbA.update(workflowRuns).set({ claimedAt: STALE }).where(eq(workflowRuns.id, runId));
    const again = await workflowDrainPass(
      dbA as unknown as Tx, { drafter: unconfiguredDrafter, accountId: w.accountId }, NOW,
    );
    expect(again.reaped).toBe(1);
    expect((await runRow(runId)).status).toBe("succeeded");
  });

  it("scopes to deps.accountId — another shard's stranded run is untouched", async () => {
    const mine = await seed();
    const theirs = await seed();
    await stranded(mine, twoSteps(mine.messageId), 0, STALE);
    const theirRun = await stranded(theirs, twoSteps(theirs.messageId), 0, STALE);

    const res = await workflowDrainPass(
      dbA as unknown as Tx, { drafter: unconfiguredDrafter, accountId: mine.accountId }, NOW,
    );
    expect(res.reaped).toBe(1);

    const other = await runRow(theirRun);
    expect(other.status).toBe("running");
    expect(other.claimedAt?.toISOString()).toBe(STALE.toISOString());
  });
});

describe("two concurrent reapers cannot both claim one stranded run", () => {
  it("TWO POOLS, one stranded run → exactly ONE reap and exactly ONE execution", async () => {
    // THE ASSERTION PGLITE CANNOT MAKE. Both connections SELECT the same row and see the same
    // `claimed_at`; both then issue the guarded UPDATE. Postgres serializes them, the winner
    // moves the row to `pending` and NULLs the stamp, and the loser — re-evaluating its WHERE
    // against the winner's committed version, which is what READ COMMITTED does after a lock
    // wait — no longer matches `status='running' AND claimed_at = <observed>`. 0 rows.
    //
    // `reaped` is asserted and not just `drained`, deliberately. If only the execution count
    // were checked, a reaper that both workers won would still pass here, rescued by the
    // drain's own `pending → running` guard one layer down — and the defect would ship
    // invisibly, surfacing only when a reap and a claim interleaved differently.
    const w = await seed();
    const runId = await stranded(w, twoSteps(w.messageId), 0, STALE);

    // THE BARRIER. Hold the row's write lock on a third session so neither reaper's UPDATE can
    // commit until both have passed their SELECT, then release. Without it the two passes
    // serialize by luck and no race is run at all — this test was green against a reaper with
    // both re-assertions deleted until the barrier existed. A plain `SELECT` is not blocked by
    // `FOR UPDATE`, so both reapers still observe the row as stale; only their UPDATEs park.
    await sqlC`begin`;
    await sqlC`select id from workflow_runs where id = ${runId}::uuid for update`;

    const race = Promise.all([
      workflowDrainPass(dbA as unknown as Tx, { drafter: unconfiguredDrafter, accountId: w.accountId }, NOW),
      workflowDrainPass(dbB as unknown as Tx, { drafter: unconfiguredDrafter, accountId: w.accountId }, NOW),
    ]);
    await waitForBlocked(2);
    // ROLLBACK: the barrier only ever held a lock. It wrote nothing, so the row the reapers
    // fight over is exactly the one they each read.
    await sqlC`rollback`;
    const [ra, rb] = await race;

    expect(ra.reaped + rb.reaped).toBe(1);
    expect(ra.drained + rb.drained).toBe(1);

    const run = await runRow(runId);
    expect(run.status).toBe("succeeded");
    // And the effects happened ONCE. `add_kb_entry` carries a unique `workflow_dedup_key`, so a
    // double execution shows up as one row plus a swallowed conflict rather than two rows —
    // hence the audit trail, which has no ON CONFLICT and would carry two rows for step 0.
    expect(await kbOf(w.accountId)).toHaveLength(1);
    const audits = await dbA.select({ id: auditLog.id }).from(auditLog)
      .where(and(eq(auditLog.accountId, w.accountId), eq(auditLog.action, "workflow_step")));
    expect(audits).toHaveLength(2);   // step 0 and step 1, once each
  });

  it("ABA: a run RE-CLAIMED between the reaper's read and its write is not stolen", async () => {
    // This is the case the `claimed_at` half of the guard exists for, and the only one that can
    // tell it from decoration. Re-asserting `status='running'` alone is not enough, because the
    // status comes BACK: reaper A reads a stale row, another worker requeues and re-claims it in
    // the meantime, and by the time A's UPDATE runs the row is `running` again — a different
    // claim, held by a live step runner. A status-only guard matches and hands that live run to a
    // second step runner, which is precisely the outcome a reaper must never produce.
    //
    // The stamp is what makes the two claims distinguishable, so the guard re-asserts the exact
    // `claimed_at` it observed and the loser matches 0 rows.
    const w = await seed();
    const runId = await stranded(w, twoSteps(w.messageId), 0, STALE);
    const RECLAIMED = ago(30_000);

    // Park reaper A on the row's write lock, after its SELECT has already seen `STALE`.
    await sqlC`begin`;
    await sqlC`select id from workflow_runs where id = ${runId}::uuid for update`;
    const pass = workflowDrainPass(
      dbA as unknown as Tx, { drafter: unconfiguredDrafter, accountId: w.accountId }, NOW,
    );
    await waitForBlocked(1);

    // …then perform the A-B-A under the lock: requeued and re-claimed, so the row returns to
    // `running` with a NEW stamp before A's UPDATE is ever evaluated.
    await sqlC`update workflow_runs set status = 'running', claimed_at = ${RECLAIMED}
                where id = ${runId}::uuid`;
    await sqlC`commit`;

    const res = await pass;
    expect(res.reaped).toBe(0);
    const run = await runRow(runId);
    expect(run.status).toBe("running");
    expect(run.claimedAt?.toISOString()).toBe(RECLAIMED.toISOString());
    expect(run.stepCursor).toBe(0);
    expect(await kbOf(w.accountId)).toEqual([]);
  });

  it("TWO POOLS, one FRESH claim → neither reaps it", async () => {
    // The negative control for the race above: with nothing stale, two reapers must agree on
    // zero. A predicate that had degraded to "any `running` row" would show up here as 1 or 2.
    const w = await seed();
    const runId = await stranded(w, twoSteps(w.messageId), 0, FRESH);

    const [ra, rb] = await Promise.all([
      workflowDrainPass(dbA as unknown as Tx, { drafter: unconfiguredDrafter, accountId: w.accountId }, NOW),
      workflowDrainPass(dbB as unknown as Tx, { drafter: unconfiguredDrafter, accountId: w.accountId }, NOW),
    ]);

    expect(ra.reaped + rb.reaped).toBe(0);
    expect((await runRow(runId)).status).toBe("running");
  });
});
