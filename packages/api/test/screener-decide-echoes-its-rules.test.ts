import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { rules } from "@trafficflow/db";
import { makeDeps, seedSession, seedScreenerHeld, req, FIXED_NOW } from "./helpers.js";

/**
 * `POST /screener/:id` ANSWERS WITH THE RULES IT WROTE — the promoted rule and every twin it
 * retargeted, each the DTO `/sync` carries for that row, so a client whose drain lags the server
 * holds the decision from the confirm on (`POST /rules` has always answered with its rule).
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });
const ADDR = "offers@spam.test";

type Change = { type: string; id: string; entity: unknown };
async function syncedRules(deps: ApiDeps, token: string): Promise<Map<string, unknown>> {
  const b = await (await H(req("GET", "/sync?since=0", { bearer: token }), deps)).json() as {
    changes: { creates: Change[]; updates: Change[]; moves: Change[]; deletes: Change[] };
  };
  const all = [...b.changes.creates, ...b.changes.updates, ...b.changes.moves, ...b.changes.deletes];
  return new Map(all.filter((c) => c.type === "rule").map((c) => [c.id, c.entity]));
}

async function heldItem(deps: ApiDeps, token: string): Promise<{ id: string }> {
  return (await (await H(req("GET", "/screener", { bearer: token }), deps)).json()).items[0];
}

const screenOut = JSON.stringify({ decision: "no", dest: "ohmail/Screened" });

describe("POST /screener/:id answers with the rules it wrote", () => {
  it("the created rule's DTO is the one /sync carries for it, beside its id and the seq", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await seedScreenerHeld(db, { accountId: s.accountId, fromAddress: ADDR });
    const item = await heldItem(deps, s.token);

    const res = await H(req("POST", `/screener/${item.id}`, { bearer: s.token, body: screenOut }), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-sync-seq"), "an echo with no seq is no echo").toMatch(/^\d+$/);
    const body = await res.json();
    expect(body.createdRule).toMatchObject({
      id: body.createdRuleId, kind: "sender", match: ADDR, destination: "ohmail/Screened",
      provenance: "promoted", enabled: true,
    });
    expect(body.createdRule).toEqual((await syncedRules(deps, s.token)).get(body.createdRuleId));
    expect(body.retargetedRules).toEqual([]);
  });

  it("a sender's existing rule IS the decided rule: answered as createdRule at its new place, as /sync carries it", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const held = await seedScreenerHeld(db, { accountId: s.accountId, fromAddress: ADDR });
    // An allow written while the sender's mail waited at the gate (another device's press). The
    // queue stops listing the sender, so the press is the one a row still on screen sends.
    const [twin] = await db.insert(rules).values({
      accountId: s.accountId, kind: "sender", match: ADDR, destination: "INBOX", provenance: "manual", enabled: true,
    }).returning();

    const res = await H(req("POST", `/screener/${held.id}`, { bearer: s.token, body: screenOut }), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    const synced = await syncedRules(deps, s.token);
    // One rule per key: the decision converges onto the sender's rule rather than adding a twin.
    expect(body.createdRuleId).toBe(twin!.id);
    expect(body.retargetedRules).toEqual([]);
    expect(body.createdRule.destination).toBe("ohmail/Screened");
    expect(body.createdRule).toEqual(synced.get(twin!.id));
    expect([...synced.keys()]).toEqual([twin!.id]);
  });

  it("the idempotent replay answers the same rules, and writes no second one", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await seedScreenerHeld(db, { accountId: s.accountId, fromAddress: ADDR });
    const item = await heldItem(deps, s.token);
    const send = () => H(req("POST", `/screener/${item.id}`, {
      bearer: s.token, headers: { "idempotency-key": "echo-1" }, body: screenOut,
    }), deps);

    const first = await (await send()).json();
    const replay = await send();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(first);
    expect(first.createdRule?.id).toBe(first.createdRuleId);
    const promoted = (await db.select().from(rules)).filter((r) => r.provenance === "promoted");
    expect(promoted).toHaveLength(1);
  });
});
