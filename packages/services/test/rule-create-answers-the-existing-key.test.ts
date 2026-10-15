import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { changeLog, rules } from "@trafficflow/db";
import { RulesService, type RuleCreation } from "../src/index.js";
import { makeCtx } from "./helpers.js";

/**
 * ONE RULE PER FOUR-FIELD KEY ON AN ORGANIZING INSTALL (RULE-CREATE-WRITES-A-TWIN-UNDER-AN-EXISTING-KEY).
 * A create over a key that already has a rule answers THAT rule, reconciled to the request the way
 * the organizer's apply reconciles a travelled create: `created: false`, the first id, a delta only
 * when something changed. A different narrowing term is a different key and a second rule.
 */
const svc = new RulesService();
const ACME = { kind: "domain", match: "acme.example", destination: "ohmail/Receipts" };
type World = Awaited<ReturnType<typeof makeCtx>>;
const rowsOf = async (w: World) => w.db.select().from(rules).where(eq(rules.accountId, w.accountId));
const ruleChanges = async (w: World, op: string) => (await w.db.select().from(changeLog)
  .where(and(eq(changeLog.accountId, w.accountId), eq(changeLog.entityType, "rule"), eq(changeLog.op, op)))).length;
const create = async (w: World, body: Record<string, unknown>, key?: string) =>
  await svc.create(w.ctx, body as never, key ? { idempotency: { key, requestHash: `h-${key}` } } : {}) as RuleCreation;

describe("a create over an existing key", () => {
  it("the same body twice: one row, the second answer names the first and changed nothing", async () => {
    const w = await makeCtx();
    const a = await create(w, ACME);
    const b = await create(w, ACME);
    expect(a.created).toBe(true);
    expect(typeof a.seq).toBe("number");
    expect(b.created).toBe(false);
    expect(b.rule.id).toBe(a.rule.id);
    expect(b.seq, "a create that changed nothing records no delta").toBeNull();
    expect(await rowsOf(w)).toHaveLength(1);
    expect(await ruleChanges(w, "create")).toBe(1);
    expect(await ruleChanges(w, "update")).toBe(0);
  });

  it("re-cased, padded and to another place: the one row is reconciled, one update delta", async () => {
    const w = await makeCtx();
    const a = await create(w, ACME);
    const b = await create(w, { ...ACME, match: "  ACME.example ", destination: "ohmail/News" });
    expect(b.created).toBe(false);
    expect(b.rule.id).toBe(a.rule.id);
    expect(b.rule.destination).toBe("ohmail/News");
    expect(typeof b.seq).toBe("number");
    const rows = await rowsOf(w);
    expect(rows.map((r) => [r.match, r.destination])).toEqual([["acme.example", "ohmail/News"]]);
    expect(await ruleChanges(w, "update")).toBe(1);
    // The routing moved and the create asked for the mail already filed: the backlog re-opens.
    expect(rows[0]!.retroRequestedAt).not.toBeNull();
  });

  it("a create over an inferred rule makes it the person's", async () => {
    const w = await makeCtx();
    await w.db.insert(rules).values({ accountId: w.accountId, kind: "domain", match: "acme.example", destination: "ohmail/Receipts", priority: 0, enabled: true, provenance: "promoted" });
    const b = await create(w, ACME);
    expect(b.created).toBe(false);
    expect((await rowsOf(w)).map((r) => r.provenance)).toEqual(["manual"]);
  });

  it("twins already under the key collapse into the acting row", async () => {
    const w = await makeCtx();
    const twin = { accountId: w.accountId, kind: "domain", match: "acme.example", priority: 0, enabled: true, provenance: "manual" };
    await w.db.insert(rules).values([{ ...twin, destination: "ohmail/Receipts" }, { ...twin, destination: "ohmail/News" }]);
    const b = await create(w, ACME);
    expect(b.created).toBe(false);
    expect((await rowsOf(w)).map((r) => r.destination)).toEqual(["ohmail/Receipts"]);
    expect(await ruleChanges(w, "delete")).toBe(1);
    expect(b.seq, "the collapse is a change").not.toBeNull();
  });

  it("CONTROL: a create differing only in subjectContains is a second rule", async () => {
    const w = await makeCtx();
    const ann = { kind: "sender", match: "ann@acme.example", destination: "ohmail/Receipts" };
    const a = await create(w, ann);
    const b = await create(w, { ...ann, subjectContains: "invoice" });
    expect(b.created).toBe(true);
    expect(b.rule.id).not.toBe(a.rule.id);
    expect(await rowsOf(w)).toHaveLength(2);
  });
});

describe("two idempotency keys over one key", () => {
  it("sequential: one row, created then reconciled, each key holding its own status", async () => {
    const w = await makeCtx();
    const a = await create(w, ACME, "k1");
    const b = await create(w, ACME, "k2");
    expect([a.created, b.created]).toEqual([true, false]);
    expect(b.rule.id).toBe(a.rule.id);
    expect(await rowsOf(w)).toHaveLength(1);
  });
});
