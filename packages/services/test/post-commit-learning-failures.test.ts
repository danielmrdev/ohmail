import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@trafficflow/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@trafficflow/db")>();
  return { ...real, demoteRoute: vi.fn(real.demoteRoute) };
});

import { and, eq } from "drizzle-orm";
import {
  AccountErasedError, approvals, demoteRoute, folderState, graduations, learningSignals, mailboxes,
  routingDecisions, rules,
} from "@trafficflow/db";
import { ApprovalService, MessageService, ServiceError, type LearningService } from "../src/index.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * A PRESS THAT COMMITTED ANSWERS ITS COMMIT. The learned rule's switch-off after a move, and the
 * promotion pass after an approval, run after the press's own transaction: if they fail, the person
 * is still answered what they did (and the doorbell still rings), with one log line; only an
 * erased account answers 410, as the fenced seam does.
 */
const SENDER = "digest@anchor.example";
const NEWS = "ohmail/News";
type World = Awaited<ReturnType<typeof makeCtx>>;
const door = vi.mocked(demoteRoute);
afterEach(() => { door.mockClear(); });

/** A route learned into News, its rule on, one override already standing: one more demotes it. */
async function learnedRoute(w: World): Promise<{ messageId: string; ruleId: string }> {
  await w.db.insert(graduations).values({
    accountId: w.accountId, patternKey: `sender:${SENDER}→${NEWS}`, action: "route", positives: 3, negatives: 0,
    graduated: true, graduatedAt: new Date("2026-07-01T00:00:00Z"),
  });
  const [rule] = await w.db.insert(rules).values({
    accountId: w.accountId, kind: "sender", match: SENDER, destination: NEWS, enabled: true, provenance: "promoted",
  }).returning({ id: rules.id });
  await w.db.insert(learningSignals).values({
    accountId: w.accountId, triggeringActionId: "move:prior:1", kind: "external_move", senderAddress: SENDER,
    destination: NEWS, label: "negative",
  });
  const messageId = await seedMessage(w.db, w.accountId, w.mailboxId, { from: SENDER, folder: NEWS, desired: NEWS });
  return { messageId, ruleId: rule!.id };
}

describe("a press that committed answers its commit when the learning after it fails", () => {
  it("a move whose switch-off fails answers the move, rings the doorbell, and leaves the rule on", async () => {
    const w = await makeCtx();
    const { messageId, ruleId } = await learnedRoute(w);
    door.mockRejectedValueOnce(new Error("the door is down"));
    const answer = await new MessageService().move(w.ctx, messageId, { folder: "INBOX" });
    expect("dto" in answer, "the committed move answered an error").toBe(true);
    expect(door, "the move owed no switch-off: the case measures nothing").toHaveBeenCalledTimes(1);
    const [fs] = await w.db.select({ desired: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, messageId));
    expect(fs).toEqual({ desired: "INBOX" });
    const [mb] = await w.db.select({ rung: mailboxes.syncRequestedAt }).from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
    expect(mb!.rung, "the doorbell did not ring after the commit").not.toBeNull();
    const [r] = await w.db.select({ enabled: rules.enabled }).from(rules).where(eq(rules.id, ruleId));
    expect(r).toEqual({ enabled: true });
  });

  it("…and an erased account answers 410 account_erased", async () => {
    const w = await makeCtx();
    const { messageId } = await learnedRoute(w);
    door.mockRejectedValueOnce(new AccountErasedError(w.accountId));
    const err = await new MessageService().move(w.ctx, messageId, { folder: "INBOX" }).then(() => null, (e: unknown) => e);
    expect([(err as ServiceError).code, (err as ServiceError).httpStatus]).toEqual(["account_erased", 410]);
  });

  async function card(w: World): Promise<{ id: string; messageId: string }> {
    const messageId = await seedMessage(w.db, w.accountId, w.mailboxId, { from: SENDER, folder: "INBOX", desired: "INBOX" });
    const [rd] = await w.db.insert(routingDecisions).values({
      accountId: w.accountId, messageId, inputProvenance: "ai", destination: NEWS, confidence: 0.6, status: "pending_approval",
    }).returning();
    const [a] = await w.db.insert(approvals).values({
      accountId: w.accountId, kind: "routing", messageId, routingDecisionId: rd!.id, action: "move",
      summary: `Route to ${NEWS}`, payload: { folder: NEWS }, confidence: 0.6, status: "pending",
    }).returning();
    return { id: a!.id, messageId };
  }
  const failing = (err: unknown): LearningService => ({ promoteOrDemote: async () => { throw err; } }) as unknown as LearningService;

  it("an approval whose pass fails answers the decision it committed, and the message is still filed", async () => {
    const w = await makeCtx();
    const { id, messageId } = await card(w);
    const dto = await new ApprovalService({ learning: failing(new Error("the pass is down")) }).decide(w.ctx, id, { decision: "approve" });
    expect(dto.status).toBe("approved");
    const [a] = await w.db.select({ status: approvals.status }).from(approvals).where(and(eq(approvals.id, id), eq(approvals.accountId, w.accountId)));
    expect(a).toEqual({ status: "approved" });
    const [fs] = await w.db.select({ desired: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, messageId));
    expect(fs, "the approval's filing did not commit").toEqual({ desired: NEWS });
  });

  it("…and an erased account answers 410 account_erased", async () => {
    const w = await makeCtx();
    const { id } = await card(w);
    const svc = new ApprovalService({ learning: failing(new ServiceError("account_erased", 410, "this account has been deleted")) });
    const err = await svc.decide(w.ctx, id, { decision: "approve" }).then(() => null, (e: unknown) => e);
    expect([(err as ServiceError).code, (err as ServiceError).httpStatus]).toEqual(["account_erased", 410]);
  });
});
