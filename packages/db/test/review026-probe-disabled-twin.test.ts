import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../src/testing.js";
import { applyRuleRequest, validateRulePayload, type ValidatedRuleRequest } from "../src/request-apply.js";
import { accounts, rules } from "../src/schema-mail.js";
import type { LedgerTx, Tx } from "../src/change-log.js";

// REVIEW-026 probe: the organizer's acting twin when the outranking twin is disabled.
const NOW = new Date("2026-10-02T12:00:00.000Z");

async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `r026-${accountId.slice(0, 8)}` });
  const [off] = await db.insert(rules).values({
    accountId, kind: "sender", match: "Ann@Shop.example", destination: "ohmail/Receipts", priority: 5, enabled: false, provenance: "manual",
  }).returning({ id: rules.id });
  const [on] = await db.insert(rules).values({
    accountId, kind: "sender", match: "ann@shop.example", destination: "ohmail/News", priority: 0, enabled: true, provenance: "manual",
  }).returning({ id: rules.id });
  const apply = (payload: ValidatedRuleRequest) => (db as unknown as Tx).transaction((tx) =>
    applyRuleRequest(tx as unknown as LedgerTx, { accountId, payload, now: NOW }));
  const left = async () => db.select({ id: rules.id, destination: rules.destination, enabled: rules.enabled })
    .from(rules).where(eq(rules.accountId, accountId));
  return { off: off!.id, on: on!.id, apply, left };
}

describe("REVIEW-026 probe: a disabled twin outranks an enabled one", () => {
  it("a removal carrying what the page showed (the disabled twin) takes the enabled rule too", async () => {
    const w = await world();
    const payload = validateRulePayload("rule.delete", {
      key: { kind: "sender", match: "ann@shop.example" }, shown: { destination: "ohmail/Receipts", enabled: false },
    })!;
    const r = await w.apply(payload);
    console.log("PROBE delete-as-shown", JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? String(v) : v)), "acting is the disabled twin:", (r as { ruleId?: string }).ruleId === w.off);
    console.log("PROBE rows left", JSON.stringify(await w.left()));
  });
  it("a removal carrying the rule the router runs (the enabled twin) is refused as changed", async () => {
    const w = await world();
    const payload = validateRulePayload("rule.delete", {
      key: { kind: "sender", match: "ann@shop.example" }, shown: { destination: "ohmail/News", enabled: true },
    })!;
    const r = await w.apply(payload);
    console.log("PROBE delete-of-running-rule", JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
    expect(r).toMatchObject({ applied: true });
  });
});
