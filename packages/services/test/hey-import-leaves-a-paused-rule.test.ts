import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { applyRuleRequest, applyScreenerDecision, rules, validateRulePayload, type Tx } from "@trafficflow/db";
import { carryDialect } from "@trafficflow/db/dialect";
import { HeyMigrationService, RulesService } from "../src/index.js";
import { makeCtx } from "./helpers.js";

/**
 * A PERSON'S DECISION OVER AN IMPORTED RULE IS THEIRS. A pause stamps the row whatever wrote it,
 * and so does a person's Screener decision, so the HEY import, which owns a row only while it is
 * migrated and unstamped, neither retargets it on a re-run whose mapping moved nor deletes it on an
 * undo. The pause through both doors (the install's PATCH, the organizer's apply of a pause that
 * travelled); the Screener decision through its one apply.
 */
const ADDR = "lena@atelier.example";
const seen = (destination: string) => [{ senderOrDomain: ADDR, kind: "sender", destination }] as never;
type World = Awaited<ReturnType<typeof makeCtx>>;
type Door = "install" | "travelled" | "screener";

const rowOf = async (w: World) => (await w.db.select().from(rules)
  .where(and(eq(rules.accountId, w.accountId), eq(rules.kind, "sender"))))
  .map((r) => ({ destination: r.destination, enabled: r.enabled, provenance: r.provenance, stamped: r.personDecidedAt !== null }));

/** Import the sender into Screened, then let the person decide on the imported rule through `door`. */
async function importedThenDecided(door: Door): Promise<World> {
  const w = await makeCtx();
  await new HeyMigrationService().migrateFromObservations(w.ctx, { observations: seen("ohmail/Screened") });
  if (door === "install") {
    const [row] = await w.db.select({ id: rules.id }).from(rules).where(eq(rules.accountId, w.accountId));
    await new RulesService().update(w.ctx, row!.id, { enabled: false } as never);
  } else if (door === "travelled") {
    const payload = validateRulePayload("rule.update", {
      key: { kind: "sender", match: ADDR, subjectContains: null, bodyContains: null }, set: { enabled: false },
    });
    await w.db.transaction(async (tx) => {
      await applyRuleRequest(tx as unknown as Tx, { accountId: w.accountId, payload: payload!, now: new Date("2026-07-30T00:00:00Z") });
    });
  } else {
    await w.db.transaction((tx) => applyScreenerDecision(carryDialect(w.db, tx), {
      accountId: w.accountId, scope: "sender", address: ADDR, appliedFolder: "ohmail/Screened", decision: "no",
      triggeringActionId: `screener:${randomUUID()}`, now: new Date("2026-07-30T00:00:00Z"), stampBaseline: false,
      decidedBy: "person", overExisting: "converge",
    }));
  }
  return w;
}

describe("the HEY import leaves a person's decision over an imported rule", () => {
  const left = (door: Door) => [{ destination: "ohmail/Screened", enabled: door === "screener", provenance: "migrated", stamped: true }];
  for (const door of ["install", "travelled", "screener"] as const) {
    it(`a re-run whose mapping moved leaves the decision (${door} door)`, async () => {
      const w = await importedThenDecided(door);
      expect(await rowOf(w)).toEqual(left(door));
      await new HeyMigrationService().migrateFromObservations(w.ctx, { observations: seen("ohmail/News") });
      expect(await rowOf(w), "the re-run retargeted the person's rule").toEqual(left(door));
    });

    it(`an undo leaves the decision (${door} door)`, async () => {
      const w = await importedThenDecided(door);
      await new HeyMigrationService().undoMigration(w.ctx);
      expect(await rowOf(w), "the undo removed the person's rule").toEqual(left(door));
    });
  }

  it("CONTROL: an imported rule nobody decided on is still the import's to retarget and to undo", async () => {
    const w = await makeCtx();
    const hey = new HeyMigrationService();
    await hey.migrateFromObservations(w.ctx, { observations: seen("ohmail/Screened") });
    await hey.migrateFromObservations(w.ctx, { observations: seen("ohmail/News") });
    expect(await rowOf(w)).toEqual([{ destination: "ohmail/News", enabled: true, provenance: "migrated", stamped: false }]);
    expect(await hey.undoMigration(w.ctx)).toEqual({ removed: 1 });
    expect(await rowOf(w)).toEqual([]);
  });
});
