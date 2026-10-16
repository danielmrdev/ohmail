import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../src/testing.js";
import { applyRuleRequest, validateRulePayload, type ValidatedRuleRequest } from "../src/request-apply.js";
import { accounts, rules } from "../src/schema.js";
import type { LedgerTx, Tx } from "../src/change-log.js";
import { carryDialect } from "../src/dialect/index.js";

/**
 * THE TRAVELLED UNDO, the relayed twin of `RulesService.update`'s: `keepProvenance` keeps the row's
 * provenance and never sets one; `restoreProvenance` travels only beside it, only as an inferred
 * value, and lands only over a `manual` row. A request breaking either is refused whole.
 */
const NOW = new Date("2026-10-01T21:00:00.000Z");

async function world(provenance: string, destination = "INBOX") {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `rruk-${accountId.slice(0, 8)}` });
  const key = { kind: "sender" as const, match: `${randomUUID()}@letter.example`, subjectContains: null, bodyContains: null };
  await db.insert(rules).values({ accountId, kind: key.kind, match: key.match, destination, priority: 0, enabled: true,
    provenance: provenance as "promoted" });
  const apply = (raw: Record<string, unknown>) => {
    const payload = validateRulePayload("rule.update", { key, ...raw }) as ValidatedRuleRequest;
    expect(payload, "the validator admitted it").not.toBeNull();
    return (db as unknown as Tx).transaction((tx) =>
      applyRuleRequest(carryDialect(db, tx as object) as unknown as LedgerTx, { accountId, payload, now: NOW }));
  };
  const read = async () => (await db.select().from(rules)
    .where(and(eq(rules.accountId, accountId), eq(rules.match, key.match))))[0]!;
  return { key, apply, read };
}

describe("a travelled undo keeps the rule's provenance and restores only a claim", () => {
  it("the Move then its undo: the rule is back as it was", async () => {
    const w = await world("promoted");
    await w.apply({ set: { destination: "reads" }, applyRetro: false });
    expect((await w.read()).provenance).toBe("manual");
    await w.apply({ set: { destination: "inbox" }, applyRetro: false, keepProvenance: true, restoreProvenance: "promoted" });
    const r = await w.read();
    expect(r.destination).toBe("INBOX");
    expect(r.provenance).toBe("promoted");
  });

  it("keepProvenance alone sets nothing; a restore over an inferred row is not written", async () => {
    const w = await world("seeded-from-sent", "ohmail/News");
    await w.apply({ set: { destination: "inbox" }, applyRetro: false, keepProvenance: true });
    expect((await w.read()).provenance).toBe("seeded-from-sent");
    await w.apply({ set: { destination: "inbox" }, applyRetro: false, keepProvenance: true, restoreProvenance: "promoted" });
    expect((await w.read()).provenance).toBe("seeded-from-sent");
  });

  it("refuses a restore without the keep, to manual, or outside the inferred set", () => {
    const key = { kind: "sender", match: "a@b.example" };
    const base = { key, set: { destination: "inbox" } };
    expect(validateRulePayload("rule.update", { ...base, restoreProvenance: "promoted" })).toBeNull();
    expect(validateRulePayload("rule.update", { ...base, keepProvenance: true, restoreProvenance: "manual" })).toBeNull();
    expect(validateRulePayload("rule.update", { ...base, keepProvenance: true, restoreProvenance: "x" })).toBeNull();
    expect(validateRulePayload("rule.update", { ...base, keepProvenance: "yes" })).toBeNull();
    // An undo puts the rule back somewhere: a restore with no destination downgrades nothing.
    expect(validateRulePayload("rule.update",
      { key, set: { priority: 3 }, keepProvenance: true, restoreProvenance: "promoted" })).toBeNull();
    expect(validateRulePayload("rule.update", { key, set: { priority: 3 }, keepProvenance: true }),
      "the keep alone without a destination stays admitted").not.toBeNull();
    expect(validateRulePayload("rule.update", { ...base, keepProvenance: true, restoreProvenance: "migrated" }),
      "the admitted shape (the positive control)").not.toBeNull();
  });
});
