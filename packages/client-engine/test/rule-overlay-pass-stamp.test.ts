import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, mutationEffects, type RuleDTO, type SyncChange } from "@ohmail/client-engine";

/**
 * THE OVERLAY STATES THE PASS THE SERVER WILL START, AND NEVER ITS END. A create with past mail,
 * a retarget, or an explicit yes is "asked, not finished"; a create declining past mail is "not
 * asked"; a patch that neither moves the rule nor asks leaves the stamp as it was.
 */
const ctx = { now: () => new Date("2026-09-25T13:00:00.000Z"), uuid: () => "c-1" };
const ISO = "2026-09-25T13:00:00.000Z";
const rule: RuleDTO = {
  id: "r-1", kind: "sender", match: "a@x.example", destination: "INBOX", priority: 0, provenance: "manual", enabled: true,
  subjectContains: null, bodyContains: null, stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
  retro: { requestedAt: "2026-09-01T00:00:00.000Z", doneAt: "2026-09-01T00:05:00.000Z" },
} as RuleDTO;

async function reader() {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([{ type: "rule", op: "create", id: rule.id, seq: 1, updatedAt: rule.updatedAt, entity: rule }] as SyncChange[]);
  return store;
}
const retroOf = (effects: ReturnType<typeof mutationEffects>) => (effects[0]!.entity as RuleDTO).retro;

describe("the overlay's pass stamp", () => {
  it("a create asks unless it declines", async () => {
    const r = await reader();
    expect(retroOf(mutationEffects(r, { kind: "rule_create", ruleKind: "sender", match: "b@x.example", destination: "INBOX" }, ctx)))
      .toEqual({ requestedAt: ISO, doneAt: null });
    expect(retroOf(mutationEffects(r, { kind: "rule_create", ruleKind: "sender", match: "b@x.example", destination: "INBOX", applyRetro: false }, ctx)))
      .toEqual({ requestedAt: null, doneAt: null });
  });

  it("a retarget or an explicit yes re-asks; a no or a same-place patch keeps the stamp", async () => {
    const r = await reader();
    expect(retroOf(mutationEffects(r, { kind: "rule_update", ruleId: "r-1", destination: "ohmail/News" }, ctx)))
      .toEqual({ requestedAt: ISO, doneAt: null });
    expect(retroOf(mutationEffects(r, { kind: "rule_update", ruleId: "r-1", destination: "INBOX", applyRetro: true }, ctx)))
      .toEqual({ requestedAt: ISO, doneAt: null });
    expect(retroOf(mutationEffects(r, { kind: "rule_update", ruleId: "r-1", destination: "ohmail/News", applyRetro: false }, ctx)))
      .toEqual(rule.retro);
    expect(retroOf(mutationEffects(r, { kind: "rule_update", ruleId: "r-1", destination: "INBOX" }, ctx))).toEqual(rule.retro);
  });
});
