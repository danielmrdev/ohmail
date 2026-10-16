import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { applyRuleRequest, graduations, rules, validateRulePayload, type Tx } from "@trafficflow/db";
import { LearningService, GRADUATION_THRESHOLD, RulesService } from "../src/index.js";
import { makeCtx } from "./helpers.js";

/**
 * A PERSON'S PAUSE OR REMOVAL OF A LEARNED RULE IS THE UNDO (the "No silent AI actions" invariant: graduation is undoable).
 * It ends the graduation through the demotion's own door, from zero: the route stops applying
 * itself and a new one needs the full threshold again. A paused row carries the person's stamp, so
 * no later graduation switches it back on or asks for its backlog. Both doors: the install's own
 * PATCH and DELETE, and the organizer's apply of a press that travelled.
 */
const learning = new LearningService();
const rulesSvc = new RulesService();
const ADDR = "a@b.example";
const NEWS = "ohmail/News";
const PK = `sender:${ADDR}→${NEWS}`;
const DONE = new Date("2026-07-29T00:00:00Z");
type World = Awaited<ReturnType<typeof makeCtx>>;

let seq = 0;
async function approve(w: World, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await learning.record(w.ctx, { triggeringActionId: `p:${seq++}`, kind: "approval", senderAddress: ADDR, destination: NEWS, label: "positive" });
  }
  await learning.promoteOrDemote(w.ctx, PK);
}
const rowsOf = async (w: World) => (await w.db.select().from(rules)
  .where(and(eq(rules.accountId, w.accountId), eq(rules.kind, "sender"))))
  .map((r) => ({
    id: r.id, destination: r.destination, enabled: r.enabled, provenance: r.provenance,
    stamped: r.personDecidedAt !== null, retroOwed: r.retroRequestedAt !== null && r.retroDoneAt === null,
  }));
const graduationOf = async (w: World) => (await w.db.select().from(graduations)
  .where(and(eq(graduations.accountId, w.accountId), eq(graduations.patternKey, PK))))
  .map((g) => ({ graduated: g.graduated, positives: g.positives, negatives: g.negatives }));

/** A graduated route and the rule it promoted, its first backlog walk finished. */
async function learned(w: World): Promise<string> {
  await approve(w, GRADUATION_THRESHOLD);
  const [r] = await rowsOf(w);
  expect(r).toMatchObject({ destination: NEWS, enabled: true, provenance: "promoted", stamped: false });
  await w.db.update(rules).set({ retroDoneAt: DONE }).where(eq(rules.id, r!.id));
  return r!.id;
}

describe("a person's pause or removal of a learned rule ends what was learned", () => {
  it("a pause on this install ends the graduation and makes the row the person's", async () => {
    const w = await makeCtx();
    const id = await learned(w);
    await rulesSvc.update(w.ctx, id, { enabled: false } as never);
    expect(await learning.isGraduated(w.ctx, PK), "the route still applies itself").toBe(false);
    expect(await graduationOf(w)).toEqual([{ graduated: false, positives: 0, negatives: 0 }]);
    expect(await rowsOf(w)).toEqual([{ id, destination: NEWS, enabled: false, provenance: "promoted", stamped: true, retroOwed: false }]);
  });

  it("approvals after the pause, below and then at the threshold, never switch it back on", async () => {
    const w = await makeCtx();
    const id = await learned(w);
    await rulesSvc.update(w.ctx, id, { enabled: false } as never);
    await approve(w, GRADUATION_THRESHOLD - 1);
    expect(await graduationOf(w), "the count did not start again from zero")
      .toEqual([{ graduated: false, positives: GRADUATION_THRESHOLD - 1, negatives: 0 }]);
    expect(await rowsOf(w)).toEqual([{ id, destination: NEWS, enabled: false, provenance: "promoted", stamped: true, retroOwed: false }]);
    await approve(w, 1);
    // The counter graduates again; under the person's pause that flag is never read as learned.
    expect(await graduationOf(w)).toEqual([{ graduated: true, positives: GRADUATION_THRESHOLD, negatives: 0 }]);
    expect(await learning.isGraduated(w.ctx, PK), "a graduation under the person's pause read as learned").toBe(false);
    expect(await rowsOf(w), "a new graduation wrote over the person's pause").toEqual([
      { id, destination: NEWS, enabled: false, provenance: "promoted", stamped: true, retroOwed: false },
    ]);
  });

  it("a removal ends it too: below the threshold no rule comes back, at the threshold one new rule", async () => {
    const w = await makeCtx();
    const id = await learned(w);
    await rulesSvc.remove(w.ctx, id);
    expect(await graduationOf(w)).toEqual([{ graduated: false, positives: 0, negatives: 0 }]);
    await approve(w, GRADUATION_THRESHOLD - 1);
    expect(await rowsOf(w), "the removed rule came back before a new graduation").toEqual([]);
    await approve(w, 1);
    const after = await rowsOf(w);
    expect(after.map(({ id: _id, ...r }) => r)).toEqual([
      { destination: NEWS, enabled: true, provenance: "promoted", stamped: false, retroOwed: true },
    ]);
    expect(after[0]!.id).not.toBe(id);
  });

  it("the organizer's apply of a pause that travelled ends it and stamps the row", async () => {
    const w = await makeCtx();
    const id = await learned(w);
    const payload = validateRulePayload("rule.update", {
      key: { kind: "sender", match: ADDR, subjectContains: null, bodyContains: null }, set: { enabled: false },
    });
    expect(payload).not.toBeNull();
    await w.db.transaction(async (tx) => {
      await applyRuleRequest(tx as unknown as Tx, { accountId: w.accountId, payload: payload!, now: new Date("2026-07-30T00:00:00Z") });
    });
    expect(await learning.isGraduated(w.ctx, PK)).toBe(false);
    expect(await rowsOf(w)).toEqual([{ id, destination: NEWS, enabled: false, provenance: "promoted", stamped: true, retroOwed: false }]);
  });

  it("…and of a removal that travelled", async () => {
    const w = await makeCtx();
    await learned(w);
    const payload = validateRulePayload("rule.delete", { key: { kind: "sender", match: ADDR, subjectContains: null, bodyContains: null } });
    await w.db.transaction(async (tx) => {
      await applyRuleRequest(tx as unknown as Tx, { accountId: w.accountId, payload: payload!, now: new Date("2026-07-30T00:00:00Z") });
    });
    expect(await graduationOf(w)).toEqual([{ graduated: false, positives: 0, negatives: 0 }]);
    await approve(w, GRADUATION_THRESHOLD - 1);
    expect(await rowsOf(w)).toEqual([]);
  });

  it("a promotion that retargets a rule already on asks for no backlog", async () => {
    const w = await makeCtx();
    const [on] = await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: ADDR, destination: "INBOX", priority: 0, enabled: true,
      provenance: "promoted", retroRequestedAt: DONE, retroDoneAt: DONE,
    }).returning({ id: rules.id });
    await approve(w, GRADUATION_THRESHOLD);
    expect(await rowsOf(w)).toEqual([{ id: on!.id, destination: NEWS, enabled: true, provenance: "promoted", stamped: false, retroOwed: false }]);
  });
});
