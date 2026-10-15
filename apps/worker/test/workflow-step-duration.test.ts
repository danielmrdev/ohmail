import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { auditLog, mailboxes, messages, workflows, workflowRuns, type Tx } from "@trafficflow/db";
import type { DraftPort } from "@trafficflow/core";
import { workflowDrainPass } from "../src/workflow-cron.js";

/**
 * ── WHAT A STEP COSTS IS RECORDED, BECAUSE THE CEILING CANNOT BE CHOSEN WITHOUT IT ─────────
 *
 * A workflow run has no per-step wall clock, and it cannot honestly have one yet: the number would
 * be a guess, and a guessed ceiling on a step that calls a model is a refusal fired on honest work.
 * The reading comes first. This measures the recorder that collects it — the wall time one APPLIED
 * step cost, on the `(runId, stepIndex)` audit row that already exists per step.
 *
 * Two properties make it a reading rather than a field: it covers the term that DOMINATES (the
 * drafting call, which happens in `prepare`, outside the step transaction), and it is real elapsed
 * time rather than the pass's own frozen stamp — measured against `now` every step of every run
 * would report zero, which is a column nobody could tell from a fast step.
 */

const NOW = new Date("2026-09-13T12:00:00Z");

/** A drafter that takes a measurable moment, the way a real model call does. */
const SLOW_MS = 60;
const SLOW: DraftPort = {
  async draft() {
    await new Promise((r) => setTimeout(r, SLOW_MS));
    return { subject: "Re:", body: "b", rationale: "r" };
  },
};

type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function seed(db: Db) {
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: "g@tf.example" }).returning();
  const dedup = `mid:${randomUUID()}`;
  const [m] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
    subject: "s", fromAddress: "a@ex.example", snippet: "x", nativeLocator: { folder: "INBOX", ref: "1:1" },
  }).returning();
  return { accountId, messageId: m!.id };
}

async function enqueue(db: Db, accountId: string, steps: unknown[]): Promise<void> {
  const [wf] = await db.insert(workflows).values({
    accountId, name: "wf", enabled: true, steps, trigger: { kind: "manual" },
  }).returning();
  await db.insert(workflowRuns).values({
    accountId, workflowId: wf!.id, status: "pending", trigger: { kind: "manual" },
  });
}

/** Every applied step's marker, in step order. */
async function markers(db: Db, accountId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await db.select({ payload: auditLog.payload }).from(auditLog)
    .where(and(eq(auditLog.accountId, accountId), eq(auditLog.action, "workflow_step")));
  return rows
    .map((r) => r.payload as Record<string, unknown>)
    .sort((a, b) => Number(a.stepIndex) - Number(b.stepIndex));
}

describe("the workflow step recorder", () => {
  it("records what the step cost, and counts the drafting call", async () => {
    const db = await makeTestDb();
    const { accountId, messageId } = await seed(db);
    await enqueue(db, accountId, [{ tool: "draft_reply", args: { messageId } }]);

    const res = await workflowDrainPass(db as unknown as Tx, { drafter: SLOW, accountId }, NOW);
    expect(res.drained).toBe(1);

    const [step] = await markers(db, accountId);
    expect(typeof step?.durationMs).toBe("number");
    /* THE DISCRIMINATING BOUND, and it is a floor rather than a range: the drafting call happens
     * in `prepare`, OUTSIDE the step transaction, so a recorder started at the transaction would
     * miss the one term that dominates and report a couple of milliseconds here. */
    expect(step!.durationMs as number).toBeGreaterThanOrEqual(SLOW_MS);
  });

  /**
   * …and it is not simply "big": a step with no model call records a small number, so the case
   * above is measuring the drafting call and not a constant.
   */
  it("records a small cost for a step that calls nothing", async () => {
    const db = await makeTestDb();
    const { accountId } = await seed(db);
    await enqueue(db, accountId, [{ tool: "add_kb_entry", args: { title: "t", content: "c" } }]);

    await workflowDrainPass(db as unknown as Tx, { drafter: SLOW, accountId }, NOW);

    const [step] = await markers(db, accountId);
    expect(step!.durationMs as number).toBeLessThan(SLOW_MS);
  });

  /**
   * THE MARKER STILL MARKS. `stepAlreadyApplied` reads `stepIndex` out of this same payload, so a
   * field beside it may not change what the idempotency gate sees — a second drain must still
   * find the step applied and re-run nothing.
   */
  it("leaves the idempotency marker readable — a second drain re-runs nothing", async () => {
    const db = await makeTestDb();
    const { accountId, messageId } = await seed(db);
    await enqueue(db, accountId, [{ tool: "draft_reply", args: { messageId } }]);

    await workflowDrainPass(db as unknown as Tx, { drafter: SLOW, accountId }, NOW);
    const second = await workflowDrainPass(db as unknown as Tx, { drafter: SLOW, accountId }, NOW);

    expect(second.drained).toBe(0);
    expect(await markers(db, accountId)).toHaveLength(1);
  });
});
