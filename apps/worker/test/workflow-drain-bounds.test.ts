import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, workflows, workflowRuns, type Tx } from "@trafficflow/db";
import type { DraftPort } from "@trafficflow/core";
import {
  workflowDrainPass, WORKFLOW_DRAIN_MAX_PER_PASS, STALE_CLAIM_MS,
} from "../src/workflow-cron.js";

/**
 * ═══ THE DRAIN TAKES A BATCH, NOT WHATEVER HAS ACCUMULATED ═════════════════════════════════
 *
 * Both of this pass's reads selected every matching row — `pending` with no `LIMIT` and no order,
 * and the reaper's `running` the same. `workflow_runs` is state a caller adds to one enqueue at a
 * time and nothing prunes, so one account's backlog became the length of the list the shared pass
 * then ran to completion. That is the actual way one account pins a pass every other account's
 * runs wait behind, and no ceiling anywhere saw it.
 *
 * The three properties that make a batch ceiling honest rather than a truncation: it is applied at
 * the READ, the deferred rows keep their status, and the ORDER is stable so the next pass takes
 * the NEXT batch — an unordered `LIMIT` hands back the same rows for ever while the oldest never
 * move. Each is a case below.
 */

const NOW = new Date("2026-09-13T12:00:00Z");
const MOCK: DraftPort = {
  async draft() { return { subject: "Re:", body: "b", rationale: "r" }; },
};

type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function account(db: Db): Promise<string> {
  const accountId = randomUUID();
  await db.insert(mailboxes).values({ accountId, provider: "imap", address: "g@tf.example" });
  return accountId;
}

/**
 * `n` pending runs of a step that touches nothing, enqueued one millisecond apart so `created_at`
 * orders them — which is what the batch's fairness rests on.
 */
async function enqueue(db: Db, accountId: string, n: number): Promise<string[]> {
  const [wf] = await db.insert(workflows).values({
    accountId, name: "wf", enabled: true,
    steps: [{ tool: "add_kb_entry", args: { title: "t", content: "c" } }],
    trigger: { kind: "manual" },
  }).returning();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const [run] = await db.insert(workflowRuns).values({
      accountId, workflowId: wf!.id, status: "pending", trigger: { kind: "manual" },
      createdAt: new Date(NOW.getTime() - (n - i) * 1_000),
    }).returning();
    ids.push(run!.id);
  }
  return ids;
}

