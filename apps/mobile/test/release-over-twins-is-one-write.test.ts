import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, type RuleDTO, type SyncChange } from "@ohmail/client-engine";
import { planPhoneRouting, releaseRules } from "../src/state/live";

/**
 * THE PHONE'S RELEASE AND MOVE OVER TWO COPIES OF ONE RULE ARE ONE WRITE (a review
 * finding, the web's mirror). The server converges a key onto the row a PATCH names, so a PATCH per twin
 * named a row the first one deleted: 404, and the press read as refused while the rule had moved.
 */
const ADDR = "lena@atelier.example";

function ruleRow(id: string, provenance: RuleDTO["provenance"]): RuleDTO {
  return {
    id, kind: "sender", match: ADDR, destination: "ohmail/Screened", priority: 0, provenance, enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: "2026-08-01T09:00:00.000Z", updatedAt: "2026-08-01T09:00:00.000Z",
  };
}

async function mirror(rules: RuleDTO[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  await store.applyChanges(rules.map((r): SyncChange => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })));
  return store;
}

describe("the phone over two twins holding the sender at Screened", () => {
  it("Allow plans one PATCH, over the twin the router runs", async () => {
    const store = await mirror([ruleRow("a", "promoted"), ruleRow("b", "manual")]);
    expect(releaseRules(store, ADDR, "ohmail/Screened", "INBOX").mutations)
      .toEqual([{ kind: "rule_update", ruleId: "b", destination: "INBOX" }]);
  });

  it("Move's routing commit writes the same one PATCH, the backlog left where it is", async () => {
    const store = await mirror([ruleRow("a", "promoted"), ruleRow("b", "manual")]);
    const writes = planPhoneRouting(store, {
      v: 1, id: "p1", seedId: "m1", address: ADDR, scope: "sender", dest: "ohbox", messageIds: [], from: "ohmail/Screened", at: 0,
    });
    expect(writes).toEqual([{ kind: "rule_update", ruleId: "b", destination: "INBOX", applyRetro: false }]);
  });

  it("a lone rule is one write (the positive arm)", async () => {
    const store = await mirror([ruleRow("a", "manual")]);
    expect(releaseRules(store, ADDR, "ohmail/Screened", "INBOX").mutations).toHaveLength(1);
  });
});
