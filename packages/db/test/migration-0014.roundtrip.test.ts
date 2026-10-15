import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "../src/testing.js";
import { workflows, workflowRuns } from "../src/index.js";
import { and, eq, isNull } from "drizzle-orm";

// Proves migration 0014 (Phase 4a-1) persists `workflows` + `workflow_runs` — the
// REST-only workflow-automation storage — with their jsonb defaults, the `enabled`
// default-false consent gate, the `deleted_at` SOFT-DELETE column, the
// `pending` run default, and a NULLABLE `workflow_id` FK so a soft-deleted workflow's
// runs are retained. Core Postgres only (RC8); replays into PGlite.
describe("migration 0014 round-trip (workflows + workflow_runs)", () => {
  const acct = "00000000-0000-0000-0000-0000000014a0";

  it("persists a workflow with jsonb defaults + enabled=false + no deletedAt", async () => {
    const db = await makeTestDb();
    const [wf] = await db.insert(workflows).values({ accountId: acct, name: "Auto-file receipts" }).returning();
    expect(wf!.enabled).toBe(false);              // default (consent gate)
    expect(wf!.provenance).toBe("user");          // default
    expect(wf!.trigger).toEqual({});              // '{}'::jsonb default
    expect(wf!.steps).toEqual([]);                // '[]'::jsonb default
    expect(wf!.deletedAt).toBeNull();             // soft-delete column present, null by default
    expect(wf!.createdAt).toBeInstanceOf(Date);

    // Round-trips typed trigger + steps jsonb.
    const [wf2] = await db.insert(workflows).values({
      accountId: acct, name: "Draft replies",
      trigger: { kind: "manual" },
      steps: [{ tool: "draft_reply", args: { tone: "brief" } }],
      enabled: true, provenance: "graduated",
    }).returning();
    expect(wf2!.trigger).toEqual({ kind: "manual" });
    expect(wf2!.steps).toEqual([{ tool: "draft_reply", args: { tone: "brief" } }]);
  });

  it("persists a pending run + a nullable workflowId, and retains runs past a soft-delete", async () => {
    const db = await makeTestDb();
    const [wf] = await db.insert(workflows).values({ accountId: acct, name: "wf" }).returning();

    const [run] = await db.insert(workflowRuns).values({
      accountId: acct, workflowId: wf!.id, trigger: { kind: "manual" },
    }).returning();
    expect(run!.status).toBe("pending");          // default
    expect(run!.stepCursor).toBe(0);              // default resume cursor
    expect(run!.log).toEqual([]);                 // '[]'::jsonb default
    expect(run!.reason).toBeNull();
    expect(run!.finishedAt).toBeNull();

    // Soft-delete the workflow: the run row still exists (history preserved).
    await db.update(workflows).set({ deletedAt: new Date(), enabled: false }).where(eq(workflows.id, wf!.id));
    const live = await db.select().from(workflows)
      .where(and(eq(workflows.id, wf!.id), isNull(workflows.deletedAt)));
    expect(live).toHaveLength(0);                 // excluded from live reads
    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, wf!.id));
    expect(runs).toHaveLength(1);                 // the run survives the soft-delete

    // A run with NO workflow (workflowId null) is also permitted (retention shape).
    const [orphanRun] = await db.insert(workflowRuns).values({ accountId: acct, workflowId: null }).returning();
    expect(orphanRun!.workflowId).toBeNull();
  });

  it("the workflow_id FK rejects a non-existent workflow", async () => {
    const db = await makeTestDb();
    await expect(
      db.insert(workflowRuns).values({ accountId: acct, workflowId: randomUUID() }),
    ).rejects.toThrow();
  });
});
