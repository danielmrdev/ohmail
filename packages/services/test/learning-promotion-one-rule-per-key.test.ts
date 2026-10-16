import { describe, it, expect } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { rules } from "@trafficflow/db";
import { LearningService, GRADUATION_THRESHOLD } from "../src/index.js";
import { makeCtx } from "./helpers.js";

/**
 * A GRADUATION WRITES UNDER THE SENDER'S KEY ONLY WHERE THE KEY IS ITS OWN (LEARNING-PROMOTION-
 * ADDS-A-TWIN). The key is the four fields; a key with no row gets the promoted rule, a key whose
 * every row is an earlier promotion of its own (promoted, never a person's decision) is converged
 * onto its acting row and switched on and retargeted there. Any manual, migrated or
 * person-decided row under the key, paused included, is a decision: nothing is written over it.
 */
const svc = new LearningService();
const ADDR = "a@b.example";
const NEWS = "ohmail/News";
const PK = `sender:${ADDR}→${NEWS}`;
type World = Awaited<ReturnType<typeof makeCtx>>;

async function graduate(w: World): Promise<void> {
  for (let i = 0; i < GRADUATION_THRESHOLD; i++) {
    await svc.record(w.ctx, { triggeringActionId: `p:${i}`, kind: "approval", senderAddress: ADDR, destination: NEWS, label: "positive" });
  }
  await svc.promoteOrDemote(w.ctx, PK);
}

type RuleSeed = Partial<typeof rules.$inferInsert>;
async function seed(w: World, row: RuleSeed): Promise<string> {
  const [r] = await w.db.insert(rules).values({
    accountId: w.accountId, kind: "sender", match: ADDR, destination: "INBOX", priority: 0, enabled: true,
    provenance: "manual", ...row,
  } as typeof rules.$inferInsert).returning({ id: rules.id });
  return r!.id;
}

const rowsOf = async (w: World) => (await w.db.select().from(rules)
  .where(and(eq(rules.accountId, w.accountId), eq(rules.kind, "sender"))).orderBy(asc(rules.createdAt), asc(rules.id)))
  .map((r) => ({
    id: r.id, destination: r.destination, enabled: r.enabled, provenance: r.provenance,
    subject: r.subjectContains, retro: r.retroRequestedAt !== null,
  }));

describe("a graduation writes one rule per key, and only over its own", () => {
  it("no row under the key: the promoted rule, with the backlog asked for (positive control)", async () => {
    const w = await makeCtx();
    await graduate(w);
    expect((await rowsOf(w)).map(({ id: _id, ...r }) => r)).toEqual([
      { destination: NEWS, enabled: true, provenance: "promoted", subject: null, retro: true },
    ]);
  });

  it("over a manual rule: nothing is written beside it", async () => {
    const w = await makeCtx();
    const id = await seed(w, {});
    await graduate(w);
    expect((await rowsOf(w)).map((r) => [r.id, r.destination, r.provenance])).toEqual([[id, "INBOX", "manual"]]);
  });

  it("over a migrated rule, and over a person's Screener decision: nothing is written", async () => {
    for (const row of [{ provenance: "migrated" }, { provenance: "promoted", personDecidedAt: new Date("2026-09-01T00:00:00Z") }] as RuleSeed[]) {
      const w = await makeCtx();
      const id = await seed(w, row);
      await graduate(w);
      expect((await rowsOf(w)).map((r) => [r.id, r.destination])).toEqual([[id, "INBOX"]]);
    }
  });

  it("over a PAUSED manual rule beside its own promotion: both stay as they are", async () => {
    const w = await makeCtx();
    const own = await seed(w, { provenance: "promoted" });
    const paused = await seed(w, { enabled: false });
    await graduate(w);
    expect((await rowsOf(w)).map((r) => [r.id, r.destination, r.enabled]).sort()).toEqual(
      [[own, "INBOX", true], [paused, "INBOX", false]].sort());
  });

  it("its own earlier promotion, demoted: switched on and retargeted in place, the backlog re-asked", async () => {
    const w = await makeCtx();
    const id = await seed(w, { provenance: "promoted", enabled: false, retroRequestedAt: null });
    await graduate(w);
    expect(await rowsOf(w)).toEqual([{ id, destination: NEWS, enabled: true, provenance: "promoted", subject: null, retro: true }]);
  });

  it("twins of its own promotions collapse onto the acting row", async () => {
    const w = await makeCtx();
    const acting = await seed(w, { provenance: "promoted", priority: 3 });
    await seed(w, { provenance: "promoted", destination: "ohmail/Screened" });
    await graduate(w);
    expect((await rowsOf(w)).map((r) => [r.id, r.destination])).toEqual([[acting, NEWS]]);
  });

  it("a row narrowed by a subject term is another key: the bare key is promoted beside it", async () => {
    const w = await makeCtx();
    const term = await seed(w, { destination: NEWS, subjectContains: "invoice" });
    await graduate(w);
    const rows = await rowsOf(w);
    expect(rows.find((r) => r.id === term)).toMatchObject({ destination: NEWS, subject: "invoice", provenance: "manual" });
    expect(rows.filter((r) => r.id !== term).map(({ id: _id, ...r }) => r)).toEqual([
      { destination: NEWS, enabled: true, provenance: "promoted", subject: null, retro: true },
    ]);
  });
});
