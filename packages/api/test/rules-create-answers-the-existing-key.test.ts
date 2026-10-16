import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { rules as rulesTbl } from "@trafficflow/db";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * `POST /rules` OVER A KEY THAT ALREADY HAS A RULE: 201 is a new rule, 200 the existing one, and
 * `X-Sync-Seq` rides only on an answer that changed something. Each `Idempotency-Key` replays the
 * status its first press got, so a retry of the create that made the rule still reads 201.
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });
const ACME = { kind: "domain", match: "acme.example", destination: "ohmail/News" };
const post = (token: string, body: unknown, key?: string): Request => req("POST", "/rules", {
  bearer: token, body: JSON.stringify(body), headers: key ? { "idempotency-key": key } : {},
});

describe("POST /rules over an existing key", () => {
  it("201 with a seq, then 200 with no seq for the same body, then 200 with a seq when it moved", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const first = await H(post(s.token, ACME), deps);
    expect(first.status).toBe(201);
    expect(first.headers.get("x-sync-seq")).toBeTruthy();
    const id = (await first.json()).id;

    const same = await H(post(s.token, ACME), deps);
    expect(same.status).toBe(200);
    expect(same.headers.get("x-sync-seq"), "a seq for a change that did not happen").toBeNull();
    expect((await same.json()).id).toBe(id);

    const moved = await H(post(s.token, { ...ACME, destination: "ohmail/Receipts" }), deps);
    expect(moved.status).toBe(200);
    expect(Number(moved.headers.get("x-sync-seq"))).toBeGreaterThan(Number(first.headers.get("x-sync-seq")));
    const body = await moved.json();
    expect([body.id, body.destination]).toEqual([id, "ohmail/Receipts"]);
    expect(await db.select().from(rulesTbl).where(eq(rulesTbl.accountId, s.accountId))).toHaveLength(1);
  });

  it("two keys: 201 then 200, and each key's replay answers its own status and body", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const a = await H(post(s.token, ACME, "k1"), deps);
    const b = await H(post(s.token, ACME, "k2"), deps);
    expect([a.status, b.status]).toEqual([201, 200]);
    const [ba, bb] = [await a.json(), await b.json()];
    expect(bb.id).toBe(ba.id);

    const ra = await H(post(s.token, ACME, "k1"), deps);
    const rb = await H(post(s.token, ACME, "k2"), deps);
    expect([ra.status, rb.status]).toEqual([201, 200]);
    expect(await ra.json()).toEqual(ba);
    expect(await rb.json()).toEqual(bb);
    expect(ra.headers.get("x-sync-seq")).toBe(a.headers.get("x-sync-seq"));
    expect(rb.headers.get("x-sync-seq")).toBeNull();
    expect(await db.select().from(rulesTbl).where(eq(rulesTbl.accountId, s.accountId))).toHaveLength(1);
  });
});
