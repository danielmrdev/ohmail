import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { applyRuleRequest, ruleCreatePayload, rules, validateRulePayload, type Tx } from "@trafficflow/db";
import { RulesService, type RuleCreation } from "../src/index.js";
import { makeCtx } from "./helpers.js";

/**
 * A CREATE THAT NAMES NO PRIORITY KEEPS THE ONE STORED (CREATE-OVER-A-RAISED-RULE-LOWERS-ITS-
 * PRIORITY). Absent is unstated, never 0: on the local door (`POST /rules`), on the organizer's
 * apply of a travelled `rule.create`, and in the payload a reader sends. A stated 0 is a value,
 * and a new row with none stated starts at 0.
 */
const svc = new RulesService();
const KEY = { kind: "sender", match: "lifted@example.invalid", subjectContains: null, bodyContains: null };
type World = Awaited<ReturnType<typeof makeCtx>>;

async function raised(w: World, priority = 5): Promise<string> {
  const [r] = await w.db.insert(rules).values({
    accountId: w.accountId, kind: KEY.kind, match: KEY.match, destination: "INBOX", priority, enabled: true, provenance: "manual",
  }).returning({ id: rules.id });
  return r!.id;
}
const priorityOf = async (w: World) => (await w.db.select({ p: rules.priority }).from(rules)
  .where(and(eq(rules.accountId, w.accountId), eq(rules.match, KEY.match)))).map((r) => r.p);
const create = (w: World, body: Record<string, unknown>) => svc.create(w.ctx, body as never) as Promise<RuleCreation>;

describe("a create naming no priority over a raised rule", () => {
  it("the local door keeps the stored priority, and answers the row unchanged", async () => {
    const w = await makeCtx();
    const id = await raised(w);
    const out = await create(w, { kind: KEY.kind, match: KEY.match, destination: "INBOX" });
    expect(out.rule.id).toBe(id);
    expect(await priorityOf(w)).toEqual([5]);
    expect(out.seq, "nothing changed, so no delta").toBeNull();
  });

  it("a stated 0 is a value: the local door writes it (positive control)", async () => {
    const w = await makeCtx();
    await raised(w);
    await create(w, { kind: KEY.kind, match: KEY.match, destination: "INBOX", priority: 0 });
    expect(await priorityOf(w)).toEqual([0]);
  });

  it("a new row with no priority stated starts at 0 (positive control)", async () => {
    const w = await makeCtx();
    await create(w, { kind: KEY.kind, match: KEY.match, destination: "INBOX" });
    expect(await priorityOf(w)).toEqual([0]);
  });

  it("the organizer's apply of a travelled create without a priority keeps the stored one", async () => {
    const w = await makeCtx();
    await raised(w);
    const payload = validateRulePayload("rule.create", { key: KEY, destination: "inbox" });
    expect(payload).not.toBeNull();
    await w.db.transaction(async (tx) => {
      await applyRuleRequest(tx as unknown as Tx, { accountId: w.accountId, payload: payload!, now: new Date("2026-10-04T12:00:00Z") });
    });
    expect(await priorityOf(w)).toEqual([5]);
  });

  it("the payload a reader sends omits an unstated priority and carries a stated one", () => {
    const absent = ruleCreatePayload({ key: KEY, destination: "inbox", enabled: true } as never);
    expect("priority" in absent, "an unstated priority travels as absent").toBe(false);
    expect(ruleCreatePayload({ key: KEY, destination: "inbox", priority: 0, enabled: true }).priority).toBe(0);
  });
});
