import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { changeLog, rules } from "@trafficflow/db";
import { HeyMigrationService, RulesService, type RuleMutation } from "../src/index.js";
import { makeCtx } from "./helpers.js";

/**
 * EVERY RULE WRITER STORES THE KEY THE READERS COMPARE (`ruleMatchKey`): `POST /rules` stored a
 * match verbatim and the HEY import lower-cased without trimming, so a padded row was the sender's
 * rule to the router and nobody's to an identity read. And a Remove takes the sender's rule whole.
 */
const svc = new RulesService();

describe("the bytes each rule writer stores", () => {
  it("POST /rules and the HEY import store the key", async () => {
    const { ctx, db, accountId } = await makeCtx();
    await svc.create(ctx, { kind: "sender", match: "  Ann@Shop.example ", destination: "ohmail/News" } as never);
    await svc.create(ctx, { kind: "domain", match: "Corp.example", destination: "ohmail/Receipts" } as never);
    await new HeyMigrationService().migrateFromObservations(ctx, {
      observations: [{ kind: "sender", senderOrDomain: " Bob@Hey.example", destination: "ohmail/News" } as never],
    });
    const stored = (await db.select({ match: rules.match }).from(rules).where(eq(rules.accountId, accountId)))
      .map((r) => r.match).sort();
    expect(stored).toEqual(["ann@shop.example", "bob@hey.example", "corp.example"]);
  });

  it("a re-run of the HEY import finds its own rows, whatever spelling the export used", async () => {
    const { ctx, db, accountId } = await makeCtx();
    const hey = new HeyMigrationService();
    await hey.migrateFromObservations(ctx, { observations: [{ kind: "sender", senderOrDomain: "bob@hey.example", destination: "ohmail/News" } as never] });
    const again = await hey.migrateFromObservations(ctx, { observations: [{ kind: "sender", senderOrDomain: " Bob@Hey.example", destination: "ohmail/News" } as never] });
    expect(again).toMatchObject({ created: 0 });
    expect(await db.select().from(rules).where(eq(rules.accountId, accountId))).toHaveLength(1);
  });

  it("a match of spaces is refused, and a header name keeps its bytes", async () => {
    const { ctx } = await makeCtx();
    await expect(svc.create(ctx, { kind: "sender", match: "   ", destination: "ohmail/News" } as never))
      .rejects.toMatchObject({ httpStatus: 400 });
    const h = await svc.create(ctx, { kind: "header", match: "List-Id", destination: "ohmail/News" } as never) as RuleMutation;
    expect(h.rule.match).toBe("List-Id");
  });
});

describe("Remove takes the sender's rule, not one byte-shape of it", () => {
  it("the row and its twin under one key both go, one delete delta each", async () => {
    const { ctx, db, accountId } = await makeCtx();
    const shown = await svc.create(ctx, { kind: "sender", match: "ann@shop.example", destination: "ohmail/News" } as never) as RuleMutation;
    const [twin] = await db.insert(rules).values({
      accountId, kind: "sender", match: "  Ann@Shop.example ", destination: "ohmail/News", provenance: "manual",
    }).returning({ id: rules.id });
    await svc.remove(ctx, shown.rule.id);
    expect(await db.select().from(rules).where(eq(rules.accountId, accountId))).toEqual([]);
    const deleted = (await db.select({ id: changeLog.entityId }).from(changeLog)
      .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityType, "rule"), eq(changeLog.op, "delete"))))
      .map((r) => r.id).sort();
    expect(deleted).toEqual([shown.rule.id, twin!.id].sort());
  });

  it("CONTROL: another sender's rule and a narrower rule for the same sender stay", async () => {
    const { ctx, db, accountId } = await makeCtx();
    const shown = await svc.create(ctx, { kind: "sender", match: "ann@shop.example", destination: "ohmail/News" } as never) as RuleMutation;
    await svc.create(ctx, { kind: "sender", match: "bob@shop.example", destination: "ohmail/News" } as never);
    await svc.create(ctx, { kind: "sender", match: "ann@shop.example", subjectContains: "[Invoice]", destination: "ohmail/Receipts" } as never);
    await svc.remove(ctx, shown.rule.id);
    expect(await db.select().from(rules).where(eq(rules.accountId, accountId))).toHaveLength(2);
  });
});
