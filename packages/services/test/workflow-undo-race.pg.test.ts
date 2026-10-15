import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import { accounts, auditLog, kbEntries, workflows, workflowRuns } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { WorkflowsService, type ServiceContext } from "@trafficflow/services";
import { ServiceError } from "../src/errors.js";

/**
 * The undo race on PostgreSQL — the read is a real `SELECT … FOR UPDATE` only here, and
 * the rival commits from a SECOND pooled connection, the production race's shape. The drain is
 * driven to completion INSIDE the undo's own window (the `db.transaction` seam
 * `approval-decide-race.pg.test.ts` uses), so nothing depends on a scheduler. Each arm builds its
 * own account; the positive control runs after the refusal on purpose, so a refusal that came
 * from co-tenancy rather than from the predicate would take the control with it.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
const svc = new WorkflowsService();
/** Every account this file made, dropped in `afterEach` so nothing of ours outlives the arm. */
const mine: string[] = [];

const ctx = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId,
  userId: null,
  now: () => new Date(),
  requestId: `undo-${randomUUID().slice(0, 8)}`,
});

/** A run whose first step has landed: one KB entry and the audit row carrying its inverse. */
async function newWorld(): Promise<{ accountId: string; runId: string }> {
  const accountId = randomUUID();
  mine.push(accountId);
  await db.insert(accounts).values({ id: accountId, name: `undo-${accountId.slice(0, 8)}` });
  const [wf] = await db.insert(workflows).values({
    accountId, name: "wf", enabled: true, steps: [], trigger: { kind: "manual" },
  }).returning();
  const [run] = await db.insert(workflowRuns).values({
    accountId, workflowId: wf!.id, status: "pending", trigger: { kind: "manual" }, stepCursor: 1,
  }).returning();
  await landOneStep(accountId, run!.id, 0);
  return { accountId, runId: run!.id };
}

/** What the workflow runner writes per applied step: the effect row, then its `audit_log` inverse. */
async function landOneStep(accountId: string, runId: string, stepIndex: number): Promise<void> {
  const [entry] = await db.insert(kbEntries).values({
    accountId, title: `step ${stepIndex}`, content: "c",
    workflowDedupKey: `${runId}:${stepIndex}`,
  }).returning();
  await db.insert(auditLog).values({
    accountId, action: "workflow_step",
    payload: { runId, stepIndex, tool: "add_kb_entry" },
    inverse: { tool: "add_kb_entry", kbEntryId: entry!.id },
  });
}

const entriesOf = async (accountId: string) =>
  db.select({ id: kbEntries.id }).from(kbEntries).where(eq(kbEntries.accountId, accountId));
const runOf = async (runId: string) =>
  (await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)))[0]!;

/**
 * Run `rival` once, inside the window the undo opens before it reads the run. Returns a context
 * whose `db.transaction` is the seam; the flag it flips is asserted by every caller, because an
 * interleave that never interleaved proves nothing.
 */
function interleaved(accountId: string, rival: () => Promise<void>): { c: ServiceContext; ran: () => boolean } {
  const c = ctx(accountId);
  const real = db.transaction.bind(db);
  let ran = false;
  (c.db as unknown as { transaction: typeof real }).transaction = (async (
    cb: Parameters<typeof real>[0],
  ) => {
    if (!ran) { ran = true; await rival(); }
    return real(cb);
  }) as typeof real;
  return { c, ran: () => ran };
}

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return "no refusal"; } catch (e) {
    if (e instanceof ServiceError) return `${e.code}/${e.httpStatus}`;
    throw e;
  }
};

describe.skipIf(!PG_UP)("undo against a run the workflow runner still holds", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterEach(async () => {
    for (const a of mine.splice(0)) {
      await db.delete(auditLog).where(eq(auditLog.accountId, a));
      await db.delete(kbEntries).where(eq(kbEntries.accountId, a));
      await db.delete(workflowRuns).where(eq(workflowRuns.accountId, a));
      await db.delete(workflows).where(eq(workflows.accountId, a));
      await db.delete(accounts).where(eq(accounts.id, a));
    }
  });
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("refuses while the drain is still stepping, and undoes nothing", async () => {
    const w = await newWorld();
    // THE EXECUTOR, in the window: it claims the run and lands a second step.
    const { c, ran } = interleaved(w.accountId, async () => {
      await db.update(workflowRuns).set({ status: "running", claimedAt: new Date() })
        .where(eq(workflowRuns.id, w.runId));
      await landOneStep(w.accountId, w.runId, 1);
    });

    expect(await codeOf(svc.undoRun(c, w.runId))).toBe("run_in_flight/409");
    expect(ran(), "the rival never ran — this test proved nothing").toBe(true);

    // NOTHING WAS REVERSED and the run still belongs to the drain.
    expect(await entriesOf(w.accountId)).toHaveLength(2);
    expect((await runOf(w.runId)).status).toBe("running");
  }, 60_000);

  /**
   * A `pending` run is a CANCEL, and the assertion is the drain's own claim: after the undo, the
   * guarded `pending → running` UPDATE takes NOTHING. That pairing is why `pending` is admitted
   * where `running` is refused — there is nothing to reverse and nothing left to reverse it under.
   */
  it("cancels a queued run so the drain's claim finds nothing to take", async () => {
    const accountId = randomUUID();
    mine.push(accountId);
    await db.insert(accounts).values({ id: accountId, name: `undo-${accountId.slice(0, 8)}` });
    const [wf] = await db.insert(workflows).values({
      accountId, name: "wf", enabled: true, steps: [], trigger: { kind: "manual" },
    }).returning();
    const [run] = await db.insert(workflowRuns).values({
      accountId, workflowId: wf!.id, status: "pending", trigger: { kind: "manual" },
    }).returning();

    expect((await svc.undoRun(ctx(accountId), run!.id)).status).toBe("undone");

    const claimed = await db.update(workflowRuns)
      .set({ status: "running", claimedAt: new Date() })
      .where(and(eq(workflowRuns.id, run!.id), eq(workflowRuns.status, "pending")))
      .returning({ id: workflowRuns.id });
    expect(claimed, "the drain claimed a run the user cancelled").toHaveLength(0);
  }, 60_000);

  /** THE POSITIVE CONTROL: the same interleave where the drain FINISHES in the window. */
  it("undoes the run once the drain has finished it", async () => {
    const w = await newWorld();
    const { c, ran } = interleaved(w.accountId, async () => {
      await landOneStep(w.accountId, w.runId, 1);
      await db.update(workflowRuns).set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(workflowRuns.id, w.runId));
    });

    const dto = await svc.undoRun(c, w.runId);
    expect(ran(), "the rival never ran — this test proved nothing").toBe(true);
    expect(dto.status).toBe("undone");
    // BOTH inverses replayed — the one that landed before the press and the one that landed in
    // the window, which is what makes the refusal above about ORDER and not about the count.
    expect(await entriesOf(w.accountId)).toHaveLength(0);
    expect((await runOf(w.runId)).status).toBe("undone");
  }, 60_000);
});