describe("the workflow drain is bounded at the read", () => {
  it("takes at most the batch and leaves the rest PENDING, not failed and not dropped", async () => {
    const db = await makeTestDb();
    const accountId = await account(db);
    const over = 5;
    await enqueue(db, accountId, WORKFLOW_DRAIN_MAX_PER_PASS + over);

    const res = await workflowDrainPass(db as unknown as Tx, { drafter: MOCK, accountId }, NOW);

    expect(res.drained).toBe(WORKFLOW_DRAIN_MAX_PER_PASS);
    const left = await db.select({ id: workflowRuns.id })
      .from(workflowRuns).where(eq(workflowRuns.status, "pending"));
    expect(left).toHaveLength(over);
  });

  /**
   * ── THE FAIRNESS CASE ─────────────────────────────────────────────────────────────────────
   *
   * A `LIMIT` with no `ORDER BY` is not a batch, it is a sample: PostgreSQL may answer with any
   * rows it likes and nothing stops it answering with the same ones next pass while the oldest
   * enqueue is never reached. So the batch is the OLDEST, and what is left is the newest.
   */
  it("takes the OLDEST enqueues, so the deferred rows are the next pass's batch", async () => {
    const db = await makeTestDb();
    const accountId = await account(db);
    const over = 3;
    const ids = await enqueue(db, accountId, WORKFLOW_DRAIN_MAX_PER_PASS + over);

    await workflowDrainPass(db as unknown as Tx, { drafter: MOCK, accountId }, NOW);

    const left = await db.select({ id: workflowRuns.id })
      .from(workflowRuns).where(eq(workflowRuns.status, "pending"))
      .orderBy(asc(workflowRuns.createdAt));
    expect(left.map((r) => r.id)).toEqual(ids.slice(-over));
  });

  /** The second pass finishes them — the ceiling defers work, it does not lose it. */
  it("the next pass drains what the first one deferred", async () => {
    const db = await makeTestDb();
    const accountId = await account(db);
    const over = 4;
    await enqueue(db, accountId, WORKFLOW_DRAIN_MAX_PER_PASS + over);

    await workflowDrainPass(db as unknown as Tx, { drafter: MOCK, accountId }, NOW);
    const second = await workflowDrainPass(db as unknown as Tx, { drafter: MOCK, accountId }, NOW);

    expect(second.drained).toBe(over);
    expect(await db.select({ id: workflowRuns.id })
      .from(workflowRuns).where(eq(workflowRuns.status, "pending"))).toHaveLength(0);
  });

  /**
   * ── THE CLOCK ─────────────────────────────────────────────────────────────────────────────
   *
   * A count bounds the LIST and not the WORK: a run executes steps and a step can call a model, so
   * the pass also stops CLAIMING once the poll that scheduled it has elapsed. Driven at zero,
   * which is the deployment that polls faster than its drain runs: nothing may be claimed, and
   * nothing may be broken either — every row is still `pending` for the next pass.
   */
  it("claims nothing once the pass deadline has passed, and leaves every row pending", async () => {
    const db = await makeTestDb();
    const accountId = await account(db);
    await enqueue(db, accountId, 3);

    const res = await workflowDrainPass(
      db as unknown as Tx, { drafter: MOCK, accountId, passDeadlineMs: 0 }, NOW,
    );

    expect(res.drained).toBe(0);
    expect(await db.select({ id: workflowRuns.id })
      .from(workflowRuns).where(eq(workflowRuns.status, "pending"))).toHaveLength(3);
  });

  /**
   * THE POSITIVE CONTROL. An ordinary backlog — one under the ceiling, with the pass's own
   * deadline — drains completely, so every refusal above is a ceiling firing and not the pass
   * having stopped working.
   */
  it("drains an ordinary backlog whole", async () => {
    const db = await makeTestDb();
    const accountId = await account(db);
    await enqueue(db, accountId, 7);

    const res = await workflowDrainPass(db as unknown as Tx, { drafter: MOCK, accountId }, NOW);

    expect(res.drained).toBe(7);
    expect(await db.select({ id: workflowRuns.id })
      .from(workflowRuns).where(eq(workflowRuns.status, "pending"))).toHaveLength(0);
  });

  /**
   * The reaper's read carries the same ceiling. A dead worker's `running` rows accumulate exactly
   * as `pending` ones do; requeueing is cheap but not free, and an unbounded requeue feeds an
   * unbounded drain one statement later.
   */
  it("requeues at most the batch of stale claims in one pass", async () => {
    const db = await makeTestDb();
    const accountId = await account(db);
    const over = 2;
    const ids = await enqueue(db, accountId, WORKFLOW_DRAIN_MAX_PER_PASS + over);
    const stranded = new Date(NOW.getTime() - STALE_CLAIM_MS - 60_000);
    for (const id of ids) {
      await db.update(workflowRuns).set({ status: "running", claimedAt: stranded })
        .where(eq(workflowRuns.id, id));
    }

    // The deadline stops the drain half, so this measures the REAPER alone.
    const res = await workflowDrainPass(
      db as unknown as Tx, { drafter: MOCK, accountId, passDeadlineMs: 0 }, NOW,
    );

    expect(res.reaped).toBe(WORKFLOW_DRAIN_MAX_PER_PASS);
    expect(await db.select({ id: workflowRuns.id })
      .from(workflowRuns).where(eq(workflowRuns.status, "running"))).toHaveLength(over);
  });
});
