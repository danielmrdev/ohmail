import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { changeLog, rules } from "@trafficflow/db";
import { ruleMatchKey } from "@trafficflow/core/rule-order";
import { HeyMigrationService } from "../src/index.js";
import { makeCtx } from "./helpers.js";

/**
 * THE HEY IMPORT WRITES ONE RULE PER KEY (HEY-MIGRATION-ADDS-A-TWIN-OVER-A-MANUAL-RULE). An
 * observation over a key that has a rule made here leaves that rule as it is — no second row, no
 * delta — and a key whose rule this migration wrote takes the observation's new destination.
 * The learning promotion writes through the same key (`learning-promotion-one-rule-per-key.test.ts`).
 */
const ADDR = "lena@atelier.example";

type Ctx = Awaited<ReturnType<typeof makeCtx>>;

async function underKey(c: Ctx) {
  return (await c.db.select().from(rules).where(eq(rules.accountId, c.accountId)))
    .filter((r) => r.kind === "sender" && ruleMatchKey(r.match) === ADDR && r.subjectContains === null && r.bodyContains === null)
    .map((r) => `${r.destination}/${r.provenance}/${r.enabled ? "on" : "off"}`).sort();
}

const migrate = (c: Ctx, destination: "INBOX" | "ohmail/Screened" | "ohmail/News") =>
  new HeyMigrationService().migrateFromObservations(c.ctx, { observations: [{ senderOrDomain: ADDR, kind: "sender", destination }] });

describe("the HEY migration over a key that has a rule", () => {
  it("an observation filing to Screened over a manual Ohbox rule leaves that rule alone: one row, no delta", async () => {
    const c = await makeCtx();
    await c.db.insert(rules).values({ accountId: c.accountId, kind: "sender", match: ADDR, destination: "INBOX", provenance: "manual" });
    const out = await migrate(c, "ohmail/Screened");
    expect(await underKey(c)).toEqual(["INBOX/manual/on"]);
    expect(out).toMatchObject({ created: 0, unchanged: 1 });
    expect(await c.db.select().from(changeLog).where(eq(changeLog.accountId, c.accountId))).toEqual([]);
  });

  it("a key whose rule this migration wrote takes the observation's new destination", async () => {
    const c = await makeCtx();
    await migrate(c, "ohmail/News");
    await migrate(c, "ohmail/Screened");
    expect(await underKey(c)).toEqual(["ohmail/Screened/migrated/on"]);
  });
});
