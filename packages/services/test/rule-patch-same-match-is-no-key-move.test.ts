import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { rules } from "@trafficflow/db";
import { RulesService } from "../src/index.js";
import { makeCtx } from "./helpers.js";

/**
 * A PATCH THAT SENDS THE SAME MATCH AGAIN IS NOT A KEY MOVE (PATCH-WITH-THE-SAME-MATCH-READS-AS-A-
 * KEY-MOVE). The resent match is folded by the store: a row stored as `İnan@Example.com` keys as the
 * store lowers it, where JavaScript lowers the capital to `i̇`. Resent, it moves nothing: the twin
 * under the row's key collapses and the stored spelling stays. A different match still moves the key.
 */
const svc = new RulesService();
const STORED = "İnan@Example.com";
const TWIN = "İNAN@example.com";

async function twins() {
  const w = await makeCtx();
  const put = (match: string, destination: string) => w.db.insert(rules)
    .values({ accountId: w.accountId, kind: "sender", match, destination, provenance: "manual" }).returning({ id: rules.id });
  const [pressed] = await put(STORED, "INBOX");
  const [twin] = await put(TWIN, "ohmail/Screened");
  const rows = async () => (await w.db.select({ id: rules.id, match: rules.match, destination: rules.destination })
    .from(rules).where(eq(rules.accountId, w.accountId))).sort((a, b) => a.match.localeCompare(b.match));
  return { w, id: pressed!.id, twinId: twin!.id, rows };
}

describe("a PATCH naming the rule's own match", () => {
  it("is no key move: the twin under the key goes and the stored spelling stays", async () => {
    const t = await twins();
    await svc.update(t.w.ctx, t.id, { match: STORED, destination: "ohmail/News" });
    expect(await t.rows()).toEqual([{ id: t.id, match: STORED, destination: "ohmail/News" }]);
  });

  it("a different match still moves the key, and the old key's other row stays (the control)", async () => {
    const t = await twins();
    await svc.update(t.w.ctx, t.id, { match: "other@example.com", destination: "ohmail/News" });
    expect(await t.rows()).toEqual([
      { id: t.twinId, match: TWIN, destination: "ohmail/Screened" },
      { id: t.id, match: "other@example.com", destination: "ohmail/News" },
    ]);
  });
});
