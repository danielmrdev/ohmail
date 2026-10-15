import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { graduations, learningSignals, rules } from "@trafficflow/db";
import { LearningService, GRADUATION_THRESHOLD } from "../src/index.js";
import { makeCtx } from "./helpers.js";

const svc = new LearningService();
const PK = "sender:a@b.example→INBOX";

async function grad(db: any, accountId: string) {
  const [g] = await db.select().from(graduations)
    .where(and(eq(graduations.accountId, accountId), eq(graduations.patternKey, PK))).limit(1);
  return g;
}

describe("LearningService — signals, dedup, and SQL-expression graduation", () => {
  it("records a signal and creates the graduation counter row on first positive", async () => {
    const { db, accountId, ctx } = await makeCtx();
    await svc.record(ctx, { triggeringActionId: "approval:1", kind: "approval", senderAddress: "a@b.example", destination: "INBOX", label: "positive" });

    const signals = await db.select().from(learningSignals).where(eq(learningSignals.accountId, accountId));
    expect(signals).toHaveLength(1);
    const g = await grad(db, accountId);
    expect(g.positives).toBe(1);
    expect(g.negatives).toBe(0);
    expect(g.graduated).toBe(false);
  });

  it("dedupes by triggeringActionId: the same action twice yields ONE signal and does not double-count", async () => {
    const { db, accountId, ctx } = await makeCtx();
    const sig = { triggeringActionId: "approval:dup", kind: "approval" as const, senderAddress: "a@b.example", destination: "INBOX" as const, label: "positive" as const };
    await svc.record(ctx, sig);
    await svc.record(ctx, sig);   // replay — must be a no-op

    const signals = await db.select().from(learningSignals).where(eq(learningSignals.accountId, accountId));
    expect(signals).toHaveLength(1);
    const g = await grad(db, accountId);
    expect(g.positives).toBe(1);   // counter NOT double-incremented
  });

  it("flips `graduated` in SQL once net positives reach the threshold", async () => {
    const { db, accountId, ctx } = await makeCtx();
    for (let i = 0; i < GRADUATION_THRESHOLD; i++) {
      await svc.record(ctx, { triggeringActionId: `approval:${i}`, kind: "approval", senderAddress: "a@b.example", destination: "INBOX", label: "positive" });
      const g = await grad(db, accountId);
      const expectGraduated = i + 1 >= GRADUATION_THRESHOLD;
      expect(g.graduated).toBe(expectGraduated);
      if (expectGraduated) expect(g.graduatedAt).not.toBeNull();
    }
    // The pipeline seam agrees.
    expect(await svc.isGraduated(ctx, PK, "route")).toBe(true);
  });

  it("concurrent double-increment accumulates both (SQL `+ 1`, not read-modify-write)", async () => {
    const { db, accountId, ctx } = await makeCtx();
    // Two DISTINCT triggering actions on the SAME pattern, fired concurrently. A lost
    // update (app-side read-modify-write) would leave positives=1; the SQL expression
    // serializes on the row lock and lands positives=2.
    await Promise.all([
      svc.record(ctx, { triggeringActionId: "approval:c1", kind: "approval", senderAddress: "a@b.example", destination: "INBOX", label: "positive" }),
      svc.record(ctx, { triggeringActionId: "approval:c2", kind: "approval", senderAddress: "a@b.example", destination: "INBOX", label: "positive" }),
    ]);
    const g = await grad(db, accountId);
    expect(g.positives).toBe(2);
  });

  it("promoteOrDemote creates a promoted rule once graduated, and disables it under accumulated overrides", async () => {
    const { db, accountId, ctx } = await makeCtx();
    for (let i = 0; i < GRADUATION_THRESHOLD; i++) {
      await svc.record(ctx, { triggeringActionId: `p:${i}`, kind: "approval", senderAddress: "a@b.example", destination: "INBOX", label: "positive" });
    }
    await svc.promoteOrDemote(ctx, PK);
    let ruleRows = await db.select().from(rules).where(and(eq(rules.accountId, accountId), eq(rules.provenance, "promoted")));
    expect(ruleRows).toHaveLength(1);
    expect(ruleRows[0].enabled).toBe(true);

    // Pile on overrides until net goes negative past the demotion threshold.
    for (let i = 0; i < GRADUATION_THRESHOLD + 3; i++) {
      await svc.record(ctx, { triggeringActionId: `n:${i}`, kind: "override", senderAddress: "a@b.example", destination: "INBOX", label: "negative" });
    }
    await svc.promoteOrDemote(ctx, PK);
    ruleRows = await db.select().from(rules).where(and(eq(rules.accountId, accountId), eq(rules.provenance, "promoted")));
    expect(ruleRows[0].enabled).toBe(false);
    expect(ruleRows[0].demotions).toBeGreaterThanOrEqual(1);
    const g = await grad(db, accountId);
    expect(g.graduated).toBe(false);   // graduation cleared on demotion (in SQL)
  });

  /**
   * ── THE RULE AND ITS BACKLOG COMMIT TOGETHER ──────────────────────────────────
   *
   * A promotion graduates off a person's own approvals, so it is their decision — and a decision
   * has to move the mail it claims. This path created the rule and never asked for the backlog:
   * eight rules on one live account carried `retro_requested_at` NULL, fifteen of their messages
   * were still at the gate days later, and the release screen counted them. `rules_retro_owed_idx`
   * is keyed on exactly this pair, so an unstamped rule is not a slow walk — it is no walk at all.
   */
  it("stamps the retro request in the same write as the promoted rule", async () => {
    const { db, accountId, ctx } = await makeCtx();
    for (let i = 0; i < GRADUATION_THRESHOLD; i++) {
      await svc.record(ctx, { triggeringActionId: `r:${i}`, kind: "approval", senderAddress: "a@b.example", destination: "INBOX", label: "positive" });
    }
    await svc.promoteOrDemote(ctx, PK);
    const [row] = await db.select().from(rules)
      .where(and(eq(rules.accountId, accountId), eq(rules.provenance, "promoted")));
    expect(row!.retroRequestedAt, "the promoted rule never asked for its own backlog").not.toBeNull();
    // The press's own instant, as on every door that writes under a sender's key.
    expect(row!.retroRequestedAt!.getTime()).toBe(ctx.now().getTime());
    // …and it is OWED, not finished: the worker's owed set is exactly this pair.
    expect(row!.retroDoneAt).toBeNull();
  });
});
