import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { auditAction, auditLog, routingDecisions, rules } from "@trafficflow/db";
import { makeDeps, seedSession, seedRule, seedMessage, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

/**
 * A RULE THAT FILED A GAP BATCH IS REVOKED LIKE ANY OTHER. The gap catch-up is the
 * one writer of `routing_decisions.matched_rule_id`, and mail 0118 keyed that column to `rules`
 * with no delete action, so the revoke of that rule answered 500 every time and the rule kept
 * filing. The decision row and the undo's audit row are the history of a move that happened: the
 * revoke keeps both and drops only the pointer.
 */
describe("DELETE /rules/:id after the rule filed a gap batch", () => {
  async function world() {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const ruleId = await seedRule(db, { accountId: s.accountId, match: "letters@news.test", destination: "ohmail/News" });
    const control = await seedRule(db, { accountId: s.accountId, match: "other@news.test", destination: "ohmail/News" });
    const m = await seedMessage(db, { accountId: s.accountId, fromAddress: "letters@news.test", folder: "ohmail/News" });
    // The rows `gapCatchupPass` writes per filed letter, in its own shape.
    await db.insert(routingDecisions).values({
      accountId: s.accountId, messageId: m.id, inputProvenance: "rule",
      matchedRuleId: ruleId, destination: "ohmail/News", status: "auto_applied",
    });
    await db.insert(auditLog).values({
      accountId: s.accountId, action: auditAction("gap_catchup_move"),
      payload: { mailboxId: m.mailboxId, messageId: m.id, from: "INBOX", to: "ohmail/News", ruleId },
      inverse: { messageId: m.id, from: "ohmail/News", to: "INBOX" },
    });
    return { db, deps, s, ruleId, control, messageId: m.id };
  }

  it("answers 204, removes the rule, and keeps the decision and its undo", async () => {
    const w = await world();
    const res = await H(req("DELETE", `/rules/${w.ruleId}`, { bearer: w.s.token }), w.deps);
    expect(res.status, await res.clone().text()).toBe(204);
    expect(await w.db.select().from(rules).where(eq(rules.id, w.ruleId))).toHaveLength(0);
    const decisions = await w.db.select().from(routingDecisions).where(eq(routingDecisions.messageId, w.messageId));
    expect(decisions, "the filing's decision went with the rule").toHaveLength(1);
    expect(decisions[0]).toMatchObject({ destination: "ohmail/News", status: "auto_applied", matchedRuleId: null });
    const undo = await w.db.select().from(auditLog).where(eq(auditLog.accountId, w.s.accountId));
    expect(undo.map((a) => a.action)).toContain("gap_catchup_move");
  });

  it("the keyed retry the outbox sends answers 204 as well (the path the browser takes)", async () => {
    const w = await world();
    const send = () => H(req("DELETE", `/rules/${w.ruleId}`, {
      bearer: w.s.token, headers: { "Idempotency-Key": "revoke-after-gap-1" },
    }), w.deps);
    expect((await send()).status).toBe(204);
    expect((await send()).status, "the replay of a revoke that happened").toBe(204);
  });

  it("a rule with no decision behind it is revoked the same way (the control)", async () => {
    const w = await world();
    const res = await H(req("DELETE", `/rules/${w.control}`, { bearer: w.s.token }), w.deps);
    expect(res.status).toBe(204);
  });
});
