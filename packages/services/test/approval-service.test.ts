import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { approvals, routingDecisions, folderState, graduations, learningSignals } from "@trafficflow/db";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { ApprovalService, GRADUATION_THRESHOLD } from "../src/index.js";
import { makeCtx, seedMessage, changesFor, FakeAdapter } from "./helpers.js";

async function seedApproval(
  db: any, accountId: string, messageId: string,
  opts: { folder?: string; status?: string; expiresAt?: Date | null } = {},
): Promise<string> {
  const { folder = "ohmail/News", status = "pending", expiresAt = null } = opts;
  const [rd] = await db.insert(routingDecisions).values({
    accountId, messageId, inputProvenance: "ai", destination: folder, confidence: 0.6, status: "pending_approval",
  }).returning();
  const [a] = await db.insert(approvals).values({
    accountId, kind: "routing", messageId, routingDecisionId: rd.id, action: "move",
    summary: `Route to ${folder}`, payload: { folder }, confidence: 0.6, status, expiresAt,
  }).returning();
  return a.id;
}

describe("ApprovalService — decide (approve/reject) + learning", () => {
  it("approve → executes the move via the reconciler, flips status, emits change_log, increments graduation", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const msg = await seedMessage(db, accountId, mailboxId, { from: "news@ex.example", folder: "INBOX", desired: "INBOX" });
    const id = await seedApproval(db, accountId, msg, { folder: "ohmail/News" });
    const adapter = new FakeAdapter();
    const svc = new ApprovalService({ adapter });

    const dto = await svc.decide(ctx, id, { decision: "approve" });
    expect(dto.status).toBe("approved");

    // Physical move executed OUTSIDE the tx.
    expect(adapter.moves).toEqual([{ from: "INBOX", to: "ohmail/News" }]);
    // Folder state + routing decision updated.
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, msg));
    expect(fs.desiredFolder).toBe("ohmail/News");
    const [rd] = await db.select().from(routingDecisions).where(eq(routingDecisions.messageId, msg));
    expect(rd.status).toBe("approved");

    // change_log: approval update + message move.
    const changes = await changesFor(db, accountId);
    expect(changes.some((c) => c.entityType === "approval" && c.op === "update")).toBe(true);
    const move = changes.find((c) => c.entityType === "message" && c.op === "move");
    expect((move!.meta as any)).toEqual({ from: "INBOX", to: "ohmail/News" });

    // Learning: positive signal (deduped id) + graduation counter via SQL.
    const signals = await db.select().from(learningSignals).where(eq(learningSignals.accountId, accountId));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ triggeringActionId: `approval:${id}`, label: "positive" });
    const [g] = await db.select().from(graduations).where(eq(graduations.accountId, accountId));
    expect(g).toMatchObject({ patternKey: "sender:news@ex.example→ohmail/News", positives: 1 });
  });

  it("two distinct approvals of the same pattern, approved concurrently, land positives=2 (race-safe)", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const m1 = await seedMessage(db, accountId, mailboxId, { from: "news@ex.example", folder: "INBOX", desired: "INBOX" });
    const m2 = await seedMessage(db, accountId, mailboxId, { from: "news@ex.example", folder: "INBOX", desired: "INBOX" });
    const a1 = await seedApproval(db, accountId, m1, { folder: "ohmail/News" });
    const a2 = await seedApproval(db, accountId, m2, { folder: "ohmail/News" });
    const svc = new ApprovalService({ adapter: new FakeAdapter() });

    await Promise.all([svc.decide(ctx, a1, { decision: "approve" }), svc.decide(ctx, a2, { decision: "approve" })]);
    const [g] = await db.select().from(graduations).where(eq(graduations.accountId, accountId));
    expect(g.positives).toBe(2);   // both increments landed; neither lost
  });

  it("reject → flips to rejected, records a negative override signal, emits change_log, no move", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const msg = await seedMessage(db, accountId, mailboxId, { from: "news@ex.example", folder: "INBOX", desired: "INBOX" });
    const id = await seedApproval(db, accountId, msg, { folder: "ohmail/News" });
    const adapter = new FakeAdapter();
    const svc = new ApprovalService({ adapter });

    const dto = await svc.decide(ctx, id, { decision: "reject" });
    expect(dto.status).toBe("rejected");
    expect(adapter.moves).toHaveLength(0);   // rejected → no physical move
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, msg));
    expect(fs.desiredFolder).toBe("INBOX");  // unchanged

    const [rd] = await db.select().from(routingDecisions).where(eq(routingDecisions.messageId, msg));
    expect(rd.status).toBe("rejected");

    const signals = await db.select().from(learningSignals).where(eq(learningSignals.accountId, accountId));
    expect(signals[0]).toMatchObject({ label: "negative", kind: "approval" });
    const [g] = await db.select().from(graduations).where(eq(graduations.accountId, accountId));
    expect(g).toMatchObject({ negatives: 1, graduated: false });

    const changes = await changesFor(db, accountId);
    expect(changes.some((c) => c.entityType === "approval" && c.op === "update")).toBe(true);
    expect(changes.some((c) => c.entityType === "message" && c.op === "move")).toBe(false);
  });

  it("deciding an already-resolved approval → 422", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const msg = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", desired: "INBOX" });
    const id = await seedApproval(db, accountId, msg, { status: "approved" });
    const svc = new ApprovalService({ adapter: new FakeAdapter() });
    await expect(svc.decide(ctx, id, { decision: "approve" })).rejects.toMatchObject({ httpStatus: 422 });
  });

  it("deciding an expired approval → 422", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const msg = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", desired: "INBOX" });
    const id = await seedApproval(db, accountId, msg, { expiresAt: new Date("2026-07-01T00:00:00Z") });
    const svc = new ApprovalService({ adapter: new FakeAdapter() });
    await expect(svc.decide(ctx, id, { decision: "approve" })).rejects.toMatchObject({ httpStatus: 422 });
  });

  it("N approvals graduate the pattern in SQL, and the 1c pipeline seam (RoutingPort.isGraduated) then reads true", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const svc = new ApprovalService({ adapter: new FakeAdapter() });
    for (let i = 0; i < GRADUATION_THRESHOLD; i++) {
      const m = await seedMessage(db, accountId, mailboxId, { from: "news@ex.example", folder: "INBOX", desired: "INBOX" });
      const a = await seedApproval(db, accountId, m, { folder: "ohmail/News" });
      await svc.decide(ctx, a, { decision: "approve" });
    }
    const [g] = await db.select().from(graduations).where(eq(graduations.accountId, accountId));
    expect(g.graduated).toBe(true);

    // Cross-check the exact read the 1c pipeline performs (same table, no code cycle).
    const repo = makeDrizzleRepo(db as any);
    // DrizzleRepo.isGraduated is account-SCOPED (accountId, patternKey, action).
    const pipelineReads = await repo.isGraduated(accountId, "sender:news@ex.example→ohmail/News", "route");
    expect(pipelineReads).toBe(true);
    // A DIFFERENT account must NOT read this pattern as graduated (accountId scoping).
    const otherAccountReads = await repo.isGraduated(
      "00000000-0000-0000-0000-0000000000ff", "sender:news@ex.example→ohmail/News", "route",
    );
    expect(otherAccountReads).toBe(false);
  });

  it("list returns pending approvals for the account", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const msg = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", desired: "INBOX" });
    const id = await seedApproval(db, accountId, msg);
    const svc = new ApprovalService({ adapter: new FakeAdapter() });
    const page = await svc.list(ctx, { status: "pending" });
    expect(page.items.map((a) => a.id)).toContain(id);
    expect(page.items[0].proposed.action).toBe("move");
  });
});
